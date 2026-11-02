const bcrypt = require("bcrypt");
const crypto = require("node:crypto");
const pool = require("../db/database");
const smsService = require("../services/smsService");
const { writeAuditLog } = require("../utils/auditLog");

const STAFF_ROLES = ["FUND_MANAGER", "REGULATOR", "ADMIN"];
const SALT_ROUNDS = 10;

function normalizeKenyanPhone(value) {
    if (typeof value !== "string") return null;
    let phone = value.replace(/[\s()-]/g, "");
    if (/^0[17]\d{8}$/.test(phone)) phone = `+254${phone.slice(1)}`;
    else if (/^254[17]\d{8}$/.test(phone)) phone = `+${phone}`;
    return /^\+254[17]\d{8}$/.test(phone) ? phone : null;
}

function generateTemporaryPassword() {
    return crypto.randomBytes(18).toString("base64url");
}

function logSmsFailure(error, userId) {
    console.error(JSON.stringify({
        event: "admin.staff_onboarding.sms_failed",
        userId,
        errorCode: String(error?.code || "SMS_SEND_FAILED").slice(0, 60),
        errorClass: error?.name || "Error",
    }));
}

async function createStaff(req, res) {
    const fullName = typeof req.body?.full_name === "string" ? req.body.full_name.trim() : "";
    const phone = normalizeKenyanPhone(req.body?.phone);
    const role = req.body?.role;
    if (fullName.length < 2 || fullName.length > 100 || !phone || !STAFF_ROLES.includes(role)) {
        return res.status(400).json({
            status: "error",
            message: "Provide a full name, a valid Kenyan phone number, and an eligible staff role.",
        });
    }

    const temporaryPassword = generateTemporaryPassword();
    let passwordHash;
    try {
        passwordHash = await bcrypt.hash(temporaryPassword, SALT_ROUNDS);
    } catch (error) {
        console.error("Failed to prepare staff credentials:", error.name || "HASH_ERROR");
        return res.status(500).json({ status: "error", message: "Unable to create staff account." });
    }

    let user;
    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        const result = await client.query(
            `INSERT INTO users
                (full_name, phone, password_hash, role, login_method, account_status,
                 is_temp_password, force_password_change)
             VALUES ($1, $2, $3, $4, 'PHONE', 'INACTIVE', TRUE, TRUE)
             RETURNING user_id, full_name, phone, role, account_status, created_at`,
            [fullName, phone, passwordHash, role]
        );
        user = result.rows[0];
        await writeAuditLog(client, {
            userId: req.user.userId,
            actionType: "CREATE",
            entityName: "STAFF_ONBOARDING",
            entityId: user.user_id,
            details: { role, status: "PENDING_SMS" },
        });
        await client.query("COMMIT");
    } catch (error) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        if (error.code === "23505") {
            return res.status(409).json({ status: "error", message: "An account already uses this phone number." });
        }
        console.error("Staff account creation failed:", error.code || "STAFF_CREATE_FAILED");
        return res.status(500).json({ status: "error", message: "Unable to create staff account." });
    } finally {
        client?.release();
    }

    let sms;
    try {
        sms = await smsService.sendSms({
            to: phone,
            message: `Your MicoPesa staff sign-in is ready. Username: ${phone}. Temporary password: ${temporaryPassword}. Change it at first sign-in.`,
        });
    } catch (error) {
        logSmsFailure(error, user.user_id);
        return res.status(201).json({
            status: "success",
            message: "Staff account was created but remains inactive because SMS delivery was not accepted. Retry onboarding from the user list.",
            data: { user, sms_accepted: false },
        });
    }

    try {
        client = await pool.connect();
        await client.query("BEGIN");
        const activated = await client.query(
            `UPDATE users SET account_status = 'ACTIVE', updated_at = now()
             WHERE user_id = $1 AND force_password_change = TRUE
             RETURNING user_id`,
            [user.user_id]
        );
        if (!activated.rows[0]) throw new Error("Onboarding account could not be activated");
        await writeAuditLog(client, {
            userId: req.user.userId,
            actionType: "UPDATE",
            entityName: "STAFF_ONBOARDING",
            entityId: user.user_id,
            details: { role, status: "ACTIVE", sms_accepted: true, provider_message_id: sms.messageId },
        });
        await client.query("COMMIT");
        return res.status(201).json({
            status: "success",
            message: "Staff account created and SMS accepted by the gateway. Inbox delivery is not confirmed.",
            data: { user: { ...user, account_status: "ACTIVE" }, sms_accepted: true },
        });
    } catch (error) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        console.error("Staff account activation failed after SMS acceptance:", error.code || "STAFF_ACTIVATION_FAILED");
        return res.status(201).json({
            status: "success",
            message: "SMS was accepted, but the staff account remains inactive. Retry onboarding to issue new temporary credentials.",
            data: { user, sms_accepted: true, account_active: false },
        });
    } finally {
        client?.release();
    }
}

async function resendStaffOnboarding(req, res) {
    const { userId } = req.params;
    if (!/^[A-F0-9]{25}$/.test(userId)) {
        return res.status(400).json({ status: "error", message: "A valid user ID is required." });
    }

    const temporaryPassword = generateTemporaryPassword();
    let passwordHash;
    try {
        passwordHash = await bcrypt.hash(temporaryPassword, SALT_ROUNDS);
    } catch (error) {
        console.error("Failed to prepare staff onboarding retry:", error.name || "HASH_ERROR");
        return res.status(500).json({ status: "error", message: "Unable to retry staff onboarding." });
    }

    let client;
    let user;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        const result = await client.query(
            `UPDATE users
             SET password_hash = $1, is_temp_password = TRUE, force_password_change = TRUE,
                 failed_login_attempts = 0, locked_until = NULL, account_status = 'INACTIVE',
                 updated_at = now()
             WHERE user_id = $2 AND role = ANY($3::varchar[]) AND force_password_change = TRUE
             RETURNING user_id, full_name, phone, role`,
            [passwordHash, userId, STAFF_ROLES]
        );
        user = result.rows[0];
        if (!user) {
            await client.query("ROLLBACK");
            return res.status(404).json({ status: "error", message: "Pending staff onboarding was not found." });
        }
        await client.query("COMMIT");
    } catch (error) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        console.error("Failed to prepare staff onboarding retry:", error.code || "STAFF_RETRY_FAILED");
        return res.status(500).json({ status: "error", message: "Unable to retry staff onboarding." });
    } finally {
        client?.release();
    }

    let sms;
    try {
        sms = await smsService.sendSms({
            to: user.phone,
            message: `Your MicoPesa staff sign-in is ready. Username: ${user.phone}. Temporary password: ${temporaryPassword}. Change it at first sign-in.`,
        });
    } catch (error) {
        logSmsFailure(error, user.user_id);
        return res.status(502).json({
            status: "error",
            message: "SMS was not accepted. The account remains inactive; retry onboarding later.",
        });
    }

    let activationClient;
    try {
        activationClient = await pool.connect();
        await activationClient.query("BEGIN");
        const activated = await activationClient.query(
            `UPDATE users SET account_status = 'ACTIVE', updated_at = now()
             WHERE user_id = $1 AND force_password_change = TRUE
             RETURNING user_id`,
            [user.user_id]
        );
        if (!activated.rows[0]) throw new Error("Onboarding account could not be activated");
        await writeAuditLog(activationClient, {
            userId: req.user.userId,
            actionType: "UPDATE",
            entityName: "STAFF_ONBOARDING",
            entityId: user.user_id,
            details: {
                role: user.role,
                status: "ACTIVE",
                sms_accepted: true,
                provider_message_id: sms.messageId,
            },
        });
        await activationClient.query("COMMIT");
        return res.status(200).json({
            status: "success",
            message: "New temporary credentials were accepted by the SMS gateway. Inbox delivery is not confirmed.",
        });
    } catch (error) {
        await activationClient.query("ROLLBACK").catch(() => {});
        console.error("Staff retry activation failed after SMS acceptance:", error.code || "STAFF_ACTIVATION_FAILED");
        return res.status(502).json({
            status: "error",
            message: "SMS was accepted, but the account remains inactive. Retry onboarding later.",
        });
    } finally {
        activationClient?.release();
    }
}

module.exports = { createStaff, resendStaffOnboarding, normalizeKenyanPhone, generateTemporaryPassword };
