const net = require("node:net");

const TEST_DATABASE_NAME = "micopesa_registration_test";
const TEST_DATABASE_HOST = "127.0.0.1";
const TEST_DATABASE_PORT = "5544";
const TEST_DATABASE_ADMIN_NAME = "postgres";

function assertTestMode(environment) {
    if (environment.NODE_ENV !== "test") {
        throw new Error("Database test commands require NODE_ENV=test.");
    }
}

function normalizeHost(hostname) {
    return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function parseDatabaseUrl(value, name) {
    if (!value) {
        throw new Error(`${name} is required; configure the dedicated local test database.`);
    }

    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${name} must be a valid PostgreSQL connection URL.`);
    }

    const host = normalizeHost(url.hostname);
    let databaseName;
    try {
        databaseName = decodeURIComponent(url.pathname.slice(1));
    } catch {
        throw new Error(`${name} must include a valid database name.`);
    }
    if (!["postgres:", "postgresql:"].includes(url.protocol)) {
        throw new Error(`${name} must use a PostgreSQL connection URL.`);
    }
    if (url.search || url.hash) {
        throw new Error(`${name} must not contain connection-routing options.`);
    }
    if (!databaseName) {
        throw new Error(`${name} must include a database name.`);
    }

    return { url, host, port: url.port || "5432", databaseName };
}

function parseDisposableTestDatabaseUrl(value, name) {
    const target = parseDatabaseUrl(value, name);
    if (target.host !== TEST_DATABASE_HOST) {
        throw new Error(`${name} must use ${TEST_DATABASE_HOST}.`);
    }
    if (target.port !== TEST_DATABASE_PORT) {
        throw new Error(`${name} must use port ${TEST_DATABASE_PORT}.`);
    }
    if (target.databaseName !== TEST_DATABASE_NAME) {
        throw new Error(`${name} must point exactly to ${TEST_DATABASE_NAME}.`);
    }
    return target;
}

function getTargetDatabase(environment = process.env) {
    assertTestMode(environment);
    return parseDisposableTestDatabaseUrl(environment.TEST_DATABASE_URL, "TEST_DATABASE_URL");
}

function getDatabaseSetupConfig(environment = process.env, operation = "setup") {
    const requiredOptIn = operation === "teardown"
        ? "ALLOW_DESTRUCTIVE_TEST_DB_TEARDOWN"
        : "ALLOW_DESTRUCTIVE_TEST_DB_SETUP";
    assertTestMode(environment);
    if (environment[requiredOptIn] !== "1") {
        throw new Error(`${requiredOptIn}=1 is required for database ${operation}.`);
    }

    const target = parseDisposableTestDatabaseUrl(environment.TEST_DATABASE_URL, "TEST_DATABASE_URL");
    const admin = parseDatabaseUrl(environment.TEST_DATABASE_ADMIN_URL, "TEST_DATABASE_ADMIN_URL");

    if (admin.databaseName === target.databaseName) {
        throw new Error("TEST_DATABASE_ADMIN_URL must target a separate database.");
    }
    if (admin.host !== TEST_DATABASE_HOST ||
        admin.port !== TEST_DATABASE_PORT ||
        admin.databaseName !== TEST_DATABASE_ADMIN_NAME) {
        throw new Error(
            `TEST_DATABASE_ADMIN_URL must target ${TEST_DATABASE_HOST}:${TEST_DATABASE_PORT}/${TEST_DATABASE_ADMIN_NAME}.`
        );
    }

    return { target, admin };
}

function isLoopbackAddress(address) {
    if (!address) return false;
    const normalized = address.split("/")[0].toLowerCase();
    if (normalized.startsWith("::ffff:")) {
        return isLoopbackAddress(normalized.slice("::ffff:".length));
    }
    if (net.isIP(normalized) === 4) return normalized.startsWith("127.");
    return normalized === "::1";
}

async function verifyDatabaseIdentity(client, expectedDatabase) {
    const result = await client.query(
        "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address"
    );
    const identity = result.rows && result.rows[0];
    if (!identity || identity.database_name !== expectedDatabase) {
        throw new Error(`Connected database identity did not match ${expectedDatabase}.`);
    }
    const serverAddress = typeof identity.server_address === "string"
        ? identity.server_address.split("/")[0].toLowerCase()
        : null;
    if (!isLoopbackAddress(serverAddress) || serverAddress !== TEST_DATABASE_HOST) {
        throw new Error(`Connected PostgreSQL server did not report ${TEST_DATABASE_HOST} as its loopback address.`);
    }
    return identity;
}

module.exports = {
    TEST_DATABASE_NAME,
    TEST_DATABASE_HOST,
    TEST_DATABASE_PORT,
    TEST_DATABASE_ADMIN_NAME,
    assertTestMode,
    getDatabaseSetupConfig,
    getTargetDatabase,
    isLoopbackAddress,
    parseDisposableTestDatabaseUrl,
    verifyDatabaseIdentity,
};
