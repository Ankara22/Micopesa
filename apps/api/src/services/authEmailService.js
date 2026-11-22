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
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const isLocalhost = hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname === "::1" ||
        /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (
        (process.env.NODE_ENV === "production" && url.protocol !== "https:") ||
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        (process.env.NODE_ENV === "production" && isLocalhost)
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

function actionEmailHtml({ heading, message, link, actionLabel, footer }) {
    const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    })[character]);
    return [
        "<!doctype html>",
        '<html lang="en"><body style="margin:0;padding:24px;background:#f4f7f6;font-family:Arial,sans-serif;color:#173b35">',
        '<main style="max-width:560px;margin:0 auto;padding:24px;background:#fff;border-radius:12px">',
        '<p style="margin:0 0 16px;color:#087f5b;font-weight:bold">MicoPesa</p>',
        `<h1 style="font-size:20px;line-height:1.4">${escapeHtml(heading)}</h1>`,
        `<p style="font-size:16px;line-height:1.6">${escapeHtml(message)}</p>`,
        `<p><a href="${escapeHtml(link)}">${escapeHtml(actionLabel)}</a></p>`,
        `<p style="font-size:14px;line-height:1.6">${escapeHtml(footer)}</p>`,
        "</main></body></html>",
    ].join("");
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

async function issueEmailToken({ userId, email, purpose, invitation = false }) {
    if (!Object.hasOwn(TOKEN_EXPIRY_MINUTES, purpose)) {
        throw new Error("Unsupported email token purpose");
    }
    if (invitation && purpose !== "EMAIL_VERIFICATION") {
        throw new Error("Staff invitations require an email-verification token");
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
    const heading = invitation
        ? "Complete your MicoPesa staff onboarding"
        : verification ? "Verify your MicoPesa email" : "Reset your MicoPesa password";
    const actionLabel = verification ? "Verify email address" : "Reset password";
    const intro = invitation
        ? "An administrator created a MicoPesa staff account for you. Verify this email address to complete onboarding. Your temporary password was submitted to the SMS provider separately; delivery to your phone is not confirmed. You will be asked to change it at first sign-in."
        : verification
            ? "Verify your email address to complete your MicoPesa account setup."
            : "Use the link below to reset your MicoPesa password.";
    const footer = verification
        ? "This link expires in 30 minutes. If you did not request this, you can ignore this email."
        : "This link expires in 30 minutes.";
    const text = `${intro}\n\n${actionLabel}: ${link.href}\n\n${footer}`;
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
        subject: invitation ? "Complete your MicoPesa staff onboarding"
            : verification ? "Verify your MicoPesa email" : "Reset your MicoPesa password",
        purpose,
        text,
        html: actionEmailHtml({
            heading,
            message: intro,
            link: link.href,
            actionLabel,
            footer,
        }),
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
    const message = "Complete your MicoPesa registration by verifying your email address.";
    const footer = "This link expires in 30 minutes. If you did not request this, you can ignore this email.";
    return sendEmail({
        to: email,
        subject: "Complete your MicoPesa registration",
        purpose: "REGISTRATION_VERIFICATION",
        text: `${message}\n\nVerify email address: ${link.href}\n\n${footer}`,
        html: actionEmailHtml({
            heading: "Complete your MicoPesa registration",
            message,
            link: link.href,
            actionLabel: "Verify email address",
            footer,
        }),
    });
}

async function resendPendingRegistrationEmail({ email }) {
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashOpaque(token);
    const client = await pool.connect();
    let transactionStarted = false;
    try {
        await client.query("BEGIN");
        transactionStarted = true;
        const pending = await client.query(
            `SELECT pending_registration_id
             FROM pending_registrations
             WHERE lower(email) = lower($1) AND expires_at > now()
             FOR UPDATE`,
            [email]
        );
        if (!pending.rows[0]) {
            await client.query("ROLLBACK");
            transactionStarted = false;
            return { accepted: false };
        }
        await client.query(
            `UPDATE pending_registrations
             SET token_hash = $1, expires_at = now() + interval '30 minutes'
             WHERE pending_registration_id = $2`,
            [tokenHash, pending.rows[0].pending_registration_id]
        );
        await client.query("COMMIT");
        transactionStarted = false;
    } catch (error) {
        if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }

    await module.exports.sendPendingRegistrationEmail({ email, token });
    return { accepted: true };
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

async function enforceRequestLimits({ req, action, email, phone, userId }) {
    await enforceRateLimit({
        scope: "IP",
        action,
        key: req.ip || req.socket?.remoteAddress || "unknown",
        limit: 20,
    });
    if (email) {
        await enforceRateLimit({ scope: "EMAIL", action, key: email, limit: 5 });
    }
    if (phone) {
        await enforceRateLimit({ scope: "PHONE", action, key: phone, limit: 5 });
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
    getFrontendBaseUrl,
    hashOpaque,
    hashRateKey,
    issueEmailToken,
    logEmailDeliveryFailure,
    resendPendingRegistrationEmail,
    safeSmtpMessage,
    sendPendingRegistrationEmail,
    sendEmail,
    sendEmailWithTransporter,
};
