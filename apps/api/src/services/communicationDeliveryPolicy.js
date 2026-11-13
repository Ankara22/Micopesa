const { normalizeKenyanPhone } = require("../utils/kenyanPhone");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeRecipient(channel, value) {
    if (channel === "SMS") return normalizeKenyanPhone(value);
    if (channel === "EMAIL" && typeof value === "string") {
        const email = value.trim().toLowerCase();
        return EMAIL_PATTERN.test(email) ? email : null;
    }
    return null;
}

function isDevelopmentDeliveryRuntime(environment = process.env) {
    return !environment.NODE_ENV || environment.NODE_ENV === "development";
}

function allowlistEnvironmentName(channel) {
    return channel === "SMS"
        ? "COMMUNICATIONS_DEV_ALLOWED_PHONES"
        : "COMMUNICATIONS_DEV_ALLOWED_EMAILS";
}

function parseAllowlist(channel, environment = process.env) {
    const name = allowlistEnvironmentName(channel);
    const configured = typeof environment[name] === "string" ? environment[name] : "";
    return [...new Set(configured.split(",")
        .map((value) => normalizeRecipient(channel, value))
        .filter(Boolean))];
}

function developmentChannelEnabled(channel, environment = process.env) {
    return isDevelopmentDeliveryRuntime(environment) &&
        environment.COMMUNICATIONS_DEV_DELIVERY_ENABLED === "true" &&
        environment[`COMMUNICATIONS_DEV_${channel}_ENABLED`] === "true";
}

function isDevelopmentChannelConfigured(channel, environment = process.env) {
    return developmentChannelEnabled(channel, environment) &&
        parseAllowlist(channel, environment).length > 0;
}

function createDeliveryError(channel, code, message) {
    const error = new Error(message);
    error.code = `${channel}_${code}`;
    error.diagnostics = {
        errorCode: error.code,
        errorClass: error.name,
        requestStarted: false,
        httpResponseReceived: false,
        httpStatus: null,
        responseCode: null,
        failureCategory: "configuration_failure",
        deliveryOutcomeUnknown: false,
    };
    return error;
}

function assertDevelopmentRecipientAllowed(channel, value, environment = process.env) {
    if (environment.NODE_ENV === "production") return;
    if (!isDevelopmentDeliveryRuntime(environment)) {
        throw createDeliveryError(
            channel,
            "PRODUCTION_ONLY",
            `${channel} notifications are disabled outside production or explicitly enabled development delivery.`
        );
    }
    if (!developmentChannelEnabled(channel, environment)) {
        throw createDeliveryError(
            channel,
            "DEVELOPMENT_DELIVERY_DISABLED",
            `${channel} development delivery is not enabled.`
        );
    }

    const allowlist = parseAllowlist(channel, environment);
    if (!allowlist.length) {
        throw createDeliveryError(
            channel,
            "DEVELOPMENT_ALLOWLIST_EMPTY",
            `${channel} development delivery has no valid allowlisted recipients.`
        );
    }

    const recipient = normalizeRecipient(channel, value);
    if (!recipient) {
        throw createDeliveryError(channel, "INVALID_RECIPIENT", `A valid ${channel} recipient is required.`);
    }
    if (!allowlist.includes(recipient)) {
        throw createDeliveryError(
            channel,
            "DEVELOPMENT_RECIPIENT_NOT_ALLOWED",
            `${channel} development delivery is restricted to allowlisted recipients.`
        );
    }
}

module.exports = {
    assertDevelopmentRecipientAllowed,
    developmentChannelEnabled,
    isDevelopmentDeliveryRuntime,
    isDevelopmentChannelConfigured,
    normalizeRecipient,
    parseAllowlist,
};
