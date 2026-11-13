const crypto = require("node:crypto");
const pool = require("../db/database");
const mobileSasaService = require("./mobileSasaService");
const smtpEmailTransport = require("./smtpEmailTransport");
const { captureRegistrationEmail, isCaptureModeRequested } = require("./localEmailCapture");

const TOKEN_EXPIRY_MINUTES = {
    EMAIL_VERIFICATION: 30,
    PASSWORD_RESET: 30,
};
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_HEADER_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MOBILE_SASA_DOMAIN_UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EMAIL_TEXT_LENGTH = 5000;
const MAX_EMAIL_HTML_LENGTH = 10000;

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

function getEmailConfiguration(environment = process.env) {
    return smtpEmailTransport.getSmtpConfiguration(environment);
}

function getEmailProvider(environment = process.env) {
    const provider = environment.EMAIL_PROVIDER?.trim().toUpperCase() || "GMAIL";
    if (provider !== "GMAIL" && provider !== "MOBILE_SASA") {
        const error = new Error("The configured email provider is unsupported.");
        error.code = "EMAIL_CONFIGURATION_MISSING";
        throw error;
    }
    return provider;
}

function assertEmailProviderConfigured(environment = process.env) {
    if (getEmailProvider(environment) === "GMAIL") return getEmailConfiguration(environment);
    if (!mobileSasaService.isEmailConfigured(environment)) {
        const error = new Error("Mobile Sasa email configuration is incomplete.");
        error.code = "EMAIL_CONFIGURATION_MISSING";
        const missingVariables = [];
        if (environment.MOBILESASA_EMAIL_ENABLED !== "true") {
            missingVariables.push("MOBILESASA_EMAIL_ENABLED");
        }
        if (typeof environment.MOBILE_SASA_EMAIL_API_TOKEN !== "string" ||
            !environment.MOBILE_SASA_EMAIL_API_TOKEN.trim().startsWith("mbs_")) {
            missingVariables.push("MOBILE_SASA_EMAIL_API_TOKEN");
        }
        if (typeof environment.MOBILE_SASA_EMAIL_FROM !== "string" ||
            !environment.MOBILE_SASA_EMAIL_FROM.trim()) {
            missingVariables.push("MOBILE_SASA_EMAIL_FROM");
        }
        error.missingVariables = missingVariables;
        if (environment.MOBILE_SASA_EMAIL_DOMAIN_UUID &&
            !MOBILE_SASA_DOMAIN_UUID_PATTERN.test(environment.MOBILE_SASA_EMAIL_DOMAIN_UUID.trim())) {
            error.invalidVariables = ["MOBILE_SASA_EMAIL_DOMAIN_UUID"];
        }
        throw error;
    }
    return null;
}

function createEmailTransporter(configuration = getEmailConfiguration()) {
    return smtpEmailTransport.createSmtpTransporter({
        GMAIL_USER: configuration.user,
        GMAIL_APP_PASSWORD: configuration.password,
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
    smtpEmailTransport.logSmtpFailure(purpose, error);
}

async function sendEmailWithTransporter(transporter, {
    to,
    subject,
    text,
    html,
    purpose = "GENERAL",
}) {
    return smtpEmailTransport.sendSmtpEmail({
        to,
        subject,
        text,
        html,
        purpose,
        environment: process.env,
        transporter,
    });
}

function textToHtml(text) {
    const escaped = text.replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    })[character]);
    return `<p>${escaped.replace(/\r?\n/g, "<br>")}</p>`;
}

async function sendEmail({ to, subject, text, html, purpose = "GENERAL" }) {
    if (
        typeof to !== "string" ||
        !EMAIL_PATTERN.test(to) ||
        typeof subject !== "string" ||
        !subject.trim() ||
        subject.length > 255 ||
        EMAIL_HEADER_CONTROL_CHARS.test(subject) ||
        typeof text !== "string" ||
        !text.trim() ||
        text.length > MAX_EMAIL_TEXT_LENGTH ||
        (html !== undefined &&
            (typeof html !== "string" || html.length > MAX_EMAIL_HTML_LENGTH))
    ) {
        const error = new Error("Email message data is invalid.");
        error.code = "EMAIL_INVALID_INPUT";
        throw error;
    }

    if (process.env.MICOPESA_TEST_MODE === "true" && !isCaptureModeRequested()) {
        throw Object.assign(new Error("Test mode requires local email capture."), {
            code: "EMAIL_CAPTURE_REQUIRED",
        });
    }

    if (isCaptureModeRequested()) {
        if (process.env.MICOPESA_EMAIL_CAPTURE !== "true") {
            throw Object.assign(new Error("MICOPESA_EMAIL_CAPTURE must be explicitly set to true."), {
                code: "EMAIL_CAPTURE_NOT_ENABLED",
            });
        }
        return captureRegistrationEmail({ to, subject: subject.trim(), text: text.trim(), html, purpose });
    }

    const provider = getEmailProvider();
    assertEmailProviderConfigured();
    const message = {
        to,
        subject: subject.trim(),
        text: text.trim(),
        ...(typeof html === "string" && html.trim() ? { html } : {}),
        purpose,
    };
    if (provider === "MOBILE_SASA") {
        const result = await mobileSasaService.sendEmail({
            ...message,
            html: message.html || textToHtml(message.text),
        });
        return {
            accepted: true,
            status: "PROVIDER_ACCEPTED",
            messageId: result.messageId || null,
            ...(result.deliveryResult ? { deliveryResult: result.deliveryResult } : {}),
        };
    }
    return smtpEmailTransport.sendSmtpEmail({
        ...message,
        environment: process.env,
    });
}

async function issueEmailToken({ userId, email, purpose }) {
    if (!Object.hasOwn(TOKEN_EXPIRY_MINUTES, purpose)) {
        throw new Error("Unsupported email token purpose");
    }
    if (process.env.MICOPESA_TEST_MODE === "true" && !isCaptureModeRequested()) {
        throw Object.assign(new Error("Test mode requires local email capture."), {
            code: "EMAIL_CAPTURE_REQUIRED",
        });
    }
    if (isCaptureModeRequested()) {
        const error = new Error(
            "Local email capture is restricted to pending registration verification."
        );
        error.code = "EMAIL_CAPTURE_UNSUPPORTED_PURPOSE";
        throw error;
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashOpaque(token);
    const frontendBaseUrl = getFrontendBaseUrl();
    assertEmailProviderConfigured();
    const verification = purpose === "EMAIL_VERIFICATION";
    const link = new URL(verification ? "/verify-email" : "/reset-password", frontendBaseUrl);
    link.searchParams.set("token", token);
    if (verification) link.searchParams.set("flow", "email-verification");
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

async function sendPendingRegistrationEmail({ email, token }) {
    const frontendBaseUrl = getFrontendBaseUrl();
    if (process.env.MICOPESA_TEST_MODE === "true" && !isCaptureModeRequested()) {
        throw Object.assign(new Error("Test mode requires local email capture."), {
            code: "EMAIL_CAPTURE_REQUIRED",
        });
    }
    if (isCaptureModeRequested()) {
        if (process.env.MICOPESA_EMAIL_CAPTURE !== "true") {
            throw Object.assign(new Error("MICOPESA_EMAIL_CAPTURE must be explicitly set to true."), {
                code: "EMAIL_CAPTURE_NOT_ENABLED",
            });
        }
    } else {
        assertEmailProviderConfigured();
    }
    const link = new URL("/verify-email", frontendBaseUrl);
    link.searchParams.set("token", token);
    link.searchParams.set("flow", "registration");
    return sendEmail({
        to: email,
        subject: "Complete your MicoPesa registration",
        purpose: "REGISTRATION_VERIFICATION",
        text: `Complete your MicoPesa registration using this link (expires in 30 minutes):\n${link.href}\n\nIf you did not request this, ignore this email.`,
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
    assertEmailProviderConfigured,
    enforceRequestLimits,
    getEmailConfiguration,
    getEmailProvider,
    hashOpaque,
    hashRateKey,
    issueEmailToken,
    logEmailDeliveryFailure,
    safeSmtpMessage,
    sendPendingRegistrationEmail,
    sendEmail,
    sendEmailWithTransporter,
};
