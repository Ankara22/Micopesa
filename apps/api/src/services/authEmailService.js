const crypto = require("node:crypto");
const nodemailer = require("nodemailer");
const pool = require("../db/database");

const TOKEN_EXPIRY_MINUTES = {
    EMAIL_VERIFICATION: 30,
    PASSWORD_RESET: 30,
};

function hashOpaque(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function hashRateKey(value) {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET is not configured");
    return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function getFrontendBaseUrl() {
    const configured = process.env.FRONTEND_BASE_URL;
    if (!configured) {
        const error = new Error("Frontend URL is not configured for email links");
        error.code = "EMAIL_LINK_CONFIGURATION_MISSING";
        error.missingVariables = ["FRONTEND_BASE_URL"];
        throw error;
    }
    let url;
    try {
        url = new URL(configured);
    } catch {
        const error = new Error("Frontend URL configuration is invalid");
        error.code = "EMAIL_LINK_CONFIGURATION_INVALID";
        error.invalidVariables = ["FRONTEND_BASE_URL"];
        throw error;
    }
    if (
        (process.env.NODE_ENV === "production" && url.protocol !== "https:") ||
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
    ) {
        const error = new Error("Frontend URL configuration must be a trusted HTTP(S) base URL");
        error.code = "EMAIL_LINK_CONFIGURATION_INVALID";
        error.invalidVariables = ["FRONTEND_BASE_URL"];
        throw error;
    }
    return url.origin;
}

function getEmailConfiguration() {
    const user = typeof process.env.GMAIL_USER === "string"
        ? process.env.GMAIL_USER.trim().toLowerCase()
        : "";
    const password = typeof process.env.GMAIL_APP_PASSWORD === "string"
        ? process.env.GMAIL_APP_PASSWORD.replace(/\s/g, "")
        : "";
    const missingVariables = [];
    if (!user) missingVariables.push("GMAIL_USER");
    if (!password) missingVariables.push("GMAIL_APP_PASSWORD");
    if (missingVariables.length) {
        const error = new Error("Gmail SMTP configuration is incomplete");
        error.code = "EMAIL_SMTP_CONFIGURATION_MISSING";
        error.missingVariables = missingVariables;
        throw error;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) {
        const error = new Error("Gmail SMTP username is invalid");
        error.code = "EMAIL_SMTP_CONFIGURATION_INVALID";
        error.invalidVariables = ["GMAIL_USER"];
        throw error;
    }
    if (!/^[A-Za-z0-9]{16}$/.test(password)) {
        const error = new Error("Gmail app password format is invalid");
        error.code = "EMAIL_SMTP_CONFIGURATION_INVALID";
        error.invalidVariables = ["GMAIL_APP_PASSWORD"];
        throw error;
    }
    return { user, password };
}

function createEmailTransporter(configuration = getEmailConfiguration()) {
    return nodemailer.createTransport({
        service: "gmail",
        auth: { user: configuration.user, pass: configuration.password },
    });
}

function safeSmtpMessage(error) {
    if (typeof error?.message !== "string") return undefined;
    let message = error.message;
    for (const secret of [
        process.env.GMAIL_APP_PASSWORD,
        process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, ""),
    ]) {
        if (secret) message = message.split(secret).join("[redacted-secret]");
    }
    return message
        .replace(/https?:\/\/\S+/gi, "[redacted-url]")
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
        .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted-token]")
        .slice(0, 300);
}

function logEmailDeliveryFailure(purpose, error) {
    console.error(JSON.stringify({
        event: "email.smtp.failed",
        purpose,
        errorClass: error?.smtpErrorClass || error?.name || "Error",
        smtpCode: typeof error?.smtpCode === "string"
            ? error.smtpCode
            : typeof error?.code === "string" ? error.code : undefined,
        responseCode: Number.isInteger(error?.responseCode) ? error.responseCode : undefined,
        ...((error?.smtpMessage || safeSmtpMessage(error))
            ? { diagnostic: error.smtpMessage || safeSmtpMessage(error) }
            : {}),
    }));
}

async function sendEmailWithTransporter(transporter, { to, subject, text, purpose = "GENERAL" }) {
    const sender = getEmailConfiguration().user;
    let info;
    try {
        info = await transporter.sendMail({ from: sender, to, subject, text });
    } catch (error) {
        error.smtpErrorClass = error.name || "Error";
        error.smtpCode = typeof error.code === "string" ? error.code : undefined;
        error.smtpMessage = safeSmtpMessage(error);
        error.code = "EMAIL_SMTP_DELIVERY_FAILED";
        throw error;
    }
    const accepted = Array.isArray(info.accepted)
        && info.accepted.some((address) => String(address).trim().toLowerCase() === to.trim().toLowerCase());
    if (!accepted) {
        const error = new Error("SMTP server did not accept the recipient");
        error.code = "EMAIL_SMTP_RECIPIENT_REJECTED";
        throw error;
    }
    const messageId = typeof info.messageId === "string" ? info.messageId : undefined;
    console.info(JSON.stringify({
        event: "email.smtp.accepted",
        purpose,
        ...(messageId ? { messageId } : {}),
        inboxDelivery: "unconfirmed",
    }));
    return { messageId };
}

async function sendEmail({ to, subject, text, purpose = "GENERAL" }) {
    const transporter = createEmailTransporter();
    return sendEmailWithTransporter(transporter, { to, subject, text, purpose });
}

async function issueEmailToken({ userId, email, purpose }) {
    if (!Object.hasOwn(TOKEN_EXPIRY_MINUTES, purpose)) {
        throw new Error("Unsupported email token purpose");
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashOpaque(token);
    const frontendBaseUrl = getFrontendBaseUrl();
    getEmailConfiguration();
    const verification = purpose === "EMAIL_VERIFICATION";
    const link = new URL(verification ? "/verify-email" : "/reset-password", frontendBaseUrl);
    link.searchParams.set("token", token);
    await pool.query(
        `UPDATE auth_tokens SET consumed_at = now()
         WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL`,
        [userId, purpose]
    );
    await pool.query(
        `INSERT INTO auth_tokens (user_id, purpose, email_address, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 minute'))`,
        [userId, purpose, email, tokenHash, TOKEN_EXPIRY_MINUTES[purpose]]
    );
    return sendEmail({
        to: email,
        subject: verification ? "Verify your MicoPesa email" : "Reset your MicoPesa password",
        purpose,
        text: verification
            ? `Verify your email address using this link (expires in 30 minutes): ${link.href}`
            : `Reset your password using this link (expires in 30 minutes): ${link.href}`,
    });
}

async function enforceRateLimit({ scope, action, key, limit, windowMinutes = 60 }) {
    const keyHash = hashRateKey(`${scope}:${key}`);
    const result = await pool.query(
        `INSERT INTO auth_rate_limits
            (scope, action, key_hash, window_started_at, request_count)
         VALUES ($1, $2, $3, date_trunc('minute', now()), 1)
         ON CONFLICT (scope, action, key_hash) DO UPDATE SET
            request_count = CASE
                WHEN auth_rate_limits.window_started_at <= now() - ($4 * interval '1 minute') THEN 1
                ELSE auth_rate_limits.request_count + 1
            END,
            window_started_at = CASE
                WHEN auth_rate_limits.window_started_at <= now() - ($4 * interval '1 minute')
                    THEN date_trunc('minute', now())
                ELSE auth_rate_limits.window_started_at
            END
         RETURNING request_count`,
        [scope, action, keyHash, windowMinutes]
    );
    if (result.rows[0].request_count > limit) {
        const error = new Error("Too many requests. Please try again later.");
        error.status = 429;
        throw error;
    }
}

async function enforceRequestLimits({ req, action, email, userId }) {
    await enforceRateLimit({
        scope: "IP",
        action,
        key: req.ip || req.socket?.remoteAddress || "unknown",
        limit: 20,
    });
    if (email) {
        await enforceRateLimit({ scope: "EMAIL", action, key: email, limit: 5 });
    }
    if (userId) {
        await enforceRateLimit({ scope: "ACCOUNT", action, key: userId, limit: 5 });
    }
}

module.exports = {
    createEmailTransporter,
    enforceRequestLimits,
    getEmailConfiguration,
    hashOpaque,
    hashRateKey,
    issueEmailToken,
    logEmailDeliveryFailure,
    safeSmtpMessage,
    sendEmail,
    sendEmailWithTransporter,
};
