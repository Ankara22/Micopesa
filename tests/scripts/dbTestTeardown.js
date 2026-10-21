const { createRequire } = require("node:module");
const path = require("node:path");
const repositoryRoot = path.resolve(__dirname, "../..");
const apiRequire = createRequire(path.join(repositoryRoot, "apps/api/package.json"));
const { Client } = apiRequire("pg");

async function main() {
    if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required.");
    const testUrl = new URL(process.env.TEST_DATABASE_URL);
    const databaseName = decodeURIComponent(testUrl.pathname.slice(1));
    if (databaseName !== "micopesa_test") {
        throw new Error("Refusing to drop any database other than micopesa_test.");
    }

    if (!process.env.TEST_DATABASE_ADMIN_URL) throw new Error("TEST_DATABASE_ADMIN_URL is required.");
    const adminUrl = new URL(process.env.TEST_DATABASE_ADMIN_URL);
    if (decodeURIComponent(adminUrl.pathname.slice(1)) === databaseName) {
        throw new Error("TEST_DATABASE_ADMIN_URL must not point to micopesa_test.");
    }
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(testUrl.hostname) ||
        !["localhost", "127.0.0.1", "::1", "[::1]"].includes(adminUrl.hostname) ||
        testUrl.hostname !== adminUrl.hostname || testUrl.port !== adminUrl.port) {
        throw new Error("Refusing database teardown unless both URLs use the same local PostgreSQL server.");
    }

    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
        await admin.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
            [databaseName]
        );
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    } finally {
        await admin.end();
    }
    console.log(`Dropped dedicated test database: ${databaseName}`);
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
