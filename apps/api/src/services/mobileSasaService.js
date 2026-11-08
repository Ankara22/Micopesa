const SMS_ENDPOINT = "https://api.mobilesasa.com/v2/send/message";
const EMAIL_ENDPOINT = "https://api.mobilesasa.com/api/v1/email/send";
const REQUEST_TIMEOUT_MS = 10000;
const DOMAIN_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function providerError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function hasConfiguration(environment, tokenName, senderName) {
    const token = typeof environment[tokenName] === "string"
        ? environment[tokenName].trim()
        : "";
    const sender = typeof environment[senderName] === "string"
        ? environment[senderName].trim()
        : "";
    return Boolean(token?.startsWith("mbs_") && sender);
}

function normalizeKenyanSmsRecipient(phone) {
    if (typeof phone !== "string") return null;
    const trimmed = phone.trim();
    if (/^\+254[17]\d{8}$/.test(trimmed)) return trimmed;
    if (/^0[17]\d{8}$/.test(trimmed)) return `+254${trimmed.slice(1)}`;
    if (/^254[17]\d{8}$/.test(trimmed)) return `+${trimmed}`;
    return null;
}

function isSmsConfigured(environment = process.env) {
    return environment.MOBILESASA_SMS_ENABLED === "true" &&
        hasConfiguration(environment, "MOBILE_SASA_SMS_API_TOKEN", "MOBILE_SASA_SMS_SENDER_ID");
}

function isTestSmsConfigured(environment = process.env) {
    return environment.NODE_ENV === "development" &&
        environment.MOBILESASA_TEST_SMS_ENABLED === "true" &&
        environment.MOBILESASA_SMS_ENABLED !== "true" &&
        hasConfiguration(environment, "MOBILE_SASA_SMS_API_TOKEN", "MOBILE_SASA_SMS_SENDER_ID");
}

function isPhoneVerificationSmsConfigured(environment = process.env) {
    return environment.NODE_ENV === "development"
        ? isTestSmsConfigured(environment)
        : environment.NODE_ENV === "production" && isSmsConfigured(environment);
}

function isEmailConfigured(environment = process.env) {
    return environment.MOBILESASA_EMAIL_ENABLED === "true" &&
        hasConfiguration(environment, "MOBILE_SASA_EMAIL_API_TOKEN", "MOBILE_SASA_EMAIL_FROM") &&
        (!environment.MOBILE_SASA_EMAIL_DOMAIN_UUID ||
            DOMAIN_UUID_PATTERN.test(environment.MOBILE_SASA_EMAIL_DOMAIN_UUID.trim()));
}

async function requestJson(url, body, {
    token,
    fetchImpl,
    timeoutMs,
    errorPrefix,
}) {
    if (typeof fetchImpl !== "function") {
        throw providerError("Mobile Sasa delivery is unavailable.", `${errorPrefix}_CONFIGURATION_MISSING`);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw providerError("The provider request timeout is invalid.", `${errorPrefix}_CONFIGURATION_MISSING`);
    }

    const controller = new AbortController();
    let timeoutId;
    try {
        const request = fetchImpl(url, {
            method: "POST",
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        const response = await Promise.race([
            request,
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    controller.abort();
                    reject(providerError(
                        "The Mobile Sasa request timed out.",
                        `${errorPrefix}_TIMEOUT`
                    ));
                }, timeoutMs);
            }),
        ]);
        let payload;
        try {
            payload = await response.json();
        } catch {
            throw providerError(
                "The Mobile Sasa provider returned an invalid response.",
                `${errorPrefix}_INVALID_RESPONSE`
            );
        }
        return { response, payload };
    } catch (error) {
        if (typeof error?.code === "string" && error.code.startsWith(`${errorPrefix}_`)) {
            throw error;
        }
        throw providerError(
            "The Mobile Sasa request outcome could not be established.",
            `${errorPrefix}_UNKNOWN_OUTCOME`
        );
    } finally {
        clearTimeout(timeoutId);
    }
}

async function sendSmsRequest(
    { to, message, trackingId },
    { environment, fetchImpl, timeoutMs },
    { testOnly = false } = {}
) {
    const testModeAllowed = environment.NODE_ENV === "development" &&
        environment.MOBILESASA_TEST_SMS_ENABLED === "true" &&
        environment.MOBILESASA_SMS_ENABLED !== "true";
    if (testOnly ? !testModeAllowed : environment.NODE_ENV !== "production") {
        throw providerError(
            "SMS sending is disabled for this runtime.",
            testOnly ? "SMS_TEST_DISABLED" : "SMS_PRODUCTION_ONLY"
        );
    }
    if (testOnly ? !hasConfiguration(
        environment,
        "MOBILE_SASA_SMS_API_TOKEN",
        "MOBILE_SASA_SMS_SENDER_ID"
    ) : !isSmsConfigured(environment)) {
        throw providerError("Mobile Sasa SMS configuration is missing.", "SMS_CONFIGURATION_MISSING");
    }
    const recipient = testOnly ? normalizeKenyanSmsRecipient(to) : to;
    if (typeof recipient !== "string" || !/^\+254[17]\d{8}$/.test(recipient) ||
        typeof message !== "string" || !message.trim() ||
        typeof trackingId !== "string" || !trackingId.trim() ||
        trackingId.length > 128 || /[\u0000-\u001f\u007f]/.test(trackingId)) {
        throw providerError("Mobile Sasa SMS data is invalid.", "SMS_INVALID_INPUT");
    }

    const { response, payload } = await requestJson(SMS_ENDPOINT, {
        senderID: environment.MOBILE_SASA_SMS_SENDER_ID.trim(),
        phone: recipient,
        message,
        trackingId,
    }, {
        token: environment.MOBILE_SASA_SMS_API_TOKEN.trim(),
        fetchImpl,
        timeoutMs,
        errorPrefix: "SMS",
    });

    if (response.status === 429) {
        throw providerError(
            "The Mobile Sasa provider explicitly rate-limited the request.",
            "SMS_RETRYABLE_REJECTION"
        );
    }
    if (!response.ok) {
        throw providerError(
            response.status >= 400 && response.status < 500
                ? "The Mobile Sasa provider did not accept the message."
                : "The Mobile Sasa request outcome could not be established.",
            response.status >= 400 && response.status < 500
                ? "SMS_PROVIDER_REJECTED"
                : "SMS_UNKNOWN_OUTCOME"
        );
    }
    if (payload?.responseCode === "0409") {
        throw providerError(
            "The Mobile Sasa provider reported a possible duplicate message.",
            "SMS_UNKNOWN_OUTCOME"
        );
    }
    if (payload?.status !== true || payload?.responseCode !== "0200") {
        throw providerError(
            payload?.status === false
                ? "The Mobile Sasa provider did not accept the message."
                : "The Mobile Sasa provider returned an invalid response.",
            payload?.status === false ? "SMS_PROVIDER_REJECTED" : "SMS_INVALID_RESPONSE"
        );
    }
    if (
        typeof payload.messageId !== "string" ||
        !payload.messageId.trim() ||
        payload.messageId.length > 128 ||
        !Number.isSafeInteger(payload.cost) ||
        payload.cost < 0
    ) {
        throw providerError("The Mobile Sasa provider returned an invalid response.", "SMS_INVALID_RESPONSE");
    }

    return {
        accepted: true,
        status: "PROVIDER_ACCEPTED",
        messageId: payload.messageId,
        deliveryResult: {
            provider: "MOBILE_SASA",
            responseCode: payload.responseCode,
            trackingId,
            smsParts: payload.cost,
        },
    };
}

async function sendSms(
    input,
    {
        environment = process.env,
        fetchImpl = global.fetch,
        timeoutMs = REQUEST_TIMEOUT_MS,
    } = {}
) {
    return sendSmsRequest(input, { environment, fetchImpl, timeoutMs });
}

async function sendPhoneVerificationSms(
    input,
    {
        environment = process.env,
        fetchImpl = global.fetch,
        timeoutMs = REQUEST_TIMEOUT_MS,
    } = {}
) {
    const developmentOnly = environment.NODE_ENV === "development";
    return sendSmsRequest(
        input,
        { environment, fetchImpl, timeoutMs },
        { testOnly: developmentOnly }
    );
}

const ADMIN_TEST_SMS_MESSAGE =
    "MicoPesa test notification: Your SMS notification service is working. This is a test message. No payment has been made.";

async function sendTestSms(
    { to, trackingId },
    {
        environment = process.env,
        fetchImpl = global.fetch,
        timeoutMs = REQUEST_TIMEOUT_MS,
    } = {}
) {
    return sendSmsRequest(
        { to, trackingId, message: ADMIN_TEST_SMS_MESSAGE },
        { environment, fetchImpl, timeoutMs },
        { testOnly: true }
    );
}

async function sendEmail(
    { to, subject, text, html },
    {
        environment = process.env,
        fetchImpl = global.fetch,
        timeoutMs = REQUEST_TIMEOUT_MS,
    } = {}
) {
    if (environment.NODE_ENV !== "production") {
        throw providerError(
            "Email sending is disabled outside the production runtime.",
            "EMAIL_PRODUCTION_ONLY"
        );
    }
    if (!isEmailConfigured(environment)) {
        throw providerError("Mobile Sasa email configuration is missing.", "EMAIL_CONFIGURATION_MISSING");
    }
    if (typeof to !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) ||
        typeof subject !== "string" || !subject.trim() ||
        typeof text !== "string" || !text.trim() ||
        typeof html !== "string" || !html.trim()) {
        throw providerError("Mobile Sasa email data is invalid.", "EMAIL_INVALID_INPUT");
    }

    const domainUuid = environment.MOBILE_SASA_EMAIL_DOMAIN_UUID?.trim();
    if (domainUuid && !DOMAIN_UUID_PATTERN.test(domainUuid)) {
        throw providerError("Mobile Sasa email domain configuration is invalid.", "EMAIL_CONFIGURATION_MISSING");
    }
    const { response, payload } = await requestJson(EMAIL_ENDPOINT, {
        to: [to],
        subject,
        text,
        html,
        from: environment.MOBILE_SASA_EMAIL_FROM.trim(),
        ...(domainUuid ? { domain_uuid: domainUuid } : {}),
    }, {
        token: environment.MOBILE_SASA_EMAIL_API_TOKEN.trim(),
        fetchImpl,
        timeoutMs,
        errorPrefix: "EMAIL",
    });

    if (!response.ok) {
        throw providerError(
            response.status >= 400 && response.status < 500
                ? "The Mobile Sasa provider did not accept the email."
                : "The Mobile Sasa email outcome could not be established.",
            response.status >= 400 && response.status < 500
                ? "EMAIL_PROVIDER_REJECTED"
                : "EMAIL_UNKNOWN_OUTCOME"
        );
    }
    const data = payload?.data;
    if (
        payload?.success !== true ||
        !data ||
        !Number.isInteger(data.accepted) || data.accepted < 0 ||
        !Number.isInteger(data.suppressed) || data.suppressed < 0 ||
        !Number.isInteger(data.failed) || data.failed < 0
    ) {
        throw providerError(
            "The Mobile Sasa provider returned an invalid response.",
            "EMAIL_INVALID_RESPONSE"
        );
    }
    if (data.accepted !== 1) {
        throw providerError(
            data.suppressed === 1
                ? "The Mobile Sasa provider suppressed the recipient."
                : "The Mobile Sasa provider did not accept the email.",
            data.suppressed === 1 ? "EMAIL_SUPPRESSED" : "EMAIL_PROVIDER_REJECTED"
        );
    }

    return {
        accepted: true,
        status: "PROVIDER_ACCEPTED",
        messageId: null,
        deliveryResult: {
            provider: "MOBILE_SASA",
            accepted: data.accepted,
            suppressed: data.suppressed,
            failed: data.failed,
        },
    };
}

module.exports = {
    isEmailConfigured,
    isPhoneVerificationSmsConfigured,
    isSmsConfigured,
    isTestSmsConfigured,
    sendEmail,
    sendPhoneVerificationSms,
    sendSms,
    sendTestSms,
};
