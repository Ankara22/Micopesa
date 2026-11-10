const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const {
    assertSafeTestModeConfiguration,
    assertTestModeWasNotLoadedFromEnvironment,
    initializeTestModeJwtSecret,
    validateTestDatabaseUrl,
} = require("../src/utils/testModeConfiguration");
const { generateToken } = require("../src/utils/token");
const authEmailService = require("../src/services/authEmailService");

const safeUrl = "postgresql://micopesa_test:test-only@127.0.0.1:5544/micopesa_registration_test";

test("test database URL accepts a dedicated loopback PostgreSQL target", () => {
    const target = validateTestDatabaseUrl(safeUrl);
    assert.equal(target.databaseName, "micopesa_registration_test");
    assert.equal(target.databaseUser, "micopesa_test");
    assert.equal(target.port, "5544");
});

test("test database URL rejects unsafe database names, hosts, ports, and overrides", () => {
    const unsafeUrls = [
        "postgres://micopesa_test:synthetic@127.0.0.1:5433/micopesa_registration_test",
        "postgres://micopesa_test:synthetic@127.0.0.1:5432/micopesa_registration_test",
        "postgres://micopesa_test:synthetic@localhost:5544/micopesa_registration_test",
        "postgres://micopesa_test:synthetic@192.168.1.10:5544/micopesa_registration_test",
        "postgres://micopesa_test:synthetic@127.0.0.1:5544/application",
        "postgres://micopesa_test:synthetic@127.0.0.1:5544/micopesa_test",
        "postgres://micopesa_test:synthetic@127.0.0.1:5544/micopesa_registration_test?host=remote.example",
        "postgres://micopesa_test:synthetic@127.0.0.1:5544/micopesa_registration_test?hostaddr=192.168.1.10",
        "postgres://micopesa_test:synthetic@127.0.0.1:5544/micopesa_registration_test?service=production",
    ];
    for (const url of unsafeUrls) {
        assert.throws(() => validateTestDatabaseUrl(url), undefined, url);
    }
});

test("test mode requires a database password in its connection URL", () => {
    const urlWithoutPassword = "postgresql://micopesa_test@127.0.0.1:5544/micopesa_registration_test";
    assert.throws(() => validateTestDatabaseUrl(urlWithoutPassword));
    assert.throws(() => assertSafeTestModeConfiguration({
        NODE_ENV: "test",
        MICOPESA_TEST_MODE: "true",
        DATABASE_URL: urlWithoutPassword,
        MICOPESA_EMAIL_CAPTURE: "true",
        MICOPESA_EMAIL_CAPTURE_DIR: path.join(os.tmpdir(), "micopesa-test-captures"),
    }), /must target 127\.0\.0\.1:5544\/micopesa_registration_test/);
});

test("test mode requires an explicit flag and dedicated DATABASE_URL", () => {
    assert.throws(() => assertSafeTestModeConfiguration({
        NODE_ENV: "test",
        DATABASE_URL: safeUrl,
    }), /MICOPESA_TEST_MODE=true/);
    assert.throws(() => assertSafeTestModeConfiguration({
        NODE_ENV: "test",
        MICOPESA_TEST_MODE: "true",
    }), /DATABASE_URL/);
    assert.throws(() => assertSafeTestModeConfiguration({
        NODE_ENV: "development",
        MICOPESA_TEST_MODE: "true",
        DATABASE_URL: safeUrl,
    }), /NODE_ENV=test/);
    assert.throws(() => assertSafeTestModeConfiguration({
        NODE_ENV: "test",
        MICOPESA_TEST_MODE: "true",
        DATABASE_URL: safeUrl,
        PGHOST: "remote.example",
        MICOPESA_EMAIL_CAPTURE: "true",
        MICOPESA_EMAIL_CAPTURE_DIR: path.join(os.tmpdir(), "micopesa-test-captures"),
    }), /connection environment overrides/);
    assert.doesNotThrow(() => assertSafeTestModeConfiguration({
        NODE_ENV: "test",
        MICOPESA_TEST_MODE: "true",
        DATABASE_URL: safeUrl,
        MICOPESA_EMAIL_CAPTURE: "true",
        MICOPESA_EMAIL_CAPTURE_DIR: path.join(os.tmpdir(), "micopesa-test-captures"),
    }));
    assert.doesNotThrow(() => assertSafeTestModeConfiguration({
        NODE_ENV: "production",
        MICOPESA_TEST_MODE: "false",
    }));
});

test("environment-file values cannot activate test mode after startup preflight", () => {
    assert.throws(() => assertTestModeWasNotLoadedFromEnvironment({
        NODE_ENV: "production",
        MICOPESA_TEST_MODE: "true",
    }, false), /must be supplied by the process environment/);
    assert.throws(() => assertTestModeWasNotLoadedFromEnvironment({
        NODE_ENV: "test",
        MICOPESA_TEST_MODE: "false",
    }, false), /must be supplied by the process environment/);
    assert.doesNotThrow(() => assertTestModeWasNotLoadedFromEnvironment({
        NODE_ENV: "test",
        MICOPESA_TEST_MODE: "true",
    }, true));
});

test("isolated test mode generates an in-memory secret for rate-limit hashing and login tokens", () => {
    const original = {
        NODE_ENV: process.env.NODE_ENV,
        MICOPESA_TEST_MODE: process.env.MICOPESA_TEST_MODE,
        JWT_SECRET: process.env.JWT_SECRET,
    };
    try {
        process.env.NODE_ENV = "test";
        process.env.MICOPESA_TEST_MODE = "true";
        delete process.env.JWT_SECRET;

        assert.equal(initializeTestModeJwtSecret(), true);
        assert.equal(process.env.JWT_SECRET.length >= 32, true);
        assert.match(authEmailService.hashRateKey("IP:127.0.0.1"), /^[a-f0-9]{64}$/);
        assert.equal(typeof generateToken({ userId: "test-user", role: "WORKER" }), "string");
        assert.equal(initializeTestModeJwtSecret(), false);
    } finally {
        for (const [name, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test("API startup rejects unsafe test configuration before loading the PostgreSQL driver", () => {
    const serverPath = path.resolve(__dirname, "../src/server.js");
    const source = `
        const Module = require("node:module");
        const originalLoad = Module._load;
        Module._load = function(request, ...args) {
            if (request === "pg") throw new Error("POSTGRES_DRIVER_WAS_LOADED");
            if (request === "dotenv") throw new Error("DOTENV_MODULE_WAS_LOADED");
            return originalLoad.call(this, request, ...args);
        };
        require(${JSON.stringify(serverPath)});
    `;
    const childEnvironment = {
        ...process.env,
        NODE_ENV: "test",
        MICOPESA_TEST_MODE: "true",
        DATABASE_URL: "postgresql://micopesa_test:test-only@127.0.0.1:5433/micopesa_registration_test",
    };
    for (const name of [
        "PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD",
        "PGSERVICE", "PGSERVICEFILE",
    ]) delete childEnvironment[name];
    const result = spawnSync(process.execPath, ["-e", source], {
        cwd: path.resolve(__dirname, "../../.."),
        env: childEnvironment,
        encoding: "utf8",
        timeout: 10000,
    });

    test("API startup rejects test-mode values injected by the environment loader before loading PostgreSQL", () => {
        const serverPath = path.resolve(__dirname, "../src/server.js");
        const source = `
            const Module = require("node:module");
            const originalLoad = Module._load;
            Module._load = function(request, ...args) {
                if (request === "./config/loadEnvironment" && args[0] && args[0].filename === ${JSON.stringify(serverPath)}) {
                    process.env.NODE_ENV = "production";
                    process.env.MICOPESA_TEST_MODE = "true";
                    process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5433/micopesa_production_test";
                    return {};
                }
                if (request === "pg") throw new Error("POSTGRES_DRIVER_WAS_LOADED");
                return originalLoad.call(this, request, ...args);
            };
            require(${JSON.stringify(serverPath)});
        `;
        const childEnvironment = {
            ...process.env,
            NODE_ENV: "development",
            DATABASE_URL: "postgresql://test:test@127.0.0.1:5544/micopesa_registration_test",
        };
        delete childEnvironment.MICOPESA_TEST_MODE;
        for (const name of [
            "PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD",
            "PGSERVICE", "PGSERVICEFILE",
        ]) delete childEnvironment[name];
        const result = spawnSync(process.execPath, ["-e", source], {
            cwd: path.resolve(__dirname, "../../.."),
            env: childEnvironment,
            encoding: "utf8",
            timeout: 10000,
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /must be supplied by the process environment/);
        assert.doesNotMatch(result.stderr, /POSTGRES_DRIVER_WAS_LOADED/);
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must target 127\.0\.0\.1:5544\/micopesa_registration_test/);
    assert.doesNotMatch(result.stderr, /POSTGRES_DRIVER_WAS_LOADED/);
    assert.doesNotMatch(result.stderr, /DOTENV_MODULE_WAS_LOADED/);
});
