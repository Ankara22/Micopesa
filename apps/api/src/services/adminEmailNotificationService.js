const sanitizeHtml = require("sanitize-html");
const mobileSasaService = require("./mobileSasaService");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEADER_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_HTML_LENGTH = 10000;
const HTML_OPTIONS = {
    allowedTags: [
        "a", "b", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3",
        "hr", "i", "li", "ol", "p", "strong", "u", "ul",
    ],
    allowedAttributes: { a: ["href", "title"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
};

function createEmailError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

async function sendAdminEmail(
    { to, subject, text, html: rawHtml },
    { environment = process.env, emailService } = {}
) {
    if (environment.NODE_ENV !== "production") {
        throw createEmailError("Email notifications are disabled outside production.", "EMAIL_PRODUCTION_ONLY");
    }
    if (environment.EMAIL_NOTIFICATIONS_ENABLED !== "true") {
        throw createEmailError("Admin email notifications are not enabled.", "EMAIL_CONFIGURATION_MISSING");
    }
    if (typeof to !== "string" || !EMAIL_PATTERN.test(to) ||
        typeof subject !== "string" || !subject.trim() || subject.length > 255 ||
        HEADER_CONTROL_CHARS.test(subject) ||
        typeof text !== "string" || !text.trim() || text.length > 5000 ||
        (rawHtml !== undefined &&
            (typeof rawHtml !== "string" || rawHtml.length > MAX_HTML_LENGTH))) {
        throw createEmailError("Email notification data is invalid.", "EMAIL_INVALID_INPUT");
    }

    const selectedProvider = environment.EMAIL_PROVIDER?.trim().toUpperCase() || "GMAIL";
    const service = emailService || (
        selectedProvider === "MOBILE_SASA"
            ? {
                sendEmail: (message) => mobileSasaService.sendEmail(
                    {
                        ...message,
                        html: message.html || textToHtml(message.text),
                    },
                    { environment }
                ),
            }
            : selectedProvider === "GMAIL"
                ? require("./authEmailService")
                : null
    );
    if (!service) {
        throw createEmailError("The configured email provider is unsupported.", "EMAIL_CONFIGURATION_MISSING");
    }
    const html = typeof rawHtml === "string" && rawHtml.trim()
        ? sanitizeHtml(rawHtml, HTML_OPTIONS)
        : undefined;
    const result = await service.sendEmail({
        to,
        subject: subject.trim(),
        text: text.trim(),
        ...(html ? { html } : {}),
        purpose: "ADMIN_NOTIFICATION",
    });
    return {
        accepted: true,
        status: "PROVIDER_ACCEPTED",
        messageId: result.messageId || null,
        ...(result.deliveryResult ? { deliveryResult: result.deliveryResult } : {}),
    };
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

module.exports = { sendAdminEmail, sanitizeAdminEmailHtml: (html) => sanitizeHtml(html, HTML_OPTIONS) };
