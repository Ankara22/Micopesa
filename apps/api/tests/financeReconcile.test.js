const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CHECKS, runReconciliation, validateTestDatabaseUrl } = require("../scripts/financeReconcile");

const TEST_DATABASE_URL = "postgres://127.0.0.1:5544/micopesa_registration_test";
process.env.NODE_ENV = "test";

const VERIFIED_TARGET = {
    database_name: "micopesa_registration_test",
    server_address: "127.0.0.1/32",
    read_only: "on",
};

class MockClient {
    constructor({ rowsByCheck = {}, failingCheck = null, target = VERIFIED_TARGET } = {}) {
        this.rowsByCheck = rowsByCheck;
        this.failingCheck = failingCheck;
        this.target = target;
        this.statements = [];
        this.released = false;
    }

    async query(sql) {
        this.statements.push(sql);
        if (/^(BEGIN|COMMIT|ROLLBACK)\b/.test(sql)) return { rows: [] };
        if (sql.startsWith("SELECT current_database()")) return { rows: [this.target] };

        const check = CHECKS.find(({ id }) => sql.includes(`reconcile:${id}`));
        assert.ok(check, `Unexpected query: ${sql}`);
        if (check.id === this.failingCheck) throw new Error(`Mock failure in ${check.id}`);
        return { rows: this.rowsByCheck[check.id] || [] };
    }

    release() {
        this.released = true;
    }
}

function makePoolClass(options = {}) {
    return class MockPool {
        constructor(poolOptions) {
            assert.equal(poolOptions.connectionString, TEST_DATABASE_URL);
            this.client = new MockClient(options);
            this.ended = false;
            MockPool.lastInstance = this;
        }

        async connect() {
            return this.client;
        }

        async end() {
            this.ended = true;
        }
    };
}

test("accepts only the disposable test database target in test mode", () => {
    const environment = { NODE_ENV: "test" };
    assert.doesNotThrow(() => validateTestDatabaseUrl(TEST_DATABASE_URL, environment));
    for (const url of [
        "postgres://example.com:5544/micopesa_registration_test",
        "postgres://127.0.0.1:5433/micopesa_registration_test",
        "postgres://127.0.0.1:5432/micopesa_registration_test",
        "postgres://127.0.0.1:5544/micopesa_test",
        "postgres://127.0.0.1:5544/micopesa_registration_test?hostaddr=203.0.113.2",
        "not a database url",
    ]) {
        assert.throws(() => validateTestDatabaseUrl(url, environment));
    }
    assert.throws(() => validateTestDatabaseUrl(TEST_DATABASE_URL, {}), /NODE_ENV=test/);
});
test("reports each mocked check's count and label independently", async () => {
    const rowsByCheck = Object.fromEntries(CHECKS.map(({ id }, index) => [
        id,
        Array.from({ length: index + 1 }, (_, rowIndex) => ({ fixture_id: `${id}-${rowIndex + 1}` })),
    ]));
    const PoolClass = makePoolClass({ rowsByCheck });

    const report = await runReconciliation({ connectionString: TEST_DATABASE_URL, PoolClass });

    assert.deepEqual(report.database_target, {
        database: "micopesa_registration_test",
        host: "local",
        read_only_transaction: true,
    });
    assert.equal(report.checks.length, CHECKS.length);
    CHECKS.forEach((expected, index) => {
        const actual = report.checks[index];
        assert.equal(actual.id, expected.id);
        assert.equal(actual.explanation, expected.explanation);
        assert.equal(actual.flagged_count, index + 1);
        assert.equal(actual.records.length, index + 1);
        assert.equal(actual.status, "completed");
    });

    const pool = PoolClass.lastInstance;
    assert.ok(pool.client.released);
    assert.ok(pool.ended);
    assert.ok(pool.client.statements[0].includes("REPEATABLE READ READ ONLY"));
    assert.equal(pool.client.statements.at(-1), "COMMIT");
    assert.ok(pool.client.statements.every((sql) => (
        /^(BEGIN|COMMIT|ROLLBACK|SELECT)\b/.test(sql) || sql.startsWith("/* reconcile:")
    )));
});

test("does not flag clean records in an empty report result", async () => {
    const PoolClass = makePoolClass();
    const report = await runReconciliation({ connectionString: TEST_DATABASE_URL, PoolClass });
    assert.ok(report.checks.every(({ flagged_count, records }) => flagged_count === 0 && records.length === 0));
});

test("rejects an unsafe URL before constructing a pool", async () => {
    let poolConstructed = false;
    class ForbiddenPool {
        constructor() {
            poolConstructed = true;
        }
    }

    await assert.rejects(
        runReconciliation({
            connectionString: "postgresql://user:password@db.example.com:5544/micopesa_registration_test",
            PoolClass: ForbiddenPool,
        }),
        /127\.0\.0\.1/
    );
    assert.equal(poolConstructed, false);
});

test("rejects an unsafe connected target before report queries and cleans up", async () => {
    const PoolClass = makePoolClass({
        target: { ...VERIFIED_TARGET, server_address: "192.0.2.10/24" },
    });

    await assert.rejects(
        runReconciliation({ connectionString: TEST_DATABASE_URL, PoolClass }),
        /did not verify as a read-only micopesa_registration_test/
    );

    const pool = PoolClass.lastInstance;
    assert.deepEqual(pool.client.statements, [
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
        "SELECT current_database() AS database_name,\n                    inet_server_addr()::text AS server_address,\n                    current_setting('transaction_read_only') AS read_only",
        "ROLLBACK",
    ]);
    assert.ok(pool.client.released);
    assert.ok(pool.ended);
});

test("rolls back a failed reconciliation query and releases client and pool", async () => {
    const failingCheck = CHECKS[2].id;
    const PoolClass = makePoolClass({ failingCheck });

    await assert.rejects(
        runReconciliation({ connectionString: TEST_DATABASE_URL, PoolClass }),
        new RegExp(`Mock failure in ${failingCheck}`)
    );

    const pool = PoolClass.lastInstance;
    assert.equal(pool.client.statements.at(-1), "ROLLBACK");
    assert.ok(!pool.client.statements.includes("COMMIT"));
    assert.ok(pool.client.released);
    assert.ok(pool.ended);
});

test("constructs blank-identifier SQL predicates for null, empty, whitespace, and valid values", () => {
    const completedSql = CHECKS.find(({ id }) => id === "completed-contribution-payment-evidence").sql;
    const duplicateSql = CHECKS.find(({ id }) => id === "duplicate-provider-identifiers").sql;
    const pendingSql = CHECKS.find(({ id }) => id === "pending-mpesa-provider-state").sql;
    const trimWhitespace = String.raw`E' \t\n\r\f\013'`;
    const missingCheckoutPredicate = `NULLIF(BTRIM(t.checkout_request_id, ${trimWhitespace}), '') IS NULL`;
    const missingReceiptPredicate = `NULLIF(BTRIM(t.mpesa_receipt, ${trimWhitespace}), '') IS NULL`;
    const presentReceiptPredicate = `NULLIF(BTRIM(mpesa_receipt, ${trimWhitespace}), '') IS NOT NULL`;
    const presentCheckoutPredicate = `NULLIF(BTRIM(checkout_request_id, ${trimWhitespace}), '') IS NOT NULL`;

    for (const [value, expectedMissing] of [
        [null, true],
        ["", true],
        [" \t\n ", true],
        ["ws_CO_valid", false],
    ]) {
        const isMissingUnderTrimSemantics = value === null || value.trim() === "";
        assert.equal(isMissingUnderTrimSemantics, expectedMissing);
        assert.ok(completedSql.includes(missingCheckoutPredicate));
        assert.ok(completedSql.includes(missingReceiptPredicate));
        assert.ok(duplicateSql.includes(presentReceiptPredicate));
        assert.ok(duplicateSql.includes(presentCheckoutPredicate));
        assert.ok(pendingSql.includes(missingCheckoutPredicate));
    }
});

test("reports documented limits for payment evidence and balance reconciliation", () => {
    const paymentCheck = CHECKS.find(({ id }) => id === "completed-contribution-payment-evidence");
    const balanceCheck = CHECKS.find(({ id }) => id === "balance-versus-completed-contributions-candidates");
    assert.match(paymentCheck.limitations.join(" "), /do not independently prove/);
    assert.match(balanceCheck.limitations.join(" "), /opening balances/);
    assert.match(balanceCheck.limitations.join(" "), /no independent financial posting ledger/);
});
