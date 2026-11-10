const paymentAttemptRepository = require("../services/mpesaPaymentAttemptRepository");
const callbackInboxRepository = require("../services/mpesaCallbackInboxRepository");
const providerService = require("../services/mpesaService");
const simulatorProviderService = require("../services/mpesaSimulatorService");
const {
    createMpesaPaymentVerificationService,
} = require("../services/mpesaPaymentVerificationService");
const {
    createMpesaPaymentSettlementService,
} = require("../services/mpesaPaymentSettlementService");

function callbackResponse(res) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Notification received; payment outcome not verified" });
}

async function startStkPush(_req, res) {
    return res.status(503).json({
        status: "error",
        message: "M-Pesa deposits are temporarily unavailable while payment verification is being secured.",
    });
}

function createMpesaVerificationController(verificationService) {
    return {
        async handleStkCallback(req, res) {
            try {
                await verificationService.processCallback(req.body);
                return callbackResponse(res);
            } catch (error) {
                if (error?.code === "INVALID_MPESA_CALLBACK") {
                    return res.status(400).json({
                        ResultCode: 1,
                        ResultDesc: "Invalid payment notification",
                    });
                }
                console.error("M-Pesa callback verification failed.", {
                    code: typeof error?.code === "string" ? error.code : "VERIFICATION_ERROR",
                });
                return res.status(503).json({
                    ResultCode: 1,
                    ResultDesc: "Payment notification could not be verified",
                });
            }
        },

        async replayUnmatchedCallbacks(_req, res) {
            try {
                const results = await verificationService.replayUnmatchedCallbacks();
                return res.status(200).json({
                    status: "success",
                    replayed: results.length,
                    verified: results.filter((result) =>
                        ["VERIFIED_SUCCESS", "VERIFIED_FAILURE"].includes(result.verification_status)
                    ).length,
                });
            } catch (error) {
                console.error("M-Pesa callback replay failed.", {
                    code: typeof error?.code === "string" ? error.code : "CALLBACK_REPLAY_ERROR",
                });
                return res.status(503).json({
                    status: "error",
                    message: "Stored payment notifications could not be replayed",
                });
            }
        },

        async reconcileStkAttempt(req, res) {
            try {
                const result = await verificationService.reconcileAttempt(req.params.attemptId);
                return res.status(200).json({
                    status: "success",
                    verification_status: result.verification_status,
                    duplicate: result.duplicate,
                });
            } catch (error) {
                const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 503;
                console.error("M-Pesa payment reconciliation failed.", {
                    code: typeof error?.code === "string" ? error.code : "VERIFICATION_ERROR",
                });
                return res.status(statusCode).json({
                    status: "error",
                    message: statusCode === 404
                        ? "Payment attempt was not found"
                        : "Payment status could not be verified",
                });
            }
        },
    };
}

const verificationService = createMpesaPaymentVerificationService({
        paymentAttemptRepository,
        callbackInboxRepository,
        providerService,
        simulatorProviderService,
        settlementService: createMpesaPaymentSettlementService({ paymentAttemptRepository }),
    });

const verificationController = createMpesaVerificationController(verificationService);

function createMpesaStatusController(repository) {
    if (!repository || typeof repository.getWorkerPaymentStatus !== "function") {
        throw new TypeError("A worker-scoped payment status repository is required.");
    }

    return {
        async getStkPushStatus(req, res) {
            const statusReference = req.params.statusReference || req.params.checkoutRequestId;
            try {
                const payment = await repository.getWorkerPaymentStatus(
                    statusReference,
                    req.user.userId
                );
                if (!payment) {
                    return res.status(404).json({
                        status: "error",
                        message: "Payment was not found for this account",
                    });
                }
                return res.status(200).json({ status: "success", data: payment });
            } catch (error) {
                const statusCode = error?.statusCode === 400 ? 400 : 500;
                if (statusCode !== 400) {
                    console.error("Failed to retrieve M-Pesa payment status.", {
                        code: typeof error?.code === "string" ? error.code : "STATUS_LOOKUP_ERROR",
                    });
                }
                return res.status(statusCode).json({
                    status: "error",
                    message: statusCode === 400
                        ? "Invalid payment status reference"
                        : "Could not retrieve payment status",
                });
            }
        },

        async getStkPushStatusByIdempotencyKey(req, res) {
            try {
                if (typeof repository.getWorkerPaymentStatusByIdempotencyKey !== "function") {
                    throw new Error("Idempotency status lookup is unavailable.");
                }
                const payment = await repository.getWorkerPaymentStatusByIdempotencyKey(
                    req.params.idempotencyKey,
                    req.user.userId
                );
                if (!payment) {
                    return res.status(404).json({
                        status: "error",
                        message: "Payment was not found for this account",
                    });
                }
                return res.status(200).json({ status: "success", data: payment });
            } catch (error) {
                const statusCode = error?.statusCode === 400 ? 400 : 500;
                if (statusCode !== 400) {
                    console.error("Failed to retrieve M-Pesa payment by idempotency key.", {
                        code: typeof error?.code === "string" ? error.code : "STATUS_LOOKUP_ERROR",
                        message: typeof error?.message === "string" ? error.message : "Unknown status lookup error",
                    });
                }
                return res.status(statusCode).json({
                    status: "error",
                    message: statusCode === 400
                        ? "Invalid payment status reference"
                        : "Could not retrieve payment status",
                });
            }
        },
    };
}

const statusController = createMpesaStatusController(paymentAttemptRepository);

module.exports = {
    ...verificationController,
    createMpesaVerificationController,
    ...statusController,
    createMpesaStatusController,
    startStkPush,
    verificationService,
};
