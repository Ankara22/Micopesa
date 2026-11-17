const pool = require("../db/database");
const { writeAuditLog } = require("../utils/auditLog");
const { getReportDetails } = require("./complianceReportController");
const { createPensionLedgerReadinessChecker } = require("../services/mpesaLedgerReadiness");

const REPORT_TYPES = new Set(["RBA", "NSSF", "INTERNAL"]);
const REPORT_STATUSES = new Set(["DRAFT", "SUBMITTED", "REVISION_REQUESTED", "ACCEPTED", "REJECTED"]);
const DECISIONS = new Set(["ACCEPTED", "REJECTED", "REVISION_REQUESTED"]);
const assertPensionLedgerActive = createPensionLedgerReadinessChecker();
const ASSIGNED_KYC_ACCOUNT_SCOPE = `EXISTS (
    SELECT 1
    FROM pension_accounts pa
    JOIN fund_allocations fa ON fa.account_id = pa.account_id
    JOIN funds f ON f.fund_id = fa.fund_id AND f.fund_status = 'ACTIVE'
    JOIN regulator_fund_assignments rfa
      ON rfa.fund_id = f.fund_id
     AND rfa.regulator_user_id = $1
     AND rfa.active = TRUE
    WHERE pa.user_id = k.user_id
      AND fa.effective_from <= CURRENT_DATE
      AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)
)`;

function parsePage(value, fallback, maximum) {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null;
}

function isValidDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function getKycOversight(req, res) {
    const page = parsePage(req.query?.page, 1, 100000);
    const pageSize = parsePage(req.query?.page_size, 25, 100);
    const { start_date: startDate, end_date: endDate, status } = req.query || {};
    if (
        page === null || pageSize === null ||
        (startDate !== undefined && !isValidDate(startDate)) ||
        (endDate !== undefined && !isValidDate(endDate)) ||
        (startDate && endDate && startDate > endDate) ||
        (status !== undefined && !["VERIFIED", "REJECTED"].includes(status))
    ) {
        return res.status(400).json({ status: "error", message: "Invalid KYC oversight filters or pagination." });
    }

    const conditions = [
        "al.entity_name = 'KYC_RECORD'",
        "al.action_type IN ('APPROVE', 'REJECT')",
        "u.role = 'ADMIN'",
        "((al.action_type = 'APPROVE' AND al.details->>'status' = 'VERIFIED') OR (al.action_type = 'REJECT' AND al.details->>'status' = 'REJECTED'))",
        ASSIGNED_KYC_ACCOUNT_SCOPE,
    ];
    const values = [req.user.userId];
    if (startDate) {
        values.push(startDate);
        conditions.push(`al."timestamp" >= $${values.length}::date`);
    }
    if (endDate) {
        values.push(endDate);
        conditions.push(`al."timestamp" < ($${values.length}::date + INTERVAL '1 day')`);
    }
    if (status) {
        values.push(status);
        conditions.push(`al.details->>'status' = $${values.length}`);
    }
    const where = conditions.join(" AND ");
    const offset = (page - 1) * pageSize;
    try {
        const [scope, counts, total, history] = await Promise.all([
            pool.query(
                `SELECT count(DISTINCT rfa.fund_id)::int AS active_assigned_fund_count
                 FROM regulator_fund_assignments rfa
                 JOIN funds f ON f.fund_id = rfa.fund_id
                 WHERE rfa.regulator_user_id = $1
                   AND rfa.active = TRUE
                   AND f.fund_status = 'ACTIVE'`,
                [req.user.userId]
            ),
            pool.query(
                `SELECT kyc_status, count(*)::int AS count
                 FROM kyc_records k
                 WHERE ${ASSIGNED_KYC_ACCOUNT_SCOPE}
                 GROUP BY kyc_status
                 ORDER BY kyc_status`,
                [req.user.userId]
            ),
            pool.query(
                `SELECT count(*)::int AS total_count
                 FROM audit_logs al
                 LEFT JOIN users u ON u.user_id = al.user_id
                 JOIN kyc_records k ON k.kyc_id = al.entity_id
                 WHERE ${where}`,
                values
            ),
            pool.query(
                `SELECT al.log_id, al.action_type,
                        al.details->>'status' AS kyc_status,
                        u.role AS reviewer_role,
                        al."timestamp"
                 FROM audit_logs al
                 LEFT JOIN users u ON u.user_id = al.user_id
                 JOIN kyc_records k ON k.kyc_id = al.entity_id
                 WHERE ${where}
                 ORDER BY al."timestamp" DESC
                 LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
                [...values, pageSize, offset]
            ),
        ]);
        const totalCount = total.rows[0]?.total_count || 0;
        return res.status(200).json({
            status: "success",
            data: {
                scope: {
                    active_assigned_fund_count: scope.rows[0]?.active_assigned_fund_count || 0,
                    has_active_fund_scope: Number(scope.rows[0]?.active_assigned_fund_count || 0) > 0,
                },
                kyc_status_counts: counts.rows,
                review_history: history.rows,
                pagination: {
                    page,
                    page_size: pageSize,
                    total_count: totalCount,
                    total_pages: Math.ceil(totalCount / pageSize),
                },
            },
        });
    } catch (error) {
        console.error("Failed to fetch regulator KYC oversight:", error?.code || "REGULATOR_KYC_QUERY_FAILED");
        return res.status(500).json({ status: "error", message: "Failed to fetch KYC oversight due to a server error" });
    }
}

async function evaluateInternalControlChecks(queryable, regulatorId) {
    const fundStatuses = await queryable.query(
        `SELECT f.fund_status, count(*)::int AS fund_count
         FROM funds f
         WHERE EXISTS (
             SELECT 1 FROM regulator_fund_assignments rfa
             WHERE rfa.regulator_user_id = $1
               AND rfa.fund_id = f.fund_id
               AND rfa.active = TRUE
         )
         GROUP BY f.fund_status
         ORDER BY f.fund_status`,
        [regulatorId]
    );
    const allocationTotals = await queryable.query(
        `WITH scoped_accounts AS (
             SELECT DISTINCT fa.account_id
             FROM fund_allocations fa
             JOIN funds scoped_fund
               ON scoped_fund.fund_id = fa.fund_id
              AND scoped_fund.fund_status = 'ACTIVE'
             WHERE fa.effective_from <= CURRENT_DATE
               AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)
               AND EXISTS (
                   SELECT 1 FROM regulator_fund_assignments rfa
                   WHERE rfa.regulator_user_id = $1
                     AND rfa.fund_id = fa.fund_id
                     AND rfa.active = TRUE
               )
         ),
         allocation_totals AS (
             SELECT fa.account_id, sum(fa.percentage)::numeric(8,2) AS total_percentage
             FROM fund_allocations fa
             JOIN scoped_accounts sa ON sa.account_id = fa.account_id
             WHERE fa.effective_from <= CURRENT_DATE
               AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)
             GROUP BY fa.account_id
         )
         SELECT count(*)::int AS evaluated_accounts,
                count(*) FILTER (WHERE total_percentage = 100.00)::int AS valid_accounts,
                count(*) FILTER (WHERE total_percentage <> 100.00)::int AS invalid_accounts
         FROM allocation_totals`,
        [regulatorId]
    );
    const paymentAttempts = await queryable.query(
        `SELECT count(DISTINCT a.attempt_id)::int AS evaluated_count,
                count(DISTINCT a.attempt_id) FILTER (
                    WHERE a.attempt_status IN ('PENDING', 'OUTCOME_UNKNOWN', 'PROMPT_ACCEPTED')
                )::int AS unresolved_count
         FROM mpesa_payment_attempts a
         JOIN contribution_fund_allocations cfa
           ON cfa.contribution_id = a.contribution_id
          AND cfa.account_id = a.account_id
         WHERE EXISTS (
               SELECT 1 FROM regulator_fund_assignments rfa
               JOIN funds f ON f.fund_id = rfa.fund_id
               WHERE rfa.regulator_user_id = $1
                 AND rfa.active = TRUE
                 AND f.fund_status = 'ACTIVE'
                 AND f.fund_id = cfa.fund_id
           )`,
        [regulatorId]
    );
    const reportSubmissions = await queryable.query(
        `SELECT count(*) FILTER (WHERE cr.rba_status = 'SUBMITTED')::int AS submitted_count,
                count(*) FILTER (
                    WHERE cr.rba_status = 'SUBMITTED'
                      AND (cr.submitted_at IS NULL
                           OR cr.last_submitted_at IS NULL
                           OR NOT EXISTS (
                               SELECT 1 FROM compliance_report_submissions s
                               WHERE s.report_id = cr.report_id
                           ))
                )::int AS incomplete_submissions
         FROM compliance_reports cr
         WHERE EXISTS (
             SELECT 1 FROM regulator_fund_assignments rfa
             JOIN funds f ON f.fund_id = rfa.fund_id
             WHERE rfa.regulator_user_id = $1
               AND rfa.fund_id = cr.fund_id
               AND rfa.active = TRUE
               AND f.fund_status = 'ACTIVE'
         )`,
        [regulatorId]
    );

    let ledgerStatus = "PASS";
    let ledgerObserved = "ACTIVE";
    try {
        await assertPensionLedgerActive(queryable);
    } catch (error) {
        ledgerStatus = error?.code === "PENSION_LEDGER_NOT_ACTIVE" ? "FAILED" : "UNEVALUATED";
        ledgerObserved = error?.code === "PENSION_LEDGER_NOT_ACTIVE"
        ? "Ledger is not active"
        : "Ledger status could not be established";
    }

    const funds = fundStatuses.rows;
    const inactiveFunds = funds
        .filter((item) => item.fund_status !== "ACTIVE")
        .reduce((sum, item) => sum + Number(item.fund_count), 0);
    const allocation = allocationTotals.rows[0] || {};
    const evaluatedAccounts = Number(allocation.evaluated_accounts || 0);
    const invalidAccounts = Number(allocation.invalid_accounts || 0);
    const validAccounts = Number(allocation.valid_accounts || 0);
    const evaluatedAttempts = Number(paymentAttempts.rows[0]?.evaluated_count || 0);
    const unresolvedCount = Number(paymentAttempts.rows[0]?.unresolved_count || 0);
    const submittedCount = Number(reportSubmissions.rows[0]?.submitted_count || 0);
    const incompleteCount = Number(reportSubmissions.rows[0]?.incomplete_submissions || 0);
    const evaluatedAt = new Date().toISOString();
    const checks = [
        {
        key: "fund_status",
        name: "Assigned fund configuration",
        description: "Counts assigned fund records by their configured active status.",
        observed_value: funds.map((item) => `${item.fund_status}: ${item.fund_count}`).join(", ") || "No assigned funds",
        expected_rule: "Fund status is evaluated from the recorded application configuration.",
        status: !funds.length ? "NOT_CONFIGURED" : inactiveFunds > 0 ? "ATTENTION_REQUIRED" : "PASS",
        source: "funds and active regulator_fund_assignments",
        evaluated_at: evaluatedAt,
        },
        {
        key: "allocation_total",
        name: "Active allocation completeness",
        description: "Checks active allocation totals for accounts with an allocation in an assigned fund.",
        observed_value: `${validAccounts} of ${evaluatedAccounts} accounts total 100.00%; ${invalidAccounts} do not.`,
        expected_rule: "Active fund allocation percentages must total exactly 100.00% per account.",
        status: evaluatedAccounts === 0 ? "NOT_CONFIGURED" : invalidAccounts > 0 ? "FAILED" : "PASS",
        source: "fund_allocations and active regulator_fund_assignments",
        evaluated_at: evaluatedAt,
        },
        {
        key: "ledger_readiness",
        name: "Pension ledger readiness",
        description: "Reads the existing ledger singleton status without changing it.",
        observed_value: ledgerObserved,
        expected_rule: "The pension ledger singleton must be ACTIVE for ledger-enforced payment settlement.",
        status: ledgerStatus,
        source: "pension_ledger singleton via the application readiness checker",
        evaluated_at: evaluatedAt,
        },
        {
        key: "payment_reconciliation",
        name: "Payment attempts awaiting reconciliation",
        description: "Counts unresolved payment attempts associated with actively assigned funds.",
        observed_value: evaluatedAttempts === 0
            ? "No scoped payment attempts"
            : `${unresolvedCount} unresolved of ${evaluatedAttempts} scoped attempt(s)`,
        expected_rule: "PENDING, OUTCOME_UNKNOWN and PROMPT_ACCEPTED attempts remain unresolved until verified.",
        status: evaluatedAttempts === 0
            ? "NOT_CONFIGURED"
            : unresolvedCount > 0 ? "ATTENTION_REQUIRED" : "PASS",
        source: "mpesa_payment_attempts, contribution_fund_allocations and active regulator fund assignments",
        evaluated_at: evaluatedAt,
        },
        {
        key: "report_workflow",
        name: "Submitted report workflow completeness",
        description: "Checks submitted reports for the submission snapshot required by the review workflow.",
        observed_value: submittedCount === 0
            ? "No submitted reports to evaluate"
            : `${incompleteCount} incomplete of ${submittedCount} submitted report(s)`,
        expected_rule: "Submitted reports require submission timestamps and a stored submission version.",
        status: submittedCount === 0
            ? "NOT_CONFIGURED"
            : incompleteCount > 0 ? "ATTENTION_REQUIRED" : "PASS",
        source: "compliance_reports and compliance_report_submissions",
        evaluated_at: evaluatedAt,
        },
    ];
    const countStatus = (status) => checks.filter((check) => check.status === status).length;
    return {
        evaluated_at: evaluatedAt,
        formal_parameters: {
        status: "NOT_CONFIGURED",
        observed_value: "No authoritative RBA parameter configuration is available.",
        source: "Application schema and current regulatory configuration",
        },
        summary: {
        evaluated_count: checks.length - countStatus("NOT_CONFIGURED") - countStatus("UNEVALUATED"),
        passed_count: countStatus("PASS"),
        failed_count: countStatus("FAILED"),
        attention_required_count: countStatus("ATTENTION_REQUIRED"),
        unevaluated_count: countStatus("UNEVALUATED"),
        not_configured_count: countStatus("NOT_CONFIGURED"),
        },
        checks,
    };
}

async function getInternalControlChecks(req, res) {
    try {
        const data = await evaluateInternalControlChecks(pool, req.user?.userId);
        return res.status(200).json({ status: "success", data });
    } catch (error) {
        console.error("Failed to evaluate regulator internal controls:", error?.code || "REGULATOR_CONTROL_QUERY_FAILED");
        return res.status(500).json({ status: "error", message: "Failed to evaluate internal control checks due to a server error" });
    }
}

async function getDashboardOverview(req, res) {
    const regulatorId = req.user?.userId;
    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const dashboardQueries = [
        () => client.query(
            `SELECT count(*)::int AS assigned_fund_count,
                    count(*) FILTER (WHERE f.fund_status = 'ACTIVE')::int AS active_assigned_fund_count
             FROM regulator_fund_assignments rfa
             JOIN funds f ON f.fund_id = rfa.fund_id
             WHERE rfa.regulator_user_id = $1 AND rfa.active = TRUE`,
            [regulatorId]
        ),
        () => client.query(
            `SELECT count(*)::int AS total_fund_count,
                    count(*) FILTER (WHERE f.fund_status = 'ACTIVE')::int AS active_fund_count,
                    count(*) FILTER (WHERE f.fund_status <> 'ACTIVE')::int AS inactive_fund_count
             FROM funds f
             WHERE EXISTS (
                 SELECT 1 FROM regulator_fund_assignments rfa
                 WHERE rfa.regulator_user_id = $1
                   AND rfa.fund_id = f.fund_id
                   AND rfa.active = TRUE
             )`,
            [regulatorId]
        ),
        () => client.query(
            `WITH scoped_accounts AS (
                 SELECT DISTINCT pa.account_id, pa.user_id, pa.account_status
                 FROM pension_accounts pa
                 JOIN fund_allocations fa ON fa.account_id = pa.account_id
                 JOIN funds f ON f.fund_id = fa.fund_id AND f.fund_status = 'ACTIVE'
                 JOIN regulator_fund_assignments rfa
                   ON rfa.fund_id = f.fund_id
                  AND rfa.regulator_user_id = $1
                  AND rfa.active = TRUE
                 JOIN users u ON u.user_id = pa.user_id AND u.role = 'WORKER'
                 WHERE fa.effective_from <= CURRENT_DATE
                   AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)
             )
             SELECT count(*)::int AS account_count,
                    count(*) FILTER (WHERE account_status = 'ACTIVE')::int AS active_account_count,
                    count(DISTINCT user_id)::int AS worker_count
             FROM scoped_accounts`,
            [regulatorId]
        ),
        () => client.query(
            `WITH scoped_reports AS (
                 SELECT cr.rba_status, cr.is_legacy,
                        COALESCE(
                            cr.report_content->>'demo_classification' = 'SYNTHETIC_DEMO',
                            FALSE
                        ) AS is_synthetic_demo,
                        (
                            cr.rba_status = 'SUBMITTED'
                            AND cr.submitted_at IS NOT NULL
                            AND cr.last_submitted_at IS NOT NULL
                            AND EXISTS (
                                SELECT 1 FROM compliance_report_submissions s
                                WHERE s.report_id = cr.report_id
                            )
                        ) AS is_awaiting_review
                 FROM compliance_reports cr
                 WHERE EXISTS (
                     SELECT 1 FROM regulator_fund_assignments rfa
                     JOIN funds f ON f.fund_id = rfa.fund_id AND f.fund_status = 'ACTIVE'
                     WHERE rfa.regulator_user_id = $1
                       AND rfa.fund_id = cr.fund_id
                       AND rfa.active = TRUE
                 )
             )
             SELECT
                 count(*) FILTER (
                     WHERE is_legacy = FALSE AND is_synthetic_demo = FALSE
                 )::int AS workflow_total_count,
                 count(*) FILTER (
                     WHERE is_legacy = FALSE AND is_synthetic_demo = FALSE AND rba_status = 'DRAFT'
                 )::int AS workflow_draft_count,
                 count(*) FILTER (
                     WHERE is_legacy = FALSE AND is_synthetic_demo = FALSE AND rba_status = 'SUBMITTED'
                 )::int AS workflow_submitted_count,
                 count(*) FILTER (
                     WHERE is_legacy = FALSE AND is_synthetic_demo = FALSE AND is_awaiting_review
                 )::int AS workflow_awaiting_review_count,
                 count(*) FILTER (
                     WHERE is_legacy = FALSE AND is_synthetic_demo = FALSE
                       AND rba_status = 'SUBMITTED' AND NOT is_awaiting_review
                 )::int AS workflow_incomplete_submission_count,
                 count(*) FILTER (
                     WHERE is_legacy = FALSE AND is_synthetic_demo = FALSE AND rba_status = 'ACCEPTED'
                 )::int AS workflow_approved_count,
                 count(*) FILTER (
                     WHERE is_legacy = FALSE AND is_synthetic_demo = FALSE
                       AND rba_status = 'REVISION_REQUESTED'
                 )::int AS workflow_returned_count,
                 count(*) FILTER (
                     WHERE is_legacy = FALSE AND is_synthetic_demo = FALSE AND rba_status = 'REJECTED'
                 )::int AS workflow_rejected_count,
                 count(*) FILTER (
                     WHERE is_legacy = FALSE AND is_synthetic_demo = TRUE
                 )::int AS synthetic_demo_total_count,
                 count(*) FILTER (
                     WHERE is_legacy = FALSE AND is_synthetic_demo = TRUE AND rba_status = 'DRAFT'
                 )::int AS synthetic_demo_draft_count,
                 count(*) FILTER (
                     WHERE is_legacy = FALSE AND is_synthetic_demo = TRUE AND rba_status = 'SUBMITTED'
                 )::int AS synthetic_demo_submitted_count,
                 count(*) FILTER (
                     WHERE is_legacy = FALSE AND is_synthetic_demo = TRUE AND is_awaiting_review
                 )::int AS synthetic_demo_awaiting_review_count,
                 count(*) FILTER (
                     WHERE is_legacy = FALSE AND is_synthetic_demo = TRUE
                       AND rba_status = 'SUBMITTED' AND NOT is_awaiting_review
                 )::int AS synthetic_demo_incomplete_submission_count,
                 count(*) FILTER (
                     WHERE is_legacy = FALSE AND is_synthetic_demo = TRUE AND rba_status = 'ACCEPTED'
                 )::int AS synthetic_demo_approved_count,
                 count(*) FILTER (
                     WHERE is_legacy = FALSE AND is_synthetic_demo = TRUE
                       AND rba_status = 'REVISION_REQUESTED'
                 )::int AS synthetic_demo_returned_count,
                 count(*) FILTER (
                     WHERE is_legacy = FALSE AND is_synthetic_demo = TRUE AND rba_status = 'REJECTED'
                 )::int AS synthetic_demo_rejected_count,
                 count(*) FILTER (WHERE is_legacy = TRUE)::int AS legacy_history_count
             FROM scoped_reports`,
            [regulatorId]
        ),
        () => client.query(
            `SELECT cr.report_id, cr.report_type,
                    latest_submission.report_content->>'report_category' AS report_category,
                    COALESCE(
                        latest_submission.report_content->>'demo_classification' = 'SYNTHETIC_DEMO',
                        FALSE
                    ) AS is_synthetic_demo,
                    latest_submission.submitted_at, cr.rba_status
             FROM compliance_reports cr
             JOIN LATERAL (
                 SELECT submitted_at, report_content
                 FROM compliance_report_submissions
                 WHERE report_id = cr.report_id
                 ORDER BY version DESC
                 LIMIT 1
             ) latest_submission ON TRUE
             WHERE cr.is_legacy = FALSE
               AND cr.rba_status = 'SUBMITTED'
               AND cr.submitted_at IS NOT NULL
               AND cr.last_submitted_at IS NOT NULL
               AND EXISTS (
                   SELECT 1 FROM regulator_fund_assignments rfa
                   JOIN funds f ON f.fund_id = rfa.fund_id AND f.fund_status = 'ACTIVE'
                   WHERE rfa.regulator_user_id = $1
                     AND rfa.fund_id = cr.fund_id
                     AND rfa.active = TRUE
               )
             ORDER BY latest_submission.submitted_at DESC
             LIMIT 5`,
            [regulatorId]
        ),
        () => client.query(
            `SELECT al.log_id, cr.report_type,
                    cr.report_content->>'report_category' AS report_category,
                    COALESCE(
                        cr.report_content->>'demo_classification' = 'SYNTHETIC_DEMO',
                        FALSE
                    ) AS is_synthetic_demo,
                    cr.rba_status, al.action_type, al."timestamp"
             FROM audit_logs al
             JOIN compliance_reports cr ON cr.report_id = al.entity_id
             WHERE al.entity_name = 'COMPLIANCE_REPORTS'
               AND al.action_type IN ('SUBMIT', 'RESUBMIT', 'APPROVE', 'REJECT', 'REQUEST_REVISION')
               AND EXISTS (
                   SELECT 1 FROM regulator_fund_assignments rfa
                   JOIN funds f ON f.fund_id = rfa.fund_id AND f.fund_status = 'ACTIVE'
                   WHERE rfa.regulator_user_id = $1
                     AND rfa.fund_id = cr.fund_id
                     AND rfa.active = TRUE
               )
             ORDER BY al."timestamp" DESC
             LIMIT 5`,
            [regulatorId]
        ),
        () => client.query(
            `SELECT count(*) FILTER (WHERE activity."timestamp" >= now() - INTERVAL '24 hours')::int AS events_last_24h,
                    max(activity."timestamp") AS last_event_at
             FROM (
                 SELECT al.log_id, al."timestamp"
                 FROM audit_logs al
                 JOIN compliance_reports cr ON cr.report_id = al.entity_id
                 WHERE al.entity_name = 'COMPLIANCE_REPORTS'
                   AND EXISTS (
                       SELECT 1 FROM regulator_fund_assignments rfa
                       JOIN funds f ON f.fund_id = rfa.fund_id AND f.fund_status = 'ACTIVE'
                       WHERE rfa.regulator_user_id = $1
                         AND rfa.fund_id = cr.fund_id
                         AND rfa.active = TRUE
                   )
                 UNION ALL
                 SELECT al.log_id, al."timestamp"
                 FROM audit_logs al
                 JOIN kyc_records k ON k.kyc_id = al.entity_id
                 WHERE al.entity_name = 'KYC_RECORD'
                   AND al.action_type IN ('APPROVE', 'REJECT')
                   AND EXISTS (
                       SELECT 1 FROM pension_accounts pa
                       JOIN fund_allocations fa ON fa.account_id = pa.account_id
                       JOIN funds f ON f.fund_id = fa.fund_id AND f.fund_status = 'ACTIVE'
                       JOIN regulator_fund_assignments rfa
                         ON rfa.fund_id = f.fund_id
                        AND rfa.regulator_user_id = $1
                        AND rfa.active = TRUE
                       WHERE pa.user_id = k.user_id
                         AND fa.effective_from <= CURRENT_DATE
                         AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)
                   )
             ) activity`,
            [regulatorId]
        ),
        () => client.query(
            `SELECT k.kyc_status, count(*)::int AS count
             FROM kyc_records k
             WHERE ${ASSIGNED_KYC_ACCOUNT_SCOPE}
             GROUP BY k.kyc_status
             ORDER BY k.kyc_status`,
            [regulatorId]
        ),
        () => client.query(
            `SELECT al.log_id, al.action_type, al.details->>'status' AS kyc_status,
                    u.role AS reviewer_role, al."timestamp"
             FROM audit_logs al
             JOIN users u ON u.user_id = al.user_id
             JOIN kyc_records k ON k.kyc_id = al.entity_id
             WHERE al.entity_name = 'KYC_RECORD'
               AND al.action_type IN ('APPROVE', 'REJECT')
               AND u.role = 'ADMIN'
               AND ((al.action_type = 'APPROVE' AND al.details->>'status' = 'VERIFIED')
                    OR (al.action_type = 'REJECT' AND al.details->>'status' = 'REJECTED'))
               AND ${ASSIGNED_KYC_ACCOUNT_SCOPE}
             ORDER BY al."timestamp" DESC
             LIMIT 5`,
            [regulatorId]
        ),
        ];
        const dashboardResults = [];
        for (const query of dashboardQueries) dashboardResults.push(await query());
        const [
            scopeResult,
            fundsResult,
            accountsResult,
            reportSummaryResult,
            recentSubmissionsResult,
            recentComplianceActivityResult,
            auditSummaryResult,
            kycCountsResult,
            kycHistoryResult,
        ] = dashboardResults;
        const controlChecks = await evaluateInternalControlChecks(client, regulatorId);
        await client.query("COMMIT");

        const scope = scopeResult.rows[0] || {};
        const accountOverview = accountsResult.rows[0] || {};
        const reportCounts = reportSummaryResult.rows[0] || {};
        const reportCount = (key) => Number(reportCounts[key] || 0);
        return res.status(200).json({
        status: "success",
        data: {
            evaluated_at: controlChecks.evaluated_at,
            scope: {
                assigned_fund_count: Number(scope.assigned_fund_count || 0),
                active_assigned_fund_count: Number(scope.active_assigned_fund_count || 0),
                has_active_fund_scope: Number(scope.active_assigned_fund_count || 0) > 0,
            },
            fund_overview: fundsResult.rows[0] || {
                total_fund_count: 0,
                active_fund_count: 0,
                inactive_fund_count: 0,
            },
            account_overview: accountOverview,
            report_summary: {
                workflow: {
                    total_count: reportCount("workflow_total_count"),
                    draft_count: reportCount("workflow_draft_count"),
                    submitted_count: reportCount("workflow_submitted_count"),
                    awaiting_review_count: reportCount("workflow_awaiting_review_count"),
                    incomplete_submission_count: reportCount("workflow_incomplete_submission_count"),
                    approved_count: reportCount("workflow_approved_count"),
                    returned_count: reportCount("workflow_returned_count"),
                    rejected_count: reportCount("workflow_rejected_count"),
                },
                synthetic_demo: {
                    total_count: reportCount("synthetic_demo_total_count"),
                    draft_count: reportCount("synthetic_demo_draft_count"),
                    submitted_count: reportCount("synthetic_demo_submitted_count"),
                    awaiting_review_count: reportCount("synthetic_demo_awaiting_review_count"),
                    incomplete_submission_count: reportCount("synthetic_demo_incomplete_submission_count"),
                    approved_count: reportCount("synthetic_demo_approved_count"),
                    returned_count: reportCount("synthetic_demo_returned_count"),
                    rejected_count: reportCount("synthetic_demo_rejected_count"),
                },
                legacy_history_count: reportCount("legacy_history_count"),
            },
            awaiting_review: {
                count: reportCount("workflow_awaiting_review_count"),
                synthetic_demo_count: reportCount("synthetic_demo_awaiting_review_count"),
                recent: recentSubmissionsResult.rows,
            },
            recent_compliance_activity: recentComplianceActivityResult.rows,
            audit_summary: auditSummaryResult.rows[0] || { events_last_24h: 0, last_event_at: null },
            kyc: {
                status_counts: kycCountsResult.rows,
                recent_review_history: kycHistoryResult.rows,
            },
            control_checks: controlChecks,
        },
        });
    } catch (error) {
        if (client) await client.query("ROLLBACK");
        console.error("Failed to load regulator dashboard:", error?.code || "REGULATOR_DASHBOARD_QUERY_FAILED");
        return res.status(500).json({ status: "error", message: "Failed to load regulator dashboard due to a server error" });
    } finally {
        client?.release();
    }
}
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
        const [audit, reports, latestRba, kycStatuses, kycReviews] = await Promise.all([
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
            pool.query(
                `SELECT k.kyc_status, count(*)::int AS count
                 FROM kyc_records k
                 WHERE ${ASSIGNED_KYC_ACCOUNT_SCOPE}
                 GROUP BY kyc_status
                 ORDER BY kyc_status`,
                [regulatorId]
            ),
            pool.query(
                `SELECT al.action_type, al.details->>'status' AS kyc_status, al."timestamp"
                 FROM audit_logs al
                 JOIN users u ON u.user_id = al.user_id
                 JOIN kyc_records k ON k.kyc_id = al.entity_id
                 WHERE al.entity_name = 'KYC_RECORD'
                   AND action_type IN ('APPROVE', 'REJECT')
                   AND u.role = 'ADMIN'
                   AND ${ASSIGNED_KYC_ACCOUNT_SCOPE}
                 ORDER BY al."timestamp" DESC
                 LIMIT 10`,
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
                kyc_status_counts: kycStatuses.rows,
                kyc_review_history: kycReviews.rows,
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
                    cr.report_content->>'report_category' AS report_category,
                    COALESCE(
                        cr.report_content->>'demo_classification' = 'SYNTHETIC_DEMO',
                        FALSE
                    ) AS is_synthetic_demo,
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
    getDashboardOverview,
    getKycOversight,
    getInternalControlChecks,
    listReports,
    getComplianceReport,
    reviewComplianceReport,
};
