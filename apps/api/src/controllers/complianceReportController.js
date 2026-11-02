const pool = require("../db/database");
const { writeAuditLog } = require("../utils/auditLog");

const REPORT_TYPES = new Set(["RBA", "NSSF", "INTERNAL"]);
const CONTENT_FIELDS = [
    "executive_summary",
    "financial_summary",
    "risk_and_governance",
    "incidents_and_actions",
    "supporting_information",
];
const MAX_SECTION_LENGTH = 10000;

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateDate(value, field, optional = false) {
    if ((value === null || value === undefined || value === "") && optional) return null;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { error: `${field} must be a valid YYYY-MM-DD date` };
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        return { error: `${field} must be a valid YYYY-MM-DD date` };
    }
    return value;
}

function validateReportFields(body, { partial = false } = {}) {
    const fields = {};
    if (!partial || Object.hasOwn(body, "report_type")) {
        const type = body.report_type || null;
        if (type !== null && !REPORT_TYPES.has(type)) {
            return { error: "report_type must be RBA, NSSF, or INTERNAL" };
        }
        fields.report_type = type;
    }

    for (const field of ["period_start", "period_end"]) {
        if (!partial || Object.hasOwn(body, field)) {
            const date = validateDate(body[field], field, true);
            if (date && date.error) return date;
            fields[field] = date;
        }
    }

    if (
        fields.period_start &&
        fields.period_end &&
        fields.period_end < fields.period_start
    ) {
        return { error: "period_end must not be before period_start" };
    }

    if (!partial || Object.hasOwn(body, "report_content")) {
        const content = body.report_content === undefined && partial ? undefined : body.report_content || {};
        if (content !== undefined && !isPlainObject(content)) {
            return { error: "report_content must be an object" };
        }
        if (content !== undefined) {
            const safeContent = {};
            for (const field of CONTENT_FIELDS) {
                const value = content[field] ?? "";
                if (typeof value !== "string" || value.length > MAX_SECTION_LENGTH) {
                    return { error: `${field} must be text no longer than ${MAX_SECTION_LENGTH} characters` };
                }
                safeContent[field] = value.trim();
            }
            fields.report_content = safeContent;
        }
    }
    return { fields };
}

function validateCompleteReport(report) {
    if (!REPORT_TYPES.has(report.report_type)) {
        return "Select a valid report type before submitting.";
    }
    if (!report.period_start || !report.period_end || report.period_end < report.period_start) {
        return "Enter a valid reporting period before submitting.";
    }
    for (const field of CONTENT_FIELDS) {
        if (typeof report.report_content?.[field] !== "string" || report.report_content[field].trim().length < 10) {
            return `Complete the ${field.replaceAll("_", " ")} section before submitting.`;
        }
    }
    return null;
}

async function getOwnedReport(client, reportId, userId, { lock = false } = {}) {
    const result = await client.query(
        `SELECT cr.report_id, cr.generated_by, cr.fund_id, cr.report_type,
                cr.period_start, cr.period_end, cr.report_content, cr.rba_status,
                cr.generated_at, cr.submitted_at, cr.last_submitted_at,
                cr.is_legacy, f.fund_name
         FROM compliance_reports cr
         JOIN funds f ON f.fund_id = cr.fund_id AND f.managed_by = $2
         WHERE cr.report_id = $1
         ${lock ? "FOR UPDATE OF cr, f" : ""}`,
        [reportId, userId]
    );
    return result.rows[0] || null;
}

async function getReportDetails(client, reportId) {
    const reportResult = await client.query(
        `SELECT cr.report_id, cr.generated_by, manager.full_name AS manager_name,
                cr.fund_id, f.fund_name, f.managed_by, cr.report_type,
                cr.period_start, cr.period_end, cr.report_content, cr.rba_status,
                cr.generated_at, cr.submitted_at, cr.last_submitted_at, cr.is_legacy
         FROM compliance_reports cr
         LEFT JOIN users manager ON manager.user_id = cr.generated_by
         LEFT JOIN funds f ON f.fund_id = cr.fund_id
         WHERE cr.report_id = $1`,
        [reportId]
    );
    const submissionsResult = await client.query(
        `SELECT submission_id, version, submitted_by, report_content, report_type,
                submitted_by_name, submitted_by_role, period_start, period_end,
                submitted_at
         FROM compliance_report_submissions
         WHERE report_id = $1
         ORDER BY version ASC`,
        [reportId]
    );
    const reviewsResult = await client.query(
        `SELECT review.review_id, review.submission_id, submission.version,
                review.reviewed_by, review.reviewed_by_name AS reviewer_name,
                review.reviewed_by_role AS reviewer_role,
                review.decision, review.reason,
                review.created_at
         FROM compliance_report_reviews review
         JOIN compliance_report_submissions submission
           ON submission.submission_id = review.submission_id
         WHERE review.report_id = $1
         ORDER BY review.created_at ASC`,
        [reportId]
    );
    if (!reportResult.rows[0]) return null;
    const report = reportResult.rows[0];
    const latestSubmission = submissionsResult.rows.at(-1);
    const hasReviewData = Boolean(
        report.fund_id && report.submitted_at && report.last_submitted_at && latestSubmission
    );
    const reviewable = !report.is_legacy
        && hasReviewData;
    const isLegacyHistory = Boolean(
        report.is_legacy || (report.rba_status !== "DRAFT" && !hasReviewData)
    );
    return {
        report: { ...report, is_legacy_history: isLegacyHistory, reviewable },
        submissions: submissionsResult.rows,
        reviews: reviewsResult.rows,
    };
}

async function listManagerReports(req, res) {
    try {
        const result = await pool.query(
            `SELECT cr.report_id, cr.fund_id, f.fund_name, cr.is_legacy, cr.report_type,
                    cr.period_start, cr.period_end, cr.rba_status,
                    cr.generated_at, cr.submitted_at, cr.last_submitted_at,
                    latest_review.decision AS latest_decision,
                    latest_review.reason AS latest_reason,
                    latest_review.created_at AS latest_review_at
             FROM compliance_reports cr
             JOIN funds f ON f.fund_id = cr.fund_id AND f.managed_by = $1
             LEFT JOIN LATERAL (
                 SELECT decision, reason, created_at
                 FROM compliance_report_reviews
                 WHERE report_id = cr.report_id
                 ORDER BY created_at DESC
                 LIMIT 1
             ) latest_review ON TRUE
             ORDER BY cr.updated_at DESC`,
            [req.user.userId]
        );
        return res.status(200).json({ status: "success", data: result.rows });
    } catch (error) {
        console.error("Failed to list manager compliance reports:", error);
        return res.status(500).json({ status: "error", message: "Failed to list compliance reports due to a server error" });
    }
}

async function createDraft(req, res) {
    const body = req.body || {};
    const { fund_id } = body;
    if (typeof fund_id !== "string" || fund_id.trim() === "") {
        return res.status(400).json({ status: "error", message: "fund_id is required" });
    }
    const validated = validateReportFields(body, { partial: true });
    if (validated.error) return res.status(400).json({ status: "error", message: validated.error });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const fundResult = await client.query(
            "SELECT fund_id FROM funds WHERE fund_id = $1 AND managed_by = $2 FOR UPDATE",
            [fund_id.trim(), req.user.userId]
        );
        if (!fundResult.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(404).json({ status: "error", message: "Managed fund not found" });
        }
        const fields = validated.fields;
        const result = await client.query(
            `INSERT INTO compliance_reports
                (generated_by, fund_id, report_type, period_start, period_end, report_content, rba_status)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'DRAFT')
             RETURNING report_id, generated_by, fund_id, report_type, period_start,
                       period_end, report_content, rba_status, generated_at`,
            [
                req.user.userId,
                fund_id.trim(),
                fields.report_type ?? null,
                fields.period_start ?? null,
                fields.period_end ?? null,
                JSON.stringify(fields.report_content || {}),
            ]
        );
        const report = result.rows[0];
        await writeAuditLog(client, {
            userId: req.user.userId,
            actionType: "CREATE",
            entityName: "COMPLIANCE_REPORTS",
            entityId: report.report_id,
            details: {
                actor_user_id: req.user.userId,
                actor_role: "FUND_MANAGER",
                from_status: null,
                to_status: "DRAFT",
            },
        });
        await client.query("COMMIT");
        return res.status(201).json({ status: "success", data: { report } });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Failed to create compliance report draft:", error);
        return res.status(500).json({ status: "error", message: "Failed to create compliance report draft due to a server error" });
    } finally {
        client.release();
    }
}

async function updateDraft(req, res) {
    const validated = validateReportFields(req.body || {}, { partial: true });
    if (validated.error) return res.status(400).json({ status: "error", message: validated.error });
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const current = await getOwnedReport(client, req.params.reportId, req.user.userId, { lock: true });
        if (!current) {
            await client.query("ROLLBACK");
            return res.status(404).json({ status: "error", message: "Compliance report not found" });
        }
        if (!["DRAFT", "REVISION_REQUESTED"].includes(current.rba_status)) {
            await client.query("ROLLBACK");
            return res.status(409).json({ status: "error", message: "Only draft or revision-requested reports can be edited" });
        }
        if (current.is_legacy) {
            await client.query("ROLLBACK");
            return res.status(409).json({ status: "error", message: "Legacy compliance reports are read-only" });
        }
        const fields = validated.fields;
        const merged = {
            report_type: fields.report_type === undefined ? current.report_type : fields.report_type,
            period_start: fields.period_start === undefined ? current.period_start : fields.period_start,
            period_end: fields.period_end === undefined ? current.period_end : fields.period_end,
            report_content: fields.report_content === undefined ? current.report_content : fields.report_content,
        };
        if (merged.period_start && merged.period_end && merged.period_end < merged.period_start) {
            await client.query("ROLLBACK");
            return res.status(400).json({ status: "error", message: "period_end must not be before period_start" });
        }
        const result = await client.query(
            `UPDATE compliance_reports
             SET report_type = $1, period_start = $2, period_end = $3,
                 report_content = $4::jsonb, updated_at = now()
             WHERE report_id = $5
             RETURNING report_id, fund_id, report_type, period_start, period_end,
                       report_content, rba_status, updated_at`,
            [merged.report_type, merged.period_start, merged.period_end, JSON.stringify(merged.report_content), current.report_id]
        );
        await writeAuditLog(client, {
            userId: req.user.userId,
            actionType: "UPDATE",
            entityName: "COMPLIANCE_REPORTS",
            entityId: current.report_id,
            details: {
                actor_user_id: req.user.userId,
                actor_role: "FUND_MANAGER",
                status: current.rba_status,
            },
        });
        await client.query("COMMIT");
        return res.status(200).json({ status: "success", data: { report: result.rows[0] } });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Failed to update compliance report draft:", error);
        return res.status(500).json({ status: "error", message: "Failed to update compliance report due to a server error" });
    } finally {
        client.release();
    }
}

async function submitReport(req, res) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const report = await getOwnedReport(client, req.params.reportId, req.user.userId, { lock: true });
        if (!report) {
            await client.query("ROLLBACK");
            return res.status(404).json({ status: "error", message: "Compliance report not found" });
        }
        const isResubmission = report.rba_status === "REVISION_REQUESTED";
        if (!isResubmission && report.rba_status !== "DRAFT") {
            await client.query("ROLLBACK");
            return res.status(409).json({ status: "error", message: "Only draft or revision-requested reports can be submitted" });
        }
        if (!report.fund_id || !report.fund_name) {
            await client.query("ROLLBACK");
            return res.status(409).json({ status: "error", message: "A managed fund is required before submission" });
        }
        if (report.is_legacy) {
            await client.query("ROLLBACK");
            return res.status(409).json({ status: "error", message: "Legacy compliance reports cannot be submitted" });
        }
        const fundResult = await client.query(
            "SELECT fund_id FROM funds WHERE fund_id = $1 AND managed_by = $2 FOR UPDATE",
            [report.fund_id, req.user.userId]
        );
        if (!fundResult.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(403).json({ status: "error", message: "The report's fund is no longer managed by this account" });
        }
        const actorResult = await client.query(
            `SELECT user_id, full_name, role
             FROM users
             WHERE user_id = $1 AND account_status = 'ACTIVE'
             FOR SHARE`,
            [req.user.userId]
        );
        const actor = actorResult.rows[0];
        if (!actor || actor.role !== "FUND_MANAGER") {
            await client.query("ROLLBACK");
            return res.status(403).json({ status: "error", message: "An active fund manager account is required to submit this report" });
        }
        const validationError = validateCompleteReport(report);
        if (validationError) {
            await client.query("ROLLBACK");
            return res.status(400).json({ status: "error", message: validationError });
        }

        const versionResult = await client.query(
            "SELECT COALESCE(MAX(version), 0)::int + 1 AS version FROM compliance_report_submissions WHERE report_id = $1",
            [report.report_id]
        );
        const version = versionResult.rows[0].version;
        const submissionResult = await client.query(
            `INSERT INTO compliance_report_submissions
                (report_id, version, submitted_by, submitted_by_name, submitted_by_role,
                 report_content, report_type, period_start, period_end)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
             RETURNING submission_id, version, submitted_at`,
            [
                report.report_id,
                version,
                actor.user_id,
                actor.full_name,
                actor.role,
                JSON.stringify(report.report_content),
                report.report_type,
                report.period_start,
                report.period_end,
            ]
        );
        await client.query(
            `UPDATE compliance_reports
             SET rba_status = 'SUBMITTED',
                 submitted_at = COALESCE(submitted_at, now()),
                 last_submitted_at = now(), updated_at = now()
             WHERE report_id = $1`,
            [report.report_id]
        );
        await client.query(
            `INSERT INTO notifications (user_id, notification_type, message)
             SELECT user_id, 'PUSH', $1
             FROM users
             WHERE role = 'REGULATOR' AND account_status = 'ACTIVE'`,
            [`Compliance report ${report.report_id} was ${isResubmission ? "resubmitted" : "submitted"} for review.`]
        );
        await writeAuditLog(client, {
            userId: req.user.userId,
            actionType: isResubmission ? "RESUBMIT" : "SUBMIT",
            entityName: "COMPLIANCE_REPORTS",
            entityId: report.report_id,
            details: {
                actor_role: "FUND_MANAGER",
                actor_user_id: req.user.userId,
                from_status: report.rba_status,
                to_status: "SUBMITTED",
                submission_version: version,
            },
        });
        await client.query("COMMIT");
        return res.status(200).json({
            status: "success",
            data: { report_id: report.report_id, rba_status: "SUBMITTED", submission: submissionResult.rows[0] },
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Failed to submit compliance report:", error);
        return res.status(500).json({ status: "error", message: "Failed to submit compliance report due to a server error" });
    } finally {
        client.release();
    }
}

async function getManagerReport(req, res) {
    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        const owned = await client.query(
            `SELECT cr.report_id
             FROM compliance_reports cr
             JOIN funds f ON f.fund_id = cr.fund_id
             WHERE cr.report_id = $1 AND f.managed_by = $2
             FOR SHARE OF cr, f`,
            [req.params.reportId, req.user.userId]
        );
        if (!owned.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(404).json({ status: "error", message: "Compliance report not found" });
        }
        const details = await getReportDetails(client, req.params.reportId);
        await client.query("COMMIT");
        return res.status(200).json({ status: "success", data: details });
    } catch (error) {
        if (client) await client.query("ROLLBACK");
        console.error("Failed to fetch manager compliance report:", error);
        return res.status(500).json({ status: "error", message: "Failed to fetch compliance report due to a server error" });
    } finally {
        client?.release();
    }
}

module.exports = {
    listManagerReports,
    createDraft,
    updateDraft,
    submitReport,
    getManagerReport,
    getReportDetails,
    validateReportFields,
};
