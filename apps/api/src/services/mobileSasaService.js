const SMS_ENDPOINT = "https://api.mobilesasa.com/v1/send/message";
const EMAIL_ENDPOINT = "https://api.mobilesasa.com/api/v1/email/send";
const REQUEST_TIMEOUT_MS = 10000;
const DOMAIN_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const {
    assertDevelopmentRecipientAllowed,
    isDevelopmentDeliveryRuntime,
} = require("./communicationDeliveryPolicy");

function providerError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function sanitizeResponseCode(value) {
    return typeof value === "string" && /^\d{4,6}$/.test(value) ? value : null;
}

function logSmsDiagnostic(logger, event, details) {
    if (typeof logger?.info !== "function") return;
    logger.info(JSON.stringify({
        event,
        provider: "MOBILE_SASA",
        ...details,
    }));
}

function smsFailure(message, code, details) {
    const error = providerError(message, code);
    error.diagnostics = {
        errorCode: code,
        errorClass: error.name,
        ...details,
    };
    return error;
}

function safeErrorClass(error) {
    const name = error?.name;
    return typeof name === "string" &&
        /^(Error|TypeError|AbortError|FetchError|AggregateError|RangeError|SyntaxError)$/.test(name)
        ? name
        : "Error";
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

function getSmsConfiguration(environment) {
    const canonicalToken = typeof environment.MOBILESASA_TOKEN === "string"
        ? environment.MOBILESASA_TOKEN.trim()
        : "";
    const legacyToken = typeof environment.MOBILE_SASA_SMS_API_TOKEN === "string"
        ? environment.MOBILE_SASA_SMS_API_TOKEN.trim()
        : "";
    const canonicalSender = typeof environment.MOBILESASA_SENDER_ID === "string"
        ? environment.MOBILESASA_SENDER_ID.trim()
        : "";
    const legacySender = typeof environment.MOBILE_SASA_SMS_SENDER_ID === "string"
        ? environment.MOBILE_SASA_SMS_SENDER_ID.trim()
        : "";

    const tokenConflict = canonicalToken && legacyToken && canonicalToken !== legacyToken;
    const senderConflict = canonicalSender && legacySender && canonicalSender !== legacySender;
    return {
        token: canonicalToken || legacyToken,
        senderId: canonicalSender || legacySender,
        conflict: Boolean(tokenConflict || senderConflict),
    };
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
    const configuration = getSmsConfiguration(environment);
    return environment.MOBILESASA_SMS_ENABLED === "true" &&
        !configuration.conflict &&
        Boolean(configuration.token.startsWith("mbs_") && configuration.senderId);
}

function isTestSmsConfigured(environment = process.env) {
    const configuration = getSmsConfiguration(environment);
    return environment.NODE_ENV === "development" &&
        environment.MOBILESASA_TEST_SMS_ENABLED === "true" &&
        environment.MOBILESASA_SMS_ENABLED !== "true" &&
        !configuration.conflict &&
        Boolean(configuration.token.startsWith("mbs_") && configuration.senderId);
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
    diagnosticLogger,
}) {
    if (typeof fetchImpl !== "function") {
        throw providerError("Mobile Sasa delivery is unavailable.", `${errorPrefix}_CONFIGURATION_MISSING`);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw providerError("The provider request timeout is invalid.", `${errorPrefix}_CONFIGURATION_MISSING`);
    }

    const controller = new AbortController();
    let timeoutId;
    const requestStarted = errorPrefix === "SMS";
    let httpResponseReceived = false;
    let httpStatus = null;
    let responseCode = null;
    if (requestStarted) {
        logSmsDiagnostic(diagnosticLogger, "mobilesasa.sms_request_started", {
            httpResponseReceived: false,
        });
    }
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
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                controller.abort();
                reject(smsFailure(
                    "The Mobile Sasa request timed out.",
                    `${errorPrefix}_TIMEOUT`,
                    {
                        requestStarted,
                        httpResponseReceived,
                        httpStatus,
                        responseCode,
                        failureCategory: "timeout",
                        deliveryOutcomeUnknown: true,
                    }
                ));
            }, timeoutMs);
        });
        const response = await Promise.race([request, timeoutPromise]);
        httpStatus = Number.isInteger(response?.status) &&
            response.status >= 100 && response.status <= 599
            ? response.status
            : null;
        httpResponseReceived = true;
        if (requestStarted) {
            logSmsDiagnostic(diagnosticLogger, "mobilesasa.sms_http_response_received", {
                httpResponseReceived: true,
                httpStatus,
            });
        }
        let payload;
        try {
            payload = await Promise.race([response.json(), timeoutPromise]);
        } catch (error) {
            if (error?.diagnostics) throw error;
            const failure = httpStatus === 401 || httpStatus === 403
                ? {
                    message: "The Mobile Sasa provider rejected SMS authentication.",
                    code: `${errorPrefix}_PROVIDER_AUTH_FAILED`,
                    failureCategory: "authentication_failure",
                    deliveryOutcomeUnknown: false,
                }
                : httpStatus === 429
                    ? {
                        message: "The Mobile Sasa provider explicitly rate-limited the request.",
                        code: `${errorPrefix}_RETRYABLE_REJECTION`,
                        failureCategory: "rate_limiting",
                        deliveryOutcomeUnknown: false,
                    }
                    : Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus < 500
                        ? {
                            message: "The Mobile Sasa provider did not accept the message.",
                            code: `${errorPrefix}_PROVIDER_REJECTED`,
                            failureCategory: "provider_rejection",
                            deliveryOutcomeUnknown: false,
                        }
                        : {
                            message: "The Mobile Sasa provider returned an invalid response.",
                            code: `${errorPrefix}_INVALID_RESPONSE`,
                            failureCategory: "unknown_outcome",
                            deliveryOutcomeUnknown: true,
                        };
            throw smsFailure(
                failure.message,
                failure.code,
                {
                    requestStarted,
                    httpResponseReceived: true,
                    httpStatus,
                    responseCode: null,
                    failureCategory: failure.failureCategory,
                    deliveryOutcomeUnknown: failure.deliveryOutcomeUnknown,
                }
            );
        }
        responseCode = sanitizeResponseCode(payload?.responseCode);
        if (requestStarted) {
            logSmsDiagnostic(diagnosticLogger, "mobilesasa.sms_response_parsed", {
                httpResponseReceived: true,
                httpStatus,
                responseCode,
            });
        }
        return { response, payload, httpStatus, responseCode };
    } catch (error) {
        if (error?.diagnostics) {
            throw error;
        }
        throw smsFailure(
            "The Mobile Sasa request failed before a response was received.",
            `${errorPrefix}_NETWORK_ERROR`,
            {
                requestStarted,
                httpResponseReceived: false,
                httpStatus: null,
                responseCode: null,
                failureCategory: "network_failure",
                deliveryOutcomeUnknown: true,
                errorClass: safeErrorClass(error),
            }
        );
    } finally {
        clearTimeout(timeoutId);
    }
}

async function sendSmsRequest(
    { to, message, trackingId },
    { environment, fetchImpl, timeoutMs },
    { testOnly = false, diagnosticLogger } = {}
) {
    const testModeAllowed = environment.NODE_ENV === "development" &&
        environment.MOBILESASA_TEST_SMS_ENABLED === "true" &&
        environment.MOBILESASA_SMS_ENABLED !== "true";
    if (testOnly && !testModeAllowed) {
        throw smsFailure(
            "SMS sending is disabled for this runtime.",
            "SMS_TEST_DISABLED",
            {
                requestStarted: false,
                httpResponseReceived: false,
                httpStatus: null,
                responseCode: null,
                failureCategory: "configuration_failure",
                deliveryOutcomeUnknown: false,
            }
        );
    }
    if (!testOnly && isDevelopmentDeliveryRuntime(environment)) {
        assertDevelopmentRecipientAllowed("SMS", to, environment);
    } else if (!testOnly && environment.NODE_ENV !== "production") {
        throw smsFailure(
            "SMS sending is disabled for this runtime.",
            "SMS_PRODUCTION_ONLY",
            {
                requestStarted: false,
                httpResponseReceived: false,
                httpStatus: null,
                responseCode: null,
                failureCategory: "configuration_failure",
                deliveryOutcomeUnknown: false,
            }
        );
    }
    const smsConfiguration = getSmsConfiguration(environment);
    if (smsConfiguration.conflict || (testOnly
        ? !(smsConfiguration.token.startsWith("mbs_") && smsConfiguration.senderId)
        : !isSmsConfigured(environment))) {
        throw smsFailure(
            "Mobile Sasa SMS configuration is missing or conflicting.",
            "SMS_CONFIGURATION_MISSING",
            {
                requestStarted: false,
                httpResponseReceived: false,
                httpStatus: null,
                responseCode: null,
                failureCategory: "configuration_failure",
                deliveryOutcomeUnknown: false,
            }
        );
    }
    const recipient = testOnly ? normalizeKenyanSmsRecipient(to) : to;
    if (typeof recipient !== "string" || !/^\+254[17]\d{8}$/.test(recipient) ||
        typeof message !== "string" || !message.trim() ||
        typeof trackingId !== "string" || !trackingId.trim() ||
        trackingId.length > 128 || /[\u0000-\u001f\u007f]/.test(trackingId)) {
        throw smsFailure("Mobile Sasa SMS data is invalid.", "SMS_INVALID_INPUT", {
            requestStarted: false,
            httpResponseReceived: false,
            httpStatus: null,
            responseCode: null,
            failureCategory: "input_validation",
            deliveryOutcomeUnknown: false,
        });
    }

    const { response, payload, httpStatus, responseCode } = await requestJson(SMS_ENDPOINT, {
        senderID: smsConfiguration.senderId,
        phone: recipient,
        message,
    }, {
        token: smsConfiguration.token,
        fetchImpl,
        timeoutMs,
        errorPrefix: "SMS",
        diagnosticLogger,
    });

    const responseDetails = {
        requestStarted: true,
        httpResponseReceived: true,
        httpStatus,
        responseCode,
        deliveryOutcomeUnknown: false,
    };
    if (httpStatus === 401 || httpStatus === 403) {
        throw smsFailure(
            "The Mobile Sasa provider rejected SMS authentication.",
            "SMS_PROVIDER_AUTH_FAILED",
            { ...responseDetails, failureCategory: "authentication_failure" }
        );
    }
    if (httpStatus === 429) {
        throw smsFailure(
            "The Mobile Sasa provider explicitly rate-limited the request.",
            "SMS_RETRYABLE_REJECTION",
            { ...responseDetails, failureCategory: "rate_limiting" }
        );
    }
    if (!response.ok) {
        const rejected = httpStatus !== null && httpStatus >= 400 && httpStatus < 500;
        throw smsFailure(
            rejected
                ? "The Mobile Sasa provider did not accept the message."
                : "The Mobile Sasa request outcome could not be established.",
            rejected
                ? "SMS_PROVIDER_REJECTED"
                : "SMS_UNKNOWN_OUTCOME",
            {
                ...responseDetails,
                failureCategory: rejected ? "provider_rejection" : "unknown_outcome",
                deliveryOutcomeUnknown: !rejected,
            }
        );
    }
    if (payload?.responseCode === "0409") {
        throw smsFailure(
            "The Mobile Sasa provider reported a possible duplicate message.",
            "SMS_UNKNOWN_OUTCOME",
            {
                ...responseDetails,
                failureCategory: "unknown_outcome",
                deliveryOutcomeUnknown: true,
            }
        );
    }
    if (payload?.status !== true || payload?.responseCode !== "0200") {
        const explicitRejection = payload?.status === false;
        throw smsFailure(
            explicitRejection
                ? "The Mobile Sasa provider did not accept the message."
                : "The Mobile Sasa provider returned an invalid response.",
            explicitRejection ? "SMS_PROVIDER_REJECTED" : "SMS_INVALID_RESPONSE",
            {
                ...responseDetails,
                failureCategory: explicitRejection ? "provider_rejection" : "unknown_outcome",
                deliveryOutcomeUnknown: !explicitRejection,
            }
        );
    }
    if (
        typeof payload.messageId !== "string" ||
        !payload.messageId.trim() ||
        payload.messageId.length > 128 ||
        (payload.cost !== undefined &&
            (!Number.isSafeInteger(payload.cost) || payload.cost < 0))
    ) {
        throw smsFailure("The Mobile Sasa provider returned an invalid response.", "SMS_INVALID_RESPONSE", {
            ...responseDetails,
            failureCategory: "unknown_outcome",
            deliveryOutcomeUnknown: true,
        });
    }

    return {
        accepted: true,
        status: "PROVIDER_ACCEPTED",
        messageId: payload.messageId,
        deliveryResult: {
            provider: "MOBILE_SASA",
            responseCode: payload.responseCode,
            trackingId,
            ...(payload.cost === undefined ? {} : { smsParts: payload.cost }),
        },
    };
}

async function sendSms(
    input,
    {
        environment = process.env,
        fetchImpl = global.fetch,
        timeoutMs = REQUEST_TIMEOUT_MS,
        logger = console,
    } = {}
) {
    return sendSmsRequest(
        input,
        { environment, fetchImpl, timeoutMs },
        { diagnosticLogger: logger }
    );
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
