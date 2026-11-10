const { createNotificationRepository } = require("../services/notificationRepository");
const {
    createWebPushService,
    validatePushEndpoint,
} = require("../services/webPushService");
const { isSmsDispatcherEnabled } = require("../services/smsDeliveryDispatcher");
const mobileSasaService = require("../services/mobileSasaService");

const SUBSCRIPTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const P256DH_KEY_PATTERN = /^[A-Za-z0-9_-]{40,200}$/;
const AUTH_KEY_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;

function createNotificationController({
    repository,
    webPushService,
    environment = process.env,
    testSmsService = mobileSasaService,
    externalSmsService = mobileSasaService,
}) {
    if (!repository) throw new TypeError("A notification repository is required.");
    if (!webPushService || typeof webPushService.getPublicKey !== "function") {
        throw new TypeError("A Web Push service is required.");
    }

    function sendError(res, error, fallbackMessage) {
        const statusCode = Number.isInteger(error?.statusCode) &&
            error.statusCode >= 400 && error.statusCode <= 599
            ? error.statusCode
            : 500;
        const code = typeof error?.code === "string" &&
            /^(NOTIFICATION|PUSH|EMAIL)_[A-Z0-9_]{1,60}$/.test(error.code)
            ? error.code
            : undefined;
        if (statusCode >= 500) {
            console.error("Notification operation failed.", {
                code: code || "NOTIFICATION_OPERATION_FAILED",
            });
        }
        return res.status(statusCode).json({
            status: "error",
            message: statusCode < 500 ? error.message : fallbackMessage,
            ...(code ? { code } : {}),
        });
    }

    return {
        async createNotification(req, res) {
            try {
                const data = await repository.queueRoleNotifications({
                    senderId: req.user.userId,
                    senderRole: req.user.role,
                    userId: req.body?.user_id,
                    userIds: req.body?.user_ids,
                    channels: req.body?.channels,
                    message: req.body?.message,
                    subject: req.body?.subject,
                    html: req.body?.html,
                    title: req.body?.title,
                    requestId: req.body?.request_id,
                    category: req.body?.category || "GENERAL",
                    fundId: req.body?.fund_id || null,
                });
                return res.status(202).json({
                    status: "success",
                    message: "Notifications queued independently by channel.",
                    data: { notifications: data },
                });
            } catch (error) {
                return sendError(res, error, "Could not queue notifications.");
            }
        },

        async getExternalSmsAvailability(_req, res) {
            const configured = environment.NODE_ENV === "production" &&
                environment.MOBILESASA_EXTERNAL_RECIPIENTS_ENABLED === "true" &&
                typeof externalSmsService.isSmsConfigured === "function" &&
                externalSmsService.isSmsConfigured(environment);
            if (!configured) {
                return res.status(200).json({
                    status: "success",
                    data: { enabled: false },
                });
            }
            try {
                const enabled = typeof repository.isExternalSmsSchemaAvailable === "function" &&
                    await repository.isExternalSmsSchemaAvailable();
                return res.status(200).json({
                    status: "success",
                    data: { enabled },
                });
            } catch (error) {
                return sendError(res, error, "Could not check external SMS availability.");
            }
        },

        async sendExternalRecipientSms(req, res) {
            if (req.body?.confirmed !== true ||
                req.body?.recipient_consented !== true) {
                return res.status(400).json({
                    status: "error",
                    code: "NOTIFICATION_CONFIRMATION_REQUIRED",
                    message: "Explicit send confirmation and recipient consent confirmation are required.",
                });
            }
            const configured = environment.NODE_ENV === "production" &&
                environment.MOBILESASA_EXTERNAL_RECIPIENTS_ENABLED === "true" &&
                typeof externalSmsService.isSmsConfigured === "function" &&
                externalSmsService.isSmsConfigured(environment);
            let schemaAvailable = false;
            try {
                schemaAvailable = configured &&
                    typeof repository.isExternalSmsSchemaAvailable === "function" &&
                    await repository.isExternalSmsSchemaAvailable();
            } catch (error) {
                return sendError(res, error, "Could not check external SMS availability.");
            }
            if (!schemaAvailable) {
                return res.status(503).json({
                    status: "error",
                    code: "NOTIFICATION_EXTERNAL_SMS_UNAVAILABLE",
                    message: "External-recipient SMS is unavailable until it has been enabled.",
                });
            }
            try {
                const request = {
                    adminId: req.user.userId,
                    recipientPhone: req.body?.recipient_phone,
                    message: req.body?.message,
                    requestId: req.body?.request_id,
                    recipientConsented: req.body?.recipient_consented,
                };
                const queued = await repository.queueExternalAdminSms(request);
                const claimed = await repository.claimExternalAdminSms({
                    adminId: request.adminId,
                    requestId: request.requestId,
                });
                if (!claimed) {
                    const existing = await repository.getExternalAdminSmsStatus({
                        adminId: request.adminId,
                        requestId: request.requestId,
                    });
                    if (!existing) {
                        throw new Error("The external SMS notification could not be retrieved.");
                    }
                    return res.status(200).json({
                        status: "success",
                        message: "The existing external SMS status is returned without resending.",
                        data: { notification: existing, created: queued.created },
                    });
                }

                let result;
                try {
                    result = await externalSmsService.sendSms({
                        to: claimed.recipient_phone,
                        message: claimed.message,
                        trackingId: claimed.notification_id,
                    }, { environment });
                } catch (error) {
                    const errorCode = typeof error?.code === "string" &&
                        /^SMS_[A-Z0-9_]{1,60}$/.test(error.code)
                        ? error.code
                        : "SMS_UNKNOWN_OUTCOME";
                    const definitiveRejections = new Set([
                        "SMS_CONFIGURATION_MISSING",
                        "SMS_ENVIRONMENT_MISMATCH",
                        "SMS_INVALID_RECIPIENT",
                        "SMS_INVALID_INPUT",
                        "SMS_PRODUCTION_ONLY",
                        "SMS_PROVIDER_REJECTED",
                        "SMS_RETRYABLE_REJECTION",
                        "SMS_SANDBOX_CREDENTIALS",
                    ]);
                    const notification = definitiveRejections.has(errorCode)
                        ? await repository.markExternalAdminSmsFailed(claimed, errorCode)
                        : await repository.markExternalAdminSmsUnknown(claimed, errorCode);
                    return res.status(200).json({
                        status: "success",
                        message: notification.delivery_status === "FAILED"
                            ? "The provider rejected the SMS. It was not resent."
                            : "The provider outcome is unknown. The SMS will not be resent automatically.",
                        data: { notification, created: queued.created },
                    });
                }

                const notification = result?.accepted === true &&
                    result.status === "PROVIDER_ACCEPTED"
                    ? await repository.markExternalAdminSmsAccepted(claimed, result)
                    : await repository.markExternalAdminSmsUnknown(
                        claimed,
                        "SMS_INVALID_RESPONSE"
                    );
                return res.status(200).json({
                    status: "success",
                    message: notification.delivery_status === "PROVIDER_ACCEPTED"
                        ? "Mobile Sasa accepted the SMS. Delivery is not yet confirmed."
                        : "The provider outcome is unknown. The SMS will not be resent automatically.",
                    data: { notification, created: queued.created },
                });
            } catch (error) {
                return sendError(res, error, "Could not process the external-recipient SMS.");
            }
        },

        async sendAdminTestSms(req, res) {
            if (req.body?.confirmed !== true) {
                return res.status(400).json({
                    status: "error",
                    code: "NOTIFICATION_CONFIRMATION_REQUIRED",
                    message: "Explicit confirmation is required before sending the test SMS.",
                });
            }
            const provider = environment.NOTIFICATION_SMS_PROVIDER?.trim().toUpperCase();
            const developmentTestEnabled = typeof testSmsService.isTestSmsConfigured === "function" &&
                environment.NODE_ENV === "development" &&
                environment.MOBILESASA_TEST_SMS_ENABLED === "true" &&
                environment.MOBILESASA_SMS_ENABLED !== "true" &&
                testSmsService.isTestSmsConfigured(environment);
            const productionQueueEnabled = environment.NODE_ENV === "production" &&
                environment.SMS_DISPATCHER_ENABLED === "true" &&
                provider === "MOBILE_SASA" &&
                isSmsDispatcherEnabled(environment);
            if (!developmentTestEnabled && !productionQueueEnabled) {
                return res.status(503).json({
                    status: "error",
                    code: "NOTIFICATION_SMS_UNAVAILABLE",
                    message: "The SMS test is unavailable because its dedicated provider settings are not enabled.",
                });
            }
            try {
                const request = {
                    adminId: req.user.userId,
                    requestId: req.body?.request_id,
                };
                const notifications = await repository.queueAdminTestSms(request);
                if (!developmentTestEnabled) {
                    return res.status(202).json({
                        status: "success",
                        message: "The test SMS was queued for the registered administrator number.",
                        data: { notifications },
                    });
                }

                const claimed = await repository.claimAdminTestSms(request);
                if (!claimed) {
                    const existing = await repository.getAdminTestSmsStatus(request);
                    if (!existing) {
                        throw new Error("The queued test SMS could not be retrieved.");
                    }
                    return res.status(200).json({
                        status: "success",
                        message: "The existing test SMS outcome is returned without resending.",
                        data: { notifications: [existing] },
                    });
                }

                let result;
                try {
                    result = await testSmsService.sendTestSms({
                        to: claimed.recipient_phone,
                        trackingId: claimed.notification_id,
                    }, { environment });
                } catch (error) {
                    const safeCode = typeof error?.code === "string" &&
                        /^SMS_[A-Z0-9_]{1,60}$/.test(error.code)
                        ? error.code
                        : "SMS_UNKNOWN_OUTCOME";
                    const definitiveRejections = new Set([
                        "SMS_CONFIGURATION_MISSING",
                        "SMS_INVALID_INPUT",
                        "SMS_PROVIDER_REJECTED",
                        "SMS_RETRYABLE_REJECTION",
                    ]);
                    const outcome = definitiveRejections.has(safeCode)
                        ? await repository.markAdminTestSmsFailed(claimed, safeCode)
                        : await repository.markAdminTestSmsUnknown(claimed, safeCode);
                    return res.status(200).json({
                        status: "success",
                        message: outcome.delivery_status === "FAILED"
                            ? "The test SMS failed and was not resent."
                            : "The provider outcome is unknown. The test SMS will not be resent automatically.",
                        data: { notifications: [outcome] },
                    });
                }

                if (result?.accepted === true && result.status === "PROVIDER_ACCEPTED") {
                    const accepted = await repository.markAdminTestSmsAccepted(claimed, result);
                    return res.status(200).json({
                        status: "success",
                        message: "Mobile Sasa accepted the test SMS. Delivery is not yet confirmed.",
                        data: { notifications: [accepted] },
                    });
                }
                const unknown = await repository.markAdminTestSmsUnknown(
                    claimed,
                    "SMS_INVALID_RESPONSE"
                );
                return res.status(200).json({
                    status: "success",
                    message: "The provider outcome is unknown. The test SMS will not be resent automatically.",
                    data: { notifications: [unknown] },
                });
            } catch (error) {
                return sendError(res, error, "Could not queue the test SMS.");
            }
        },

        async listNotifications(_req, res) {
            try {
                const data = await repository.listAdminNotifications();
                return res.status(200).json({ status: "success", data });
            } catch (error) {
                return sendError(res, error, "Could not retrieve notifications.");
            }
        },

        async listRecipients(req, res) {
            try {
                const data = await repository.listRecipients(req.query?.search || "");
                return res.status(200).json({ status: "success", data });
            } catch (error) {
                return sendError(res, error, "Could not retrieve notification recipients.");
            }
        },

        async listRoleRecipients(req, res) {
            try {
                const data = await repository.listRoleRecipients({
                    senderId: req.user.userId,
                    senderRole: req.user.role,
                    search: req.query?.search || "",
                });
                return res.status(200).json({ status: "success", data });
            } catch (error) {
                return sendError(res, error, "Could not retrieve notification recipients.");
            }
        },

        async listNotificationAudit(req, res) {
            try {
                const data = await repository.listNotificationAudit({
                    userId: req.user.userId,
                    role: req.user.role,
                });
                return res.status(200).json({ status: "success", data });
            } catch (error) {
                return sendError(res, error, "Could not retrieve notification audit records.");
            }
        },

        async getMyNotifications(req, res) {
            try {
                const data = await repository.listUserNotifications(req.user.userId);
                return res.status(200).json({ status: "success", data });
            } catch (error) {
                return sendError(res, error, "Could not retrieve your notifications.");
            }
        },

        async getPushPublicKey(_req, res) {
            try {
                return res.status(200).json({
                    status: "success",
                    data: { public_key: webPushService.getPublicKey() },
                });
            } catch (error) {
                return sendError(res, error, "Push notifications are not configured.");
            }
        },

        async registerPushSubscription(req, res) {
            const subscription = req.body?.subscription;
            const endpoint = subscription?.endpoint;
            const keys = subscription?.keys;
            const allowLocalhost = environment.NODE_ENV !== "production";
            if (
                typeof endpoint !== "string" ||
                endpoint.length > 4096 ||
                !validatePushEndpoint(endpoint, { allowLocalhost }) ||
                !keys ||
                typeof keys.p256dh !== "string" ||
                !P256DH_KEY_PATTERN.test(keys.p256dh) ||
                typeof keys.auth !== "string" ||
                !AUTH_KEY_PATTERN.test(keys.auth)
            ) {
                return res.status(400).json({
                    status: "error",
                    message: "A valid browser push subscription is required.",
                });
            }
            try {
                const subscriptionId = await repository.upsertPushSubscription(
                    req.user.userId,
                    { endpoint, keys }
                );
                return res.status(201).json({
                    status: "success",
                    data: { subscription_id: subscriptionId },
                });
            } catch (error) {
                return sendError(res, error, "Could not save this push subscription.");
            }
        },

        async removePushSubscription(req, res) {
            if (!SUBSCRIPTION_ID_PATTERN.test(req.params.subscriptionId || "")) {
                return res.status(400).json({ status: "error", message: "A valid subscription ID is required." });
            }
            try {
                const removed = await repository.deletePushSubscription(
                    req.user.userId,
                    req.params.subscriptionId
                );
                if (!removed) {
                    return res.status(404).json({ status: "error", message: "Push subscription was not found." });
                }
                return res.status(200).json({ status: "success" });
            } catch (error) {
                return sendError(res, error, "Could not remove this push subscription.");
            }
        },
    };
}

let defaultController;
function getDefaultController() {
    if (!defaultController) {
        const pool = require("../db/database");
        const repository = createNotificationRepository(pool);
        const webPushService = createWebPushService({ repository });
        defaultController = createNotificationController({ repository, webPushService });
    }
    return defaultController;
}

const controller = Object.fromEntries([
    "createNotification",
    "getExternalSmsAvailability",
    "sendExternalRecipientSms",
    "sendAdminTestSms",
    "listNotifications",
    "listRecipients",
    "listRoleRecipients",
    "listNotificationAudit",
    "getMyNotifications",
    "getPushPublicKey",
    "registerPushSubscription",
    "removePushSubscription",
].map((handlerName) => [
    handlerName,
    (...args) => getDefaultController()[handlerName](...args),
]));

module.exports = {
    ...controller,
    createNotificationController,
};
