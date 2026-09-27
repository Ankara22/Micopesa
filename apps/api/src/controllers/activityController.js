const pool = require("../db/database");

/**
 * GET /api/admin/activity/sessions
 * ADMIN only. Recent USSD sessions (a proxy for "system activity" - the
 * schema has no generic user-activity/session table beyond ussd_sessions).
 */
async function listSessions(req, res) {
    try {
        const result = await pool.query(
            `SELECT s.session_id, s.user_id, u.full_name, s.phone, s.session_status, s.started_at, s.ended_at
             FROM ussd_sessions s
             JOIN users u ON u.user_id = s.user_id
             ORDER BY s.started_at DESC
             LIMIT 200`
        );

        return res.status(200).json({ status: "success", data: result.rows });
    } catch (error) {
        console.error("Failed to list sessions:", error);
        return res.status(500).json({ status: "error", message: "Failed to list sessions due to a server error" });
    }
}

/**
 * GET /api/admin/activity/summary
 * ADMIN only. Lightweight platform activity snapshot: active USSD sessions,
 * users by account_status, and audit action counts in the last 24 hours.
 */
async function getActivitySummary(req, res) {
    try {
        const [activeSessions, usersByStatus, recentActions] = await Promise.all([
            pool.query("SELECT count(*)::int AS count FROM ussd_sessions WHERE session_status = 'ACTIVE'"),
            pool.query("SELECT account_status, count(*)::int AS count FROM users GROUP BY account_status"),
            pool.query(
                `SELECT action_type, count(*)::int AS count
                 FROM audit_logs
                 WHERE "timestamp" > now() - interval '24 hours'
                 GROUP BY action_type`
            ),
        ]);

        return res.status(200).json({
            status: "success",
            data: {
                active_sessions: activeSessions.rows[0].count,
                users_by_status: usersByStatus.rows,
                audit_actions_last_24h: recentActions.rows,
            },
        });
    } catch (error) {
        console.error("Failed to fetch activity summary:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch activity summary due to a server error",
        });
    }
}

module.exports = { listSessions, getActivitySummary };
