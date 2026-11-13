const ALLOWED_DATABASE = "Micopesa_migration_validation";
const ALLOWED_PORT = "5433";
const ALLOWED_HOSTS = new Set(["127.0.0.1", "::1"]);
const REQUIRED_ENVIRONMENT = [
    "MICOPESA_VALIDATION_DB_HOST",
    "MICOPESA_VALIDATION_DB_PORT",
    "MICOPESA_VALIDATION_DB_NAME",
    "MICOPESA_VALIDATION_DB_USER",
    "MICOPESA_VALIDATION_DB_PASSWORD",
];

const PREFLIGHT_DIAGNOSTICS = Object.freeze({
    connectionRefused: "Connection refused by the PostgreSQL endpoint.",
    authenticationFailed: "PostgreSQL authentication failed.",
    databaseNotFound: "The configured validation database was not found.",
    wrongDatabaseName: "Connected server reported an unexpected database name.",
    wrongServerAddress: "Connected server reported an unexpected server address.",
    wrongPort: "Connected server reported an unexpected port.",
    connectionFailed: "PostgreSQL connection failed for an unclassified reason.",
});

function getValidationDatabaseConfig(environment = process.env) {
    const missing = REQUIRED_ENVIRONMENT.filter((name) => !environment[name]);
    if (missing.length) {
        throw new Error(
            `Set the required explicit validation database variables: ${missing.join(", ")}.`
        );
    }

    const host = environment.MICOPESA_VALIDATION_DB_HOST;
    const port = environment.MICOPESA_VALIDATION_DB_PORT;
    const database = environment.MICOPESA_VALIDATION_DB_NAME;
    if (!ALLOWED_HOSTS.has(host)) {
        throw new Error("Wrong server address: MICOPESA_VALIDATION_DB_HOST must be loopback.");
    }
    if (port !== ALLOWED_PORT) {
        throw new Error("Wrong port: MICOPESA_VALIDATION_DB_PORT must be 5433.");
    }
    if (database !== ALLOWED_DATABASE) {
        throw new Error("Wrong database name: MICOPESA_VALIDATION_DB_NAME is not allowlisted.");
    }

    return {
        host,
        port: Number(port),
        database,
        user: environment.MICOPESA_VALIDATION_DB_USER,
        password: environment.MICOPESA_VALIDATION_DB_PASSWORD,
        ssl: false,
        application_name: "micopesa-validation-integration-tests",
    };
}

function normalizeLoopbackAddress(address) {
    if (typeof address !== "string") return null;
    const normalized = address.toLowerCase();
    if (normalized === "127.0.0.1" || normalized === "127.0.0.1/32") {
        return "127.0.0.1";
    }
    if (normalized === "::1" || normalized === "::1/128") {
        return "::1";
    }
    return null;
}

async function verifyValidationDatabaseIdentity(client, config) {
    const result = await client.query(
        `SELECT current_database() AS database_name,
                inet_server_addr()::text AS server_address,
                inet_server_port() AS server_port`
    );
    const identity = result.rows[0];
    if (!identity || identity.database_name !== ALLOWED_DATABASE) {
        const error = new Error(PREFLIGHT_DIAGNOSTICS.wrongDatabaseName);
        error.code = "MICOPESA_VALIDATION_WRONG_DATABASE_NAME";
        throw error;
    }
    if (normalizeLoopbackAddress(identity.server_address) !== config.host) {
        const error = new Error(PREFLIGHT_DIAGNOSTICS.wrongServerAddress);
        error.code = "MICOPESA_VALIDATION_WRONG_SERVER_ADDRESS";
        throw error;
    }
    if (Number(identity.server_port) !== Number(ALLOWED_PORT)) {
        const error = new Error(PREFLIGHT_DIAGNOSTICS.wrongPort);
        error.code = "MICOPESA_VALIDATION_WRONG_PORT";
        throw error;
    }
    return identity;
}

function getPreflightDiagnostic(error) {
    const pending = [error];
    const visited = new Set();
    while (pending.length) {
        const current = pending.shift();
        if (!current || (typeof current !== "object" && typeof current !== "function") ||
            visited.has(current)) {
            continue;
        }
        visited.add(current);

        if (current.code === "ECONNREFUSED") {
            return PREFLIGHT_DIAGNOSTICS.connectionRefused;
        }
        if (current.code === "28P01" || current.code === "28000") {
            return PREFLIGHT_DIAGNOSTICS.authenticationFailed;
        }
        if (current.code === "3D000") {
            return PREFLIGHT_DIAGNOSTICS.databaseNotFound;
        }
        if (current.code === "MICOPESA_VALIDATION_WRONG_DATABASE_NAME") {
            return PREFLIGHT_DIAGNOSTICS.wrongDatabaseName;
        }
        if (current.code === "MICOPESA_VALIDATION_WRONG_SERVER_ADDRESS") {
            return PREFLIGHT_DIAGNOSTICS.wrongServerAddress;
        }
        if (current.code === "MICOPESA_VALIDATION_WRONG_PORT") {
            return PREFLIGHT_DIAGNOSTICS.wrongPort;
        }

        pending.push(current.cause);
        if (Array.isArray(current.errors)) pending.push(...current.errors);
    }
    return PREFLIGHT_DIAGNOSTICS.connectionFailed;
}

module.exports = {
    ALLOWED_DATABASE,
    ALLOWED_HOSTS,
    ALLOWED_PORT,
    PREFLIGHT_DIAGNOSTICS,
    REQUIRED_ENVIRONMENT,
    getPreflightDiagnostic,
    getValidationDatabaseConfig,
    normalizeLoopbackAddress,
    verifyValidationDatabaseIdentity,
};
