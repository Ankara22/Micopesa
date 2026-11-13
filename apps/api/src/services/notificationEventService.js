const { createHash } = require("node:crypto");
const { normalizeKenyanPhone } = require("../utils/kenyanPhone");

const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,25}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;
const EVENT_MESSAGES = {
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
        message: "Your identity verification was not approved. Sign in to view next steps.",
    },
    RETIREMENT_PLAN_SAVED: {
        subject: "Retirement plan saved",
        message: "Your retirement plan has been saved. Sign in to view your updated projection.",
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

function renderTransactionalTemplate(eventType) {
    const template = EVENT_MESSAGES[eventType];
    if (!template) throw new TypeError("A supported notification event is required.");
    const subject = escapeHtml(template.subject);
    const message = escapeHtml(template.message);
    return {
        subject: template.subject,
        text: template.message,
        html: [
            "<!doctype html>",
            '<html lang="en"><body style="margin:0;padding:24px;background:#f4f7f6;font-family:Arial,sans-serif;color:#173b35">',
            '<main style="max-width:560px;margin:0 auto;padding:24px;background:#fff;border-radius:12px">',
            '<p style="margin:0 0 16px;color:#087f5b;font-weight:bold">MicoPesa</p>',
            `<h1 style="font-size:20px;line-height:1.4">${subject}</h1>`,
            `<p style="font-size:16px;line-height:1.6">${message}</p>`,
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

    async function getPreferences(userId) {
        validateUserId(userId);
        const result = await pool.query(
            `SELECT sms_enabled, email_enabled
             FROM notification_preferences
             WHERE user_id = $1`,
            [userId]
        );
        return result.rows[0] || { sms_enabled: false, email_enabled: false };
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
            const result = await client.query(
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
                       AND delivery_status = 'PENDING'`,
                    [userId, disabledChannels]
                );
            }
            await client.query("COMMIT");
            transactionStarted = false;
            return result.rows[0];
        } catch (error) {
            if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async function enqueueEvent({ userId, eventType, referenceId } = {}) {
        validateUserId(userId);
        if (!Object.prototype.hasOwnProperty.call(EVENT_MESSAGES, eventType) ||
            typeof referenceId !== "string" || !REFERENCE_PATTERN.test(referenceId)) {
            throw new TypeError("A supported event and reference are required.");
        }

        const recipientResult = await pool.query(
            `SELECT u.phone, u.email, u.email_verified, u.phone_verified_at,
                    COALESCE(p.sms_enabled, FALSE) AS sms_enabled,
                    COALESCE(p.email_enabled, FALSE) AS email_enabled
             FROM users u
             LEFT JOIN notification_preferences p ON p.user_id = u.user_id
             WHERE u.user_id = $1 AND u.account_status = 'ACTIVE'`,
            [userId]
        );
        const recipient = recipientResult.rows[0];
        if (!recipient) return { queued: 0 };

        const template = renderTransactionalTemplate(eventType);
        const key = createHash("sha256")
            .update(`${userId}\0${eventType}\0${referenceId}`)
            .digest("hex");
        const channels = ["IN_APP"];
        const verifiedPhone = recipient.phone_verified_at
            ? normalizeKenyanPhone(recipient.phone)
            : null;
        if (recipient.sms_enabled && verifiedPhone) {
            channels.push("SMS");
        }
        if (recipient.email_enabled && recipient.email_verified && recipient.email) {
            channels.push("EMAIL");
        }

        const client = await pool.connect();
        let transactionStarted = false;
        let queued = 0;
        try {
            await client.query("BEGIN");
            transactionStarted = true;
            for (const channel of channels) {
                const phone = channel === "SMS" ? verifiedPhone : null;
                const email = channel === "EMAIL" ? recipient.email : null;
                const subject = channel === "EMAIL" ? template.subject : null;
                const html = channel === "EMAIL" ? template.html : null;
                const result = await client.query(
                    `INSERT INTO notifications (
                        user_id, notification_type, message, recipient_phone, recipient_email,
                        email_subject, email_html_body, notification_category, deduplication_key
                     )
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACCOUNT_SERVICE', $8)
                     ON CONFLICT (user_id, notification_type, deduplication_key)
                     WHERE deduplication_key IS NOT NULL
                     DO NOTHING
                     RETURNING notification_id`,
                    [userId, channel, template.text, phone, email, subject, html, key]
                );
                queued += result.rowCount === 1 ? 1 : 0;
            }
            await client.query("COMMIT");
            transactionStarted = false;
            return { queued, channels };
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
            return await service.enqueueEvent(input);
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
    escapeHtml,
    enqueueBusinessNotification,
    renderTransactionalTemplate,
};
