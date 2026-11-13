const nodemailer = require("nodemailer");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_HEADER_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_EMAIL_TEXT_LENGTH = 5000;
const MAX_EMAIL_HTML_LENGTH = 10000;
const SAFE_SMTP_CODES = new Set([
    "EAUTH",
    "ECONNECTION",
    "ECONNREFUSED",
    "ECONNRESET",
    "EENVELOPE",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EPIPE",
    "ESOCKET",
    "ETIMEDOUT",
    "ETLS",
]);

function getSmtpConfiguration(environment = process.env) {
    const user = typeof environment.GMAIL_USER === "string"
        ? environment.GMAIL_USER.trim().toLowerCase()
        : "";
    const password = typeof environment.GMAIL_APP_PASSWORD === "string"
        ? environment.GMAIL_APP_PASSWORD.replace(/\s/g, "")
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
    if (!EMAIL_PATTERN.test(user)) {
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

function createSmtpTransporter(environment = process.env, createTransport = nodemailer.createTransport) {
    const configuration = getSmtpConfiguration(environment);
    return createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user: configuration.user, pass: configuration.password },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
    });
}

function classifySmtpFailure(error) {
    const smtpCode = typeof error?.smtpCode === "string" &&
        SAFE_SMTP_CODES.has(error.smtpCode) ? error.smtpCode : null;
    const responseCode = Number.isInteger(error?.responseCode) &&
        error.responseCode >= 400 && error.responseCode <= 599
        ? error.responseCode
        : null;
    let failureCategory = "unknown";
    if (error?.code === "EMAIL_SMTP_RECIPIENT_REJECTED") {
        failureCategory = "provider_rejection";
    } else if (smtpCode === "EAUTH" || [534, 535].includes(responseCode)) {
        failureCategory = "authentication_failure";
    } else if (responseCode !== null) {
        failureCategory = "smtp_rejection";
    } else if (smtpCode === "ETIMEDOUT" || error?.name === "TimeoutError") {
        failureCategory = "timeout";
    } else if ([
        "ECONNECTION", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH",
        "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ESOCKET", "ETLS",
    ].includes(smtpCode)) {
        failureCategory = "network_failure";
    }
    return {
        errorClass: typeof error?.name === "string" &&
            /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name)
            ? error.name
            : "Error",
        failureCategory,
        ...(smtpCode ? { smtpCode } : {}),
        ...(responseCode !== null ? { responseCode } : {}),
        deliveryOutcomeUnknown: ![
            "authentication_failure",
            "smtp_rejection",
            "provider_rejection",
        ].includes(failureCategory),
    };
}

function logSmtpFailure(purpose, error, logger = console) {
    if (error?.smtpLogged) return;
    const diagnostic = classifySmtpFailure(error);
    logger.error(JSON.stringify({
        event: "email.smtp.failed",
        purpose,
        ...diagnostic,
    }));
    error.smtpLogged = true;
}

function validateMessage({ to, subject, text, html }) {
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
}

async function sendSmtpEmail({
    to,
    subject,
    text,
    html,
    purpose = "GENERAL",
    environment = process.env,
    transporter,
    logger = console,
}) {
    validateMessage({ to, subject, text, html });
    const configuration = getSmtpConfiguration(environment);
    const smtpTransporter = transporter || createSmtpTransporter(environment);
    let info;
    try {
        info = await smtpTransporter.sendMail({
            from: configuration.user,
            to,
            subject: subject.trim(),
            text: text.trim(),
            ...(typeof html === "string" && html ? { html } : {}),
        });
    } catch (error) {
        error.smtpErrorClass = error.name || "Error";
        error.smtpCode = typeof error.code === "string" &&
            SAFE_SMTP_CODES.has(error.code) ? error.code : undefined;
        error.responseCode = Number.isInteger(error.responseCode) ? error.responseCode : undefined;
        error.code = "EMAIL_SMTP_DELIVERY_FAILED";
        logSmtpFailure(purpose, error, logger);
        throw error;
    }

    const accepted = Array.isArray(info.accepted) &&
        info.accepted.some((address) =>
            String(address).trim().toLowerCase() === to.trim().toLowerCase()
        );
    if (!accepted) {
        const error = new Error("SMTP server did not accept the recipient");
        error.code = "EMAIL_SMTP_RECIPIENT_REJECTED";
        error.responseCode = Number.isInteger(info.responseCode) ? info.responseCode : undefined;
        logSmtpFailure(purpose, error, logger);
        throw error;
    }

    const messageId = typeof info.messageId === "string" ? info.messageId : undefined;
    logger.info?.(JSON.stringify({
        event: "email.smtp.accepted",
        purpose,
        ...(messageId ? { messageId } : {}),
        inboxDelivery: "unconfirmed",
    }));
    return { messageId };
}

module.exports = {
    classifySmtpFailure,
    createSmtpTransporter,
    getSmtpConfiguration,
    logSmtpFailure,
    sendSmtpEmail,
};
