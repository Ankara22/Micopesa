const net = require("node:net");

const TEST_DATABASE_NAME = "micopesa_test";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function assertTestMode(environment) {
    if (environment.NODE_ENV !== "test") {
        throw new Error("Database test commands require NODE_ENV=test.");
    }
}

function normalizeHost(hostname) {
    return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function parseLocalDatabaseUrl(value, name, expectedDatabase) {
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
    if (!LOCAL_HOSTS.has(host)) {
        throw new Error(`${name} must use a local PostgreSQL host.`);
    }
    if (!databaseName) {
        throw new Error(`${name} must include a database name.`);
    }
    if (expectedDatabase && databaseName !== expectedDatabase) {
        throw new Error(`${name} must point exactly to ${expectedDatabase}.`);
    }

    return { url, host, port: url.port || "5432", databaseName };
}

function getTargetDatabase(environment = process.env) {
    assertTestMode(environment);
    return parseLocalDatabaseUrl(
        environment.TEST_DATABASE_URL,
        "TEST_DATABASE_URL",
        TEST_DATABASE_NAME
    );
}

function getDatabaseSetupConfig(environment = process.env, operation = "setup") {
    const requiredOptIn = operation === "teardown"
        ? "ALLOW_DESTRUCTIVE_TEST_DB_TEARDOWN"
        : "ALLOW_DESTRUCTIVE_TEST_DB_SETUP";
    assertTestMode(environment);
    if (environment[requiredOptIn] !== "1") {
        throw new Error(`${requiredOptIn}=1 is required for database ${operation}.`);
    }

    const target = parseLocalDatabaseUrl(
        environment.TEST_DATABASE_URL,
        "TEST_DATABASE_URL",
        TEST_DATABASE_NAME
    );
    const admin = parseLocalDatabaseUrl(
        environment.TEST_DATABASE_ADMIN_URL,
        "TEST_DATABASE_ADMIN_URL",
        null
    );

    if (admin.databaseName === target.databaseName ||
        admin.host !== target.host ||
        admin.port !== target.port) {
        throw new Error("TEST_DATABASE_ADMIN_URL must target a separate database on the same local server.");
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
    if (!isLoopbackAddress(identity.server_address)) {
        throw new Error("Connected PostgreSQL server did not report a loopback address.");
    }
    return identity;
}

module.exports = {
    TEST_DATABASE_NAME,
    assertTestMode,
    getDatabaseSetupConfig,
    getTargetDatabase,
    isLoopbackAddress,
    verifyDatabaseIdentity,
};
