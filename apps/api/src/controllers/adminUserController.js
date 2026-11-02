const pool = require("../db/database");
const { writeAuditLog } = require("../utils/auditLog");
const { hashRateKey } = require("../services/authEmailService");
const { isSafePhotoReference, removeProfilePhoto } = require("../services/profilePhotoStorage");

const VALID_ROLES = ["WORKER", "FUND_MANAGER", "REGULATOR", "ADMIN"];
const VALID_STATUSES = ["ACTIVE", "INACTIVE", "SUSPENDED"];
const SAFE_COLUMNS = "user_id, full_name, phone, role, occupation, account_status, is_temp_password, force_password_change, created_at, updated_at";

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

async function deleteUser(req, res) {
    const actingAdminId = req.user?.userId;
    const { userId } = req.params;
    if (typeof userId !== "string" || !/^[A-F0-9]{25}$/.test(userId)) {
        return res.status(400).json({ status: "error", message: "A valid user ID is required" });
    }
    if (userId === actingAdminId) {
        return res.status(400).json({ status: "error", message: "You cannot delete your own active account" });
    }

    let client;
    let transactionOpen = false;
    let profilePhotoRef;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        transactionOpen = true;

        const activeAdmins = await client.query(
            `SELECT user_id FROM users
             WHERE role = 'ADMIN' AND account_status = 'ACTIVE'
             ORDER BY user_id FOR UPDATE`
        );
        const targetResult = await client.query(
            `SELECT user_id, role, account_status, email, pending_email, profile_photo_ref
             FROM users WHERE user_id = $1 FOR UPDATE`,
            [userId]
        );
        const target = targetResult.rows[0];
        if (!target) {
            await client.query("ROLLBACK");
            transactionOpen = false;
            return res.status(404).json({ status: "error", message: "User not found" });
        }
        if (
            target.role === "ADMIN" &&
            target.account_status === "ACTIVE" &&
            activeAdmins.rows.length <= 1
        ) {
            await client.query("ROLLBACK");
            transactionOpen = false;
            return res.status(409).json({
                status: "error",
                message: "The final active administrator cannot be deleted",
            });
        }
        profilePhotoRef = target.profile_photo_ref;
        if (profilePhotoRef && !isSafePhotoReference(profilePhotoRef)) {
            const error = new Error("Stored profile photo reference is not safe to remove");
            error.code = "PROFILE_PHOTO_REFERENCE_INVALID";
            throw error;
        }

        const transactionResult = await client.query(
            `SELECT t.transaction_id
             FROM transactions t
             WHERE EXISTS (
                 SELECT 1
                 FROM contributions c
                 JOIN pension_accounts pa ON pa.account_id = c.account_id
                 WHERE pa.user_id = $1 AND c.transaction_id = t.transaction_id
             )
             OR EXISTS (
                 SELECT 1
                 FROM withdrawal_claims wc
                 JOIN pension_accounts pa ON pa.account_id = wc.account_id
                 WHERE pa.user_id = $1 AND wc.transaction_id = t.transaction_id
             )
             FOR UPDATE OF t`,
            [userId]
        );
        const transactionIds = [...new Set(transactionResult.rows.map((row) => row.transaction_id))];
        const rateLimitKeys = [];
        for (const scopeKey of [`ACCOUNT:${userId}`, ...[target.email, target.pending_email]
            .filter((email) => typeof email === "string" && email.trim())
            .map((email) => `EMAIL:${email.trim().toLowerCase()}`)]) {
            rateLimitKeys.push(hashRateKey(scopeKey));
        }

        await client.query(
            `UPDATE funds
             SET managed_by = NULL, administrator_name = 'Unassigned'
             WHERE managed_by = $1`,
            [userId]
        );
        await client.query(
            "UPDATE compliance_reports SET generated_by = NULL WHERE generated_by = $1",
            [userId]
        );
        await client.query(
            "UPDATE audit_logs SET entity_id = 'REDACTED' WHERE entity_id = $1",
            [userId]
        );
        await client.query(
            `DELETE FROM auth_rate_limits
             WHERE (scope = 'ACCOUNT' OR scope = 'EMAIL') AND key_hash = ANY($1::char(64)[])`,
            [rateLimitKeys]
        );
        await client.query(
            `DELETE FROM contributions c
             USING pension_accounts pa
             WHERE c.account_id = pa.account_id AND pa.user_id = $1`,
            [userId]
        );
        const deleted = await client.query(
            "DELETE FROM users WHERE user_id = $1 RETURNING user_id",
            [userId]
        );
        if (!deleted.rows[0]) {
            throw new Error("Locked user disappeared during deletion");
        }
        if (transactionIds.length) {
            await client.query(
                `DELETE FROM transactions t
                 WHERE t.transaction_id = ANY($1::varchar[])
                   AND NOT EXISTS (
                       SELECT 1 FROM contributions c WHERE c.transaction_id = t.transaction_id
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM withdrawal_claims wc WHERE wc.transaction_id = t.transaction_id
                   )`,
                [transactionIds]
            );
        }
        await writeAuditLog(client, {
            userId: actingAdminId,
            actionType: "DELETE",
            entityName: "USERS_DELETE",
            entityId: "REDACTED",
        });
        await client.query("COMMIT");
        transactionOpen = false;
    } catch (error) {
        if (client && transactionOpen) {
            await client.query("ROLLBACK").catch(() => {});
            transactionOpen = false;
        }
        if (error.code === "23502" || error.code === "23503") {
            return res.status(409).json({
                status: "error",
                message: "Deletion is blocked by related records or database schema; no changes were made.",
            });
        }
        console.error(JSON.stringify({
            event: "admin.user_deletion.failed",
            errorClass: error?.name || "Error",
            errorCode: typeof error?.code === "string" ? error.code : "ADMIN_USER_DELETION_FAILED",
        }));
        return res.status(500).json({
            status: "error",
            message: "Unable to delete this user right now. No changes were made.",
        });
    } finally {
        client?.release();
    }

    try {
        await removeProfilePhoto(profilePhotoRef);
    } catch (error) {
        console.error(JSON.stringify({
            event: "admin.user_deletion.photo_cleanup_failed",
            errorClass: error?.name || "Error",
            errorCode: typeof error?.code === "string" ? error.code : "PROFILE_PHOTO_CLEANUP_FAILED",
        }));
        return res.status(500).json({
            status: "error",
            message: "The user was deleted, but profile photo cleanup failed. Contact an administrator.",
        });
    }
    return res.status(200).json({ status: "success", message: "User deleted permanently" });
}

module.exports = { listUsers, getUser, updateUserRole, updateUserStatus, deleteUser };
