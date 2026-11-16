const ENFORCEMENT_SETTING = "MPESA_LEDGER_ENFORCEMENT_ENABLED";
const LEDGER_STATUS_QUERY = "SELECT status FROM pension_ledger WHERE singleton_key IS TRUE";

function createReadinessError(code, message, cause) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = 503;
    if (cause) error.cause = cause;
    return error;
}

function isPensionLedgerEnforcementEnabled(environment = process.env) {
    if (environment == null || typeof environment !== "object") {
        throw createReadinessError(
            "PENSION_LEDGER_ENFORCEMENT_CONFIG_INVALID",
            `${ENFORCEMENT_SETTING} must be true or false.`
        );
    }

    const value = environment[ENFORCEMENT_SETTING];
    if (value === undefined) return false;
    if (value === "true") return true;
    if (value === "false") return false;

    throw createReadinessError(
        "PENSION_LEDGER_ENFORCEMENT_CONFIG_INVALID",
        `${ENFORCEMENT_SETTING} must be true or false.`
    );
}

function createPensionLedgerReadinessChecker({ beforeRead } = {}) {
    return async function assertPensionLedgerActive(queryable) {
        if (!queryable || typeof queryable.query !== "function") {
            throw createReadinessError(
                "PENSION_LEDGER_READINESS_UNAVAILABLE",
                "Pension ledger readiness could not be established."
            );
        }

        let result;
        try {
            if (beforeRead) await beforeRead(queryable);
            result = await queryable.query(LEDGER_STATUS_QUERY);
        } catch (error) {
            throw createReadinessError(
                "PENSION_LEDGER_READINESS_UNAVAILABLE",
                "Pension ledger readiness could not be established.",
                error
            );
        }

        if (!Array.isArray(result?.rows)) {
            throw createReadinessError(
                "PENSION_LEDGER_READINESS_UNAVAILABLE",
                "Pension ledger readiness could not be established."
            );
        }
        if (result.rows.length !== 1 || result.rows[0].status !== "ACTIVE") {
            throw createReadinessError(
                "PENSION_LEDGER_NOT_ACTIVE",
                "The pension ledger is not ACTIVE."
            );
        }
        return true;
    };
}

function createPensionLedgerReadinessGuard({
    environmentProvider = () => process.env,
    assertPensionLedgerActive,
} = {}) {
    if (typeof environmentProvider !== "function") {
        throw new TypeError("An environment provider is required.");
    }

    return async function assertPensionLedgerReady(queryable) {
        if (!isPensionLedgerEnforcementEnabled(environmentProvider())) return false;
        if (typeof assertPensionLedgerActive !== "function") {
            throw createReadinessError(
                "PENSION_LEDGER_READINESS_UNAVAILABLE",
                "Pension ledger readiness could not be established."
            );
        }
        await assertPensionLedgerActive(queryable);
        return true;
    };
}

module.exports = {
    createPensionLedgerReadinessChecker,
    createPensionLedgerReadinessGuard,
    isPensionLedgerEnforcementEnabled,
};
