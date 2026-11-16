const notificationEventService = require("./notificationEventService");

function createMpesaPaymentSettlementService({
    paymentAttemptRepository,
    enqueueBusinessNotification = notificationEventService.enqueueBusinessNotification,
    environmentProvider = () => process.env,
    logger = console,
}) {
    if (!paymentAttemptRepository ||
        typeof paymentAttemptRepository.settleVerifiedPayment !== "function") {
        throw new TypeError("A payment-attempt settlement repository is required.");
    }
    if (typeof enqueueBusinessNotification !== "function") {
        throw new TypeError("A business notification enqueuer is required.");
    }
    if (typeof environmentProvider !== "function") {
        throw new TypeError("An environment provider is required.");
    }
    if (!logger || typeof logger.error !== "function") {
        throw new TypeError("A notification logger is required.");
    }

    return {
        async settleVerifiedPayment(input) {
            const result = await paymentAttemptRepository.settleVerifiedPayment(input, {
                environmentProvider,
            });
            if (
                result?.alreadySettled === false &&
                result.verification_status === "VERIFIED_SUCCESS" &&
                result.contribution_status === "COMPLETED" &&
                result.transaction_status === "COMPLETED" &&
                typeof result.user_id === "string" &&
                typeof result.contribution_id === "string"
            ) {
                try {
                    await enqueueBusinessNotification({
                        userId: result.user_id,
                        eventType: "CONTRIBUTION_CONFIRMED",
                        referenceId: result.contribution_id,
                        ...(result.provider_mode === "SIMULATOR" ? { simulated: true } : {}),
                    });
                } catch (error) {
                    const code = typeof error?.code === "string" &&
                        /^NOTIFICATION_[A-Z0-9_]{1,60}$/.test(error.code)
                        ? error.code
                        : "NOTIFICATION_ENQUEUE_FAILED";
                    logger.error("Settled contribution notification could not be enqueued.", { code });
                }
            }
            return result;
        },
    };
}

module.exports = { createMpesaPaymentSettlementService };
