const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const repositoryRoot = path.resolve(__dirname, "../..");
const apiRequire = createRequire(path.join(repositoryRoot, "apps/api/package.json"));
const { Client } = apiRequire("pg");

function parseDatabaseUrl(value, name) {
    if (!value) throw new Error(`${name} is required; configure a dedicated test database.`);
    const url = new URL(value);
    const databaseName = decodeURIComponent(url.pathname.slice(1));
    if (databaseName !== "micopesa_test") {
        throw new Error(`${name} must point exactly to the dedicated micopesa_test database.`);
    }
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
        throw new Error(`${name} must use a local PostgreSQL host to prevent production database access.`);
    }
    return { url, databaseName };
}

async function main() {
    const target = parseDatabaseUrl(process.env.TEST_DATABASE_URL, "TEST_DATABASE_URL");
    const adminUrl = new URL(process.env.TEST_DATABASE_ADMIN_URL || "");
    if (!adminUrl.hostname || decodeURIComponent(adminUrl.pathname.slice(1)) === target.databaseName) {
        throw new Error("TEST_DATABASE_ADMIN_URL must connect to a separate administrative database.");
    }
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(adminUrl.hostname) ||
        adminUrl.hostname !== target.url.hostname || adminUrl.port !== target.url.port) {
        throw new Error("TEST_DATABASE_ADMIN_URL must use the same local PostgreSQL server as the test database.");
    }

    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
        const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [target.databaseName]);
        if (exists.rowCount === 0) {
            await admin.query(`CREATE DATABASE "${target.databaseName}"`);
        }
    } finally {
        await admin.end();
    }

    const database = new Client({ connectionString: target.url.toString() });
    await database.connect();
    try {
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
    console.log(`Prepared dedicated test database: ${target.databaseName}`);
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
