const bcrypt = require("bcrypt");
const crypto = require("node:crypto");
const pool = require("../db/database");
const { hashRateKey } = require("../services/authEmailService");
const { writeAuditLog } = require("../utils/auditLog");
const { lockUserIdentities, userIdentityLockKeys } = require("../utils/userIdentityLock");
const { normalizeKenyanPhone, normalizedPhoneSql } = require("../utils/kenyanPhone");

const VALID_ROLES = ["WORKER", "FUND_MANAGER", "REGULATOR", "ADMIN", "PAYOUT_OFFICER"];
const VALID_STATUSES = ["ACTIVE", "INACTIVE", "SUSPENDED"];
const IS_DELETED_EXPRESSION = `CASE WHEN full_name = 'Deleted account'
    AND phone ~ '^D[0-9a-f]{14}$' THEN TRUE ELSE FALSE END AS is_deleted`;
const SAFE_COLUMNS = `user_id, full_name, phone, role, occupation, account_status,
    email_verified, phone_verified_at, is_temp_password, force_password_change,
    created_at, updated_at, ${IS_DELETED_EXPRESSION}`;

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
        const target = await client.query(
            `SELECT ${SAFE_COLUMNS} FROM users WHERE user_id = $1 FOR UPDATE`,
            [userId]
        );
        if (!target.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(404).json({ status: "error", message: "User not found" });
        }
        if (target.rows[0].is_deleted) {
            await client.query("ROLLBACK");
            return res.status(409).json({
                status: "error",
                message: "Deleted accounts cannot be changed.",
            });
        }
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
        const columnCache = new Map();
        const target = await client.query(
            `SELECT user_id, role, account_status, ${IS_DELETED_EXPRESSION}
             FROM users WHERE user_id = $1 FOR UPDATE`,
            [userId]
        );
        if (!target.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(404).json({ status: "error", message: "User not found" });
        }
        if (target.rows[0].is_deleted) {
            await client.query("ROLLBACK");
            return res.status(409).json({
                status: "error",
                message: "Deleted accounts cannot be changed.",
            });
        }
        if (account_status !== "ACTIVE") {
            const activeAdmins = await client.query(
                `SELECT user_id FROM users
                 WHERE role = 'ADMIN' AND account_status = 'ACTIVE'
                 ORDER BY user_id FOR UPDATE`
            );
            if (
                target.rows[0].role === "ADMIN" &&
                target.rows[0].account_status === "ACTIVE" &&
                activeAdmins.rows.length <= 1
            ) {
                await client.query("ROLLBACK");
                return res.status(409).json({
                    status: "error",
                    message: "The final active administrator cannot be deactivated",
                });
            }
        }
        const result = await client.query(
            `UPDATE users
             SET account_status = $1,
                 auth_version = auth_version + CASE WHEN account_status <> $1 THEN 1 ELSE 0 END,
                 updated_at = now()
             WHERE user_id = $2
             RETURNING ${SAFE_COLUMNS}`,
            [account_status, userId]
        );

        if (result.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ status: "error", message: "User not found" });
        }

        if (account_status !== "ACTIVE") {
            await queryOptionalTable(
                client,
                "auth_tokens",
                ["user_id", "consumed_at"],
                "UPDATE auth_tokens SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
                [userId],
                columnCache
            );
            await queryOptionalTable(
                client,
                "phone_change_verifications",
                ["user_id", "pending_phone", "code_hash", "code_salt", "expires_at"],
                `UPDATE phone_change_verifications
                 SET pending_phone = NULL, code_hash = NULL, code_salt = NULL, expires_at = NULL
                 WHERE user_id = $1 AND pending_phone IS NOT NULL`,
                [userId],
                columnCache
            );
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

async function getPublicTableColumns(client, table, cache = new Map()) {
    if (cache.has(table)) return cache.get(table);
    const result = await client.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table]
    );
    const columns = new Set(result.rows.map(({ column_name }) => column_name));
    cache.set(table, columns);
    return columns;
}

async function queryOptionalTable(client, table, requiredColumns, query, values = [], cache) {
    const columns = await getPublicTableColumns(client, table, cache);
    if (requiredColumns.some((column) => !columns.has(column))) return { rows: [] };
    return client.query(query, values);
}

async function deleteByUserIdentity(client, table, userId, emails, phone, cache) {
    const columns = await getPublicTableColumns(client, table, cache);
    const predicates = [];
    const values = [];
    if (columns.has("user_id")) {
        values.push(userId);
        predicates.push(`user_id = $${values.length}`);
    }
    if (columns.has("email") && emails.length > 0) {
        values.push(emails);
        predicates.push(`lower(email) = ANY($${values.length}::text[])`);
    }
    if (columns.has("phone") && phone) {
        values.push(phone);
        predicates.push(`${normalizedPhoneSql("phone")} = $${values.length}`);
    }
    if (predicates.length === 0) return { rows: [] };
    return client.query(
        `DELETE FROM public.${quoteIdentifier(table)} WHERE ${predicates.join(" OR ")}`,
        values
    );
}

async function updateUserToTombstone(client, userId, phone, passwordHash, columns) {
    const assignments = [
        "full_name = 'Deleted account'",
        "phone = $1",
        "password_hash = $2",
        "account_status = 'SUSPENDED'",
        "auth_version = auth_version + 1",
    ];
    const optionalAssignments = [
        ["phone_verified_at", "NULL"],
        ["email", "NULL"],
        ["pending_email", "NULL"],
        ["email_verified", "FALSE"],
        ["is_temp_password", "FALSE"],
        ["force_password_change", "FALSE"],
        ["failed_login_attempts", "0"],
        ["locked_until", "NULL"],
        ["profile_photo_ref", "NULL"],
        ["updated_at", "now()"],
    ];
    for (const [column, value] of optionalAssignments) {
        if (columns.has(column)) assignments.push(`${quoteIdentifier(column)} = ${value}`);
    }
    return client.query(
        `UPDATE users
         SET ${assignments.join(", ")}
         WHERE user_id = $3
         RETURNING user_id`,
        [phone, passwordHash, userId]
    );
}

/**
 * DELETE /api/admin/users/:userId
 * ADMIN only. Permanently removes accounts without protected history. Accounts
 * referenced by history are retained as inaccessible tombstones with contacts
 * and authentication credentials removed.
 */
async function deleteUser(req, res) {
    const actingAdminId = req.user?.userId;
    const { userId } = req.params;
    if (typeof userId !== "string" || !/^[A-F0-9]{25}$/.test(userId)) {
        return res.status(400).json({ status: "error", message: "A valid user ID is required" });
    }
    if (userId === actingAdminId) {
        return res.status(400).json({ status: "error", message: "You cannot delete your own account" });
    }

    let client;
    let transactionOpen = false;
    let protectedHistory = false;
    let outcome = null;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        transactionOpen = true;
        const columnCache = new Map();
        const userColumns = await getPublicTableColumns(client, "users", columnCache);
        const optionalUserColumn = (column) => userColumns.has(column)
            ? quoteIdentifier(column)
            : `NULL::varchar AS ${quoteIdentifier(column)}`;
        const identitySelect = `SELECT user_id, role, account_status, full_name, phone,
                    ${optionalUserColumn("email")}, ${optionalUserColumn("pending_email")},
                    ${IS_DELETED_EXPRESSION}
             FROM users WHERE user_id = $1`;

        const identitySnapshotResult = await client.query(identitySelect, [userId]);
        const identitySnapshot = identitySnapshotResult.rows[0];
        if (!identitySnapshot) {
            await client.query("ROLLBACK");
            transactionOpen = false;
            return res.status(404).json({ status: "error", message: "User not found" });
        }
        if (identitySnapshot.is_deleted) {
            await client.query("ROLLBACK");
            transactionOpen = false;
            return res.status(409).json({
                status: "error",
                message: "This account has already been deleted.",
            });
        }
        if (!VALID_ROLES.includes(identitySnapshot.role)) {
            await client.query("ROLLBACK");
            transactionOpen = false;
            return res.status(409).json({
                status: "error",
                message: "Protected system accounts cannot be deleted.",
            });
        }

        const pendingPhoneResult = await queryOptionalTable(
            client,
            "phone_change_verifications",
            ["user_id", "pending_phone"],
            "SELECT pending_phone FROM phone_change_verifications WHERE user_id = $1",
            [userId],
            columnCache
        );
        const nationalIdResult = await queryOptionalTable(
            client,
            "kyc_records",
            ["user_id", "national_id_fingerprint"],
            "SELECT national_id_fingerprint FROM kyc_records WHERE user_id = $1",
            [userId],
            columnCache
        );
        const lockedIdentityKeys = userIdentityLockKeys({
            emails: [identitySnapshot.email, identitySnapshot.pending_email],
            phones: [
                identitySnapshot.phone,
                ...pendingPhoneResult.rows.map(({ pending_phone: phone }) => phone),
            ],
            nationalIds: nationalIdResult.rows.map(({ national_id_fingerprint: fingerprint }) => fingerprint),
        });
        await lockUserIdentities(client, {
            emails: [identitySnapshot.email, identitySnapshot.pending_email],
            phones: [
                identitySnapshot.phone,
                ...pendingPhoneResult.rows.map(({ pending_phone: phone }) => phone),
            ],
            nationalIds: nationalIdResult.rows.map(({ national_id_fingerprint: fingerprint }) => fingerprint),
        });

        const activeAdmins = await client.query(
            `SELECT user_id FROM users
             WHERE role = 'ADMIN' AND account_status = 'ACTIVE'
             ORDER BY user_id FOR UPDATE`
        );
        const targetResult = await client.query(
            identitySelect.replace("WHERE user_id = $1", "WHERE user_id = $1 FOR UPDATE"),
            [userId]
        );
        const target = targetResult.rows[0];
        if (!target) {
            await client.query("ROLLBACK");
            transactionOpen = false;
            return res.status(404).json({ status: "error", message: "User not found" });
        }
        const currentPendingPhoneResult = await queryOptionalTable(
            client,
            "phone_change_verifications",
            ["user_id", "pending_phone"],
            "SELECT pending_phone FROM phone_change_verifications WHERE user_id = $1 FOR UPDATE",
            [userId],
            columnCache
        );
        const currentNationalIdResult = await queryOptionalTable(
            client,
            "kyc_records",
            ["user_id", "national_id_fingerprint"],
            "SELECT national_id_fingerprint FROM kyc_records WHERE user_id = $1 FOR UPDATE",
            [userId],
            columnCache
        );
        const currentIdentityKeys = userIdentityLockKeys({
            emails: [target.email, target.pending_email],
            phones: [
                target.phone,
                ...currentPendingPhoneResult.rows.map(({ pending_phone: phone }) => phone),
            ],
            nationalIds: currentNationalIdResult.rows.map(({ national_id_fingerprint: fingerprint }) => fingerprint),
        });
        if (currentIdentityKeys.some((key) => !lockedIdentityKeys.includes(key))) {
            await client.query("ROLLBACK");
            transactionOpen = false;
            return res.status(409).json({
                status: "error",
                message: "The account identity changed during deletion. Retry the request.",
            });
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

        const identityEmails = [...new Set(
            [target.email, target.pending_email]
                .filter((email) => typeof email === "string" && email.trim())
                .map((email) => email.trim().toLowerCase())
        )];
        const normalizedPhone = normalizeKenyanPhone(target.phone) ||
            target.phone?.trim().replace(/[\s()-]/g, "") ||
            null;
        await deleteByUserIdentity(
            client,
            "pending_registrations",
            userId,
            identityEmails,
            normalizedPhone,
            columnCache
        );
        await deleteByUserIdentity(
            client,
            "worker_registration_challenges",
            userId,
            identityEmails,
            normalizedPhone,
            columnCache
        );
        const emailRateLimitHashes = identityEmails.map((email) => hashRateKey(`EMAIL:${email}`));
        const accountRateLimitHash = hashRateKey(`ACCOUNT:${userId}`);
        const phoneRateLimitHash = normalizedPhone
            ? hashRateKey(`PHONE:${normalizedPhone}`)
            : null;
        await queryOptionalTable(
            client,
            "auth_rate_limits",
            ["scope", "key_hash"],
            `DELETE FROM auth_rate_limits
             WHERE (scope = 'EMAIL' AND key_hash = ANY($1::char(64)[]))
                OR (scope = 'ACCOUNT' AND key_hash = $2)
                OR (scope = 'PHONE' AND key_hash = $3)`,
            [emailRateLimitHashes, accountRateLimitHash, phoneRateLimitHash],
            columnCache
        );

        protectedHistory = await hasProtectedUserReferences(client, userId);
        await queryOptionalTable(
            client,
            "auth_tokens",
            ["user_id"],
            "DELETE FROM auth_tokens WHERE user_id = $1",
            [userId],
            columnCache
        );
        await queryOptionalTable(
            client,
            "phone_change_verifications",
            ["user_id"],
            "DELETE FROM phone_change_verifications WHERE user_id = $1",
            [userId],
            columnCache
        );
        await queryOptionalTable(
            client,
            "worker_password_reset_challenges",
            ["user_id"],
            "DELETE FROM worker_password_reset_challenges WHERE user_id = $1",
            [userId],
            columnCache
        );
        await queryOptionalTable(
            client,
            "notification_preferences",
            ["user_id"],
            "DELETE FROM notification_preferences WHERE user_id = $1",
            [userId],
            columnCache
        );
        await queryOptionalTable(
            client,
            "push_subscriptions",
            ["user_id"],
            "DELETE FROM push_subscriptions WHERE user_id = $1",
            [userId],
            columnCache
        );
        await queryOptionalTable(
            client,
            "ussd_sessions",
            ["user_id", "session_status", "ended_at"],
            `UPDATE ussd_sessions
             SET session_status = 'EXPIRED', ended_at = COALESCE(ended_at, now())
             WHERE user_id = $1 AND session_status = 'ACTIVE'`,
            [userId],
            columnCache
        );

        if (protectedHistory) {
            const tombstonePhone = await generateUniqueTombstonePhone(client, userId);
            const tombstonePassword = await bcrypt.hash(
                crypto.randomBytes(32).toString("base64url"),
                10
            );
            const tombstone = await client.query(
                `UPDATE users
                 SET full_name = 'Deleted account',
                     phone = $1,
                     phone_verified_at = NULL,
                     email = NULL,
                     pending_email = NULL,
                     email_verified = FALSE,
                     password_hash = $2,
                     is_temp_password = FALSE,
                     force_password_change = FALSE,
                     failed_login_attempts = 0,
                     locked_until = NULL,
                     profile_photo_ref = NULL,
                     account_status = 'SUSPENDED',
                     auth_version = auth_version + 1,
                     updated_at = now()
                 WHERE user_id = $3
                 RETURNING user_id`,
                [tombstonePhone, tombstonePassword, userId]
            );
            if (!tombstone.rows[0]) throw new Error("Locked user could not be anonymized");
            outcome = "ANONYMIZED";
        } else {
            const deleted = await client.query(
                "DELETE FROM users WHERE user_id = $1 RETURNING user_id",
                [userId]
            );
            if (!deleted.rows[0]) throw new Error("Locked user could not be deleted");
            outcome = "PERMANENTLY_DELETED";
        }

        await writeAuditLog(client, {
            userId: actingAdminId,
            actionType: "DELETE",
            entityName: "USERS_ACCOUNT",
            entityId: userId,
            details: {
                outcome,
                history_retained: protectedHistory,
                contact_details_released: true,
                authentication_revoked: true,
            },
        });
        await client.query("COMMIT");
        transactionOpen = false;
    } catch (error) {
        if (client && transactionOpen) {
            await client.query("ROLLBACK").catch(() => {});
            transactionOpen = false;
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
    return res.status(200).json({
        status: "success",
        message: protectedHistory
            ? "Historical records are protected. The account was anonymized, login access was revoked, and its email and phone were released for a separate registration."
            : "User account permanently deleted. Its email and phone are available for a new registration.",
        data: {
            deletion: {
                outcome,
                history_retained: protectedHistory,
                contact_details_released: true,
            },
        },
    });
}

const REMOVABLE_USER_REFERENCES = new Set([
    "auth_tokens",
    "phone_change_verifications",
    "worker_password_reset_challenges",
    "worker_national_id_claims",
    "notification_preferences",
    "push_subscriptions",
]);

const NON_FOREIGN_KEY_USER_REFERENCES = [
    { table: "audit_logs", columns: ["entity_id"], predicate: "entity_name LIKE 'USERS%'" },
    { table: "notification_audit_events", columns: ["sender_user_id", "recipient_user_id"] },
    { table: "report_download_events", columns: ["downloaded_by"] },
    { table: "compliance_report_submissions", columns: ["submitted_by"] },
    { table: "compliance_report_reviews", columns: ["reviewed_by"] },
    { table: "pension_adjustment_requests", columns: ["requester_user_id", "approver_user_id"] },
    { table: "pension_adjustment_decision_audit", columns: ["actor_user_id"] },
    { table: "pension_account_movements", columns: ["actor_user_id"] },
    { table: "withdrawal_payout_retry_decisions", columns: ["authorized_by_user_id"] },
];

function quoteIdentifier(identifier) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
        throw new Error("Unexpected database identifier while checking user history");
    }
    return `"${identifier}"`;
}

async function generateUniqueTombstonePhone(client, userId) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const candidate = `D${crypto.randomBytes(7).toString("hex")}`;
        const collision = await client.query(
            `SELECT 1 FROM users
             WHERE user_id <> $2 AND ${normalizedPhoneSql("phone")} = $1
             LIMIT 1`,
            [candidate, userId]
        );
        if (collision.rows.length === 0) return candidate;
    }
    throw new Error("Unable to allocate a unique non-routable account phone");
}

async function hasProtectedUserReferences(client, userId) {
    const foreignKeys = await client.query(
        `SELECT child_namespace.nspname AS schema_name,
                child_table.relname AS table_name,
                array_agg(child_column.attname::text ORDER BY key_column.ordinality) AS column_names
         FROM pg_constraint constraint_row
         JOIN pg_class child_table ON child_table.oid = constraint_row.conrelid
         JOIN pg_namespace child_namespace ON child_namespace.oid = child_table.relnamespace
         JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
           ON TRUE
         JOIN pg_attribute child_column
           ON child_column.attrelid = child_table.oid
          AND child_column.attnum = key_column.attnum
         WHERE constraint_row.contype = 'f'
           AND constraint_row.confrelid = 'public.users'::regclass
           AND child_namespace.nspname = 'public'
         GROUP BY child_namespace.nspname, child_table.relname, constraint_row.oid`
    );

    for (const reference of foreignKeys.rows) {
        if (REMOVABLE_USER_REFERENCES.has(reference.table_name)) continue;
        const columns = reference.column_names
            .map((column) => `${quoteIdentifier(column)} = $1`)
            .join(" OR ");
        const exists = await client.query(
            `SELECT EXISTS (
                 SELECT 1 FROM ${quoteIdentifier(reference.schema_name)}.${quoteIdentifier(reference.table_name)}
                 WHERE ${columns}
             ) AS present`,
            [userId]
        );
        if (exists.rows[0]?.present) return true;
    }

    for (const reference of NON_FOREIGN_KEY_USER_REFERENCES) {
        const relation = await client.query(
            "SELECT to_regclass($1) IS NOT NULL AS present",
            [`public.${reference.table}`]
        );
        if (!relation.rows[0]?.present) continue;

        const columns = reference.columns
            .map((column) => `${quoteIdentifier(column)} = $1`)
            .join(" OR ");
        const predicate = reference.predicate ? ` AND (${reference.predicate})` : "";
        const exists = await client.query(
            `SELECT EXISTS (
                 SELECT 1 FROM public.${quoteIdentifier(reference.table)}
                 WHERE (${columns})${predicate}
             ) AS present`,
            [userId]
        );
        if (exists.rows[0]?.present) return true;
    }
    return false;
}

module.exports = { listUsers, getUser, updateUserRole, updateUserStatus, deleteUser };
