const { createMobileSasaDlrRepository } = require("../services/mobileSasaDlrRepository");

function createMobileSasaDlrController({ repository, logger = console } = {}) {
    if (!repository ||
        typeof repository.ingestDeliveryReport !== "function" ||
        typeof repository.reconcileUnmatched !== "function") {
        throw new TypeError("A Mobile Sasa delivery report repository is required.");
    }

    function sendError(res, error, fallbackMessage) {
        const statusCode = Number.isInteger(error?.statusCode) &&
            error.statusCode >= 400 && error.statusCode <= 599
            ? error.statusCode
            : 503;
        if (statusCode >= 500) {
            logger.error("Mobile Sasa delivery report processing failed.", {
                code: typeof error?.code === "string" &&
                    /^MOBILE_SASA_DLR_[A-Z0-9_]{1,48}$/.test(error.code)
                    ? error.code
                    : "MOBILE_SASA_DLR_PROCESSING_FAILED",
            });
        }
        return res.status(statusCode).json({
            status: "error",
            message: statusCode < 500 ? error.message : fallbackMessage,
        });
    }

    return {
        async receiveDeliveryReport(req, res) {
            try {
                if (!req.mobileSasaDeliveryReport || !(req.mobileSasaWebhookVerifiedAt instanceof Date)) {
                    const error = new Error("A valid delivery report is required.");
                    error.statusCode = 400;
                    throw error;
                }
                const result = await repository.ingestDeliveryReport(
                    req.mobileSasaDeliveryReport,
                    req.mobileSasaWebhookVerifiedAt
                );
                return res.status(200).json({
                    status: "received",
                    matched: result.matched,
                    duplicate: result.duplicate,
                    processingStatus: result.status,
                });
            } catch (error) {
                return sendError(res, error, "Delivery report could not be stored.");
            }
        },

        async replayUnmatched(req, res) {
            try {
                const limit = req.body?.limit === undefined ? 100 : req.body.limit;
                const result = await repository.reconcileUnmatched(limit);
                return res.status(200).json({ status: "success", data: result });
            } catch (error) {
                return sendError(res, error, "Unmatched delivery reports could not be reconciled.");
            }
        },
    };
}

let defaultController;
function getDefaultController() {
    if (!defaultController) {
        const pool = require("../db/database");
        defaultController = createMobileSasaDlrController({
            repository: createMobileSasaDlrRepository(pool),
        });
    }
    return defaultController;
}

module.exports = {
    createMobileSasaDlrController,
    receiveDeliveryReport: (req, res) => getDefaultController().receiveDeliveryReport(req, res),
    replayUnmatched: (req, res) => getDefaultController().replayUnmatched(req, res),
};
