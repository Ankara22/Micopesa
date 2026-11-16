const paymentAttemptRepository = require("../services/mpesaPaymentAttemptRepository");
const providerService = require("../services/mpesaService");
const {
    createMpesaPaymentOrchestrationService,
} = require("../services/mpesaPaymentOrchestrationService");
const {
    getPaymentProviderConfiguration,
} = require("../services/mpesaPaymentProviderConfig");
const {
    createPensionLedgerReadinessGuard,
} = require("../services/mpesaLedgerReadiness");

async function getPaymentAvailability({
    environmentProvider = () => process.env,
    darajaProviderService = providerService,
    ledgerReadinessCheck = paymentAttemptRepository.assertPensionLedgerActive,
} = {}) {
    let configuration;
    try {
        configuration = getPaymentProviderConfiguration(environmentProvider());
    } catch {
        return {
            enabled: false,
            message: "M-Pesa payment configuration is invalid.",
            messageKey: "MPESA_CONFIGURATION_INVALID",
        };
    }

    if (configuration.provider !== "DARAJA") {
        return {
            enabled: false,
            message: "M-Pesa payment initiation is not enabled.",
            messageKey: "MPESA_PROVIDER_UNAVAILABLE",
        };
    }
    if (!configuration.paymentEnabled) {
        return {
            enabled: false,
            message: "M-Pesa payment initiation is not enabled.",
            messageKey: "MPESA_PAYMENTS_DISABLED",
        };
    }

    try {
        const darajaConfiguration = darajaProviderService.assertConfigured();
        if (darajaConfiguration?.paymentEnabled !== true) {
            return {
                enabled: false,
                message: "M-Pesa payment initiation is not enabled.",
                messageKey: "MPESA_PAYMENTS_DISABLED",
            };
        }
    } catch {
        return {
            enabled: false,
            message: "M-Pesa payment configuration is incomplete.",
            messageKey: "MPESA_CONFIGURATION_INCOMPLETE",
        };
    }

    try {
        const assertLedgerReady = createPensionLedgerReadinessGuard({
            environmentProvider,
            assertPensionLedgerActive: ledgerReadinessCheck,
        });
        await assertLedgerReady();
        return { enabled: true };
    } catch (error) {
        const invalidConfiguration =
            error?.code === "PENSION_LEDGER_ENFORCEMENT_CONFIG_INVALID";
        return {
            enabled: false,
            message: invalidConfiguration
                ? "M-Pesa payment configuration is invalid."
                : "Pension ledger readiness could not be established.",
            messageKey: invalidConfiguration
                ? "MPESA_CONFIGURATION_INVALID"
                : "MPESA_LEDGER_NOT_READY",
        };
    }
}

function createMpesaDarajaController({
    repository = paymentAttemptRepository,
    darajaProviderService = providerService,
    orchestrationService,
    environmentProvider = () => process.env,
} = {}) {
    const resolvedOrchestrationService = orchestrationService === undefined
        ? createMpesaPaymentOrchestrationService({
            paymentAttemptRepository: repository,
            providerService: darajaProviderService,
            environmentProvider,
        })
        : orchestrationService;

    return {
        async startStkPush(req, res) {
            const availability = await getPaymentAvailability({
                environmentProvider,
                darajaProviderService,
                ledgerReadinessCheck: repository.assertPensionLedgerActive,
            });
            if (!availability.enabled) {
                return res.status(503).json({
                    status: "error",
                    message: availability.message,
                    message_key: availability.messageKey,
                });
            }

            if (req.user?.role !== "WORKER" || typeof req.user.userId !== "string") {
                return res.status(req.user ? 403 : 401).json({
                    status: "error",
                    message: "An eligible worker account is required to initiate a payment.",
                });
            }

            try {
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

                const input = {
                    workerId: req.user.userId,
                    idempotencyKey: req.body?.idempotencyKey,
                    amount: req.body?.amount,
                    phoneNumber,
                };
                const result = req.body?.contributionId
                    ? await resolvedOrchestrationService.retryWorkerPayment({
                        ...input,
                        contributionId: req.body.contributionId,
                    })
                    : await resolvedOrchestrationService.initiateWorkerPayment(input);

                return res.status(200).json({ status: "success", data: result });
            } catch (error) {
                const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 503;
                console.error("M-Pesa payment initiation failed.", {
                    code: typeof error?.code === "string" ? error.code : "PAYMENT_INITIATION_ERROR",
                });
                return res.status(statusCode).json({
                    status: "error",
                    message: statusCode === 400
                        ? "Invalid M-Pesa payment request"
                        : statusCode === 409
                            ? "The verified account phone or payment attempt is not eligible"
                            : "M-Pesa payment initiation is unavailable",
                });
            }
        },
    };
}

async function requireDarajaPaymentEnabled(req, res, next) {
    const availability = await getPaymentAvailability();
    if (!availability.enabled) {
        return res.status(503).json({
            status: "error",
            message: availability.message,
            message_key: availability.messageKey,
        });
    }
    return next();
}

module.exports = {
    createMpesaDarajaController,
    getPaymentAvailability,
    requireDarajaPaymentEnabled,
    ...createMpesaDarajaController(),
};
