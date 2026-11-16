const phoneChangeService = require("../services/phoneChangeService");

function createPhoneChangeController(service = phoneChangeService) {
    async function handle(res, operation, successStatus = 200) {
        try {
            const data = await operation();
            return res.status(successStatus).json({ status: "success", data });
        } catch (error) {
            const statusCode = Number.isInteger(error?.statusCode) &&
                error.statusCode >= 400 && error.statusCode <= 599
                ? error.statusCode
                : 500;
            const knownCodes = new Set([
                "PHONE_CHANGE_CONFIRMATION_REQUIRED",
                "PHONE_CHANGE_PASSWORD_REQUIRED",
                "PHONE_CHANGE_PASSWORD_INVALID",
                "PHONE_CHANGE_INVALID_PHONE",
                "PHONE_CHANGE_SAME_PHONE",
                "PHONE_CHANGE_PHONE_IN_USE",
                "PHONE_CHANGE_RATE_LIMITED",
                "PHONE_CHANGE_INVALID_CODE",
                "PHONE_CHANGE_CODE_EXPIRED",
                "PHONE_CHANGE_CHALLENGE_NOT_FOUND",
                "PHONE_CHANGE_SMS_UNAVAILABLE",
                "PHONE_CHANGE_SMS_CONFIGURATION_MISSING",
                "PHONE_CHANGE_SMS_PROVIDER_REJECTED",
                "PHONE_CHANGE_SMS_OUTCOME_UNKNOWN",
                "PHONE_CHANGE_SMS_DELIVERY_FAILED",
                "PHONE_CHANGE_ACCOUNT_NOT_FOUND",
            ]);
            const code = knownCodes.has(error?.code) ? error.code : "PHONE_CHANGE_FAILED";
            if (statusCode >= 500) {
                const diagnostics = error?.diagnostics || {};
                const safeVariableNames = (names) => Array.isArray(names)
                    ? names.filter((name) =>
                        typeof name === "string" && /^[A-Z][A-Z0-9_]{0,80}$/.test(name))
                    : [];
                console.error("Phone change operation failed.", {
                    code,
                    ...(typeof diagnostics.provider === "string" &&
                        ["AFRICAS_TALKING", "MOBILE_SASA"].includes(diagnostics.provider)
                        ? { provider: diagnostics.provider }
                        : {}),
                    ...(typeof diagnostics.reasonCode === "string" &&
                        /^SMS_[A-Z0-9_]{1,60}$/.test(diagnostics.reasonCode)
                        ? { reasonCode: diagnostics.reasonCode }
                        : {}),
                    ...(typeof diagnostics.providerErrorCode === "string" &&
                        /^SMS_[A-Z0-9_]{1,60}$/.test(diagnostics.providerErrorCode)
                        ? { providerErrorCode: diagnostics.providerErrorCode }
                        : {}),
                    missingVariables: safeVariableNames(diagnostics.missingVariables),
                    invalidVariables: safeVariableNames(diagnostics.invalidVariables),
                });
            }
            return res.status(statusCode).json({
                status: "error",
                code,
                message: statusCode >= 500
                    ? "Unable to complete phone verification right now."
                    : error.message,
            });
        }
    }

    return {
        requestPhoneChange(req, res) {
            return handle(res, () => service.startPhoneChange({
                userId: req.user.userId,
                currentPassword: req.body?.current_password,
                newPhone: req.body?.new_phone,
                confirmed: req.body?.confirmed,
            }), 202);
        },

        verifyPhoneChange(req, res) {
            return handle(res, async () => {
                const result = await service.verifyPhoneChange({
                    userId: req.user.userId,
                    code: req.body?.code,
                });
                if (result?.error) throw result.error;
                return result;
            });
        },
    };
}

module.exports = createPhoneChangeController();
module.exports.createPhoneChangeController = createPhoneChangeController;
