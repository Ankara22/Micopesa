const SMS_ENDPOINT = "https://api.africastalking.com/version1/messaging";
const REQUEST_TIMEOUT_MS = 10000;
const mobileSasaService = require("./mobileSasaService");
const { assertDevelopmentRecipientAllowed } = require("./communicationDeliveryPolicy");

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
            { environment, fetchImpl, timeoutMs, logger }
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

module.exports = { sendSms, normalizeRecipient };
