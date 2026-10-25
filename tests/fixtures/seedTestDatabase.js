const path = require("node:path");
const { createRequire } = require("node:module");
const apiRequire = createRequire(path.resolve(__dirname, "../../apps/api/package.json"));
const bcrypt = apiRequire("bcrypt");

const TEST_PASSWORD = "TestPassword123!";
const TEST_USERS = [
    ["Admin Example", "254700000001", "ADMIN", "ACTIVE"],
    ["Fund Manager Example", "254700000002", "FUND_MANAGER", "ACTIVE"],
    ["Regulator Example", "254700000003", "REGULATOR", "ACTIVE"],
    ["Worker A Example", "254700000004", "WORKER", "ACTIVE"],
    ["Worker B Example", "254700000005", "WORKER", "ACTIVE"],
    ["Inactive Worker Example", "254700000006", "WORKER", "INACTIVE"],
];
const TEST_PHONES = TEST_USERS.map(([, phone]) => phone);

async function cleanTestFixtures(pool) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const existingUsers = await client.query(
            "SELECT user_id, phone, full_name FROM users WHERE phone = ANY($1)",
            [TEST_PHONES]
        );
        const nonFixtureUser = await client.query(
            "SELECT phone FROM users WHERE NOT (phone = ANY($1)) LIMIT 1",
            [TEST_PHONES]
        );
        if (nonFixtureUser.rowCount) {
            throw new Error("Refusing to reset test fixtures: users table contains non-fixture users.");
        }
        const expectedNames = new Map(TEST_USERS.map(([name, phone]) => [phone, name]));
        if (existingUsers.rows.some((user) => expectedNames.get(user.phone) !== user.full_name)) {
            throw new Error("Refusing to reset test fixtures: a reserved test phone belongs to a different user.");
        }

        const userIds = existingUsers.rows.map((user) => user.user_id);
        if (userIds.length) {
            const testAccounts = await client.query(
                "SELECT account_id FROM pension_accounts WHERE user_id = ANY($1)",
                [userIds]
            );
            const accountIds = testAccounts.rows.map((account) => account.account_id);
            const associatedTransactions = await client.query(
                `SELECT DISTINCT t.transaction_id
                 FROM transactions t
                 LEFT JOIN contributions c ON c.transaction_id = t.transaction_id
                 LEFT JOIN pension_accounts pa ON pa.account_id = c.account_id
                 WHERE pa.user_id = ANY($1) OR t.mpesa_phone = ANY($2)`,
                [userIds, TEST_PHONES]
            );
            const transactionIds = associatedTransactions.rows.map((row) => row.transaction_id);

            await client.query("DELETE FROM audit_logs WHERE user_id = ANY($1)", [userIds]);
            await client.query("DELETE FROM compliance_reports WHERE generated_by = ANY($1)", [userIds]);
            await client.query(
                `DELETE FROM fund_allocations fa USING funds f
                 WHERE fa.fund_id = f.fund_id AND f.managed_by = ANY($1)`,
                [userIds]
            );
            await client.query("DELETE FROM funds WHERE managed_by = ANY($1)", [userIds]);
            await client.query("DELETE FROM contributions WHERE account_id = ANY($1)", [accountIds]);
            await client.query("DELETE FROM transactions WHERE transaction_id = ANY($1)", [transactionIds]);
            await client.query("DELETE FROM users WHERE user_id = ANY($1)", [userIds]);
        }

        const remainingAuditLogs = await client.query("SELECT count(*)::int AS count FROM audit_logs");
        if (remainingAuditLogs.rows[0].count !== 0) {
            throw new Error("Refusing to seed fixtures while non-fixture audit records remain in the test database.");
        }
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

async function seedTestDatabase(pool) {
    await cleanTestFixtures(pool);
    const passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
    const users = {};

    for (const [fullName, phone, role, accountStatus] of TEST_USERS) {
        const result = await pool.query(
            `INSERT INTO users (full_name, phone, password_hash, role, account_status, occupation)
             VALUES ($1, $2, $3, $4, $5, 'OTHER_INFORMAL_WORKER')
             RETURNING user_id`,
            [fullName, phone, passwordHash, role, accountStatus]
        );
        users[role === "WORKER" ? phone.slice(-1) : role.toLowerCase()] = result.rows[0].user_id;
    }

    const accounts = {};
    for (const [key, userId, balance] of [
        ["workerA", users["4"], 0],
        ["workerB", users["5"], 0],
        ["inactive", users["6"], 0],
    ]) {
        const result = await pool.query(
            `INSERT INTO pension_accounts (user_id, current_balance, retirement_age)
             VALUES ($1, $2, 60) RETURNING account_id`,
            [userId, balance]
        );
        accounts[key] = result.rows[0].account_id;
    }

    for (const [userId, nationalId, birthDate] of [
        [users["4"], "TEST-NATIONAL-0004", "1990-01-01"],
        [users["5"], "TEST-NATIONAL-0005", "1985-02-02"],
        [users["6"], "TEST-NATIONAL-0006", "1999-03-03"],
    ]) {
        await pool.query(
            `INSERT INTO kyc_records (user_id, national_id, date_of_birth, kyc_status)
             VALUES ($1, $2, $3, 'VERIFIED')`,
            [userId, nationalId, birthDate]
        );
    }

    for (const [accountId, amount] of [
        [accounts.workerA, 1200],
        [accounts.workerA, 3400],
        [accounts.workerB, 777],
    ]) {
        const transaction = await pool.query(
            `INSERT INTO transactions (transaction_type, amount, transaction_status)
             VALUES ('CONTRIBUTION', $1, 'PENDING') RETURNING transaction_id`,
            [amount]
        );
        await pool.query(
            `INSERT INTO contributions (account_id, transaction_id, amount, channel, contribution_status)
             VALUES ($1, $2, $3, 'MPESA', 'PENDING')`,
            [accountId, transaction.rows[0].transaction_id, amount]
        );
    }

    const pendingWithdrawal = await pool.query(
        `INSERT INTO withdrawal_claims
            (account_id, amount_requested, destination_phone, withdrawal_reason, claim_status)
         VALUES ($1, 1000, '254700000004', 'medical', 'PENDING')
         RETURNING claim_id`,
        [accounts.workerA]
    );

    const otherUserPlan = await pool.query(
        `INSERT INTO retirement_plans
            (account_id, target_amount, target_age, expected_return, contribution_frequency)
         VALUES ($1, 1000000, 60, 8, 'MONTHLY') RETURNING plan_id`,
        [accounts.workerB]
    );
    await pool.query(
        `INSERT INTO retirement_projections
            (plan_id, assumed_contribution, assumed_return, projected_amount, projection_years)
         VALUES ($1, 5000, 8, 500000, 20)`,
        [otherUserPlan.rows[0].plan_id]
    );

    const auditCount = await pool.query("SELECT count(*)::int AS count FROM audit_logs");
    if (auditCount.rows[0].count !== 0) throw new Error("Test fixture must start with an empty audit log.");

    return { users, accounts, pendingWithdrawalId: pendingWithdrawal.rows[0].claim_id };
}

module.exports = { seedTestDatabase, TEST_PASSWORD };
