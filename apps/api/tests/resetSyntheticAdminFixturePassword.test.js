const { test } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");
const {
    getValidatedTarget,
    resetSyntheticAdminFixturePassword,
} = require("./resetSyntheticAdminFixturePassword");

test("synthetic admin password reset rejects unsafe database targets", () => {
    const unsafeUrls = [
        "postgres://micopesa_test:synthetic@127.0.0.1:5433/micopesa_registration_test",
        "postgres://micopesa_test:synthetic@127.0.0.1:5544/micopesa_other_test",
        "postgres://micopesa_test:synthetic@localhost:5544/micopesa_registration_test",
        "postgres://other_user:synthetic@127.0.0.1:5544/micopesa_registration_test",
        "postgres://micopesa_test:synthetic@127.0.0.1:5544/micopesa_registration_test?sslmode=disable",
    ];

    for (const DATABASE_URL of unsafeUrls) {
        assert.throws(
            () => getValidatedTarget({ DATABASE_URL }),
            /approved disposable target|127\.0\.0\.1|port 5544|micopesa_registration_test|connection-routing options/
        );
    }
});

test("synthetic admin password reset accepts only the exact disposable database target", () => {
    const { target } = getValidatedTarget({
        DATABASE_URL:
            "postgres://micopesa_test:synthetic@127.0.0.1:5544/micopesa_registration_test",
    });

    assert.equal(target.databaseName, "micopesa_registration_test");
    assert.equal(target.url.hostname, "127.0.0.1");
    assert.equal(target.url.port, "5544");
});

test("synthetic admin recovery changes only the verified active fixture password and lockout fields", async () => {
    const calls = [];
    const environment = {
        DATABASE_URL: "postgresql://micopesa_test@127.0.0.1:5544/micopesa_registration_test",
        MICOPESA_TEST_ADMIN_PASSWORD: "Synthetic-Test-Password-Only",
    };
    const client = {
        async connect() {},
        async end() {},
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (sql.startsWith("SELECT current_database()")) {
                return { rows: [{ database_name: "micopesa_registration_test", database_user: "micopesa_test" }] };
            }
            if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
                return { rowCount: null, rows: [] };
            }
            if (sql.startsWith("SELECT role, email_verified, account_status")) {
                return {
                    rowCount: 1,
                    rows: [{ role: "ADMIN", email_verified: true, account_status: "ACTIVE" }],
                };
            }
            if (sql.startsWith("UPDATE users")) {
                return {
                    rowCount: 1,
                    rows: [{
                        role: "ADMIN",
                        email_verified: true,
                        account_status: "ACTIVE",
                        failed_login_attempts: 0,
                        locked_until: null,
                        password_hash: values[0],
                    }],
                };
            }
            assert.fail("Unexpected database query.");
        },
    };

    const result = await resetSyntheticAdminFixturePassword(environment, {
        createClient: () => client,
    });

    assert.deepEqual(result, { administratorsUpdated: 1 });
    const update = calls.find(({ sql }) => sql.startsWith("UPDATE users"));
    assert.match(update.sql, /SET password_hash = \$1, failed_login_attempts = 0, locked_until = NULL/);
    assert.match(update.sql, /lower\(email\) = \$2 AND role = 'ADMIN'/);
    assert.match(update.sql, /email_verified IS TRUE AND account_status = 'ACTIVE'/);
    assert.deepEqual(update.values.slice(1), ["micopesa-admin@example.test"]);
    assert.deepEqual(
        calls.map(({ sql }) => sql).filter((sql) => sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK"),
        ["BEGIN", "COMMIT"]
    );
    assert.equal(await bcrypt.compare(environment.MICOPESA_TEST_ADMIN_PASSWORD, update.values[0]), true);
});

test("synthetic admin recovery refuses an account that is not verified and active without updating it", async () => {
    const calls = [];
    const environment = {
        DATABASE_URL: "postgresql://micopesa_test@127.0.0.1:5544/micopesa_registration_test",
        MICOPESA_TEST_ADMIN_PASSWORD: "Synthetic-Test-Password-Only",
    };
    const client = {
        async connect() {},
        async end() {},
        async query(sql) {
            calls.push(sql);
            if (sql.startsWith("SELECT current_database()")) {
                return { rows: [{ database_name: "micopesa_registration_test", database_user: "micopesa_test" }] };
            }
            if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
            if (sql.startsWith("SELECT role, email_verified, account_status")) {
                return {
                    rowCount: 1,
                    rows: [{ role: "ADMIN", email_verified: true, account_status: "SUSPENDED" }],
                };
            }
            assert.fail("Unexpected database query.");
        },
    };

    await assert.rejects(
        resetSyntheticAdminFixturePassword(environment, { createClient: () => client }),
        /verified, active synthetic administrator/
    );
    assert.equal(calls.some((sql) => sql.startsWith("UPDATE users")), false);
    assert.ok(calls.includes("ROLLBACK"));
});
