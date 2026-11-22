const { createHash } = require("node:crypto");
const { normalizeKenyanPhone } = require("../utils/kenyanPhone");
const { getFrontendBaseUrl } = require("./authEmailService");
const { normalizeRecipient } = require("./communicationDeliveryPolicy");
const {
    ESSENTIAL_TRANSACTIONAL_EVENT_TYPES,
    NOTIFICATION_EVENT_POLICIES,
    isEssentialTransactionalNotification,
} = require("./notificationEventPolicy");

const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,25}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;
const EVENT_MESSAGES = {
    CONTRIBUTION_SUBMITTED: {
        subject: "Contribution payment request submitted",
        message: "Your contribution payment request has been submitted. Payment is not confirmed until the provider verifies it.",
    },
    CONTRIBUTION_CONFIRMED: {
        subject: "Contribution confirmed",
        message: "Your contribution has been confirmed and added to your account.",
    },
    KYC_VERIFIED: {
        subject: "Identity verification approved",
        message: "Your identity verification was approved. Sign in to view your account status.",
    },
    KYC_REJECTED: {
        subject: "Identity verification needs attention",
        message: "Your identity verification was not approved. Sign in to review your KYC status and contact your fund administrator about correcting and resubmitting your identity information.",
    },
    RETIREMENT_PLAN_SAVED: {
        subject: "Retirement plan saved",
        message: "Your retirement plan has been saved. Sign in to view your updated projection.",
    },
    WITHDRAWAL_SUBMITTED: {
        subject: "Withdrawal request submitted",
        message: "Your withdrawal request has been submitted for review.",
    },
    WITHDRAWAL_APPROVED: {
        subject: "Withdrawal request approved",
        message: "Your withdrawal request has been approved. Approval does not mean payment has been made.",
    },
    WITHDRAWAL_REJECTED: {
        subject: "Withdrawal request declined",
        message: "Your withdrawal request was not approved. Contact your fund manager for more information.",
    },
    WITHDRAWAL_OTP_AUTHORIZED: {
        subject: "Withdrawal authorization verified",
        message: "The payout authorization code was verified. No payout has been made and no funds have been disbursed.",
    },
    PASSWORD_RESET_COMPLETED: {
        subject: "Password reset completed",
        message: "Your MicoPesa password was reset using phone verification. If you did not make this change, contact support.",
    },
};

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    })[character]);
}

async function loadEventDetails(pool, { userId, eventType, referenceId }) {
    if (eventType === "CONTRIBUTION_SUBMITTED") {
        const result = await pool.query(
            `SELECT c.amount::text AS amount, t.transaction_id AS reference
             FROM contributions c
             JOIN transactions t ON t.transaction_id = c.transaction_id
             JOIN pension_accounts pa ON pa.account_id = c.account_id
             WHERE c.contribution_id = $1
               AND pa.user_id = $2
               AND c.channel = 'MPESA'
               AND c.contribution_status = 'PENDING'
               AND t.transaction_status = 'PENDING'`,
            [referenceId, userId]
        );
        return result.rows[0] || null;
    }
    if (eventType === "CONTRIBUTION_CONFIRMED") {
        const result = await pool.query(
            `SELECT c.amount::text AS amount,
                    COALESCE(NULLIF(t.mpesa_receipt, ''), t.transaction_id) AS reference,
                    t.completed_at,
                    pa.current_balance::text AS balance
             FROM contributions c
             JOIN transactions t ON t.transaction_id = c.transaction_id
             JOIN pension_accounts pa ON pa.account_id = c.account_id
             WHERE c.contribution_id = $1
               AND pa.user_id = $2
               AND c.contribution_status = 'COMPLETED'
               AND t.transaction_status = 'COMPLETED'`,
            [referenceId, userId]
        );
        return result.rows[0] || null;
    }
    if ([
        "WITHDRAWAL_SUBMITTED",
        "WITHDRAWAL_APPROVED",
        "WITHDRAWAL_REJECTED",
    ].includes(eventType)) {
        const expectedStatus = {
            WITHDRAWAL_SUBMITTED: "PENDING",
            WITHDRAWAL_APPROVED: "APPROVED",
            WITHDRAWAL_REJECTED: "REJECTED",
        }[eventType];
        const result = await pool.query(
            `SELECT wc.claim_id, wc.amount_requested::text AS amount
             FROM withdrawal_claims wc
             JOIN pension_accounts pa ON pa.account_id = wc.account_id
             WHERE wc.claim_id = $1
               AND pa.user_id = $2
               AND wc.claim_status = $3
               AND wc.transaction_id IS NULL
               AND wc.processed_at IS NULL`,
            [referenceId, userId, expectedStatus]
        );
        return result.rows[0]
            ? { claimId: result.rows[0].claim_id, amount: result.rows[0].amount }
            : null;
    }
    if (eventType === "WITHDRAWAL_OTP_AUTHORIZED") {
        const result = await pool.query(
            `SELECT wc.claim_id, wc.amount_requested::text AS amount
             FROM withdrawal_payout_otp_authorizations otp
             JOIN withdrawal_claims wc ON wc.claim_id = otp.claim_id
             JOIN pension_accounts pa ON pa.account_id = wc.account_id
             WHERE otp.authorization_attempt_id::text = $1
               AND otp.worker_user_id = $2
               AND otp.status = 'VERIFIED'
               AND wc.claim_status = 'APPROVED'
               AND wc.transaction_id IS NULL
               AND wc.processed_at IS NULL`,
            [referenceId, userId]
        );
        return result.rows[0]
            ? { claimId: result.rows[0].claim_id, amount: result.rows[0].amount }
            : null;
    }
    if (eventType === "PASSWORD_RESET_COMPLETED") {
        const result = await pool.query(
            `SELECT 1
             FROM worker_password_reset_challenges
             WHERE challenge_id::text = $1
               AND user_id = $2
               AND challenge_status = 'CONSUMED'`,
            [referenceId, userId]
        );
        return result.rows.length ? {} : null;
    }
    if (eventType === "KYC_VERIFIED" || eventType === "KYC_REJECTED") {
        const expectedStatus = eventType === "KYC_VERIFIED" ? "VERIFIED" : "REJECTED";
        const result = await pool.query(
            `SELECT 1 FROM kyc_records
             WHERE kyc_id = $1 AND user_id = $2 AND kyc_status = $3`,
            [referenceId, userId, expectedStatus]
        );
        return result.rows.length ? {} : null;
    }
    return {};
}

function formatAmount(value) {
    if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
    const [whole, fraction = ""] = value.split(".");
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `KES ${grouped}.${fraction.padEnd(2, "0")}`;
}

function formatTimestamp(value) {
    if (!(value instanceof Date) && typeof value !== "string") return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function renderTransactionalTemplate(eventType, { simulated = false, details = null } = {}) {
    if (simulated && eventType !== "CONTRIBUTION_CONFIRMED") {
        throw new TypeError("Only contribution confirmations can be marked simulated.");
    }
    const eventTemplate = EVENT_MESSAGES[eventType];
    let template = simulated
        ? {
            subject: "Simulated contribution confirmed",
            message: "Your simulated contribution has been confirmed and added to your account. No real money was transferred.",
        }
        : eventTemplate ? { ...eventTemplate } : null;
    if (!template) throw new TypeError("A supported notification event is required.");
    if (eventType === "CONTRIBUTION_SUBMITTED" && details) {
        const amount = formatAmount(details.amount);
        const reference = typeof details.reference === "string" &&
            /^[A-Za-z0-9._-]{1,60}$/.test(details.reference)
            ? details.reference
            : null;
        template.message = [
            "Your contribution payment request has been submitted. Payment is not confirmed until the provider verifies it.",
            amount ? `Amount: ${amount}.` : null,
            reference ? `Payment reference: ${reference}.` : null,
        ].filter(Boolean).join(" ");
    }
    if (!simulated && eventType === "CONTRIBUTION_CONFIRMED" && details) {
        const amount = formatAmount(details.amount);
        const reference = typeof details.reference === "string" &&
            /^[A-Za-z0-9._-]{1,60}$/.test(details.reference)
            ? details.reference
            : null;
        const timestamp = formatTimestamp(details.completed_at);
        const balance = formatAmount(details.balance);
        template.message = [
            "Your contribution has been confirmed and added to your account.",
            amount ? `Amount: ${amount}.` : null,
            reference ? `Transaction reference: ${reference}.` : null,
            timestamp ? `Confirmed at: ${timestamp}.` : null,
            balance ? `Current balance: ${balance}.` : null,
        ].filter(Boolean).join(" ");
    }
    if (eventType.startsWith("WITHDRAWAL_") && details) {
        const amount = formatAmount(details.amount);
        const claim = typeof details.claimId === "string" &&
            /^[A-Za-z0-9_-]{1,25}$/.test(details.claimId)
            ? details.claimId
            : null;
        const amountText = amount ? `Amount: ${amount}.` : "";
        const claimText = claim ? `Request reference: ${claim}.` : "";
        if (eventType === "WITHDRAWAL_SUBMITTED") {
            template.message = `Your withdrawal request has been submitted for review. ${amountText} ${claimText}`.trim();
        } else if (eventType === "WITHDRAWAL_APPROVED") {
            template.message = `Your withdrawal request has been approved. Approval does not mean payment has been made. ${amountText} ${claimText}`.trim();
        } else if (eventType === "WITHDRAWAL_REJECTED") {
            template.message = `Your withdrawal request was not approved. Contact your fund manager for more information. ${amountText} ${claimText}`.trim();
        } else if (eventType === "WITHDRAWAL_OTP_AUTHORIZED") {
            template.message = `The payout authorization code for your withdrawal request was verified. No payout has been made and no funds have been disbursed. ${amountText} ${claimText}`.trim();
        }
    }
    if (eventType === "KYC_REJECTED" && !simulated) {
        template.actionUrl = new URL("/worker/profile#kyc-status", getFrontendBaseUrl()).href;
        template.actionLabel = "Review KYC status and next steps";
    }
    const subject = escapeHtml(template.subject);
    const message = escapeHtml(template.message);
    const action = template.actionUrl
        ? `\n\n${template.actionLabel}: ${template.actionUrl}`
        : "";
    const htmlAction = template.actionUrl
        ? `<p><a href="${escapeHtml(template.actionUrl)}">${escapeHtml(template.actionLabel)}</a></p>`
        : "";
    return {
        subject: template.subject,
        text: `${template.message}${action}`,
        html: [
            "<!doctype html>",
            '<html lang="en"><body style="margin:0;padding:24px;background:#f4f7f6;font-family:Arial,sans-serif;color:#173b35">',
            '<main style="max-width:560px;margin:0 auto;padding:24px;background:#fff;border-radius:12px">',
            '<p style="margin:0 0 16px;color:#087f5b;font-weight:bold">MicoPesa</p>',
            `<h1 style="font-size:20px;line-height:1.4">${subject}</h1>`,
            `<p style="font-size:16px;line-height:1.6">${message}</p>`,
            htmlAction,
            '<p style="margin-top:24px;color:#52635f">Sign in to MicoPesa for more information.</p>',
            "</main></body></html>",
        ].join(""),
    };
}

function createNotificationEventService(pool) {
    if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
        throw new TypeError("A PostgreSQL pool is required for transactional notifications.");
    }

    function validateUserId(userId) {
        if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId)) {
            const error = new TypeError("A valid notification recipient is required.");
            error.code = "NOTIFICATION_INVALID_PREFERENCES";
            error.statusCode = 400;
            throw error;
        }
    }

    async function readPreferences(userId, queryable = pool) {
        const result = await queryable.query(
            `SELECT COALESCE(np.sms_enabled, FALSE) AS sms_enabled,
                    COALESCE(np.email_enabled, FALSE) AS email_enabled,
                    (u.phone IS NOT NULL AND btrim(u.phone) <> '') AS phone_registered,
                    (u.phone_verified_at IS NOT NULL) AS phone_verified,
                    (COALESCE(NULLIF(btrim(u.email), ''), NULLIF(btrim(u.pending_email), ''))
                        IS NOT NULL) AS email_registered,
                    (u.email IS NOT NULL AND btrim(u.email) <> ''
                        AND u.email_verified IS TRUE) AS email_verified,
                    EXISTS (
                        SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = u.user_id
                    ) AS push_enabled
             FROM users u
             LEFT JOIN notification_preferences np ON np.user_id = u.user_id
             WHERE u.user_id = $1`,
            [userId]
        );
        return result.rows[0] || {
            sms_enabled: false,
            email_enabled: false,
            phone_registered: false,
            phone_verified: false,
            email_registered: false,
            email_verified: false,
            push_enabled: false,
        };
    }

    async function getPreferences(userId) {
        validateUserId(userId);
        return readPreferences(userId);
    }

    async function updatePreferences(userId, input) {
        validateUserId(userId);
        if (!input || typeof input !== "object" || Array.isArray(input)) {
            const error = new TypeError("Notification preferences must be an object.");
            error.code = "NOTIFICATION_INVALID_PREFERENCES";
            error.statusCode = 400;
            throw error;
        }
        const hasSms = Object.prototype.hasOwnProperty.call(input, "sms_enabled");
        const hasEmail = Object.prototype.hasOwnProperty.call(input, "email_enabled");
        if ((!hasSms && !hasEmail) ||
            (hasSms && typeof input.sms_enabled !== "boolean") ||
            (hasEmail && typeof input.email_enabled !== "boolean") ||
            Object.keys(input).some((key) => !["sms_enabled", "email_enabled"].includes(key))) {
            const error = new TypeError("Set SMS and/or email preferences to true or false.");
            error.code = "NOTIFICATION_INVALID_PREFERENCES";
            error.statusCode = 400;
            throw error;
        }

        const client = await pool.connect();
        let transactionStarted = false;
        try {
            await client.query("BEGIN");
            transactionStarted = true;
            await client.query(
                `INSERT INTO notification_preferences (user_id, sms_enabled, email_enabled)
                 VALUES ($1, COALESCE($2::boolean, FALSE), COALESCE($3::boolean, FALSE))
                 ON CONFLICT (user_id) DO UPDATE
                 SET sms_enabled = COALESCE($2::boolean, notification_preferences.sms_enabled),
                     email_enabled = COALESCE($3::boolean, notification_preferences.email_enabled),
                     updated_at = now()
                 RETURNING sms_enabled, email_enabled`,
                [userId, hasSms ? input.sms_enabled : null, hasEmail ? input.email_enabled : null]
            );
            const disabledChannels = [
                ...(hasSms && !input.sms_enabled ? ["SMS"] : []),
                ...(hasEmail && !input.email_enabled ? ["EMAIL"] : []),
            ];
            if (disabledChannels.length) {
                await client.query(
                    `UPDATE notifications
                     SET delivery_status = 'FAILED',
                         last_error_code = 'NOTIFICATION_PREFERENCE_DISABLED'
                     WHERE user_id = $1
                       AND notification_type = ANY($2::varchar[])
                       AND delivery_status = 'PENDING'
                       AND (
                           notification_event_type IS NULL
                           OR NOT (notification_event_type = ANY($3::varchar[]))
                       )`,
                    [userId, disabledChannels, ESSENTIAL_TRANSACTIONAL_EVENT_TYPES]
                );
            }
            const preferences = await readPreferences(userId, client);
            await client.query("COMMIT");
            transactionStarted = false;
            return preferences;
        } catch (error) {
            if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async function enqueueEvent({
        userId,
        eventType,
        referenceId,
        suppressExternalDelivery = false,
        simulated = false,
    } = {}) {
        validateUserId(userId);
        if (!Object.prototype.hasOwnProperty.call(EVENT_MESSAGES, eventType) ||
            !Object.prototype.hasOwnProperty.call(NOTIFICATION_EVENT_POLICIES, eventType) ||
            typeof referenceId !== "string" || !REFERENCE_PATTERN.test(referenceId) ||
            typeof suppressExternalDelivery !== "boolean" ||
            typeof simulated !== "boolean" ||
            (simulated && eventType !== "CONTRIBUTION_CONFIRMED")) {
            throw new TypeError("A supported event and reference are required.");
        }

        const details = await loadEventDetails(pool, { userId, eventType, referenceId });
        if (details === null) return { queued: 0 };
        const recipientResult = await pool.query(
            `SELECT u.phone, u.email, u.email_verified, u.phone_verified_at,
                    COALESCE(p.sms_enabled, FALSE) AS sms_enabled,
                    COALESCE(p.email_enabled, FALSE) AS email_enabled
             FROM users u
             LEFT JOIN notification_preferences p ON p.user_id = u.user_id
             WHERE u.user_id = $1
               AND u.account_status = 'ACTIVE'`,
            [userId]
        );
        const recipient = recipientResult.rows[0];
        if (!recipient) return { queued: 0 };

        const template = renderTransactionalTemplate(eventType, { simulated, details });
        const key = createHash("sha256")
            .update(`${userId}\0${eventType}\0${referenceId}`)
            .digest("hex");
        const channels = ["IN_APP"];
        const verifiedPhone = recipient.phone_verified_at
            ? normalizeKenyanPhone(recipient.phone)
            : null;
        const verifiedEmail = recipient.email_verified
            ? normalizeRecipient("EMAIL", recipient.email)
            : null;
        const essential = isEssentialTransactionalNotification(eventType);
        if (!simulated && !suppressExternalDelivery && verifiedPhone &&
            (essential || recipient.sms_enabled)) {
            channels.push("SMS");
        }
        if (!suppressExternalDelivery && verifiedEmail && (essential || recipient.email_enabled)) {
            channels.push("EMAIL");
        }

        const client = await pool.connect();
        let transactionStarted = false;
        let queued = 0;
        const channelErrors = [];
        try {
            await client.query("BEGIN");
            transactionStarted = true;
            for (const channel of channels) {
                const phone = channel === "SMS" ? verifiedPhone : null;
                const email = channel === "EMAIL" ? verifiedEmail : null;
                const subject = channel === "EMAIL" ? template.subject : null;
                const html = channel === "EMAIL" ? template.html : null;
                const savepoint = `notification_channel_${channel.toLowerCase()}`;
                await client.query(`SAVEPOINT ${savepoint}`);
                try {
                    const result = await client.query(
                        `INSERT INTO notifications (
                            user_id, notification_type, message, recipient_phone, recipient_email,
                            email_subject, email_html_body, notification_category, deduplication_key,
                            notification_event_type
                         )
                         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACCOUNT_SERVICE', $8, $9)
                         ON CONFLICT (user_id, notification_type, deduplication_key)
                         WHERE deduplication_key IS NOT NULL
                         DO NOTHING
                         RETURNING notification_id`,
                        [
                            userId,
                            channel,
                            template.text,
                            phone,
                            channel === "EMAIL" ? verifiedEmail : null,
                            subject,
                            html,
                            key,
                            eventType,
                        ]
                    );
                    queued += result.rowCount === 1 ? 1 : 0;
                    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
                } catch (error) {
                    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
                    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
                    channelErrors.push({
                        channel,
                        errorCode: error?.code === "42703" || error?.code === "42P01"
                            ? "NOTIFICATION_SCHEMA_MISMATCH"
                            : "NOTIFICATION_CHANNEL_QUEUE_FAILED",
                    });
                }
            }
            await client.query("COMMIT");
            transactionStarted = false;
            return {
                queued,
                channels,
                ...(channelErrors.length ? { channelErrors } : {}),
            };
        } catch (error) {
            if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    return { enqueueEvent, getPreferences, updatePreferences };
}

let defaultService;
function getDefaultService() {
    if (!defaultService) {
        defaultService = createNotificationEventService(require("../db/database"));
    }
    return defaultService;
}

async function enqueueBusinessNotification(input) {
    return enqueueDefaultBusinessNotification(input);
}

const enqueueDefaultBusinessNotification = createBusinessNotificationEnqueuer(
    getDefaultService,
    console
);

function createBusinessNotificationEnqueuer(serviceProvider, logger = console) {
    if (typeof serviceProvider !== "function" &&
        (!serviceProvider || typeof serviceProvider.enqueueEvent !== "function")) {
        throw new TypeError("A notification event service is required.");
    }
    return async function enqueueWithoutAffectingBusinessResult(input) {
        try {
            const service = typeof serviceProvider === "function"
                ? serviceProvider()
                : serviceProvider;
            if (!service || typeof service.enqueueEvent !== "function") {
                throw new TypeError("A notification event service is required.");
            }
            const result = await service.enqueueEvent(input);
            for (const failure of result.channelErrors || []) {
                logger.error("Business notification channel could not be queued.", {
                    channel: failure.channel,
                    code: failure.errorCode,
                });
            }
            return result;
        } catch (error) {
            const code = typeof error?.code === "string" &&
                /^NOTIFICATION_[A-Z0-9_]{1,60}$/.test(error.code)
                ? error.code
                : "NOTIFICATION_ENQUEUE_FAILED";
            logger.error("Business notification enqueue failed.", { code });
            return { queued: 0 };
        }
    };
}

module.exports = {
    createBusinessNotificationEnqueuer,
    createNotificationEventService,
    EVENT_MESSAGES,
    escapeHtml,
    enqueueBusinessNotification,
    renderTransactionalTemplate,
};
