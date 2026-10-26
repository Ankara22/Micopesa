const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

function isEnvironmentFlagEnabled(value, name) {
    if (value === undefined || value === null || String(value).trim() === "") {
        return false;
    }

    const normalized = String(value).trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) return true;
    if (FALSE_VALUES.has(normalized)) return false;
    throw new Error(`${name} must be a boolean value`);
}

function assertSafeAuthConfiguration(environment = process.env) {
    const isProduction = String(environment.NODE_ENV || "").trim().toLowerCase() === "production";
    if (isProduction && isEnvironmentFlagEnabled(environment.ALLOW_PRIVILEGED_SIGNUP, "ALLOW_PRIVILEGED_SIGNUP")) {
        throw new Error("ALLOW_PRIVILEGED_SIGNUP must be disabled in production");
    }
}

module.exports = { assertSafeAuthConfiguration, isEnvironmentFlagEnabled };
