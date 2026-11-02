const pool = require("../db/database");

const DEFAULT_SETTINGS = Object.freeze({
    assumed_yearly_growth: 8,
    max_failed_login_attempts: 5,
    account_lockout_duration_minutes: 15,
    require_otp_on_withdrawal: true,
});

function parseSettings(rows) {
    const values = new Map(rows.map(({ setting_key, setting_value }) => [setting_key, setting_value]));
    const missing = Object.keys(DEFAULT_SETTINGS).filter((key) => !values.has(key));
    if (missing.length) {
        const error = new Error(`Required admin settings are missing: ${missing.join(", ")}`);
        error.code = "ADMIN_SETTINGS_MISSING";
        throw error;
    }

    const settings = {
        assumed_yearly_growth: Number(values.get("assumed_yearly_growth")),
        max_failed_login_attempts: Number(values.get("max_failed_login_attempts")),
        account_lockout_duration_minutes: Number(values.get("account_lockout_duration_minutes")),
        require_otp_on_withdrawal: values.get("require_otp_on_withdrawal") === "true",
    };
    if (
        !Number.isFinite(settings.assumed_yearly_growth) ||
        settings.assumed_yearly_growth < 1 ||
        settings.assumed_yearly_growth > 20 ||
        !Number.isInteger(settings.max_failed_login_attempts) ||
        settings.max_failed_login_attempts < 3 ||
        settings.max_failed_login_attempts > 10 ||
        !Number.isInteger(settings.account_lockout_duration_minutes) ||
        settings.account_lockout_duration_minutes < 5 ||
        settings.account_lockout_duration_minutes > 60 ||
        !["true", "false"].includes(values.get("require_otp_on_withdrawal"))
    ) {
        const error = new Error("Stored admin settings contain invalid values");
        error.code = "ADMIN_SETTINGS_INVALID";
        throw error;
    }
    return settings;
}

async function loadAdminSettings(client = pool, { lock = false } = {}) {
    const result = await client.query(
        `SELECT setting_key, setting_value
         FROM system_settings
         WHERE setting_key = ANY($1::varchar[])${lock ? " FOR UPDATE" : ""}`,
        [Object.keys(DEFAULT_SETTINGS)]
    );
    return parseSettings(result.rows);
}

module.exports = { DEFAULT_SETTINGS, loadAdminSettings, parseSettings };
