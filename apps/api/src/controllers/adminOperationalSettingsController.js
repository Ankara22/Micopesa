const pool = require("../db/database");
const { writeAuditLog } = require("../utils/auditLog");
const { DEFAULT_SETTINGS, loadAdminSettings } = require("../services/adminSettingsService");

function validateSettings(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return "settings must be an object";
    }
    const keys = Object.keys(DEFAULT_SETTINGS);
    if (keys.some((key) => !Object.hasOwn(input, key)) || Object.keys(input).some((key) => !keys.includes(key))) {
        return `settings must contain exactly: ${keys.join(", ")}`;
    }
    if (
        typeof input.assumed_yearly_growth !== "number" ||
        !Number.isFinite(input.assumed_yearly_growth) ||
        input.assumed_yearly_growth < 1 ||
        input.assumed_yearly_growth > 20
    ) {
        return "assumed_yearly_growth must be between 1 and 20";
    }
    if (
        !Number.isInteger(input.max_failed_login_attempts) ||
        input.max_failed_login_attempts < 3 ||
        input.max_failed_login_attempts > 10
    ) {
        return "max_failed_login_attempts must be a whole number between 3 and 10";
    }
    if (
        !Number.isInteger(input.account_lockout_duration_minutes) ||
        input.account_lockout_duration_minutes < 5 ||
        input.account_lockout_duration_minutes > 60
    ) {
        return "account_lockout_duration_minutes must be a whole number between 5 and 60";
    }
    if (typeof input.require_otp_on_withdrawal !== "boolean") {
        return "require_otp_on_withdrawal must be true or false";
    }
    return null;
}

async function getOperationalSettings(req, res) {
    try {
        const settings = await loadAdminSettings();
        return res.status(200).json({ status: "success", data: { settings } });
    } catch (error) {
        console.error("Failed to load operational settings:", error.code || "ADMIN_SETTINGS_READ_FAILED");
        return res.status(500).json({
            status: "error",
            message: "Failed to load system settings. Ensure the admin settings migration has been applied.",
        });
    }
}

async function updateOperationalSettings(req, res) {
    const settings = req.body?.settings;
    const validationError = validateSettings(settings);
    if (validationError) {
        return res.status(400).json({ status: "error", message: validationError });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        const current = await loadAdminSettings(client, { lock: true });
        for (const [setting_key, value] of Object.entries(settings)) {
            const oldValue = current[setting_key];
            if (oldValue === value) continue;
            const updated = await client.query(
                `UPDATE system_settings
                 SET setting_value = $1, updated_by = $2, updated_at = now()
                 WHERE setting_key = $3
                 RETURNING setting_key`,
                [String(value), req.user.userId, setting_key]
            );
            if (!updated.rows[0]) {
                throw Object.assign(new Error("System setting disappeared during update"), {
                    code: "ADMIN_SETTING_NOT_FOUND",
                });
            }
            await writeAuditLog(client, {
                userId: req.user.userId,
                actionType: "UPDATE",
                entityName: "SYSTEM_SETTINGS",
                entityId: "ADMIN_SETTINGS",
                details: { key: setting_key, old_value: oldValue, new_value: value },
            });
        }
        await client.query("COMMIT");
        return res.status(200).json({ status: "success", data: { settings } });
    } catch (error) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        console.error("Failed to update operational settings:", error.code || "ADMIN_SETTINGS_UPDATE_FAILED");
        return res.status(500).json({
            status: "error",
            message: "System settings were not saved.",
        });
    } finally {
        client?.release();
    }
}

module.exports = { getOperationalSettings, updateOperationalSettings, validateSettings };
