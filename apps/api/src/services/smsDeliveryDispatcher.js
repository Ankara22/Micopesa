const RETRY_BASE_DELAY_MS = 30000;
const RETRY_MAX_DELAY_MS = 15 * 60 * 1000;
const BATCH_SIZE = 10;
const POLL_INTERVAL_MS = 5000;
const {
    getNotificationChannelAvailability,
    getNotificationChannelAvailabilityMap,
    getNotificationSmsProvider,
} = require("./notificationChannelConfiguration");
const SAFE_ERROR_CODES = new Set([
    "EMAIL_SMTP_DELIVERY_FAILED",
    "EMAIL_SMTP_CONFIGURATION_MISSING",
    "EMAIL_SMTP_CONFIGURATION_INVALID",
    "EMAIL_SMTP_AUTH_FAILED",
    "EMAIL_SMTP_PROVIDER_REJECTED",
    "EMAIL_SMTP_TIMEOUT",
    "EMAIL_SMTP_NETWORK_ERROR",
    "EMAIL_SMTP_UNKNOWN_OUTCOME",
    "EMAIL_CONFIGURATION_MISSING",
    "EMAIL_CONFIGURATION_INVALID",
    "EMAIL_PROVIDER_UNSUPPORTED",
    "EMAIL_INVALID_INPUT",
    "EMAIL_PRODUCTION_ONLY",
    "EMAIL_DEVELOPMENT_DELIVERY_DISABLED",
    "EMAIL_DEVELOPMENT_ALLOWLIST_EMPTY",
    "EMAIL_DEVELOPMENT_RECIPIENT_NOT_ALLOWED",
    "EMAIL_PROVIDER_REJECTED",
    "EMAIL_PROVIDER_TIMEOUT",
    "EMAIL_NETWORK_ERROR",
    "EMAIL_PROVIDER_AUTH_FAILED",
    "EMAIL_TIMEOUT",
    "EMAIL_SUPPRESSED",
    "EMAIL_INVALID_RESPONSE",
    "EMAIL_UNKNOWN_OUTCOME",
    "EMAIL_SMTP_RECIPIENT_REJECTED",
    "SMS_CONFIGURATION_MISSING",
    "SMS_NOTIFICATION_DELIVERY_DISABLED",
    "SMS_CONFIGURATION_INVALID",
    "SMS_PROVIDER_UNSUPPORTED",
    "SMS_ENVIRONMENT_MISMATCH",
    "SMS_INVALID_RECIPIENT",
    "SMS_INVALID_INPUT",
    "SMS_INVALID_RESPONSE",
    "SMS_NETWORK_ERROR",
    "SMS_PRODUCTION_ONLY",
    "SMS_DEVELOPMENT_DELIVERY_DISABLED",
    "SMS_PROVIDER_REJECTED",
    "SMS_PROVIDER_AUTH_FAILED",
    "SMS_RETRYABLE_REJECTION",
    "SMS_SANDBOX_CREDENTIALS",
    "SMS_TIMEOUT",
    "SMS_UNKNOWN_OUTCOME",
    "PUSH_CONFIGURATION_INVALID",
    "PUSH_CONFIGURATION_MISSING",
    "PUSH_INVALID_INPUT",
    "PUSH_NO_SUBSCRIPTIONS",
    "PUSH_PRODUCTION_ONLY",
    "PUSH_PROVIDER_REJECTED",
    "PUSH_RETRYABLE_REJECTION",
    "PUSH_UNKNOWN_OUTCOME",
    "NOTIFICATION_SCHEMA_MISMATCH",
]);
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

function classifyEmailFailure(error) {
    let code = SAFE_ERROR_CODES.has(error?.code) ? error.code : "EMAIL_UNKNOWN_OUTCOME";
    let failureCategory = "unknown";
    const smtpCode = typeof error?.smtpCode === "string" &&
        SAFE_SMTP_CODES.has(error.smtpCode) ? error.smtpCode : null;
    const responseCode = Number.isInteger(error?.responseCode) &&
        error.responseCode >= 400 && error.responseCode <= 599
        ? error.responseCode
        : null;

    if (error?.code === "EMAIL_SMTP_DELIVERY_FAILED") {
        if (smtpCode === "EAUTH" || [534, 535].includes(responseCode)) {
            code = "EMAIL_PROVIDER_AUTH_FAILED";
            failureCategory = "authentication_failure";
        } else if (responseCode !== null) {
            code = "EMAIL_PROVIDER_REJECTED";
            failureCategory = "smtp_rejection";
        } else if (smtpCode === "ETIMEDOUT" || error?.name === "TimeoutError") {
            code = "EMAIL_PROVIDER_TIMEOUT";
            failureCategory = "timeout";
        } else if ([
            "ECONNECTION", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH",
            "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ESOCKET", "ETLS",
        ].includes(smtpCode)) {
            code = "EMAIL_NETWORK_ERROR";
            failureCategory = "network_failure";
        } else {
            code = "EMAIL_UNKNOWN_OUTCOME";
        }
    } else if (code === "EMAIL_TIMEOUT") {
        code = "EMAIL_PROVIDER_TIMEOUT";
        failureCategory = "timeout";
    } else if (code === "EMAIL_NETWORK_ERROR") {
        failureCategory = "network_failure";
    } else if (code === "EMAIL_PROVIDER_AUTH_FAILED") {
        failureCategory = "authentication_failure";
    } else if (code === "EMAIL_INVALID_RESPONSE") {
        code = "EMAIL_UNKNOWN_OUTCOME";
        failureCategory = "unknown_outcome";
    } else if (
        code === "EMAIL_SMTP_RECIPIENT_REJECTED" ||
        code === "EMAIL_PROVIDER_REJECTED" ||
        code === "EMAIL_SMTP_PROVIDER_REJECTED"
    ) {
        code = "EMAIL_PROVIDER_REJECTED";
        failureCategory = "provider_rejection";
    } else if (
        code.includes("CONFIGURATION") ||
        code.includes("DEVELOPMENT_") ||
        code === "EMAIL_PROVIDER_UNSUPPORTED" ||
        code === "EMAIL_INVALID_INPUT"
    ) {
        failureCategory = "configuration_or_policy_failure";
    } else if (code === "EMAIL_PROVIDER_TIMEOUT") {
        failureCategory = "timeout";
    } else if (code === "EMAIL_NETWORK_ERROR") {
        failureCategory = "network_failure";
    } else if (code === "EMAIL_PROVIDER_AUTH_FAILED") {
        failureCategory = "authentication_failure";
    }

    const rawErrorClass = error?.smtpErrorClass || error?.name;
    const errorClass = typeof rawErrorClass === "string" &&
        /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(rawErrorClass)
        ? rawErrorClass
        : "Error";

    return {
        code,
        failureCategory,
        errorClass,
        ...(smtpCode ? { smtpCode } : {}),
        ...(responseCode !== null ? { responseCode } : {}),
        deliveryOutcomeUnknown: ![
            "EMAIL_PROVIDER_REJECTED",
            "EMAIL_PROVIDER_REJECTED",
            "EMAIL_PROVIDER_AUTH_FAILED",
            "EMAIL_CONFIGURATION_MISSING",
            "EMAIL_CONFIGURATION_INVALID",
            "EMAIL_PROVIDER_UNSUPPORTED",
            "EMAIL_SMTP_CONFIGURATION_MISSING",
            "EMAIL_SMTP_CONFIGURATION_INVALID",
            "EMAIL_PRODUCTION_ONLY",
            "EMAIL_DEVELOPMENT_DELIVERY_DISABLED",
            "EMAIL_DEVELOPMENT_ALLOWLIST_EMPTY",
            "EMAIL_DEVELOPMENT_RECIPIENT_NOT_ALLOWED",
            "EMAIL_INVALID_INPUT",
        ].includes(code),
    };
}

function isSmsDispatcherEnabled(environment = process.env) {
    return getNotificationChannelAvailability("SMS", environment).enabled;
}

function isEmailDispatcherEnabled(environment = process.env) {
    return getNotificationChannelAvailability("EMAIL", environment).enabled;
}

function isPushDispatcherEnabled(environment = process.env) {
    return getNotificationChannelAvailability("PUSH", environment).enabled;
}

function enabledChannels(environment = process.env) {
    return [
        ...(isSmsDispatcherEnabled(environment) ? ["SMS"] : []),
        ...(isEmailDispatcherEnabled(environment) ? ["EMAIL"] : []),
        ...(isPushDispatcherEnabled(environment) ? ["PUSH"] : []),
    ];
}

function retryDelayMs(attemptCount) {
    return Math.min(
        RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attemptCount - 1)),
        RETRY_MAX_DELAY_MS
    );
}

function createSmsDeliveryDispatcher({
    repository,
    sendSms,
    sendEmail,
    sendPush,
    environment = process.env,
    logger = console,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    pollIntervalMs = POLL_INTERVAL_MS,
    batchSize = BATCH_SIZE,
}) {
    if (!repository || typeof repository.claimBatch !== "function") {
        throw new TypeError("An SMS notification repository is required.");
    }
    if (typeof sendSms !== "function") {
        throw new TypeError("An SMS provider service is required.");
    }

    const channelSenders = { SMS: sendSms, EMAIL: sendEmail, PUSH: sendPush };
    const activeChannels = enabledChannels(environment);
    const enabled = activeChannels.length > 0;
    let timer = null;
    let activeRun = null;
    let stopping = false;
    let fatalPollingError = null;

    function logError(message, error) {
        logger.error(message, {
            code: SAFE_ERROR_CODES.has(error?.code) ? error.code : "SMS_DISPATCH_ERROR",
            ...(typeof error?.databaseCode === "string" &&
                /^\d{5}$/.test(error.databaseCode)
                ? { databaseCode: error.databaseCode }
                : {}),
            ...(error?.schemaObject === "notifications.notification_event_type" ||
                error?.schemaObject === "notification delivery schema"
                ? { schemaObject: error.schemaObject }
                : {}),
        });
    }

    function handlePollingError(message, error) {
        if (error?.code === "NOTIFICATION_SCHEMA_MISMATCH") {
            if (fatalPollingError) return;
            fatalPollingError = error;
            if (timer) {
                clearIntervalImpl(timer);
                timer = null;
            }
            logError("Notification dispatcher stopped because the database schema is incompatible.", error);
            return;
        }
        logError(message, error);
    }

    async function dispatchOne(notification) {
        try {
            if (["SMS", "EMAIL"].includes(notification.notification_type)) {
                if (typeof repository.isClaimEligible !== "function") {
                    await repository.markFailed(notification, "NOTIFICATION_RECIPIENT_UNVERIFIED");
                    return;
                }
                if (!await repository.isClaimEligible(notification)) {
                    await repository.markFailed(notification, "NOTIFICATION_RECIPIENT_STALE");
                    return;
                }
            }
            let sender = channelSenders[notification.notification_type];
            if (typeof sender !== "function") {
                await repository.markFailed(notification, "NOTIFICATION_CHANNEL_UNAVAILABLE");
                return;
            }
            const result = notification.notification_type === "SMS"
                ? await sender({
                    to: notification.recipient_phone,
                    message: notification.message,
                    trackingId: notification.notification_id,
                })
                : notification.notification_type === "EMAIL"
                    ? await sender({
                        to: notification.recipient_email,
                        subject: notification.email_subject,
                        text: notification.message,
                        html: notification.email_html_body || undefined,
                        purpose: "ADMIN_NOTIFICATION",
                    })
                    : await sender({
                        userId: notification.user_id,
                        title: notification.push_title,
                        body: notification.message,
                        url: notification.push_url || "/worker/notifications",
                    });
            if (result?.accepted === true && result.status === "PROVIDER_ACCEPTED") {
                await repository.markProviderAccepted(notification, {
                    messageId: result.messageId || null,
                    deliveryResult: {
                        ...(result.deliveryResult || {}),
                        provider: notification.notification_type === "SMS"
                            ? getNotificationSmsProvider(environment)
                            : notification.notification_type === "EMAIL"
                                ? (environment.EMAIL_PROVIDER?.trim().toUpperCase() || "GMAIL")
                                : "WEB_PUSH",
                    },
                });
                return;
            }
            await repository.markUnknown(
                notification,
                `${notification.notification_type}_INVALID_RESPONSE`
            );
        } catch (error) {
            const emailFailure = notification.notification_type === "EMAIL"
                ? classifyEmailFailure(error)
                : null;
            const code = emailFailure?.code || (
                SAFE_ERROR_CODES.has(error?.code)
                    ? error.code
                    : `${notification.notification_type}_UNKNOWN_OUTCOME`
            );
            if (emailFailure && !error?.smtpLogged) {
                logger.error("Admin notification email delivery attempt failed.", {
                    errorCode: emailFailure.code,
                    errorClass: emailFailure.errorClass,
                    failureCategory: emailFailure.failureCategory,
                    deliveryOutcomeUnknown: emailFailure.deliveryOutcomeUnknown,
                    ...(emailFailure.smtpCode ? { smtpCode: emailFailure.smtpCode } : {}),
                    ...(emailFailure.responseCode ? { responseCode: emailFailure.responseCode } : {}),
                });
            }
            try {
                if (["SMS_RETRYABLE_REJECTION", "PUSH_RETRYABLE_REJECTION"].includes(code)) {
                    await repository.retryRejected(notification, {
                        errorCode: code,
                        delayMs: retryDelayMs(notification.attempt_count),
                    });
                } else if ([
                    "SMS_INVALID_RECIPIENT",
                    "SMS_INVALID_INPUT",
                    "SMS_PROVIDER_REJECTED",
                    "SMS_PROVIDER_AUTH_FAILED",
                    "SMS_CONFIGURATION_MISSING",
                    "SMS_CONFIGURATION_INVALID",
                    "SMS_PROVIDER_UNSUPPORTED",
                    "SMS_ENVIRONMENT_MISMATCH",
                    "SMS_PRODUCTION_ONLY",
                    "SMS_DEVELOPMENT_DELIVERY_DISABLED",
                    "SMS_SANDBOX_CREDENTIALS",
                    "EMAIL_SMTP_RECIPIENT_REJECTED",
                    "EMAIL_SMTP_AUTH_FAILED",
                    "EMAIL_SMTP_PROVIDER_REJECTED",
                    "EMAIL_PROVIDER_AUTH_FAILED",
                    "EMAIL_SMTP_CONFIGURATION_MISSING",
                    "EMAIL_SMTP_CONFIGURATION_INVALID",
                    "EMAIL_PROVIDER_REJECTED",
                    "EMAIL_SUPPRESSED",
                    "EMAIL_CONFIGURATION_MISSING",
                    "EMAIL_CONFIGURATION_INVALID",
                    "EMAIL_PROVIDER_UNSUPPORTED",
                    "EMAIL_INVALID_INPUT",
                    "EMAIL_PRODUCTION_ONLY",
                    "EMAIL_DEVELOPMENT_DELIVERY_DISABLED",
                    "EMAIL_DEVELOPMENT_ALLOWLIST_EMPTY",
                    "EMAIL_DEVELOPMENT_RECIPIENT_NOT_ALLOWED",
                    "PUSH_CONFIGURATION_INVALID",
                    "PUSH_CONFIGURATION_MISSING",
                    "PUSH_INVALID_INPUT",
                    "PUSH_NO_SUBSCRIPTIONS",
                    "PUSH_PRODUCTION_ONLY",
                    "PUSH_PROVIDER_REJECTED",
                ].includes(code)) {
                    await repository.markFailed(notification, code);
                } else {
                    await repository.markUnknown(notification, code);
                }
            } catch (persistenceError) {
                logError(`Could not persist ${notification.notification_type} delivery outcome.`, persistenceError);
            }
            if (!emailFailure) {
                logError(`${notification.notification_type} delivery attempt did not complete.`, error);
            }
        }
    }

    async function runOnce() {
        if (fatalPollingError) throw fatalPollingError;
        if (!enabled || stopping) return 0;
        if (activeRun) return activeRun;

        activeRun = (async () => {
            const claimed = await repository.claimBatch(batchSize, activeChannels);
            await Promise.all(claimed.map(dispatchOne));
            return claimed.length;
        })();
        try {
            return await activeRun;
        } finally {
            activeRun = null;
        }
    }

    function start() {
        if (!enabled || timer || fatalPollingError) return false;
        stopping = false;
        timer = setIntervalImpl(() => {
            runOnce().catch((error) =>
                handlePollingError("Notification dispatcher poll failed.", error)
            );
        }, pollIntervalMs);
        timer.unref?.();
        runOnce().catch((error) =>
            handlePollingError("Notification dispatcher startup poll failed.", error)
        );
        return true;
    }

    async function stop() {
        stopping = true;
        if (timer) {
            clearIntervalImpl(timer);
            timer = null;
        }
        if (activeRun) await activeRun;
    }

    return { enabled, runOnce, start, stop };
}

module.exports = {
    classifyEmailFailure,
    createSmsDeliveryDispatcher,
    enabledChannels,
    getNotificationChannelAvailability,
    getNotificationChannelAvailabilityMap,
    isEmailDispatcherEnabled,
    isPushDispatcherEnabled,
    isSmsDispatcherEnabled,
    getNotificationSmsProvider,
    retryDelayMs,
};
