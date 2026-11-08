const path = require("node:path");
const { createRequire } = require("node:module");
const {
    getDatabaseSetupConfig,
    verifyDatabaseIdentity,
} = require("./testDatabaseSafety");

const repositoryRoot = path.resolve(__dirname, "../..");
const apiRequire = createRequire(path.join(repositoryRoot, "apps/api/package.json"));
const { Client } = apiRequire("pg");

async function main(environment = process.env) {
    const { target, admin: adminConfig } = getDatabaseSetupConfig(environment, "teardown");
    const database = new Client({ connectionString: target.url.toString() });
    await database.connect();
    try {
        await verifyDatabaseIdentity(database, target.databaseName);
    } finally {
        await database.end();
    }

    const admin = new Client({ connectionString: adminConfig.url.toString() });
    await admin.connect();
    try {
        await verifyDatabaseIdentity(admin, adminConfig.databaseName);
        await admin.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
            [target.databaseName]
        );
        await admin.query(`DROP DATABASE "${target.databaseName}"`);
    } finally {
        await admin.end();
    }
    console.log(`Dropped dedicated test database: ${target.databaseName}`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { main };
