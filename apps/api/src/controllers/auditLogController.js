const pool = require("../db/database");

const BASE_QUERY = `
    SELECT al.log_id, al.user_id, u.full_name, u.role AS user_role,
           al.action_type, al.entity_name, al.entity_id, al.details, al."timestamp"
    FROM audit_logs al
    LEFT JOIN users u ON u.user_id = al.user_id
`;

const REGULATOR_QUERY = `
    SELECT al.log_id,
           CASE
               WHEN al.entity_name = 'KYC_RECORD' THEN 'Authorized reviewer'
               WHEN al.entity_name = 'REGULATOR_FUND_ASSIGNMENT' THEN 'Administrator'
               ELSE 'You'
           END AS full_name,
           CASE WHEN al.entity_name IN ('KYC_RECORD', 'REGULATOR_FUND_ASSIGNMENT')
                THEN 'ADMIN' ELSE 'REGULATOR' END AS user_role,
           al.action_type,
           CASE al.entity_name
               WHEN 'KYC_RECORD' THEN 'KYC Review'
               WHEN 'REGULATOR_FUND_ASSIGNMENT' THEN 'Fund Scope'
               WHEN 'COMPLIANCE_REPORTS' THEN 'Compliance Report'
               WHEN 'ROLE_NOTIFICATION' THEN 'Notification'
           END AS entity_name,
           CASE
               WHEN al.entity_name = 'KYC_RECORD' THEN al.details->>'status'
               WHEN al.entity_name = 'REGULATOR_FUND_ASSIGNMENT' THEN f.fund_name
               WHEN al.entity_name = 'COMPLIANCE_REPORTS' THEN 'Scoped report activity'
               ELSE 'Scoped notification activity'
           END AS entity_id,
           al."timestamp"
    FROM audit_logs al
    LEFT JOIN users u ON u.user_id = al.user_id
    LEFT JOIN funds f
      ON al.entity_name = 'REGULATOR_FUND_ASSIGNMENT'
     AND f.fund_id = al.entity_id
`;

/**
 * GET /api/audit-logs/operational
 * Fund Managers see their own scoped activity. Regulators also see redacted
 * KYC review history and assignments that currently grant them fund scope.
 */
async function listOperationalLogs(req, res) {
    const page = parsePage(req.query?.page, 1, 100000);
    const pageSize = parsePage(req.query?.page_size, 50, 100);
    const { start_date: startDate, end_date: endDate, action_type: actionType, category } = req.query || {};
    if (
        page === null || pageSize === null ||
        (startDate !== undefined && !isValidDate(startDate)) ||
        (endDate !== undefined && !isValidDate(endDate)) ||
        (startDate && endDate && startDate > endDate) ||
        (actionType !== undefined && !/^[A-Z_]{1,40}$/.test(actionType)) ||
        (category !== undefined && !/^[A-Z_]{1,60}$/.test(category))
    ) {
        return res.status(400).json({ status: "error", message: "Invalid audit log filters or pagination." });
    }

    const scope = `(
        (al.user_id = $1 AND (
            (al.entity_name = 'COMPLIANCE_REPORTS' AND EXISTS (
                SELECT 1
                FROM compliance_reports cr
                JOIN funds f ON f.fund_id = cr.fund_id
                WHERE cr.report_id = al.entity_id
                  AND f.fund_status = 'ACTIVE'
                  AND (
                        ($2 = 'REGULATOR' AND EXISTS (
                            SELECT 1 FROM regulator_fund_assignments rfa
                            WHERE rfa.regulator_user_id = $1
                              AND rfa.fund_id = f.fund_id
                              AND rfa.active = TRUE
                        ))
                        OR ($2 = 'FUND_MANAGER' AND f.managed_by = $1)
                  )
            ))
            OR (al.entity_name = 'ROLE_NOTIFICATION' AND (
                (al.details ? 'scopeFundId' AND al.details->'scopeFundId' = 'null'::jsonb)
                OR (
                    jsonb_typeof(al.details->'scopeFundId') = 'string'
                    AND EXISTS (
                        SELECT 1 FROM funds f
                        WHERE f.fund_id = al.details->>'scopeFundId'
                          AND f.fund_status = 'ACTIVE'
                          AND (
                                ($2 = 'REGULATOR' AND EXISTS (
                                    SELECT 1 FROM regulator_fund_assignments rfa
                                    WHERE rfa.regulator_user_id = $1
                                      AND rfa.fund_id = f.fund_id
                                      AND rfa.active = TRUE
                                ))
                                OR ($2 = 'FUND_MANAGER' AND f.managed_by = $1)
                          )
                    )
                )
            ))
            OR ($2 = 'FUND_MANAGER' AND al.entity_name = 'WITHDRAWAL_CLAIMS' AND EXISTS (
                SELECT 1
                FROM withdrawal_claims wc
                JOIN fund_allocations fa ON fa.account_id = wc.account_id
                JOIN funds f ON f.fund_id = fa.fund_id
                WHERE wc.claim_id = al.entity_id
                  AND f.managed_by = $1
                  AND f.fund_status = 'ACTIVE'
                  AND fa.effective_from <= CURRENT_DATE
                  AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)
            ))
        ))
        ${req.user.role === "REGULATOR" ? `
        OR (
            al.entity_name = 'KYC_RECORD'
            AND al.action_type IN ('APPROVE', 'REJECT')
            AND u.role = 'ADMIN'
            AND (
                (al.action_type = 'APPROVE' AND al.details->>'status' = 'VERIFIED')
                OR (al.action_type = 'REJECT' AND al.details->>'status' = 'REJECTED')
            )
            AND EXISTS (
                SELECT 1
                FROM kyc_records k
                JOIN pension_accounts pa ON pa.user_id = k.user_id
                JOIN fund_allocations fa ON fa.account_id = pa.account_id
                JOIN funds f ON f.fund_id = fa.fund_id AND f.fund_status = 'ACTIVE'
                JOIN regulator_fund_assignments rfa
                  ON rfa.fund_id = f.fund_id
                 AND rfa.regulator_user_id = $1
                 AND rfa.active = TRUE
                WHERE k.kyc_id = al.entity_id
                  AND fa.effective_from <= CURRENT_DATE
                  AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)
            )
        )
        OR (
            al.entity_name = 'REGULATOR_FUND_ASSIGNMENT'
            AND al.action_type = 'UPDATE'
            AND u.role = 'ADMIN'
            AND al.details->>'regulatorUserId' = $1
            AND al.details->>'active' = 'true'
            AND EXISTS (
                SELECT 1
                FROM regulator_fund_assignments rfa
                WHERE rfa.regulator_user_id = $1
                  AND rfa.fund_id = al.entity_id
                  AND rfa.active = TRUE
            )
        )` : ""}
    )`;
    const values = [req.user.userId, req.user.role];
    const filters = [];
    if (startDate) {
        values.push(startDate);
        filters.push(`al."timestamp" >= $${values.length}::date`);
    }
    if (endDate) {
        values.push(endDate);
        filters.push(`al."timestamp" < ($${values.length}::date + INTERVAL '1 day')`);
    }
    if (actionType) {
        values.push(actionType);
        filters.push(`al.action_type = $${values.length}`);
    }
    if (category) {
        values.push(category);
        filters.push(`al.entity_name = $${values.length}`);
    }
    const where = `WHERE ${scope}${filters.length ? ` AND ${filters.join(" AND ")}` : ""}`;
    const offset = (page - 1) * pageSize;
    try {
        const base = req.user.role === "REGULATOR" ? REGULATOR_QUERY : BASE_QUERY;
        const [countResult, result] = await Promise.all([
            pool.query(
                `SELECT count(*)::int AS total_count
                 FROM audit_logs al
                 LEFT JOIN users u ON u.user_id = al.user_id
                 ${where}`,
                values
            ),
            pool.query(
                `${base} ${where}
                 ORDER BY al."timestamp" DESC
                 LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
                [...values, pageSize, offset]
            ),
        ]);
        const totalCount = countResult.rows[0]?.total_count || 0;
        return res.status(200).json({
            status: "success",
            data: result.rows,
            pagination: { page, page_size: pageSize, total_count: totalCount, total_pages: Math.ceil(totalCount / pageSize) },
        });
    } catch (error) {
        console.error("Failed to list operational audit logs:", error?.code || "AUDIT_LOG_QUERY_FAILED");
        return res.status(500).json({ status: "error", message: "Failed to list audit logs due to a server error" });
    }

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
}

/**
 * GET /api/audit-logs/system
 * ADMIN only. Full, unrestricted audit trail, newest first.
 */
async function listSystemLogs(req, res) {
    try {
        const result = await pool.query(`${BASE_QUERY} ORDER BY al."timestamp" DESC LIMIT 500`);
        return res.status(200).json({ status: "success", data: result.rows });
    } catch (error) {
        console.error("Failed to list system audit logs:", error);
        return res.status(500).json({ status: "error", message: "Failed to list audit logs due to a server error" });
    }
}

module.exports = { listOperationalLogs, listSystemLogs };
