const RETRY_BASE_DELAY_MS = 30000;
const RETRY_MAX_DELAY_MS = 15 * 60 * 1000;
const BATCH_SIZE = 10;
const POLL_INTERVAL_MS = 5000;
const mobileSasaService = require("./mobileSasaService");
const SAFE_ERROR_CODES = new Set([
    "EMAIL_SMTP_DELIVERY_FAILED",
    "EMAIL_CONFIGURATION_MISSING",
    "EMAIL_INVALID_INPUT",
    "EMAIL_PRODUCTION_ONLY",
    "EMAIL_PROVIDER_REJECTED",
    "EMAIL_SUPPRESSED",
    "EMAIL_INVALID_RESPONSE",
    "EMAIL_UNKNOWN_OUTCOME",
    "EMAIL_SMTP_RECIPIENT_REJECTED",
    "SMS_CONFIGURATION_MISSING",
    "SMS_ENVIRONMENT_MISMATCH",
    "SMS_INVALID_RECIPIENT",
    "SMS_INVALID_INPUT",
    "SMS_INVALID_RESPONSE",
    "SMS_NETWORK_ERROR",
    "SMS_PRODUCTION_ONLY",
    "SMS_PROVIDER_REJECTED",
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
]);

function isSmsDispatcherEnabled(environment = process.env) {
    if (environment.NODE_ENV !== "production" || environment.SMS_DISPATCHER_ENABLED !== "true") {
        return false;
    }
    const provider = environment.NOTIFICATION_SMS_PROVIDER?.trim().toUpperCase() || "AFRICAS_TALKING";
    if (provider === "MOBILE_SASA") return mobileSasaService.isSmsConfigured(environment);
    return provider === "AFRICAS_TALKING" &&
        environment.AT_ENVIRONMENT?.trim().toLowerCase() === "production" &&
        Boolean(environment.AT_USERNAME?.trim()) &&
        environment.AT_USERNAME.trim().toLowerCase() !== "sandbox" &&
        Boolean(environment.AT_API_KEY?.trim());
}

function isEmailDispatcherEnabled(environment = process.env) {
    if (environment.NODE_ENV !== "production" ||
        environment.NOTIFICATION_DISPATCHER_ENABLED !== "true" ||
        environment.EMAIL_NOTIFICATIONS_ENABLED !== "true") {
        return false;
    }
    const provider = environment.EMAIL_PROVIDER?.trim().toUpperCase() || "GMAIL";
    if (provider === "MOBILE_SASA") return mobileSasaService.isEmailConfigured(environment);
    return provider === "GMAIL" &&
        Boolean(environment.GMAIL_USER?.trim()) &&
        Boolean(environment.GMAIL_APP_PASSWORD?.trim());
}

function isPushDispatcherEnabled(environment = process.env) {
    return environment.NODE_ENV === "production" &&
        environment.NOTIFICATION_DISPATCHER_ENABLED === "true" &&
        environment.WEB_PUSH_ENABLED === "true" &&
        Boolean(environment.WEB_PUSH_PUBLIC_KEY?.trim()) &&
        Boolean(environment.WEB_PUSH_PRIVATE_KEY?.trim()) &&
        Boolean(environment.WEB_PUSH_SUBJECT?.trim());
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

    function logError(message, error) {
        logger.error(message, {
            code: SAFE_ERROR_CODES.has(error?.code) ? error.code : "SMS_DISPATCH_ERROR",
        });
    }

    async function dispatchOne(notification) {
        try {
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
                            ? (environment.NOTIFICATION_SMS_PROVIDER?.trim().toUpperCase() || "AFRICAS_TALKING")
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
            const code = SAFE_ERROR_CODES.has(error?.code)
                ? error.code
                : `${notification.notification_type}_UNKNOWN_OUTCOME`;
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
                    "SMS_CONFIGURATION_MISSING",
                    "SMS_ENVIRONMENT_MISMATCH",
                    "SMS_PRODUCTION_ONLY",
                    "SMS_SANDBOX_CREDENTIALS",
                    "EMAIL_SMTP_RECIPIENT_REJECTED",
                    "EMAIL_PROVIDER_REJECTED",
                    "EMAIL_SUPPRESSED",
                    "EMAIL_CONFIGURATION_MISSING",
                    "EMAIL_INVALID_INPUT",
                    "EMAIL_PRODUCTION_ONLY",
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
                logError("Could not persist SMS delivery outcome.", persistenceError);
            }
            logError("SMS delivery attempt did not complete.", error);
        }
    }

    async function runOnce() {
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
        if (!enabled || timer) return false;
        stopping = false;
        timer = setIntervalImpl(() => {
            runOnce().catch((error) => logError("SMS dispatcher poll failed.", error));
        }, pollIntervalMs);
        timer.unref?.();
        runOnce().catch((error) => logError("SMS dispatcher startup poll failed.", error));
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
    createSmsDeliveryDispatcher,
    enabledChannels,
    isEmailDispatcherEnabled,
    isPushDispatcherEnabled,
    isSmsDispatcherEnabled,
    retryDelayMs,
};
