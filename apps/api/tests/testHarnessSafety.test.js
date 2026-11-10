const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");
require("../../../tests/scripts/unitTestBootstrap");
const {
    getDatabaseSetupConfig,
    getTargetDatabase,
    isLoopbackAddress,
    verifyDatabaseIdentity,
} = require("../../../tests/scripts/testDatabaseSafety");
const { resolveTestFiles } = require("../../../tests/scripts/runIntegrationTests");
const { main: runDatabaseTests } = require("../../../tests/scripts/runDatabaseTests");
const { main: setupTestDatabase } = require("../../../tests/scripts/dbTestSetup");
const { main: teardownTestDatabase } = require("../../../tests/scripts/dbTestTeardown");

const repositoryRoot = path.resolve(__dirname, "../../..");
const apiRequire = createRequire(path.join(repositoryRoot, "apps/api/package.json"));

const validEnvironment = {
    NODE_ENV: "test",
    ALLOW_DESTRUCTIVE_TEST_DB_SETUP: "1",
    TEST_DATABASE_URL: "postgres://127.0.0.1:5544/micopesa_registration_test",
    TEST_DATABASE_ADMIN_URL: "postgres://127.0.0.1:5544/postgres",
};

test("normal test scripts never invoke database setup or regression integration tests", () => {
    const rootPackage = require(path.join(repositoryRoot, "package.json"));
    const apiPackage = require(path.join(repositoryRoot, "apps/api/package.json"));

    for (const scriptName of ["test", "test:unit", "test:api", "test:coverage", "test:api:coverage"]) {
        assert.doesNotMatch(rootPackage.scripts[scriptName], /db:test:setup|test:db|--env-file/);
    }
    assert.equal(rootPackage.scripts.test, "npm run test:unit && npm run test:web");
    assert.equal(apiPackage.scripts.test, "npm run test:unit");
    assert.match(rootPackage.scripts["test:db"], /runDatabaseTests\.js/);
});

test("database setup requires test mode, explicit opt-in, exact local target, and separate admin database", () => {
    const setupConfig = getDatabaseSetupConfig(validEnvironment);
    assert.deepEqual(
        [setupConfig.admin.host, setupConfig.admin.port, setupConfig.admin.databaseName],
        ["127.0.0.1", "5544", "postgres"]
    );
    assert.deepEqual(
        [getTargetDatabase(validEnvironment).host, getTargetDatabase(validEnvironment).port, getTargetDatabase(validEnvironment).databaseName],
        ["127.0.0.1", "5544", "micopesa_registration_test"]
    );
    assert.throws(
        () => getDatabaseSetupConfig({ ...validEnvironment, NODE_ENV: "development" }),
        /NODE_ENV=test/
    );
    assert.throws(
        () => getDatabaseSetupConfig({ ...validEnvironment, ALLOW_DESTRUCTIVE_TEST_DB_SETUP: undefined }),
        /ALLOW_DESTRUCTIVE_TEST_DB_SETUP=1/
    );
    assert.throws(
        () => getDatabaseSetupConfig({
            ...validEnvironment,
            TEST_DATABASE_URL: "postgres://example.com:5544/micopesa_registration_test",
        }),
        /127\.0\.0\.1/
    );
    assert.throws(
        () => getDatabaseSetupConfig({
            ...validEnvironment,
            TEST_DATABASE_URL: "postgres://127.0.0.1:5433/micopesa_registration_test",
        }),
        /port 5544/
    );
    assert.throws(
        () => getDatabaseSetupConfig({
            ...validEnvironment,
            TEST_DATABASE_URL: "postgres://127.0.0.1:5544/micopesa_test",
        }),
        /exactly to micopesa_registration_test/
    );
    assert.throws(
        () => getDatabaseSetupConfig({
            ...validEnvironment,
            TEST_DATABASE_ADMIN_URL: "postgres://127.0.0.1:5433/postgres",
        }),
        /127\.0\.0\.1:5544/
    );
    assert.throws(
        () => getDatabaseSetupConfig({
            ...validEnvironment,
            TEST_DATABASE_ADMIN_URL: "postgres://127.0.0.1:5432/postgres",
        }),
        /127\.0\.0\.1:5544/
    );
    assert.throws(
        () => getDatabaseSetupConfig({
            ...validEnvironment,
            TEST_DATABASE_ADMIN_URL: "postgres://127.0.0.1:5544/micopesa_registration_test",
        }),
        /separate database/
    );
    assert.throws(
        () => getDatabaseSetupConfig({
            ...validEnvironment,
            TEST_DATABASE_ADMIN_URL: "postgres://127.0.0.1:5544/micopesa_test_admin",
        }),
        /127\.0\.0\.1:5544\/postgres/
    );
    assert.throws(
        () => getDatabaseSetupConfig({
            ...validEnvironment,
            TEST_DATABASE_ADMIN_URL: "postgres://example.com:5544/postgres",
        }),
        /127\.0\.0\.1:5544\/postgres/
    );
});

test("teardown has a distinct explicit opt-in", () => {
    assert.throws(
        () => getDatabaseSetupConfig(validEnvironment, "teardown"),
        /ALLOW_DESTRUCTIVE_TEST_DB_TEARDOWN=1/
    );
    assert.doesNotThrow(() => getDatabaseSetupConfig({
        ...validEnvironment,
        ALLOW_DESTRUCTIVE_TEST_DB_TEARDOWN: "1",
    }, "teardown"));
    assert.throws(() => getDatabaseSetupConfig({
        ...validEnvironment,
        ALLOW_DESTRUCTIVE_TEST_DB_TEARDOWN: "1",
        TEST_DATABASE_ADMIN_URL: "postgres://127.0.0.1:5544/micopesa_registration_test",
    }, "teardown"), /separate database/);
});

test("integration tests require selected API test files and a local test database", () => {
    assert.deepEqual(
        resolveTestFiles(["apps/api/tests/regression.test.js"]),
        [path.join(repositoryRoot, "apps", "api", "tests", "regression.test.js")]
    );
    assert.throws(() => resolveTestFiles([]), /Select one or more/);
    assert.throws(
        () => resolveTestFiles(["apps/api/tests/../fixtures/seedTestDatabase.js"]),
        /apps\/api\/tests/
    );
    assert.throws(() => getTargetDatabase({ ...validEnvironment, NODE_ENV: "production" }), /NODE_ENV=test/);
    assert.throws(() => getTargetDatabase({
        ...validEnvironment,
        NODE_ENV: undefined,
    }), /NODE_ENV=test/);
});

test("database identity and address checks reject unexpected servers", async () => {
    assert.equal(isLoopbackAddress("127.0.0.1/32"), true);
    assert.equal(isLoopbackAddress("::1/128"), true);
    assert.equal(isLoopbackAddress("10.0.0.1/24"), false);
    await assert.rejects(
        verifyDatabaseIdentity({
            async query() {
                return { rows: [{ database_name: "production", server_address: "127.0.0.1/32" }] };
            },
        }, "micopesa_registration_test"),
        /identity did not match/
    );
    await assert.rejects(
        verifyDatabaseIdentity({
            async query() {
                return { rows: [{ database_name: "micopesa_registration_test", server_address: "203.0.113.1/32" }] };
            },
        }, "micopesa_registration_test"),
        /loopback address/
    );
    await assert.rejects(
        verifyDatabaseIdentity({
            async query() {
                return { rows: [{ database_name: "micopesa_registration_test", server_address: "127.0.0.2" }] };
            },
        }, "micopesa_registration_test"),
        /127\.0\.0\.1/
    );
});

test("unit-test bootstrap blocks database access and external fetch calls", async () => {
    const { Pool } = apiRequire("pg");
    const pool = new Pool({ connectionString: "postgres://127.0.0.1:5544/micopesa_registration_test" });
    await assert.rejects(pool.query("SELECT 1"), {
        code: "DATABASE_ACCESS_DISABLED_IN_UNIT_TEST",
    });
    await pool.end();
    await assert.rejects(fetch("https://provider.example.test"), /External network access is disabled/);
});

test("database setup and teardown reject missing safeguards before opening a client", async () => {
    await assert.rejects(setupTestDatabase({}), /NODE_ENV=test/);
    await assert.rejects(teardownTestDatabase({}), /NODE_ENV=test/);
    assert.throws(
        () => runDatabaseTests(["apps/api/tests/regression.test.js"], {}),
        /NODE_ENV=test/
    );
});

test("environment file loading is skipped in test mode", () => {
    const dotenv = apiRequire("dotenv");
    const originalConfig = dotenv.config;
    const originalNodeEnv = process.env.NODE_ENV;
    const loaderPath = path.join(repositoryRoot, "apps", "api", "src", "config", "loadEnvironment.js");
    let configCalls = 0;
    dotenv.config = () => {
        configCalls += 1;
    };
    process.env.NODE_ENV = "test";
    delete require.cache[loaderPath];

    try {
        require(loaderPath);
        assert.equal(configCalls, 0);
    } finally {
        dotenv.config = originalConfig;
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
        delete require.cache[loaderPath];
    }
});
