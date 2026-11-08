const { createWorkerStatementService } = require("../services/workerStatementService");

function createWorkerStatementController({ service }) {
    if (!service) throw new TypeError("A worker statement service is required.");

    return {
        async download(req, res) {
            try {
                const statement = await service.generate({
                    userId: req.user.userId,
                    role: req.user.role,
                    format: req.query?.format,
                    filters: {
                        ...(req.query?.start_date ? { start_date: req.query.start_date } : {}),
                        ...(req.query?.end_date ? { end_date: req.query.end_date } : {}),
                        ...(req.query?.contribution_status
                            ? { contribution_status: req.query.contribution_status }
                            : {}),
                    },
                });
                const date = new Date().toISOString().slice(0, 10);
                res.setHeader("Content-Type", statement.contentType);
                res.setHeader(
                    "Content-Disposition",
                    `attachment; filename="micopesa-my-statement-${date}.${statement.extension}"`
                );
                res.setHeader("Cache-Control", "private, no-store");
                res.setHeader("X-Statement-Row-Count", String(statement.rows));
                res.setHeader("X-Statement-Total-Count", String(statement.totalCount));
                res.setHeader("X-Statement-Truncated", String(statement.truncated));
                return res.status(200).send(statement.buffer);
            } catch (error) {
                const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
                if (statusCode >= 500) {
                    console.error("Worker statement generation failed.", {
                        code: error?.code || "STATEMENT_GENERATION_FAILED",
                    });
                }
                return res.status(statusCode).json({
                    status: "error",
                    message: statusCode < 500 ? error.message : "Could not generate the statement.",
                    ...(typeof error?.code === "string" ? { code: error.code } : {}),
                });
            }
        },
    };
}

let defaultController;
function download(req, res) {
    if (!defaultController) {
        const pool = require("../db/database");
        defaultController = createWorkerStatementController({
            service: createWorkerStatementService(pool),
        });
    }
    return defaultController.download(req, res);
}

module.exports = { createWorkerStatementController, download };
