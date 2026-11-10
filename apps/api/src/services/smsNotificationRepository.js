const { randomUUID } = require("node:crypto");
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
                               push_title, message, attempt_count, claim_token`,
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
             WHERE notification_id = $2
               AND claim_token = $3
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
        markFailed,
        markProviderAccepted,
        markUnknown,
        retryRejected,
    };
}

module.exports = { createSmsNotificationRepository };
