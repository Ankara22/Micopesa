const {
    createWorkerRegistrationService,
    GENERIC_REGISTRATION_MESSAGE,
} = require("../services/workerRegistrationService");

function createWorkerRegistrationController(service = createWorkerRegistrationService()) {
    async function respond(res, operation, statusCode = 200) {
        try {
            const result = await operation();
            const data = {
                ...(result.challengeId ? { challenge_id: result.challengeId } : {}),
                ...(result.accountStatus ? {
                    account_status: result.accountStatus,
                    kyc_status: result.kycStatus,
                } : {}),
            };
            return res.status(statusCode).json({
                status: "success",
                message: result.message || GENERIC_REGISTRATION_MESSAGE,
                ...(Object.keys(data).length ? { data } : {}),
            });
        } catch (error) {
            const safeCode = typeof error?.code === "string" &&
                /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code)
                ? error.code
                : "WORKER_REGISTRATION_FAILED";
            const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
            if (status >= 500) {
                if (process.env.NODE_ENV !== "production") { console.error("Registration diagnostic:", { name: error?.name, message: error?.message, stack: error?.stack }); } console.error("Worker registration failed.", {
                    code: safeCode,
                    configurationVariables: Array.isArray(error?.diagnostics?.missingVariables)
                        ? error.diagnostics.missingVariables
                        : Array.isArray(error?.configurationVariables)
                            ? error.configurationVariables
                            : [],
                });
            }
            return res.status(status).json({
                status: "error",
                code: safeCode,
                message: status >= 500
                    ? "Unable to complete worker registration right now."
                    : error.message,
            });
        }
    }

    return {
        startRegistration(req, res) {
            return respond(
                res,
                () => service.startRegistration(req.body, req),
                202
            );
        },
        resendRegistrationCode(req, res) {
            return respond(
                res,
                () => service.resendRegistrationCode(req.body?.challenge_id, req)
            );
        },
        completeRegistration(req, res) {
            return respond(
                res,
                () => service.completeRegistration({
                    challengeId: req.body?.challenge_id,
                    code: req.body?.code,
                    password: req.body?.password,
                }, req),
                202
            );
        },
    };
}

module.exports = createWorkerRegistrationController();
module.exports.createWorkerRegistrationController = createWorkerRegistrationController;
