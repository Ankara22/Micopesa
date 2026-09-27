const pool = require("../db/database");

const VALID_REPORT_TYPES = ["RBA", "NSSF", "INTERNAL"];

/**
 * POST /api/compliance-reports
 * FUND_MANAGER or REGULATOR only (matches the enforce_compliance_report_generator_role
 * trigger). generated_by is always the acting user's own userId - never
 * trusted from the request body.
 * Body: { report_type, period_start, period_end }
 */
async function createReport(req, res) {
    const { userId } = req.user;
    const { report_type, period_start, period_end } = req.body;

    if (!report_type || !period_start || !period_end) {
        return res.status(400).json({
            status: "error",
            message: "report_type, period_start, and period_end are required",
        });
    }

    if (!VALID_REPORT_TYPES.includes(report_type)) {
        return res.status(400).json({
            status: "error",
            message: `report_type must be one of: ${VALID_REPORT_TYPES.join(", ")}`,
        });
    }

    if (new Date(period_end) < new Date(period_start)) {
        return res.status(400).json({ status: "error", message: "period_end must not be before period_start" });
    }

    try {
        const result = await pool.query(
            `INSERT INTO compliance_reports (generated_by, report_type, period_start, period_end)
             VALUES ($1, $2, $3, $4)
             RETURNING report_id, generated_by, report_type, period_start, period_end, rba_status, generated_at`,
            [userId, report_type, period_start, period_end]
        );

        return res.status(201).json({
            status: "success",
            message: "Compliance report created successfully",
            data: { report: result.rows[0] },
        });
    } catch (error) {
        console.error("Failed to create compliance report:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to create compliance report due to a server error",
        });
    }
}

/**
 * GET /api/compliance-reports
 * FUND_MANAGER or REGULATOR - both roles may view all compliance reports
 * (compliance oversight/reporting is a shared responsibility per the
 * design docs), newest first.
 */
async function listReports(req, res) {
    try {
        const result = await pool.query(
            `SELECT cr.report_id, cr.generated_by, u.full_name AS generated_by_name, u.role AS generated_by_role,
                    cr.report_type, cr.period_start, cr.period_end, cr.rba_status, cr.generated_at
             FROM compliance_reports cr
             JOIN users u ON u.user_id = cr.generated_by
             ORDER BY cr.generated_at DESC`
        );

        return res.status(200).json({ status: "success", data: result.rows });
    } catch (error) {
        console.error("Failed to list compliance reports:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to list compliance reports due to a server error",
        });
    }
}

/**
 * GET /api/compliance-reports/:reportId
 */
async function getReport(req, res) {
    const { reportId } = req.params;

    try {
        const result = await pool.query(
            `SELECT cr.report_id, cr.generated_by, u.full_name AS generated_by_name, u.role AS generated_by_role,
                    cr.report_type, cr.period_start, cr.period_end, cr.rba_status, cr.generated_at
             FROM compliance_reports cr
             JOIN users u ON u.user_id = cr.generated_by
             WHERE cr.report_id = $1`,
            [reportId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ status: "error", message: "Compliance report not found" });
        }

        return res.status(200).json({ status: "success", data: { report: result.rows[0] } });
    } catch (error) {
        console.error("Failed to fetch compliance report:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch compliance report due to a server error",
        });
    }
}

module.exports = { createReport, listReports, getReport };
