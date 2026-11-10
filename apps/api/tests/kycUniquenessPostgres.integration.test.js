const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Client } = require("pg");
const { validateKycTestDatabaseUrl } = require("./kycIntegrationDatabaseGuard");

const migrationPath = path.resolve(__dirname, "../../../database/migration_kyc_verified_national_id_uniqueness.sql");
const connectionString = process.env.MICOPESA_TEST_DATABASE_URL;

if (!connectionString) {
    throw new Error(
        "Set MICOPESA_TEST_DATABASE_URL to a dedicated local disposable PostgreSQL test database before running this test."
    );
}
const target = validateKycTestDatabaseUrl(connectionString);
const client = new Client({ connectionString });
const schemaName = `micopesa_kyc_test_${randomUUID().replace(/-/g, "")}`;
const quotedSchema = `"${schemaName}"`;
let schemaCreated = false;
let clientConnected = false;
let nextId = 0;

before(async () => {
    await client.connect();
    clientConnected = true;
    const identity = await client.query(
        `SELECT current_database() AS database_name, current_user AS database_user`
    );
    if (
        identity.rows[0]?.database_name !== target.databaseName ||
        identity.rows[0]?.database_user !== decodeURIComponent(target.url.username)
    ) {
        throw new Error("Connected PostgreSQL database identity did not match the validated test target.");
    }

    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    schemaCreated = true;
    await client.query(`SET search_path TO ${quotedSchema}, public`);
    await client.query(`
        CREATE TABLE users (
            user_id VARCHAR(25) PRIMARY KEY
        );
        CREATE TABLE pension_accounts (
            account_id VARCHAR(25) PRIMARY KEY,
            user_id VARCHAR(25) NOT NULL UNIQUE REFERENCES users(user_id)
        );
        CREATE TABLE kyc_records (
            kyc_id VARCHAR(25) PRIMARY KEY,
            user_id VARCHAR(25) NOT NULL UNIQUE REFERENCES users(user_id),
            national_id VARCHAR(25) NOT NULL,
            date_of_birth DATE NOT NULL,
            kyc_status VARCHAR(15) NOT NULL DEFAULT 'PENDING'
                CHECK (kyc_status IN ('PENDING', 'VERIFIED', 'REJECTED')),
            verified_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_kyc_records_national_id UNIQUE (national_id)
        )
    `);
    await client.query(
        `INSERT INTO users (user_id) VALUES ('legacy-user');
         INSERT INTO kyc_records (kyc_id, user_id, national_id, date_of_birth)
         VALUES ('legacy-kyc', 'legacy-user', '76543210', '1990-04-15')`
    );
    await client.query(fs.readFileSync(migrationPath, "utf8"));
});

after(async () => {
    try {
        if (schemaCreated) {
            await client.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
        }
    } finally {
        if (clientConnected) await client.end();
    }
});

async function finalizeRegistration(label, nationalId = "76543210") {
    const userId = `user-${label}-${++nextId}`;
    const accountId = `account-${label}-${nextId}`;
    const kycId = `kyc-${label}-${nextId}`;
    await client.query("BEGIN");
    try {
        await client.query("INSERT INTO users (user_id) VALUES ($1)", [userId]);
        await client.query(
            "INSERT INTO pension_accounts (account_id, user_id) VALUES ($1, $2)",
            [accountId, userId]
        );
        await client.query(
            `INSERT INTO kyc_records (kyc_id, user_id, national_id, date_of_birth, kyc_status)
             VALUES ($1, $2, $3, '1990-04-15', 'PENDING')`,
            [kycId, userId, nationalId]
        );
        await client.query("COMMIT");
        return { userId, accountId, kycId };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
}

test("migration preserves existing records and allows duplicate pending registration finalization", async () => {
    const existing = await client.query(
        "SELECT user_id FROM kyc_records WHERE kyc_id = 'legacy-kyc'"
    );
    assert.equal(existing.rows.length, 1);

    const first = await finalizeRegistration("first");
    const second = await finalizeRegistration("second");
    const duplicates = await client.query(
        `SELECT kyc_id, duplicate_submission
         FROM kyc_records
         WHERE kyc_id = ANY($1::varchar[])`,
        [[first.kycId, second.kycId]]
    );
    assert.equal(duplicates.rows.length, 2);
    assert.ok(duplicates.rows.every((row) => row.duplicate_submission === true));
});

test("a failed KYC insert rolls back user and pension-account creation", async () => {
    const userId = `rollback-user-${++nextId}`;
    const accountId = `rollback-account-${nextId}`;
    await client.query("BEGIN");
    await client.query("INSERT INTO users (user_id) VALUES ($1)", [userId]);
    await client.query(
        "INSERT INTO pension_accounts (account_id, user_id) VALUES ($1, $2)",
        [accountId, userId]
    );
    await assert.rejects(
        client.query(
            `INSERT INTO kyc_records (kyc_id, user_id, national_id, date_of_birth)
             VALUES ($1, $2, NULL, '1990-04-15')`,
            [`rollback-kyc-${nextId}`, userId]
        ),
        (error) => error.code === "23502"
    );
    await client.query("ROLLBACK");
    const leftovers = await client.query(
        `SELECT
            (SELECT count(*) FROM users WHERE user_id = $1) AS users,
            (SELECT count(*) FROM pension_accounts WHERE user_id = $1) AS accounts`,
        [userId]
    );
    assert.equal(Number(leftovers.rows[0].users), 0);
    assert.equal(Number(leftovers.rows[0].accounts), 0);
});

test("concurrent approvals cannot verify the same National ID twice", async () => {
    const first = await finalizeRegistration("approval-first");
    const second = await finalizeRegistration("approval-second");
    const approvalClients = [new Client({ connectionString }), new Client({ connectionString })];
    await Promise.all(approvalClients.map((approvalClient) => approvalClient.connect()));
    const results = await Promise.allSettled(approvalClients.map(async (approvalClient, index) => {
        await approvalClient.query(`SET search_path TO ${quotedSchema}, public`);
        await approvalClient.query("BEGIN");
        try {
            await approvalClient.query(
                `UPDATE kyc_records
                 SET kyc_status = 'VERIFIED', verified_at = now()
                 WHERE kyc_id = $1`,
                [index === 0 ? first.kycId : second.kycId]
            );
            await approvalClient.query("COMMIT");
        } catch (error) {
            await approvalClient.query("ROLLBACK");
            throw error;
        }
    }));
    await Promise.all(approvalClients.map((approvalClient) => approvalClient.end()));

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "23505");
    assert.equal(rejected.reason.constraint, "uq_kyc_records_verified_national_id");
    const verified = await client.query(
        "SELECT count(*) FROM kyc_records WHERE national_id = '76543210' AND kyc_status = 'VERIFIED'"
    );
    assert.equal(Number(verified.rows[0].count), 1);
});
