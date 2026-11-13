const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    ALLOWED_DATABASE,
    PREFLIGHT_DIAGNOSTICS,
    getPreflightDiagnostic,
    getValidationDatabaseConfig,
    normalizeLoopbackAddress,
    verifyValidationDatabaseIdentity,
} = require("../../../tests/scripts/micopesaValidationDatabase");

const validEnvironment = {
    MICOPESA_VALIDATION_DB_HOST: "127.0.0.1",
    MICOPESA_VALIDATION_DB_PORT: "5433",
    MICOPESA_VALIDATION_DB_NAME: ALLOWED_DATABASE,
    MICOPESA_VALIDATION_DB_USER: "integration_user",
    MICOPESA_VALIDATION_DB_PASSWORD: "not-a-real-password",
};

test("validation database configuration accepts only explicit allowlisted endpoints", () => {
    assert.deepEqual(
        getValidationDatabaseConfig(validEnvironment),
        {
            host: "127.0.0.1",
            port: 5433,
            database: ALLOWED_DATABASE,
            user: "integration_user",
            password: "not-a-real-password",
            ssl: false,
            application_name: "micopesa-validation-integration-tests",
        }
    );
    assert.equal(
        getValidationDatabaseConfig({
            ...validEnvironment,
            MICOPESA_VALIDATION_DB_HOST: "::1",
        }).host,
        "::1"
    );

    for (const [name, value, message] of [
        ["MICOPESA_VALIDATION_DB_HOST", "localhost", /Wrong server address/],
        ["MICOPESA_VALIDATION_DB_HOST", "192.0.2.1", /Wrong server address/],
        ["MICOPESA_VALIDATION_DB_PORT", "5432", /Wrong port/],
        ["MICOPESA_VALIDATION_DB_NAME", "Micopesa", /Wrong database name/],
        ["MICOPESA_VALIDATION_DB_NAME", "micopesa_test", /Wrong database name/],
    ]) {
        assert.throws(
            () => getValidationDatabaseConfig({ ...validEnvironment, [name]: value }),
            message
        );
    }
    assert.throws(
        () => getValidationDatabaseConfig({}),
        /MICOPESA_VALIDATION_DB_HOST/
    );
});

test("server identity must exactly match the configured validation endpoint", async () => {
    const config = getValidationDatabaseConfig(validEnvironment);
    const clientFor = (row) => ({
        async query() {
            return { rows: [row] };
        },
    });
    await assert.doesNotReject(() => verifyValidationDatabaseIdentity(
        clientFor({
            database_name: ALLOWED_DATABASE,
            server_address: "127.0.0.1",
            server_port: 5433,
        }),
        config
    ));

    const ipv6Config = getValidationDatabaseConfig({
        ...validEnvironment,
        MICOPESA_VALIDATION_DB_HOST: "::1",
    });
    for (const address of ["::1", "::1/128"]) {
        assert.equal(normalizeLoopbackAddress(address), "::1");
        await assert.doesNotReject(() => verifyValidationDatabaseIdentity(
            clientFor({
                database_name: ALLOWED_DATABASE,
                server_address: address,
                server_port: 5433,
            }),
            ipv6Config
        ));
    }

    assert.equal(normalizeLoopbackAddress("127.0.0.1/32"), "127.0.0.1");
    for (const address of [
        "10.0.0.1",
        "192.168.1.1",
        "203.0.113.1",
        "::2",
        "::ffff:127.0.0.1",
    ]) {
        assert.equal(normalizeLoopbackAddress(address), null);
    }

    for (const [row, diagnostic] of [
        [
            { database_name: "Micopesa", server_address: "127.0.0.1", server_port: 5433 },
            PREFLIGHT_DIAGNOSTICS.wrongDatabaseName,
        ],
        [
            { database_name: "micopesa_test", server_address: "127.0.0.1", server_port: 5433 },
            PREFLIGHT_DIAGNOSTICS.wrongDatabaseName,
        ],
        [
            { database_name: ALLOWED_DATABASE, server_address: "203.0.113.1", server_port: 5433 },
            PREFLIGHT_DIAGNOSTICS.wrongServerAddress,
        ],
        [
            { database_name: ALLOWED_DATABASE, server_address: "192.168.1.10/24", server_port: 5433 },
            PREFLIGHT_DIAGNOSTICS.wrongServerAddress,
        ],
        [
            { database_name: ALLOWED_DATABASE, server_address: "127.0.0.1", server_port: 5432 },
            PREFLIGHT_DIAGNOSTICS.wrongPort,
        ],
    ]) {
        await assert.rejects(verifyValidationDatabaseIdentity(clientFor(row), config), {
            message: diagnostic,
        });
    }
});

test("preflight diagnostics classify connection and identity failures without error details", () => {
    const cases = [
        [{ code: "ECONNREFUSED" }, PREFLIGHT_DIAGNOSTICS.connectionRefused],
        [{ code: "28P01" }, PREFLIGHT_DIAGNOSTICS.authenticationFailed],
        [{ code: "28000" }, PREFLIGHT_DIAGNOSTICS.authenticationFailed],
        [{ code: "3D000" }, PREFLIGHT_DIAGNOSTICS.databaseNotFound],
        [{ code: "MICOPESA_VALIDATION_WRONG_DATABASE_NAME" }, PREFLIGHT_DIAGNOSTICS.wrongDatabaseName],
        [{ code: "MICOPESA_VALIDATION_WRONG_SERVER_ADDRESS" }, PREFLIGHT_DIAGNOSTICS.wrongServerAddress],
        [{ code: "MICOPESA_VALIDATION_WRONG_PORT" }, PREFLIGHT_DIAGNOSTICS.wrongPort],
        [{ code: "ECONNRESET", message: "contains a private connection value" }, PREFLIGHT_DIAGNOSTICS.connectionFailed],
    ];
    for (const [error, expected] of cases) {
        assert.equal(getPreflightDiagnostic(error), expected);
    }
    assert.equal(
        getPreflightDiagnostic({
            cause: { code: "ECONNREFUSED", message: "contains a private connection value" },
        }),
        PREFLIGHT_DIAGNOSTICS.connectionRefused
    );
    assert.doesNotMatch(
        getPreflightDiagnostic({
            code: "ECONNRESET",
            message: "secret password and postgres://private",
        }),
        /secret|password|postgres:\/\//
    );
});
