const pool = require("../db/database");

async function getComplianceOverview(req, res) {
    try {
        const [audit, reports, latestRba] = await Promise.all([
            pool.query(
                `SELECT count(*)::int AS events_last_24h, max("timestamp") AS last_event_at
                 FROM audit_logs
                 WHERE "timestamp" >= now() - interval '24 hours'`
            ),
            pool.query(
                `SELECT rba_status, count(*)::int AS count
                 FROM compliance_reports
                 WHERE report_type = 'RBA'
                 GROUP BY rba_status
                 ORDER BY rba_status`
            ),
            pool.query(
                `SELECT report_id, rba_status, period_start, period_end, generated_at
                 FROM compliance_reports
                 WHERE report_type = 'RBA'
                 ORDER BY generated_at DESC
                 LIMIT 1`
            ),
        ]);

        const latest = latestRba.rows[0] || null;
        const complianceStatus = !latest
            ? "NOT_REPORTED"
            : latest.rba_status === "ACCEPTED"
                ? "COMPLIANT"
                : latest.rba_status === "REJECTED"
                    ? "ATTENTION_REQUIRED"
                    : "PENDING_REVIEW";

        return res.status(200).json({
            status: "success",
            data: {
                audit_health: audit.rows[0],
                rba_compliance_status: complianceStatus,
                rba_reports_by_status: reports.rows,
                latest_rba_report: latest,
                rba_parameter_checks: {
                    status: "NOT_CONFIGURED",
                    details: "The database schema contains no RBA-specific limits or parameter configuration to evaluate.",
                },
            },
        });
    } catch (error) {
        console.error("Failed to fetch regulator compliance overview:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch compliance overview due to a server error",
        });
    }
}

async function listReports(req, res) {
    try {
        const result = await pool.query(
            `SELECT cr.report_id, cr.generated_by, u.full_name AS generated_by_name,
                    u.role AS generated_by_role, cr.report_type, cr.period_start,
                    cr.period_end, cr.rba_status, cr.generated_at
             FROM compliance_reports cr
             JOIN users u ON u.user_id = cr.generated_by
             ORDER BY cr.generated_at DESC
             LIMIT 500`
        );

        return res.status(200).json({ status: "success", data: result.rows });
    } catch (error) {
        console.error("Failed to fetch regulator compliance reports:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch compliance reports due to a server error",
        });
    }
}

module.exports = { getComplianceOverview, listReports };
