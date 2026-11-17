const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const paymentAttemptRepository = require("../services/mpesaPaymentAttemptRepository");
const simulatorProviderService = require("../services/mpesaSimulatorService");
const darajaProviderService = require("../services/mpesaService");
const {
    assertSimulatorRequest,
    getPaymentProviderConfiguration,
} = require("../services/mpesaPaymentProviderConfig");
const {
    createMpesaPaymentOrchestrationService,
} = require("../services/mpesaPaymentOrchestrationService");
const {
    createPensionLedgerReadinessGuard,
} = require("../services/mpesaLedgerReadiness");
const { verificationService } = require("./mpesaController");

function writeSanitizedDiagnostic(diagnostic) {
    const logPath = path.join(os.tmpdir(), "micopesa-simulator-diagnostics.log");
    try {
        fs.appendFileSync(
            logPath,
            `${JSON.stringify({ timestamp: new Date().toISOString(), ...diagnostic })}\n`,
            { encoding: "utf8", mode: 0o600 }
        );
    } catch (error) {
        console.error("Could not persist simulated payment diagnostics.", {
            code: typeof error?.code === "string" ? error.code : "DIAGNOSTIC_LOG_WRITE_FAILED",
        });
    }
}

function getPublicFailure(error, statusCode) {
    if (error?.code === "PAYMENT_ALLOCATION_INVALID") {
        return {
            messageKey: "MPESA_ALLOCATION_INVALID",
            message: "Set valid allocations across active funds totaling 100% before starting a contribution. No payment was started.",
        };
    }
    if (error?.code === "PAYMENT_ACCOUNT_NOT_FOUND") {
        return {
            messageKey: "MPESA_ACCOUNT_NOT_AVAILABLE",
            message: "An active pension account is required to start a payment. No payment was started.",
        };
    }
    if (
        error?.code === "PAYMENT_CONTRIBUTION_NOT_FOUND" ||
        error?.code === "PAYMENT_CONTRIBUTION_NOT_ELIGIBLE"
    ) {
        return {
            messageKey: "MPESA_CONTRIBUTION_NOT_ELIGIBLE",
            message: "This contribution is not eligible for a new payment attempt. Check its status before retrying.",
        };
    }
    if (error?.code === "IDEMPOTENCY_KEY_CONFLICT") {
        return {
            messageKey: "MPESA_IDEMPOTENCY_CONFLICT",
            message: "This request key is already associated with a different payment request. Check payment status before retrying.",
        };
    }
    if (error?.code === "PAYMENT_PROVIDER_CONFIGURATION_ERROR") {
        return statusCode === 409
            ? {
                messageKey: "MPESA_PROVIDER_MISMATCH",
                message: "The requested payment method does not match the simulator configured on this server. No payment was started.",
            }
            : {
                messageKey: "MPESA_SIMULATOR_UNAVAILABLE",
                message: "The payment simulator is unavailable in this environment. No payment was started.",
            };
    }
    if (String(error?.code || "").startsWith("PENSION_LEDGER_")) {
        return {
            messageKey: "MPESA_LEDGER_NOT_READY",
            message: "Payments are unavailable until the pension ledger is verified as active. No payment was started.",
        };
    }
    if (statusCode === 409) {
        return {
            messageKey: "MPESA_REQUEST_CONFLICT",
            message: "The payment request conflicts with the current account or attempt state. Check payment status before retrying.",
        };
    }
    return {
        messageKey: statusCode === 403
            ? "MPESA_SIMULATOR_FORBIDDEN"
            : statusCode === 404
                ? "MPESA_REQUEST_NOT_FOUND"
                : statusCode === 400
                    ? "MPESA_INVALID_REQUEST"
                    : "MPESA_INITIATION_UNAVAILABLE",
        message: statusCode === 403
            ? "The payment simulator cannot run in this environment."
            : statusCode === 404
                ? "The requested payment or active account could not be found."
                : statusCode === 400
                    ? "The payment request is invalid. No payment was started."
                    : "Payment initiation could not be completed. Check contribution history before retrying.",
    };
}

function createMpesaSimulatorController({
    repository = paymentAttemptRepository,
    providerService = simulatorProviderService,
    darajaConfigurationService = darajaProviderService,
    paymentVerificationService = verificationService,
    environmentProvider = () => process.env,
    diagnosticSink = writeSanitizedDiagnostic,
} = {}) {
    const orchestrationService = createMpesaPaymentOrchestrationService({
        paymentAttemptRepository: repository,
        providerService,
        environmentProvider,
    });
    const assertLedgerReady = createPensionLedgerReadinessGuard({
        environmentProvider,
        assertPensionLedgerActive: repository.assertPensionLedgerActive,
    });

    async function assertSimulatorLedgerReady() {
        if (typeof repository.assertPensionLedgerActive !== "function") {
            const error = new Error("Pension ledger readiness could not be established.");
            error.code = "PENSION_LEDGER_READINESS_UNAVAILABLE";
            error.statusCode = 503;
            throw error;
        }
        await repository.assertPensionLedgerActive();
    }

    function requireWorker(req, res) {
        if (req.user?.role !== "WORKER" || typeof req.user.userId !== "string") {
            res.status(req.user ? 403 : 401).json({
                status: "error",
                message: "A worker account is required for simulated payments.",
            });
            return false;
        }
        return true;
    }

    function diagnosticCategory(error, statusCode) {
        if (/^\d{5}$/.test(String(error?.code || "")) ||
            error?.constraint || error?.table || error?.column) {
            return "DATABASE";
        }
        if ((statusCode >= 400 && statusCode < 500) ||
            String(error?.code || "").startsWith("INVALID_")) {
            return "VALIDATION";
        }
        return "APPLICATION";
    }

    function safeErrorMessage(value) {
        return String(value || "Unknown error")
            .replace(/postgres(?:ql)?:\/\/\S+/gi, "[REDACTED_DATABASE_URL]")
            .replace(/\b(password|token|secret|authorization|database_url)\b\s*[:=]\s*[^,\s;]+/gi, "$1=[REDACTED]")
            .replace(/\b(?:\+?254|0)(?:[17]\d{8})\b/g, "[REDACTED_PHONE]")
            .replace(/\bidempotency(?:[_\s-]*key)?\b\s*[:=]\s*\S+/gi, "idempotency_key=[REDACTED]")
            .replace(/\(idempotency_key\)\s*=\s*\([^)]*\)/gi, "(idempotency_key)=([REDACTED])");
    }

    function sourceLocation(error) {
        const frames = String(error?.stack || "").split("\n").slice(1);
        const frame = frames
            .map((entry) => entry.replace(/\\+/g, "\\"))
            .find((entry) => /[\\/]apps[\\/]api[\\/]src[\\/]/i.test(entry));
        if (!frame) return null;
        const match = frame.match(/([A-Za-z]:[\\/].*?[\\/]apps[\\/]api[\\/]src[\\/].*?):(\d+):(\d+)/i);
        return match
            ? `${match[1].replace(/\\/g, "/").replace(/^.*\/apps\/api\//i, "apps/api/")}:${match[2]}:${match[3]}`
            : frame.trim().slice(0, 240);
    }

    function logFailure(error, req, statusCode) {
        const stack = safeErrorMessage(error?.stack)
            .replace(/^[^\r\n]*(?:\r?\n|$)/, "")
            .split(/\r?\n/)
            .filter((line) => line.trim().startsWith("at "))
            .slice(0, 20)
            .join("\n");
        const diagnostic = {
            category: diagnosticCategory(error, statusCode),
            code: typeof error?.code === "string" ? error.code : null,
            statusCode,
            message: safeErrorMessage(error?.message),
            constraint: typeof error?.constraint === "string" ? error.constraint : null,
            table: typeof error?.table === "string" ? error.table : null,
            column: typeof error?.column === "string" ? error.column : null,
            sourceLocation: sourceLocation(error),
            stack,
            stage: typeof error?.paymentStage === "string"
                ? error.paymentStage
                : "simulator_confirmation",
            attemptId: typeof req?.params?.attemptId === "string" ? req.params.attemptId : null,
            route: `${req?.method || "UNKNOWN"} ${req?.baseUrl || ""}${req?.route?.path || req?.path || ""}`,
        };
        (statusCode >= 500 ? console.error : console.warn)(
            "Simulated payment request failed.",
            diagnostic
        );
        diagnosticSink(diagnostic);
    }

    function sendFailure(res, error, req) {
        const statusCode = Number.isInteger(error?.statusCode) &&
            error.statusCode >= 400 && error.statusCode <= 599
            ? error.statusCode
            : 503;
        logFailure(error, req, statusCode);
        const publicFailure = getPublicFailure(error, statusCode);
        return res.status(statusCode).json({
            status: "error",
            message: publicFailure.message,
            message_key: publicFailure.messageKey,
        });
    }

    async function paymentResponse(res, attempt, confirmation, workerId, created) {
        const status = await repository.getWorkerPaymentStatus(attempt.attempt_id, workerId);
        if (!status) {
            const error = new Error("Payment attempt was not found for this worker.");
            error.statusCode = 404;
            throw error;
        }
        const outcome = confirmation.outcome ||
            (confirmation.verification_status === "VERIFIED_SUCCESS"
                ? "SUCCESS"
                : confirmation.verification_status === "VERIFIED_FAILURE"
                    ? "FAILED"
                    : status.verification_description?.includes("still pending")
                        ? "PENDING"
                        : "UNKNOWN");
        return res.status(200).json({
            status: "success",
            data: {
                ...status,
                attempt_status: status.attempt_status || attempt.payment_status,
                amount: Number(status.amount ?? attempt.amount),
                payment_provider: "SIMULATED",
                simulated: true,
                no_real_money_transferred: true,
                payment_outcome: outcome,
                verification_status: confirmation.verification_status,
                verification_duplicate: Boolean(confirmation.duplicate),
                created,
            },
        });
    }

    return {
        async getPaymentProvider(_req, res) {
            try {
                const configuration = getPaymentProviderConfiguration(environmentProvider());
                let paymentEnabled = configuration.paymentEnabled;
                let messageKey = paymentEnabled
                    ? "MPESA_PAYMENTS_AVAILABLE"
                    : "MPESA_PAYMENTS_DISABLED";
                if (configuration.provider === "DARAJA" && paymentEnabled) {
                    try {
                        const darajaConfiguration = darajaConfigurationService.assertConfigured();
                        paymentEnabled = darajaConfiguration?.paymentEnabled === true;
                        if (!paymentEnabled) messageKey = "MPESA_PAYMENTS_DISABLED";
                    } catch {
                        paymentEnabled = false;
                        messageKey = "MPESA_CONFIGURATION_INCOMPLETE";
                    }
                }
                if (paymentEnabled) {
                    try {
                        if (configuration.provider === "SIMULATOR") {
                            await assertSimulatorLedgerReady();
                        } else {
                            await assertLedgerReady();
                        }
                    } catch (error) {
                        paymentEnabled = false;
                        messageKey = error?.code === "PENSION_LEDGER_ENFORCEMENT_CONFIG_INVALID"
                            ? "MPESA_CONFIGURATION_INVALID"
                            : "MPESA_LEDGER_NOT_READY";
                    }
                }
                const environment = configuration.provider === "SIMULATOR"
                    ? "simulator"
                    : configuration.darajaEnvironment || "unavailable";
                return res.status(200).json({
                    status: "success",
                    data: {
                        provider: configuration.provider,
                        environment,
                        payment_enabled: paymentEnabled,
                        message_key: messageKey,
                    },
                });
            } catch {
                return res.status(200).json({
                    status: "success",
                    data: {
                        provider: "UNAVAILABLE",
                        environment: "unavailable",
                        payment_enabled: false,
                        message_key: "MPESA_CONFIGURATION_INVALID",
                    },
                });
            }
        },

        async initiateSimulatedPayment(req, res) {
            if (!requireWorker(req, res)) return undefined;
            try {
                assertSimulatorRequest(req.body?.provider, environmentProvider());
                if (typeof repository.getVerifiedWorkerPhone !== "function") {
                    return res.status(503).json({
                        status: "error",
                        message: "A verified profile phone is required to initiate a payment.",
                        message_key: "MPESA_VERIFIED_PHONE_REQUIRED",
                    });
                }
                const phoneNumber = await repository.getVerifiedWorkerPhone(req.user.userId);
                if (!phoneNumber) {
                    return res.status(409).json({
                        status: "error",
                        message: "A verified profile phone is required to initiate a payment.",
                        message_key: "MPESA_VERIFIED_PHONE_REQUIRED",
                    });
                }
                await assertSimulatorLedgerReady();
                const input = {
                    workerId: req.user.userId,
                    idempotencyKey: req.body?.idempotencyKey,
                    amount: req.body?.amount,
                    phoneNumber,
                };
                const pending = req.body?.contributionId
                    ? await orchestrationService.retryWorkerPayment({
                        ...input,
                        contributionId: req.body.contributionId,
                    })
                    : await orchestrationService.initiateWorkerPayment(input);
                const confirmation = await paymentVerificationService.confirmSimulatorAttempt(
                    pending.attempt_id,
                    req.user.userId
                );
                return await paymentResponse(
                    res,
                    pending,
                    confirmation,
                    req.user.userId,
                    pending.created !== false
                );
            } catch (error) {
                if (error && typeof error === "object" && !error.paymentStage) {
                    error.paymentStage = "simulated_payment_orchestration";
                }
                return sendFailure(res, error, req);
            }
        },

        async confirmSimulatedPayment(req, res) {
            if (!requireWorker(req, res)) return undefined;
            try {
                assertSimulatorRequest(req.body?.provider, environmentProvider());
                const confirmation = await paymentVerificationService.confirmSimulatorAttempt(
                    req.params.attemptId,
                    req.user.userId
                );
                const attempt = await repository.findById(req.params.attemptId);
                if (!attempt || attempt.user_id !== req.user.userId) {
                    const error = new Error("Payment attempt was not found for this worker.");
                    error.statusCode = 404;
                    throw error;
                }
                return await paymentResponse(
                    res,
                    {
                        attempt_id: attempt.attempt_id,
                        amount: Number(attempt.expected_amount),
                        payment_status: attempt.attempt_status,
                    },
                    confirmation,
                    req.user.userId,
                    false
                );
            } catch (error) {
                if (error && typeof error === "object" && !error.paymentStage) {
                    error.paymentStage = "simulator_confirmation";
                }
                return sendFailure(res, error, req);
            }
        },
    };
}

module.exports = {
    createMpesaSimulatorController,
    ...createMpesaSimulatorController(),
};
