const pool = require("../db/database");

const BASE_QUERY = `
    SELECT al.log_id, al.user_id, u.full_name, u.role AS user_role,
           al.action_type, al.entity_name, al.entity_id, al."timestamp"
    FROM audit_logs al
    LEFT JOIN users u ON u.user_id = al.user_id
`;

/**
 * GET /api/audit-logs/operational
 * FUND_MANAGER or REGULATOR. Recent audit trail, newest first.
 *
 * NOTE: schema.sql has a single, undifferentiated audit_logs table - there
 * is no "operational" vs "system" scope flag at the data level. This route
 * and /system below both read the same table; the split is purely a
 * route/permission-naming convention matching the design docs' distinct
 * "Review Operational Audit Logs" (FUND_MANAGER/REGULATOR) and "Review
 * System Audit Logs" (ADMIN) use cases.
 */
async function listOperationalLogs(req, res) {
    try {
        const result = await pool.query(`${BASE_QUERY} ORDER BY al."timestamp" DESC LIMIT 200`);
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
