const fs = require("node:fs");
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
    const { target, admin: adminConfig } = getDatabaseSetupConfig(environment);
    const admin = new Client({ connectionString: adminConfig.url.toString() });
    await admin.connect();
    try {
        await verifyDatabaseIdentity(admin, adminConfig.databaseName);
        const exists = await admin.query(
            "SELECT 1 FROM pg_database WHERE datname = $1",
            [target.databaseName]
        );
        if (exists.rowCount === 0) {
            throw new Error(
                "The dedicated micopesa_registration_test database does not exist; refusing to create or redirect it."
            );
        }
    } finally {
        await admin.end();
    }

    const database = new Client({ connectionString: target.url.toString() });
    await database.connect();
    try {
        await verifyDatabaseIdentity(database, target.databaseName);
        const migrations = [
            "database/schema.sql",
            "database/migration_withdrawal_reason.sql",
            "database/migration_mpesa_stk_push.sql",
            "database/migration_withdrawal_pending_unique.sql",
            "database/migration_user_profiles.sql",
        ];
        for (const migration of migrations) {
            const sql = fs.readFileSync(path.join(repositoryRoot, migration), "utf8");
            await database.query(sql);
            console.log(`Applied ${migration}`);
        }
    } finally {
        await database.end();
    }
    console.log(`Prepared dedicated disposable database: ${target.databaseName}`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { main };
