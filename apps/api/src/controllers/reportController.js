const { createReportService } = require("../services/reportService");

function createReportController({ service }) {
    if (!service) throw new TypeError("A report service is required.");

    function handleError(res, error, fallback) {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        if (statusCode >= 500) {
            console.error("Report operation failed.", {
                code: typeof error?.code === "string" ? error.code : "REPORT_OPERATION_FAILED",
            });
        }
        return res.status(statusCode).json({
            status: "error",
            message: statusCode < 500 ? error.message : fallback,
            ...(typeof error?.code === "string" ? { code: error.code } : {}),
        });
    }

    function sendDownload(res, report, name) {
        res.setHeader("Content-Type", report.contentType);
        res.setHeader("Content-Disposition", `attachment; filename="${name}.${report.extension}"`);
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("X-Report-Id", report.reportId);
        res.setHeader("X-Report-Truncated", String(Boolean(report.truncated)));
        res.setHeader("X-Report-Row-Count", String(report.rows));
        res.setHeader("X-Report-Total-Count", String(report.totalCount ?? report.rows));
        res.setHeader("X-Report-Total-Count-Is-Lower-Bound", String(Boolean(report.truncated)));
        return res.status(200).send(report.buffer);
    }

    return {
        async generate(req, res) {
            try {
                const report = await service.generate({
                    userId: req.user.userId,
                    role: req.user.role,
                    reportKey: req.body?.report_key,
                    filters: req.body?.filters || {},
                    format: req.body?.format,
                    language: req.body?.language,
                });
                return sendDownload(
                    res,
                    report,
                    `micopesa-${req.body.report_key}-${new Date().toISOString().slice(0, 10)}`
                );
            } catch (error) {
                return handleError(res, error, "Could not generate the report.");
            }
        },

        async listHistory(req, res) {
            try {
                const data = await service.listHistory({
                    userId: req.user.userId,
                    role: req.user.role,
                });
                return res.status(200).json({ status: "success", data });
            } catch (error) {
                return handleError(res, error, "Could not retrieve report history.");
            }
        },

        async listCatalog(req, res) {
            try {
                return res.status(200).json({
                    status: "success",
                    data: service.listCatalog(req.user.role),
                });
            } catch (error) {
                return handleError(res, error, "Could not retrieve report types.");
            }
        },

        async listFunds(req, res) {
            try {
                const data = await service.listFunds({
                    userId: req.user.userId,
                    role: req.user.role,
                });
                return res.status(200).json({ status: "success", data });
            } catch (error) {
                return handleError(res, error, "Could not retrieve report scopes.");
            }
        },

        async analytics(req, res) {
            try {
                const data = await service.getAnalytics({
                    userId: req.user.userId,
                    role: req.user.role,
                    filters: req.query || {},
                });
                return res.status(200).json({ status: "success", data });
            } catch (error) {
                return handleError(res, error, "Could not retrieve analytics.");
            }
        },

        async download(req, res) {
            try {
                const report = await service.download({
                    userId: req.user.userId,
                    role: req.user.role,
                    reportId: req.params.reportId,
                    language: req.query?.language,
                });
                return sendDownload(res, report, `micopesa-report-${report.reportId}`);
            } catch (error) {
                return handleError(res, error, "Could not download the report.");
            }
        },
    };
}

let defaultController;
function getDefaultController() {
    if (!defaultController) {
        const pool = require("../db/database");
        defaultController = createReportController({ service: createReportService(pool) });
    }
    return defaultController;
}

module.exports = {
    createReportController,
    generate: (...args) => getDefaultController().generate(...args),
    listHistory: (...args) => getDefaultController().listHistory(...args),
    listCatalog: (...args) => getDefaultController().listCatalog(...args),
    listFunds: (...args) => getDefaultController().listFunds(...args),
    analytics: (...args) => getDefaultController().analytics(...args),
    download: (...args) => getDefaultController().download(...args),
};
