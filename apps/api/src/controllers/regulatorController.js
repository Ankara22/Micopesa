const pool = require("../db/database");
const { writeAuditLog } = require("../utils/auditLog");
const { getReportDetails } = require("./complianceReportController");

const REPORT_TYPES = new Set(["RBA", "NSSF", "INTERNAL"]);
const REPORT_STATUSES = new Set(["DRAFT", "SUBMITTED", "REVISION_REQUESTED", "ACCEPTED", "REJECTED"]);
const DECISIONS = new Set(["ACCEPTED", "REJECTED", "REVISION_REQUESTED"]);

async function getComplianceOverview(req, res) {
    const regulatorId = req.user?.userId;
    const assignedFundScope = `EXISTS (
        SELECT 1
        FROM regulator_fund_assignments rfa
        WHERE rfa.regulator_user_id = $1
          AND rfa.fund_id = cr.fund_id
          AND rfa.active = TRUE
    )`;
    try {
        const [audit, reports, latestRba] = await Promise.all([
            pool.query(
                `SELECT count(*)::int AS events_last_24h, max(al."timestamp") AS last_event_at
                 FROM audit_logs al
                 WHERE al."timestamp" >= now() - interval '24 hours'
                   AND al.entity_name = 'COMPLIANCE_REPORTS'
                   AND EXISTS (
                       SELECT 1
                       FROM compliance_reports cr
                       JOIN regulator_fund_assignments rfa
                         ON rfa.fund_id = cr.fund_id
                        AND rfa.regulator_user_id = $1
                        AND rfa.active = TRUE
                       WHERE cr.report_id = al.entity_id
                         AND (cr.is_legacy = TRUE OR cr.rba_status <> 'DRAFT')
                   )`,
                [regulatorId]
            ),
            pool.query(
                `SELECT rba_status, count(*)::int AS count
                 FROM compliance_reports cr
                WHERE cr.report_type = 'RBA'
                  AND (cr.is_legacy = TRUE OR cr.rba_status <> 'DRAFT')
                  AND ${assignedFundScope}
                 GROUP BY cr.rba_status
                 ORDER BY cr.rba_status`,
                [regulatorId]
            ),
            pool.query(
                `SELECT report_id, rba_status, period_start, period_end, generated_at
                 FROM compliance_reports cr
                 WHERE cr.report_type = 'RBA'
                   AND (cr.is_legacy = TRUE OR cr.rba_status <> 'DRAFT')
                   AND ${assignedFundScope}
                 ORDER BY COALESCE(cr.last_submitted_at, cr.generated_at) DESC
                 LIMIT 1`,
                [regulatorId]
            ),
        ]);

        const latest = latestRba.rows[0] || null;
        const complianceStatus = !latest
            ? "NOT_REPORTED"
            : latest.rba_status === "ACCEPTED"
                ? "COMPLIANT"
                : ["REJECTED", "REVISION_REQUESTED"].includes(latest.rba_status)
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
    const regulatorId = req.user?.userId;
    const { fund_id, manager_id, report_type, status, period_start, period_end, search } = req.query;
    if (report_type && !REPORT_TYPES.has(report_type)) {
        return res.status(400).json({ status: "error", message: "Invalid report_type filter" });
    }
    if (status && !REPORT_STATUSES.has(status)) {
        return res.status(400).json({ status: "error", message: "Invalid status filter" });
    }
    for (const [field, value] of [["period_start", period_start], ["period_end", period_end]]) {
        if (value) {
            if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                return res.status(400).json({ status: "error", message: `${field} must be a YYYY-MM-DD date` });
            }
            const parsedDate = new Date(`${value}T00:00:00.000Z`);
            if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== value) {
                return res.status(400).json({ status: "error", message: `${field} must be a valid YYYY-MM-DD date` });
            }
        }
    }
    if (period_start && period_end && period_end < period_start) {
        return res.status(400).json({ status: "error", message: "period_end must not be before period_start" });
    }

    const conditions = [
        "(cr.is_legacy = TRUE OR cr.rba_status <> 'DRAFT')",
        `EXISTS (
            SELECT 1 FROM regulator_fund_assignments rfa
            WHERE rfa.regulator_user_id = $1
              AND rfa.fund_id = cr.fund_id
              AND rfa.active = TRUE
        )`,
    ];
    const values = [regulatorId];
    const addFilter = (sql, value) => {
        values.push(value);
        conditions.push(sql.replace("?", `$${values.length}`));
    };
    if (fund_id) addFilter("cr.fund_id = ?", fund_id);
    if (manager_id) addFilter("cr.generated_by = ?", manager_id);
    if (report_type) addFilter("cr.report_type = ?", report_type);
    if (status) addFilter("cr.rba_status = ?", status);
    if (period_start) addFilter("cr.period_end >= ?", period_start);
    if (period_end) addFilter("cr.period_start <= ?", period_end);
    if (search) {
        const searchValue = `%${String(search).slice(0, 100)}%`;
        values.push(searchValue, searchValue);
        conditions.push(`(f.fund_name ILIKE $${values.length - 1} OR manager.full_name ILIKE $${values.length})`);
    }
    try {
        const result = await pool.query(
            `SELECT cr.report_id, cr.generated_by AS manager_id,
                    manager.full_name AS manager_name, cr.fund_id, f.fund_name,
                    cr.report_type, cr.period_start, cr.period_end, cr.rba_status,
                    cr.generated_at, cr.submitted_at, cr.last_submitted_at, cr.is_legacy,
                    (cr.is_legacy OR cr.fund_id IS NULL OR cr.submitted_at IS NULL
                     OR cr.last_submitted_at IS NULL OR latest_submission.submission_id IS NULL)
                        AS is_legacy_history,
                    (NOT cr.is_legacy AND cr.fund_id IS NOT NULL AND cr.submitted_at IS NOT NULL
                     AND cr.last_submitted_at IS NOT NULL AND latest_submission.submission_id IS NOT NULL)
                        AS reviewable,
                    latest_review.decision AS latest_decision,
                    latest_review.reason AS latest_reason,
                    latest_review.created_at AS latest_review_at
             FROM compliance_reports cr
             LEFT JOIN users manager ON manager.user_id = cr.generated_by
             LEFT JOIN funds f ON f.fund_id = cr.fund_id
             LEFT JOIN LATERAL (
                 SELECT decision, reason, created_at
                 FROM compliance_report_reviews
                 WHERE report_id = cr.report_id
                 ORDER BY created_at DESC
                 LIMIT 1
             ) latest_review ON TRUE
             LEFT JOIN LATERAL (
                 SELECT submission_id
                 FROM compliance_report_submissions
                 WHERE report_id = cr.report_id
                 ORDER BY version DESC
                 LIMIT 1
             ) latest_submission ON TRUE
             WHERE ${conditions.join(" AND ")}
             ORDER BY COALESCE(cr.last_submitted_at, cr.generated_at) DESC
             LIMIT 500`,
            values
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

async function getComplianceReport(req, res) {
    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const visible = await client.query(
            `SELECT report_id FROM compliance_reports
             WHERE report_id = $1 AND (is_legacy = TRUE OR rba_status <> 'DRAFT')
               AND EXISTS (
                   SELECT 1 FROM regulator_fund_assignments rfa
                   WHERE rfa.regulator_user_id = $2
                     AND rfa.fund_id = compliance_reports.fund_id
                     AND rfa.active = TRUE
               )`,
            [req.params.reportId, req.user?.userId]
        );
        if (!visible.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(404).json({ status: "error", message: "Submitted compliance report not found" });
        }
        const details = await getReportDetails(client, req.params.reportId);
        await client.query("COMMIT");
        return res.status(200).json({ status: "success", data: details });
    } catch (error) {
        if (client) await client.query("ROLLBACK");
        console.error("Failed to fetch regulator compliance report:", error);
        return res.status(500).json({ status: "error", message: "Failed to fetch compliance report due to a server error" });
    } finally {
        client?.release();
    }
}

async function reviewComplianceReport(req, res) {
    const { decision, reason, submission_id: expectedSubmissionId } = req.body || {};
    if (!DECISIONS.has(decision)) {
        return res.status(400).json({ status: "error", message: "decision must be ACCEPTED, REJECTED, or REVISION_REQUESTED" });
    }
    if (reason !== undefined && (typeof reason !== "string" || reason.length > 2000)) {
        return res.status(400).json({ status: "error", message: "reason must be text no longer than 2000 characters" });
    }
    const normalizedReason = typeof reason === "string" ? reason.trim() : null;
    if (decision !== "ACCEPTED" && (!normalizedReason || normalizedReason.length < 10)) {
        return res.status(400).json({ status: "error", message: "A reason of at least 10 characters is required for rejection or revision requests" });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        const reportResult = await client.query(
            `SELECT report_id, generated_by, rba_status, is_legacy,
                    fund_id, submitted_at, last_submitted_at,
                    EXISTS (
                        SELECT 1 FROM compliance_report_submissions
                        WHERE report_id = compliance_reports.report_id
                    ) AS has_submission
             FROM compliance_reports
             WHERE report_id = $1
               AND EXISTS (
                   SELECT 1
                   FROM regulator_fund_assignments rfa
                   WHERE rfa.regulator_user_id = $2
                     AND rfa.fund_id = compliance_reports.fund_id
                     AND rfa.active = TRUE
               )
             FOR UPDATE`,
            [req.params.reportId, req.user.userId]
        );
        const report = reportResult.rows[0];
        if (!report || (report.rba_status === "DRAFT" && !report.is_legacy)) {
            await client.query("ROLLBACK");
            return res.status(404).json({ status: "error", message: "Submitted compliance report not found" });
        }
        const assignmentResult = await client.query(
            `SELECT fund_id
             FROM regulator_fund_assignments
             WHERE regulator_user_id = $1 AND fund_id = $2 AND active = TRUE
             FOR SHARE`,
            [req.user.userId, report.fund_id]
        );
        if (!assignmentResult.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(404).json({ status: "error", message: "Submitted compliance report not found" });
        }
        if (
            report.is_legacy ||
            !report.fund_id ||
            !report.submitted_at ||
            !report.last_submitted_at ||
            !report.has_submission
        ) {
            await client.query("ROLLBACK");
            return res.status(409).json({ status: "error", message: "Legacy or incomplete historical reports cannot be reviewed" });
        }
        if (report.generated_by === req.user.userId) {
            await client.query("ROLLBACK");
            return res.status(403).json({ status: "error", message: "A report submitter cannot review their own report" });
        }
        if (report.rba_status !== "SUBMITTED") {
            await client.query("ROLLBACK");
            return res.status(409).json({ status: "error", message: "Only submitted reports can be reviewed" });
        }
        const fundOwnerResult = await client.query(
            "SELECT managed_by FROM funds WHERE fund_id = $1 FOR SHARE",
            [report.fund_id]
        );
        const currentManagerId = fundOwnerResult.rows[0]?.managed_by;
        const actorResult = await client.query(
            `SELECT user_id, full_name, role
             FROM users
             WHERE user_id = $1 AND account_status = 'ACTIVE'
             FOR SHARE`,
            [req.user.userId]
        );
        const actor = actorResult.rows[0];
        if (!actor || actor.role !== "REGULATOR") {
            await client.query("ROLLBACK");
            return res.status(403).json({ status: "error", message: "An active regulator account is required to review this report" });
        }
        const submissionResult = await client.query(
            `SELECT submission_id, version
             FROM compliance_report_submissions
             WHERE report_id = $1
             ORDER BY version DESC
             LIMIT 1`,
            [report.report_id]
        );
        const submission = submissionResult.rows[0];
        if (!submission) {
            await client.query("ROLLBACK");
            return res.status(409).json({ status: "error", message: "The submitted report version is unavailable" });
        }
        if (typeof expectedSubmissionId !== "string" || expectedSubmissionId.trim() === "") {
            await client.query("ROLLBACK");
            return res.status(400).json({ status: "error", message: "submission_id is required for the version being reviewed" });
        }
        if (expectedSubmissionId !== submission.submission_id) {
            await client.query("ROLLBACK");
            return res.status(409).json({
                status: "error",
                code: "STALE_SUBMISSION",
                message: "A newer report submission is available. Review the latest version before recording a decision.",
            });
        }

        await client.query(
            `INSERT INTO compliance_report_reviews
                (report_id, submission_id, reviewed_by, reviewed_by_name, reviewed_by_role,
                 decision, reason)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                report.report_id,
                submission.submission_id,
                actor.user_id,
                actor.full_name,
                actor.role,
                decision,
                normalizedReason,
            ]
        );
        await client.query(
            "UPDATE compliance_reports SET rba_status = $1, updated_at = now() WHERE report_id = $2",
            [decision, report.report_id]
        );
        if (currentManagerId) {
            await client.query(
                `INSERT INTO notifications (user_id, created_by, notification_type, message)
                 VALUES ($1, $2, 'PUSH', $3)`,
                [
                    currentManagerId,
                    req.user.userId,
                    `Compliance report ${report.report_id}: ${decision.toLowerCase().replaceAll("_", " ")}${normalizedReason ? `. ${normalizedReason.slice(0, 150)}` : "."}`,
                ]
            );
        }
        const actionType = decision === "ACCEPTED"
            ? "APPROVE"
            : decision === "REJECTED"
                ? "REJECT"
                : "REQUEST_REVISION";
        await writeAuditLog(client, {
            userId: req.user.userId,
            actionType,
            entityName: "COMPLIANCE_REPORTS",
            entityId: report.report_id,
            details: {
                actor_user_id: req.user.userId,
                actor_role: "REGULATOR",
                from_status: "SUBMITTED",
                to_status: decision,
                submission_version: submission.version,
                reason: normalizedReason,
            },
        });
        await client.query("COMMIT");
        return res.status(200).json({
            status: "success",
            data: { report_id: report.report_id, rba_status: decision, submission_version: submission.version },
        });
    } catch (error) {
        if (client) await client.query("ROLLBACK");
        console.error("Failed to review compliance report:", error);
        return res.status(500).json({ status: "error", message: "Failed to review compliance report due to a server error" });
    } finally {
        client?.release();
    }
}

module.exports = {
    getComplianceOverview,
    listReports,
    getComplianceReport,
    reviewComplianceReport,
};
