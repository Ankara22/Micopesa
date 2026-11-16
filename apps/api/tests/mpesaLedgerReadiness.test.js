const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createPensionLedgerReadinessChecker,
    createPensionLedgerReadinessGuard,
    isPensionLedgerEnforcementEnabled,
} = require("../src/services/mpesaLedgerReadiness");

function queryable(result, error = null) {
    return {
        async query(sql) {
            assert.equal(sql, "SELECT status FROM pension_ledger WHERE singleton_key IS TRUE");
            if (error) throw error;
            return result;
        },
    };
}

test("ledger enforcement defaults off and accepts only explicit boolean strings", () => {
    assert.equal(isPensionLedgerEnforcementEnabled({}), false);
    assert.equal(isPensionLedgerEnforcementEnabled({
        MPESA_LEDGER_ENFORCEMENT_ENABLED: "false",
    }), false);
    assert.equal(isPensionLedgerEnforcementEnabled({
        MPESA_LEDGER_ENFORCEMENT_ENABLED: "true",
    }), true);
    assert.throws(
        () => isPensionLedgerEnforcementEnabled({
            MPESA_LEDGER_ENFORCEMENT_ENABLED: "TRUE",
        }),
        { code: "PENSION_LEDGER_ENFORCEMENT_CONFIG_INVALID", statusCode: 503 }
    );
    assert.throws(
        () => isPensionLedgerEnforcementEnabled({
            MPESA_LEDGER_ENFORCEMENT_ENABLED: "",
        }),
        { code: "PENSION_LEDGER_ENFORCEMENT_CONFIG_INVALID", statusCode: 503 }
    );
    assert.throws(
        () => isPensionLedgerEnforcementEnabled({
            MPESA_LEDGER_ENFORCEMENT_ENABLED: null,
        }),
        { code: "PENSION_LEDGER_ENFORCEMENT_CONFIG_INVALID", statusCode: 503 }
    );
});

test("readiness checker accepts exactly one ACTIVE ledger", async () => {
    const assertPensionLedgerActive = createPensionLedgerReadinessChecker();

    assert.equal(await assertPensionLedgerActive(queryable({ rows: [{ status: "ACTIVE" }] })), true);
});

test("readiness checker rejects PREPARING and missing ledgers", async () => {
    const assertPensionLedgerActive = createPensionLedgerReadinessChecker();

    await assert.rejects(
        assertPensionLedgerActive(queryable({ rows: [{ status: "PREPARING" }] })),
        { code: "PENSION_LEDGER_NOT_ACTIVE", statusCode: 503 }
    );
    await assert.rejects(
        assertPensionLedgerActive(queryable({ rows: [] })),
        { code: "PENSION_LEDGER_NOT_ACTIVE", statusCode: 503 }
    );
});

test("readiness checker sanitizes database errors while retaining the cause", async () => {
    const assertPensionLedgerActive = createPensionLedgerReadinessChecker();
    const databaseError = Object.assign(new Error("database detail"), { code: "42P01" });

    await assert.rejects(
        assertPensionLedgerActive(queryable(null, databaseError)),
        (error) => {
            assert.equal(error.code, "PENSION_LEDGER_READINESS_UNAVAILABLE");
            assert.equal(error.statusCode, 503);
            assert.equal(error.message, "Pension ledger readiness could not be established.");
            assert.equal(error.cause, databaseError);
            return true;
        }
    );
});

test("enabled readiness guard fails closed when no checker is available", async () => {
    const guard = createPensionLedgerReadinessGuard({
        environmentProvider: () => ({ MPESA_LEDGER_ENFORCEMENT_ENABLED: "true" }),
    });

    await assert.rejects(guard(), {
        code: "PENSION_LEDGER_READINESS_UNAVAILABLE",
        statusCode: 503,
    });
});
