const SMS_ENDPOINT = "https://api.africastalking.com/version1/messaging";
const REQUEST_TIMEOUT_MS = 10000;
const mobileSasaService = require("./mobileSasaService");
const { assertDevelopmentRecipientAllowed } = require("./communicationDeliveryPolicy");

function getTransactionalSmsProvider(environment = process.env) {
    const configuredProvider = typeof environment.TRANSACTIONAL_SMS_PROVIDER === "string"
        ? environment.TRANSACTIONAL_SMS_PROVIDER.trim().toUpperCase()
        : "";
    const provider = configuredProvider || "AFRICAS_TALKING";
    if (provider !== "AFRICAS_TALKING" && provider !== "MOBILE_SASA") {
        throw createSmsError("The configured transactional SMS provider is unsupported.", "SMS_CONFIGURATION_MISSING");
    }
    return provider;
}

function getAfricaTalkConfigurationStatus(environment) {
    const missingVariables = [];
    const invalidVariables = [];
    const atEnvironment = typeof environment.AT_ENVIRONMENT === "string"
        ? environment.AT_ENVIRONMENT.trim().toLowerCase()
        : "";
    if (atEnvironment !== "production") {
        (atEnvironment ? invalidVariables : missingVariables).push("AT_ENVIRONMENT");
    }
    const username = typeof environment.AT_USERNAME === "string"
        ? environment.AT_USERNAME.trim()
        : "";
    if (!username) missingVariables.push("AT_USERNAME");
    else if (username.toLowerCase() === "sandbox") invalidVariables.push("AT_USERNAME");
    if (typeof environment.AT_API_KEY !== "string" || !environment.AT_API_KEY.trim()) {
        missingVariables.push("AT_API_KEY");
    }
    const available = missingVariables.length === 0 && invalidVariables.length === 0;
    return {
        available,
        errorCode: available
            ? null
            : invalidVariables.length
                ? "SMS_CONFIGURATION_INVALID"
                : "SMS_CONFIGURATION_MISSING",
        missingVariables,
        invalidVariables,
    };
}

function getNotificationSmsConfigurationStatus(provider, environment = process.env) {
    const selectorName = typeof environment.NOTIFICATION_SMS_PROVIDER === "string" &&
        environment.NOTIFICATION_SMS_PROVIDER.trim()
        ? "NOTIFICATION_SMS_PROVIDER"
        : typeof environment.TRANSACTIONAL_SMS_PROVIDER === "string" &&
            environment.TRANSACTIONAL_SMS_PROVIDER.trim()
            ? "TRANSACTIONAL_SMS_PROVIDER"
            : null;
    if (provider === "MOBILE_SASA") {
        return mobileSasaService.getNotificationSmsConfigurationStatus(environment);
    }
    if (provider === "AFRICAS_TALKING") {
        if (environment.NODE_ENV === "development") {
            return {
                available: false,
                errorCode: "SMS_PROVIDER_UNSUPPORTED",
                missingVariables: [],
                invalidVariables: selectorName ? [selectorName] : [],
            };
        }
        return getAfricaTalkConfigurationStatus(environment);
    }
    return {
        available: false,
        errorCode: "SMS_PROVIDER_UNSUPPORTED",
        missingVariables: [],
        invalidVariables: selectorName ? [selectorName] : [],
    };
}

function getPhoneVerificationSmsConfiguration(environment = process.env) {
    if (environment.NODE_ENV === "development") {
        return {
            ...mobileSasaService.getSmsConfigurationStatus(environment, { testOnly: true }),
            mode: "development-test",
            provider: "MOBILE_SASA",
        };
    }
    if (environment.NODE_ENV !== "production") {
        return {
            available: false,
            errorCode: "SMS_ENVIRONMENT_UNSUPPORTED",
            missingVariables: environment.NODE_ENV ? [] : ["NODE_ENV"],
            invalidVariables: environment.NODE_ENV ? ["NODE_ENV"] : [],
            mode: "unsupported",
            provider: null,
        };
    }

    let provider;
    try {
        provider = getTransactionalSmsProvider(environment);
    } catch {
        return {
            available: false,
            errorCode: "SMS_CONFIGURATION_MISSING",
            missingVariables: [],
            invalidVariables: ["TRANSACTIONAL_SMS_PROVIDER"],
            mode: "production-transactional",
            provider: null,
        };
    }
    const status = provider === "MOBILE_SASA"
        ? mobileSasaService.getSmsConfigurationStatus(environment)
        : getAfricaTalkConfigurationStatus(environment);
    return {
        ...status,
        mode: "production-transactional",
        provider,
    };
}

function isPhoneVerificationSmsConfigured(environment = process.env) {
    return getPhoneVerificationSmsConfiguration(environment).available;
}

async function sendPhoneVerificationSms(input, options = {}) {
    const environment = options.environment || process.env;
    const configuration = getPhoneVerificationSmsConfiguration(environment);
    const expectedConfiguration = options.providerConfiguration;
    if (expectedConfiguration?.available &&
        (expectedConfiguration.mode !== configuration.mode ||
            expectedConfiguration.provider !== configuration.provider)) {
        const error = createSmsError(
            "The phone verification SMS provider changed after availability was checked.",
            "SMS_CONFIGURATION_CHANGED"
        );
        error.diagnostics = {
            errorCode: error.code,
            failureCategory: "configuration_failure",
            deliveryOutcomeUnknown: false,
        };
        throw error;
    }
    if (!configuration.available) {
        const error = createSmsError(
            "Phone verification SMS configuration is incomplete or invalid.",
            configuration.errorCode || "SMS_CONFIGURATION_MISSING"
        );
        error.diagnostics = {
            errorCode: error.code,
            errorClass: error.name,
            failureCategory: "configuration_failure",
            deliveryOutcomeUnknown: false,
            missingVariables: configuration.missingVariables,
            invalidVariables: configuration.invalidVariables,
        };
        throw error;
    }
    if (configuration.mode === "development-test") {
        return mobileSasaService.sendPhoneVerificationSms(input, options);
    }
    return sendSms(input, {
        ...options,
        environment,
        provider: configuration.provider,
    });
}

function createSmsError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function normalizeRecipient(value) {
    if (typeof value !== "string") {
        throw createSmsError("A valid Kenyan SMS recipient is required.", "SMS_INVALID_RECIPIENT");
    }

    const compact = value.trim().replace(/[\s()-]/g, "");
    let normalized;
    if (/^0[17]\d{8}$/.test(compact)) normalized = `+254${compact.slice(1)}`;
    else if (/^\+?254[17]\d{8}$/.test(compact)) normalized = `+${compact.replace(/^\+/, "")}`;
    if (!normalized || !/^\+254[17]\d{8}$/.test(normalized)) {
        throw createSmsError("A valid Kenyan SMS recipient is required.", "SMS_INVALID_RECIPIENT");
    }
    return normalized;
}

async function sendSms(
    { to, message, trackingId },
    {
        environment = process.env,
        fetchImpl = global.fetch,
        timeoutMs = REQUEST_TIMEOUT_MS,
        provider = "AFRICAS_TALKING",
        logger = null,
        notificationDelivery = false,
    } = {}
) {
    const recipient = normalizeRecipient(to);
    if (typeof message !== "string" || !message.trim()) {
        throw createSmsError("An SMS message is required.", "SMS_INVALID_MESSAGE");
    }

    const selectedProvider = typeof provider === "string"
        ? provider.trim().toUpperCase()
        : "";
    assertDevelopmentRecipientAllowed("SMS", recipient, environment);
    if (selectedProvider === "MOBILE_SASA") {
        return mobileSasaService.sendSms(
            { to: recipient, message, trackingId },
            { environment, fetchImpl, timeoutMs, logger, notificationDelivery }
        );
    }
    if (selectedProvider !== "AFRICAS_TALKING") {
        throw createSmsError("The configured SMS provider is unsupported.", "SMS_CONFIGURATION_MISSING");
    }
    if (environment.AT_ENVIRONMENT?.trim().toLowerCase() !== "production") {
        throw createSmsError(
            "Africa's Talking production mode must be explicitly configured.",
            "SMS_ENVIRONMENT_MISMATCH"
        );
    }

    const username = environment.AT_USERNAME?.trim();
    const apiKey = environment.AT_API_KEY?.trim();
    if (!username || !apiKey) {
        throw createSmsError("Africa's Talking SMS configuration is missing.", "SMS_CONFIGURATION_MISSING");
    }
    if (username.toLowerCase() === "sandbox") {
        throw createSmsError(
            "Africa's Talking sandbox credentials cannot be used for production SMS.",
            "SMS_SANDBOX_CREDENTIALS"
        );
    }
    if (typeof fetchImpl !== "function") {
        throw createSmsError("SMS delivery is unavailable.", "SMS_CONFIGURATION_MISSING");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw createSmsError("The SMS request timeout is invalid.", "SMS_CONFIGURATION_MISSING");
    }

    const body = new URLSearchParams({ username, to: recipient, message });
    const senderId = environment.AT_SENDER_ID?.trim();
    if (senderId) body.set("from", senderId);

    const controller = new AbortController();
    let timeoutId;
    const request = async () => {
        const response = await fetchImpl(SMS_ENDPOINT, {
            method: "POST",
            headers: {
                apiKey,
                Accept: "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: body.toString(),
            signal: controller.signal,
        });

        if (!response?.ok) {
            if (response?.status === 429) {
                throw createSmsError(
                    "The SMS provider explicitly rejected the request for rate limiting.",
                    "SMS_RETRYABLE_REJECTION"
                );
            }
            const definitivelyRejected =
                Number.isInteger(response?.status) &&
                response.status >= 400 &&
                response.status < 500;
            throw createSmsError(
                definitivelyRejected
                    ? "The SMS provider did not accept the message."
                    : "The SMS provider outcome could not be established.",
                definitivelyRejected ? "SMS_PROVIDER_REJECTED" : "SMS_UNKNOWN_OUTCOME"
            );
        }

        let payload;
        try {
            payload = await response.json();
        } catch {
            throw createSmsError("The SMS provider returned an invalid response.", "SMS_INVALID_RESPONSE");
        }

        const recipients = payload?.SMSMessageData?.Recipients;
        if (!Array.isArray(recipients) ||
            recipients.length !== 1 ||
            typeof recipients[0]?.status !== "string" ||
            (recipients[0].messageId != null && typeof recipients[0].messageId !== "string")) {
            throw createSmsError("The SMS provider returned an invalid response.", "SMS_INVALID_RESPONSE");
        }
        if (recipients[0].status !== "Success") {
            throw createSmsError("The SMS provider did not accept the message.", "SMS_PROVIDER_REJECTED");
        }

        return {
            accepted: true,
            messageId: recipients[0].messageId || null,
            status: "PROVIDER_ACCEPTED",
        };
    };

    try {
        return await Promise.race([
            request(),
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    controller.abort();
                    reject(createSmsError("The SMS provider request timed out.", "SMS_TIMEOUT"));
                }, timeoutMs);
            }),
        ]);
    } catch (cause) {
        if (cause?.code === "SMS_TIMEOUT") throw cause;
        if (typeof cause?.code === "string" && cause.code.startsWith("SMS_")) throw cause;
        throw createSmsError("The SMS provider request failed.", "SMS_NETWORK_ERROR");
    } finally {
        clearTimeout(timeoutId);
    }
}

module.exports = {
    getAfricaTalkConfigurationStatus,
    getNotificationSmsConfigurationStatus,
    getPhoneVerificationSmsConfiguration,
    getTransactionalSmsProvider,
    isPhoneVerificationSmsConfigured,
    sendPhoneVerificationSms,
    sendSms,
    normalizeRecipient,
};
