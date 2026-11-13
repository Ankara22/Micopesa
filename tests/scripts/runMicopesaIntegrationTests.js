const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const {
    getPreflightDiagnostic,
    getValidationDatabaseConfig,
    normalizeLoopbackAddress,
    verifyValidationDatabaseIdentity,
} = require("./micopesaValidationDatabase");

const repositoryRoot = path.resolve(__dirname, "../..");
const apiRequire = createRequire(path.join(repositoryRoot, "apps/api/package.json"));
const { Client } = apiRequire("pg");
const integrationTest = path.join(
    repositoryRoot,
    "apps/api/tests/micopesaIntegrationsPostgres.integration.cjs"
);

function childEnvironment(environment, config) {
    const child = { NODE_ENV: "test" };
    for (const name of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
        if (environment[name]) child[name] = environment[name];
    }
    child.MICOPESA_VALIDATION_DB_HOST = config.host;
    child.MICOPESA_VALIDATION_DB_PORT = String(config.port);
    child.MICOPESA_VALIDATION_DB_NAME = config.database;
    child.MICOPESA_VALIDATION_DB_USER = config.user;
    child.MICOPESA_VALIDATION_DB_PASSWORD = config.password;
    return child;
}

async function verifyBeforeStartingTests(config) {
    const host = normalizeLoopbackAddress(config.host);
    if (host !== config.host) {
        throw new Error("Wrong server address: validation database host is not allowlisted.");
    }
    const client = new Client({ ...config, host });
    let connected = false;
    try {
        await client.connect();
        connected = true;
        await verifyValidationDatabaseIdentity(client, config);
    } finally {
        if (connected) await client.end();
    }
}

async function main(environment = process.env) {
    const config = getValidationDatabaseConfig(environment);
    try {
        await verifyBeforeStartingTests(config);
    } catch (error) {
        console.error(`Validation database preflight failed: ${getPreflightDiagnostic(error)}`);
        console.error("No integration tests were started.");
        return 1;
    }

    console.log(
        "Database safety preflight passed: allowlisted validation database, loopback server, port 5433."
    );
    const result = spawnSync(process.execPath, ["--test", integrationTest], {
        cwd: repositoryRoot,
        env: childEnvironment(environment, config),
        stdio: "inherit",
    });
    if (result.error) {
        console.error("Could not start the PostgreSQL integration test process.");
        return 1;
    }
    return result.status === null ? 1 : result.status;
}

if (require.main === module) {
    main().then((status) => {
        process.exitCode = status;
    }).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { childEnvironment, main, verifyBeforeStartingTests };
