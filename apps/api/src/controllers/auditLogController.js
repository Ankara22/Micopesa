const pool = require("../db/database");

const BASE_QUERY = `
    SELECT al.log_id, al.user_id, u.full_name, u.role AS user_role,
           al.action_type, al.entity_name, al.entity_id, al.details, al."timestamp"
    FROM audit_logs al
    LEFT JOIN users u ON u.user_id = al.user_id
`;

/**
 * GET /api/audit-logs/operational
 * FUND_MANAGER or REGULATOR. Their own actions, subject to current fund scope.
 */
async function listOperationalLogs(req, res) {
    try {
        const result = await pool.query(
            `${BASE_QUERY}
             WHERE al.user_id = $1
               AND (
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
               )
             ORDER BY al."timestamp" DESC LIMIT 200`,
            [req.user.userId, req.user.role]
        );
        return res.status(200).json({ status: "success", data: result.rows });
    } catch (error) {
        console.error("Failed to list operational audit logs:", error);
        return res.status(500).json({ status: "error", message: "Failed to list audit logs due to a server error" });
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
