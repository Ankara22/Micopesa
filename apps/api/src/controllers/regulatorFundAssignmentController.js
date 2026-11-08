const { createRegulatorFundAssignmentRepository } = require("../services/regulatorFundAssignmentRepository");

function createRegulatorFundAssignmentController({ repository }) {
    if (!repository) throw new TypeError("A regulator assignment repository is required.");

    function handleError(res, error, fallback) {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        if (statusCode >= 500) {
            console.error("Regulator scope operation failed.", {
                code: typeof error?.code === "string" ? error.code : "REGULATOR_SCOPE_FAILED",
            });
        }
        return res.status(statusCode).json({
            status: "error",
            message: statusCode < 500 ? error.message : fallback,
            ...(typeof error?.code === "string" ? { code: error.code } : {}),
        });
    }

    return {
        async list(_req, res) {
            try {
                return res.status(200).json({ status: "success", data: await repository.list() });
            } catch (error) {
                return handleError(res, error, "Could not retrieve regulator scopes.");
            }
        },
        async listCandidates(_req, res) {
            try {
                return res.status(200).json({ status: "success", data: await repository.listCandidates() });
            } catch (error) {
                return handleError(res, error, "Could not retrieve assignment options.");
            }
        },
        async assign(req, res) {
            try {
                const data = await repository.assign({
                    adminId: req.user.userId,
                    regulatorId: req.body?.regulator_id,
                    fundId: req.body?.fund_id,
                });
                return res.status(200).json({ status: "success", data });
            } catch (error) {
                return handleError(res, error, "Could not assign the regulator scope.");
            }
        },
        async revoke(req, res) {
            try {
                await repository.revoke({
                    adminId: req.user.userId,
                    regulatorId: req.params.regulatorId,
                    fundId: req.params.fundId,
                });
                return res.status(200).json({ status: "success" });
            } catch (error) {
                return handleError(res, error, "Could not revoke the regulator scope.");
            }
        },
    };
}

let defaultController;
function getDefaultController() {
    if (!defaultController) {
        const pool = require("../db/database");
        defaultController = createRegulatorFundAssignmentController({
            repository: createRegulatorFundAssignmentRepository(pool),
        });
    }
    return defaultController;
}

module.exports = {
    createRegulatorFundAssignmentController,
    list: (...args) => getDefaultController().list(...args),
    listCandidates: (...args) => getDefaultController().listCandidates(...args),
    assign: (...args) => getDefaultController().assign(...args),
    revoke: (...args) => getDefaultController().revoke(...args),
};
