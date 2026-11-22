const {
    createPhonePasswordRecoveryService,
    GENERIC_MESSAGE,
} = require("../services/phonePasswordRecoveryService");

function createPhonePasswordRecoveryController(service = createPhonePasswordRecoveryService()) {
    async function handle(res, operation) {
        try {
            const result = await operation();
            return res.status(200).json({
                status: "success",
                message: result.message || GENERIC_MESSAGE,
                ...(result.challengeId ? { data: { challenge_id: result.challengeId } } : {}),
            });
        } catch (error) {
            const code = typeof error?.code === "string" &&
                /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code)
                ? error.code
                : "PHONE_RECOVERY_FAILED";
            const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
            if (status >= 500) {
                console.error("Phone password recovery failed.", {
                    code,
                    configurationVariables: Array.isArray(error?.diagnostics?.missingVariables)
                        ? error.diagnostics.missingVariables
                        : [],
                });
            }
            return res.status(status).json({
                status: "error",
                code,
                message: status >= 500
                    ? "Unable to complete phone recovery right now."
                    : error.message,
            });
        }
    }

    return {
        requestCode(req, res) {
            return handle(res, () => service.requestCode(req.body, req));
        },
        completeRecovery(req, res) {
            return handle(res, () => service.completeRecovery(req.body, req));
        },
    };
}

module.exports = createPhonePasswordRecoveryController();
module.exports.createPhonePasswordRecoveryController = createPhonePasswordRecoveryController;
