const { randomUUID } = require("node:crypto");
const { normalizedPhoneSql } = require("../utils/kenyanPhone");
const ERROR_CODE_PATTERN = /^(SMS|EMAIL|PUSH|NOTIFICATION)_[A-Z0-9_]{1,60}$/;

function createSmsNotificationRepository(
    pool,
    { claimLeaseMs = 60000, maxAttempts = 4 } = {}
) {
    if (!pool || typeof pool.connect !== "function") {
        throw new TypeError("A PostgreSQL pool is required for SMS delivery.");
    }
    if (!Number.isSafeInteger(claimLeaseMs) || claimLeaseMs <= 0) {
        throw new TypeError("The SMS claim lease must be a positive integer.");
    }
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
        throw new TypeError("The SMS attempt limit must be a positive integer.");
    }

    async function claimBatch(batchSize, channels = ["SMS"]) {
        if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
            throw new TypeError("The SMS batch size must be a positive integer.");
        }
        if (!Array.isArray(channels) || channels.length === 0 ||
            channels.some((channel) => !["SMS", "EMAIL", "PUSH"].includes(channel))) {
            throw new TypeError("One or more valid notification channels are required.");
        }

        const client = await pool.connect();
        let transactionStarted = false;
        try {
            await client.query("BEGIN");
            transactionStarted = true;
            await client.query(
                `UPDATE notifications
                 SET delivery_status = 'UNKNOWN',
                     claimed_at = NULL,
                     claim_token = NULL,
                     last_error_code = 'CLAIM_EXPIRED'
                 WHERE notification_type = ANY($2::varchar[])
                   AND user_id IS NOT NULL
                   AND delivery_status = 'PROCESSING'
                   AND claimed_at <= now() - ($1 * INTERVAL '1 millisecond')`,
                [claimLeaseMs, channels]
            );

            await client.query(
                `UPDATE notifications n
                 SET delivery_status = 'FAILED',
                     last_error_code = 'NOTIFICATION_RECIPIENT_STALE'
                 WHERE n.notification_type = ANY($1::varchar[])
                   AND n.delivery_status = 'PENDING'
                   AND (
                       (n.notification_type = 'SMS' AND NOT EXISTS (
                           SELECT 1
                           FROM users u
                           LEFT JOIN notification_preferences np ON np.user_id = u.user_id
                           WHERE u.user_id = n.user_id
                             AND u.account_status = 'ACTIVE'
                             AND u.phone_verified_at IS NOT NULL
                             AND (n.admin_request_key IS NOT NULL OR np.sms_enabled IS TRUE)
                             AND (${normalizedPhoneSql("u.phone")}) = n.recipient_phone
                       ))
                       OR
                       (n.notification_type = 'EMAIL' AND NOT EXISTS (
                           SELECT 1
                           FROM users u
                           LEFT JOIN notification_preferences np ON np.user_id = u.user_id
                           WHERE u.user_id = n.user_id
                             AND u.account_status = 'ACTIVE'
                             AND u.email_verified IS TRUE
                             AND (n.admin_request_key IS NOT NULL OR np.email_enabled IS TRUE)
                             AND lower(u.email) = lower(n.recipient_email)
                       ))
                   )`,
                [channels]
            );

            const eligible = await client.query(
                `SELECT notification_id
                 FROM notifications
                 WHERE notification_type = ANY($2::varchar[])
                   AND user_id IS NOT NULL
                   AND delivery_status = 'PENDING'
                   AND (
                       (notification_type = 'SMS' AND recipient_phone IS NOT NULL)
                       OR (notification_type = 'EMAIL'
                           AND recipient_email IS NOT NULL
                           AND email_subject IS NOT NULL)
                       OR notification_type = 'PUSH'
                   )
                   AND (
                       (notification_type = 'SMS' AND (
                           admin_request_key IS NOT NULL OR EXISTS (
                           SELECT 1 FROM notification_preferences np
                           WHERE np.user_id = notifications.user_id
                             AND np.sms_enabled IS TRUE
                       )))
                       OR (notification_type = 'EMAIL' AND (
                           admin_request_key IS NOT NULL OR EXISTS (
                           SELECT 1 FROM notification_preferences np
                           WHERE np.user_id = notifications.user_id
                             AND np.email_enabled IS TRUE
                       )))
                       OR notification_type = 'PUSH'
                   )
                   AND (
                       (notification_type = 'SMS' AND EXISTS (
                           SELECT 1
                           FROM users u
                           WHERE u.user_id = notifications.user_id
                             AND u.account_status = 'ACTIVE'
                             AND u.phone_verified_at IS NOT NULL
                             AND (${normalizedPhoneSql("u.phone")}) = notifications.recipient_phone
                       ))
                       OR
                       (notification_type = 'EMAIL' AND EXISTS (
                           SELECT 1
                           FROM users u
                           WHERE u.user_id = notifications.user_id
                             AND u.account_status = 'ACTIVE'
                             AND u.email_verified IS TRUE
                             AND lower(u.email) = lower(notifications.recipient_email)
                       ))
                       OR notification_type = 'PUSH'
                   )
                   AND next_attempt_at <= now()
                   AND attempt_count < $1
                 ORDER BY next_attempt_at, created_at
                   LIMIT $3
                   FOR UPDATE SKIP LOCKED`,
                [maxAttempts, channels, batchSize]
            );

            const claimed = [];
            for (const row of eligible.rows) {
                const claimToken = randomUUID();
                const result = await client.query(
                    `UPDATE notifications
                     SET delivery_status = 'PROCESSING',
                         claimed_at = now(),
                         claim_token = $1,
                         attempt_count = attempt_count + 1,
                         last_attempt_at = now(),
                         last_error_code = NULL
                     WHERE notification_id = $2
                       AND user_id IS NOT NULL
                       AND delivery_status = 'PENDING'
                     RETURNING notification_id, user_id, notification_type,
                               recipient_phone, recipient_email, email_subject,
                               email_html_body, push_title, message, attempt_count,
                               claim_token, created_by`,
                    [claimToken, row.notification_id]
                );
                if (result.rows[0]) claimed.push(result.rows[0]);
            }

            await client.query("COMMIT");
            transactionStarted = false;
            return claimed;
        } catch (error) {
            if (transactionStarted) {
                await client.query("ROLLBACK");
                transactionStarted = false;
            }
            throw error;
        } finally {
            client.release();
        }
    }

    async function isClaimEligible(notification) {
        if (!notification || typeof notification.notification_id !== "string" ||
            typeof notification.claim_token !== "string" ||
            typeof notification.user_id !== "string" ||
            !["SMS", "EMAIL"].includes(notification.notification_type)) {
            return false;
        }
        const contactCondition = notification.notification_type === "SMS"
            ? `u.phone_verified_at IS NOT NULL
               AND (${normalizedPhoneSql("u.phone")}) = n.recipient_phone
               AND (n.admin_request_key IS NOT NULL OR np.sms_enabled IS TRUE)`
            : `u.email_verified IS TRUE
               AND lower(u.email) = lower(n.recipient_email)
               AND (n.admin_request_key IS NOT NULL OR np.email_enabled IS TRUE)`;
        const result = await pool.query(
            `SELECT n.notification_id
             FROM notifications n
             JOIN users u ON u.user_id = n.user_id
             LEFT JOIN notification_preferences np ON np.user_id = n.user_id
             WHERE n.notification_id = $1
               AND n.claim_token = $2
               AND n.user_id = $3
               AND n.notification_type = $4
               AND n.delivery_status = 'PROCESSING'
               AND u.account_status = 'ACTIVE'
               AND ${contactCondition}`,
            [
                notification.notification_id,
                notification.claim_token,
                notification.user_id,
                notification.notification_type,
            ]
        );
        return result.rowCount === 1;
    }

    async function updateClaim(notificationId, claimToken, sql, params) {
        if (typeof notificationId !== "string" || !notificationId ||
            typeof claimToken !== "string" || !claimToken) {
            throw new TypeError("A notification ID and claim token are required.");
        }
        const result = await pool.query(sql, [...params, notificationId, claimToken]);
        if (result.rowCount !== 1) {
            const error = new Error("SMS notification claim is no longer active.");
            error.code = "SMS_CLAIM_LOST";
            throw error;
        }
    }

    function requireErrorCode(errorCode) {
        if (typeof errorCode !== "string" || !ERROR_CODE_PATTERN.test(errorCode)) {
            throw new TypeError("A sanitized SMS error code is required.");
        }
        return errorCode;
    }

    async function markProviderAccepted(notification, { messageId = null, deliveryResult = null }) {
        await updateClaim(
            notification.notification_id,
            notification.claim_token,
            `UPDATE notifications
             SET delivery_status = 'PROVIDER_ACCEPTED',
                 provider_message_id = $1,
                 provider_accepted_at = now(),
                 delivery_result = $2::jsonb,
                 claimed_at = NULL,
                 claim_token = NULL,
                 last_error_code = NULL
             WHERE notification_id = $3
               AND claim_token = $4
               AND delivery_status = 'PROCESSING'`,
            [messageId, deliveryResult === null ? null : JSON.stringify(deliveryResult)]
        );
    }

    async function markFailed(notification, errorCode) {
        requireErrorCode(errorCode);
        await updateClaim(
            notification.notification_id,
            notification.claim_token,
            `UPDATE notifications
             SET delivery_status = 'FAILED',
                 claimed_at = NULL,
                 claim_token = NULL,
                 last_error_code = $1
             WHERE notification_id = $2
               AND claim_token = $3
               AND delivery_status = 'PROCESSING'`,
            [errorCode]
        );
    }

    async function retryRejected(notification, { errorCode, delayMs }) {
        if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
            throw new TypeError("The SMS retry delay must be a non-negative integer.");
        }
        requireErrorCode(errorCode);
        const terminal = notification.attempt_count >= maxAttempts;
        await updateClaim(
            notification.notification_id,
            notification.claim_token,
            `UPDATE notifications
             SET delivery_status = $1,
                 next_attempt_at = CASE
                     WHEN $1 = 'PENDING' THEN now() + ($2 * INTERVAL '1 millisecond')
                     ELSE next_attempt_at
                 END,
                 claimed_at = NULL,
                 claim_token = NULL,
                 last_error_code = $3
             WHERE notification_id = $4
               AND claim_token = $5
               AND delivery_status = 'PROCESSING'`,
            [terminal ? "FAILED" : "PENDING", delayMs, errorCode]
        );
    }

    async function markUnknown(notification, errorCode) {
        requireErrorCode(errorCode);
        await updateClaim(
            notification.notification_id,
            notification.claim_token,
            `UPDATE notifications
             SET delivery_status = 'UNKNOWN',
                 claimed_at = NULL,
                 claim_token = NULL,
                 last_error_code = $1
             WHERE notification_id = $2
               AND claim_token = $3
               AND delivery_status = 'PROCESSING'`,
            [errorCode]
        );
    }

    return {
        claimBatch,
        isClaimEligible,
        markFailed,
        markProviderAccepted,
        markUnknown,
        retryRejected,
    };
}

module.exports = { createSmsNotificationRepository };
