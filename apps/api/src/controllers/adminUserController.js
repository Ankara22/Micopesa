const pool = require("../db/database");
const { writeAuditLog } = require("../utils/auditLog");

const VALID_ROLES = ["WORKER", "FUND_MANAGER", "REGULATOR", "ADMIN"];
const VALID_STATUSES = ["ACTIVE", "INACTIVE", "SUSPENDED"];
const SAFE_COLUMNS = "user_id, full_name, phone, role, occupation, account_status, created_at, updated_at";

/**
 * GET /api/admin/users
 * ADMIN only. Lists all users (never includes password_hash).
 */
async function listUsers(req, res) {
    try {
        const result = await pool.query(`SELECT ${SAFE_COLUMNS} FROM users ORDER BY created_at DESC`);
        return res.status(200).json({ status: "success", data: result.rows });
    } catch (error) {
        console.error("Failed to list users:", error);
        return res.status(500).json({ status: "error", message: "Failed to list users due to a server error" });
    }
}

/**
 * GET /api/admin/users/:userId
 */
async function getUser(req, res) {
    const { userId } = req.params;

    try {
        const result = await pool.query(`SELECT ${SAFE_COLUMNS} FROM users WHERE user_id = $1`, [userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ status: "error", message: "User not found" });
        }

        return res.status(200).json({ status: "success", data: { user: result.rows[0] } });
    } catch (error) {
        console.error("Failed to fetch user:", error);
        return res.status(500).json({ status: "error", message: "Failed to fetch user due to a server error" });
    }
}

/**
 * PATCH /api/admin/users/:userId/role
 * ADMIN only. Body: { role }
 * Guards against an admin accidentally demoting themselves away from ADMIN
 * (self-lockout prevention).
 */
async function updateUserRole(req, res) {
    const { userId: actingAdminId } = req.user;
    const { userId } = req.params;
    const { role } = req.body;

    if (!role || !VALID_ROLES.includes(role)) {
        return res.status(400).json({ status: "error", message: `role must be one of: ${VALID_ROLES.join(", ")}` });
    }

    if (userId === actingAdminId && role !== "ADMIN") {
        return res.status(400).json({
            status: "error",
            message: "You cannot change your own role away from ADMIN",
        });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query(
            `UPDATE users SET role = $1, updated_at = now() WHERE user_id = $2 RETURNING ${SAFE_COLUMNS}`,
            [role, userId]
        );

        if (result.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ status: "error", message: "User not found" });
        }

        await writeAuditLog(client, {
            userId: actingAdminId,
            actionType: "UPDATE",
            entityName: "USERS_ROLE",
            entityId: userId,
        });
        await client.query("COMMIT");
        return res.status(200).json({
            status: "success",
            message: "User role updated successfully",
            data: { user: result.rows[0] },
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Failed to update user role:", error);
        return res.status(500).json({ status: "error", message: "Failed to update user role due to a server error" });
    } finally {
        client.release();
    }
}

/**
 * PATCH /api/admin/users/:userId/status
 * ADMIN only. Body: { account_status }
 *
 * The database is the source of truth: this handler only ever returns a
 * success response when the UPDATE actually affected a row, and always
 * returns the row's real, just-persisted account_status (via RETURNING)
 * rather than echoing back the client's requested value.
 *
 * Guards against an admin accidentally deactivating/suspending themselves
 * (self-lockout prevention).
 */
async function updateUserStatus(req, res) {
    const { userId: actingAdminId } = req.user;
    const { userId } = req.params;
    const { account_status } = req.body;

    if (!userId || typeof userId !== "string") {
        return res.status(400).json({
            status: "error",
            message: "A valid userId is required",
        });
    }

    if (!account_status || !VALID_STATUSES.includes(account_status)) {
        return res.status(400).json({
            status: "error",
            message: `account_status must be one of: ${VALID_STATUSES.join(", ")}`,
        });
    }

    if (userId === actingAdminId && account_status !== "ACTIVE") {
        return res.status(400).json({
            status: "error",
            message: "You cannot deactivate or suspend your own account",
        });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query(
            `UPDATE users SET account_status = $1, updated_at = now() WHERE user_id = $2 RETURNING ${SAFE_COLUMNS}`,
            [account_status, userId]
        );

        if (result.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ status: "error", message: "User not found" });
        }

        await writeAuditLog(client, {
            userId: actingAdminId,
            actionType: "UPDATE",
            entityName: "USERS_ACCOUNT_STATUS",
            entityId: userId,
        });
        await client.query("COMMIT");
        return res.status(200).json({
            status: "success",
            message: "User account status updated successfully",
            data: { user: result.rows[0] },
        });
    } catch (error) {
        await client.query("ROLLBACK");
        // 23514 = Postgres check_violation. VALID_STATUSES above mirrors the
        // users.account_status CHECK constraint exactly, so this should be
        // unreachable in practice, but surfacing it as a 400 (rather than a
        // generic 500) keeps the database's own constraint as the final
        // source of truth without ever implying a write silently "succeeded".
        if (error.code === "23514") {
            return res.status(400).json({
                status: "error",
                message: `account_status must be one of: ${VALID_STATUSES.join(", ")}`,
            });
        }
        console.error("Failed to update user status:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to update user status due to a server error",
        });
    } finally {
        client.release();
    }
}

module.exports = { listUsers, getUser, updateUserRole, updateUserStatus };
