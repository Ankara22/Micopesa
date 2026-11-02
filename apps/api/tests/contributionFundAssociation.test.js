const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const pool = require("../src/db/database");
const accountRoutes = require("../src/routes/accountRoutes");
const { distributeContributionAmount } = require("../src/controllers/accountController");
const { generateToken } = require("../src/utils/token");

process.env.JWT_SECRET ||= "micopesa-contribution-fund-test-secret";

const originalQuery = pool.query;
const originalConnect = pool.connect;
const originalJwtSecret = process.env.JWT_SECRET;
const USER_A = "A".repeat(25);
const USER_B = "B".repeat(25);
const ACCOUNT_A = "C".repeat(25);
const ACCOUNT_B = "D".repeat(25);
const FUND_A = "E".repeat(25);
const FUND_B = "F".repeat(25);
const FUND_INACTIVE = "G".repeat(25);
const TRANSACTION = "H".repeat(25);
const CONTRIBUTION = "I".repeat(25);
const schemaSql = fs.readFileSync(
    path.join(__dirname, "../../../database/schema.sql"),
    "utf8"
);
const migrationSql = fs.readFileSync(
    path.join(__dirname, "../../../database/migration_contribution_fund_allocations.sql"),
    "utf8"
);

after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    process.env.JWT_SECRET = originalJwtSecret;
});

function createState() {
    return {
        users: new Map([
            [USER_A, { user_id: USER_A, role: "WORKER", account_status: "ACTIVE", auth_version: 0 }],
            [USER_B, { user_id: USER_B, role: "WORKER", account_status: "ACTIVE", auth_version: 0 }],
        ]),
        accounts: new Map([[USER_A, ACCOUNT_A], [USER_B, ACCOUNT_B]]),
        allocations: [
            { allocation_id: "J".repeat(25), account_id: ACCOUNT_A, fund_id: FUND_A, fund_name: "Balanced", percentage: "70.00" },
            { allocation_id: "K".repeat(25), account_id: ACCOUNT_A, fund_id: FUND_B, fund_name: "Growth", percentage: "30.00" },
            { allocation_id: "L".repeat(25), account_id: ACCOUNT_B, fund_id: FUND_INACTIVE, fund_name: "Other", percentage: "100.00" },
        ],
        activeFunds: new Set([FUND_A, FUND_B]),
        transactions: [{
            transaction_id: "OLD-TRANSACTION",
            transaction_status: "COMPLETED",
        }],
        contributions: [{
            contribution_id: "OLD-CONTRIBUTION",
            contribution_status: "COMPLETED",
        }],
        shares: [],
        clientQueries: [],
        poolQueries: [],
        failShareInsert: false,
    };
}

function installDatabase(state) {
    pool.query = async (query, values = []) => {
        state.poolQueries.push({ query, values });
        if (query.includes("SELECT user_id, role, account_status, auth_version FROM users")) {
            const user = state.users.get(values[0]);
            return { rows: user ? [user] : [] };
        }
        if (query.includes("SELECT account_id FROM pension_accounts")) {
            const accountId = state.accounts.get(values[0]);
            return { rows: accountId ? [{ account_id: accountId }] : [] };
        }
        if (query.includes("FROM contributions c") && query.includes("fund_allocations")) {
            return {
                rows: state.contributions
                    .filter(({ account_id }) => account_id === ACCOUNT_A)
                    .map((contribution) => ({
                        ...contribution,
                        fund_allocations: state.shares.filter(({ contribution_id }) =>
                            contribution_id === contribution.contribution_id
                        ),
                    })),
            };
        }
        assert.fail(`Unexpected pool query: ${query}`);
    };

    pool.connect = async () => {
        let snapshot;
        return {
            async query(query, values = []) {
                state.clientQueries.push({ query, values });
                if (query === "BEGIN") {
                    snapshot = structuredClone({
                        transactions: state.transactions,
                        contributions: state.contributions,
                        shares: state.shares,
                    });
                    return { rows: [] };
                }
                if (query === "ROLLBACK") {
                    state.transactions = snapshot.transactions;
                    state.contributions = snapshot.contributions;
                    state.shares = snapshot.shares;
                    return { rows: [] };
                }
                if (query === "COMMIT") return { rows: [] };
                if (query.includes("FROM pension_accounts") && query.includes("FOR UPDATE")) {
                    const accountId = state.accounts.get(values[0]);
                    return {
                        rows: accountId === ACCOUNT_A
                            ? [{ account_id: accountId }]
                            : [],
                    };
                }
                if (query.includes("FROM fund_allocations fa")) {
                    return {
                        rows: state.allocations.filter((allocation) =>
                            allocation.account_id === values[0] &&
                            values[1].includes(allocation.fund_id) &&
                            state.activeFunds.has(allocation.fund_id)
                        ),
                    };
                }
                if (query.includes("INSERT INTO transactions")) {
                    const transaction = {
                        transaction_id: TRANSACTION,
                        amount: values[0],
                        transaction_status: "PENDING",
                        initiated_at: "2026-10-28T10:00:00.000Z",
                    };
                    state.transactions.push(transaction);
                    return { rows: [transaction] };
                }
                if (query.includes("INSERT INTO contributions")) {
                    const contribution = {
                        contribution_id: CONTRIBUTION,
                        account_id: values[0],
                        transaction_id: values[1],
                        amount: values[2],
                        channel: values[3],
                        contribution_status: "PENDING",
                        created_at: "2026-10-28T10:00:00.000Z",
                    };
                    state.contributions.push(contribution);
                    return { rows: [contribution] };
                }
                if (query.includes("INSERT INTO contribution_fund_allocations")) {
                    if (state.failShareInsert) {
                        const error = new Error("simulated share persistence failure");
                        error.code = "23503";
                        throw error;
                    }
                    const [contribution_id, account_id, fund_id, fund_name,
                        allocation_percentage, allocated_amount] = values;
                    state.shares.push({
                        contribution_id,
                        account_id,
                        fund_id,
                        fund_name,
                        allocation_percentage,
                        allocated_amount,
                    });
                    return { rows: [] };
                }
                assert.fail(`Unexpected transaction query: ${query}`);
            },
            release() {},
        };
    };
}

async function createApi(state) {
    installDatabase(state);
    const app = express();
    app.use(express.json());
    app.use("/api/accounts", accountRoutes);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return {
        request(path, { userId = USER_A, method = "POST", body } = {}) {
            const token = generateToken({ userId, role: "WORKER", authVersion: 0 });
            return fetch(`${baseUrl}${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${token}`,
                    ...(body ? { "Content-Type": "application/json" } : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
        },
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        }),
    };
}

test("splits cents exactly across selected allocation weights", () => {
    const shares = distributeContributionAmount(1001n, [
        { allocation_id: "1", fund_id: FUND_A, fund_name: "Balanced", percentage: "70.00" },
        { allocation_id: "2", fund_id: FUND_B, fund_name: "Growth", percentage: "30.00" },
    ]);
    assert.deepEqual(shares.map(({ fund_id, allocated_amount }) => [fund_id, allocated_amount]), [
        [FUND_A, "7.01"],
        [FUND_B, "3.00"],
    ]);
    assert.equal(shares.reduce((sum, share) => sum + Math.round(Number(share.allocated_amount) * 100), 0), 1001);
});

test("snapshot constraints do not depend on mutable allocation rows", () => {
    for (const sql of [schemaSql, migrationSql]) {
        const snapshotDefinition = sql.match(
            /CREATE TABLE contribution_fund_allocations \(([\s\S]*?)\n\);/
        )?.[1];
        assert.ok(snapshotDefinition);
        assert.match(snapshotDefinition, /FOREIGN KEY \(contribution_id, account_id\)/);
        assert.match(snapshotDefinition, /FOREIGN KEY \(fund_id\) REFERENCES funds \(fund_id\) ON DELETE RESTRICT/);
        assert.doesNotMatch(snapshotDefinition, /REFERENCES\s+fund_allocations/i);
    }
    assert.doesNotMatch(schemaSql, /uq_fund_allocations_id_account_fund/);
    assert.doesNotMatch(migrationSql, /uq_fund_allocations_id_account_fund/);
});

test("creates pending contribution and selected-fund snapshots from the authenticated account allocation", async () => {
    const state = createState();
    const api = await createApi(state);
    try {
        const response = await api.request("/api/accounts/my-contributions", {
            body: { amount: "10.01", channel: "BANK", fund_ids: [FUND_A, FUND_B], account_id: ACCOUNT_B },
        });
        const body = await response.json();
        assert.equal(response.status, 202);
        assert.equal(body.data.contribution.account_id, ACCOUNT_A);
        assert.equal(body.data.transaction.transaction_status, "PENDING");
        assert.equal(body.data.payment_status, "PENDING");
        assert.deepEqual(body.data.fund_allocations.map(({ allocated_amount }) => allocated_amount), ["7.01", "3.00"]);
        assert.equal(state.shares.length, 2);
        assert.ok(state.shares.every((share) => share.account_id === ACCOUNT_A));
        assert.equal(state.clientQueries.some(({ query }) => query.includes("INSERT INTO contribution_fund_allocations")), true);
        assert.equal(state.transactions[0].transaction_status, "COMPLETED");
        assert.equal(state.contributions[0].contribution_status, "COMPLETED");
        assert.equal(state.clientQueries.some(({ query }) => /UPDATE pension_accounts/i.test(query)), false);
    } finally {
        await api.close();
    }
});

test("rejects inactive, nonexistent, and other-account funds without creating records", async () => {
    for (const fundId of [FUND_INACTIVE, "M".repeat(25)]) {
        const state = createState();
        const api = await createApi(state);
        try {
            const response = await api.request("/api/accounts/my-contributions", {
                body: { amount: "10.00", channel: "USSD", fund_ids: [fundId] },
            });
            assert.equal(response.status, 409);
            assert.equal(state.transactions.length, 1);
            assert.equal(state.contributions.length, 1);
            assert.equal(state.shares.length, 0);
        } finally {
            await api.close();
        }
    }
});

test("rolls back contribution, transaction, and fund snapshots if association persistence fails", async () => {
    const state = createState();
    state.failShareInsert = true;
    const api = await createApi(state);
    try {
        const response = await api.request("/api/accounts/my-contributions", {
            body: { amount: "10.00", channel: "BANK", fund_ids: [FUND_A] },
        });
        assert.equal(response.status, 500);
        assert.equal(state.transactions.length, 1);
        assert.equal(state.contributions.length, 1);
        assert.equal(state.shares.length, 0);
        assert.equal(state.clientQueries.some(({ query }) => query === "ROLLBACK"), true);
    } finally {
        await api.close();
    }
});

test("keeps the contribution fund snapshot in history after its current allocation is removed", async () => {
    const state = createState();
    const api = await createApi(state);
    try {
        const createdResponse = await api.request("/api/accounts/my-contributions", {
            body: { amount: "12.34", channel: "BANK", fund_ids: [FUND_A] },
        });
        assert.equal(createdResponse.status, 202);
        state.allocations = state.allocations.filter(({ account_id, fund_id }) =>
            account_id !== ACCOUNT_A || fund_id !== FUND_A
        );

        const response = await api.request("/api/accounts/my-contributions", { method: "GET" });
        const body = await response.json();
        assert.equal(response.status, 200);
        const historicalShare = body.data.find(({ contribution_id }) =>
            contribution_id === CONTRIBUTION
        ).fund_allocations[0];
        assert.equal(historicalShare.fund_id, FUND_A);
        assert.equal(historicalShare.fund_name, "Balanced");
        assert.equal(historicalShare.allocation_percentage, "100.0000000000");
        assert.equal(historicalShare.allocated_amount, "12.34");
        assert.equal(state.shares.length, 1);
        assert.match(state.clientQueries.find(({ query }) =>
            query.includes("INSERT INTO contribution_fund_allocations")
        ).query, /fund_name/);
        assert.doesNotMatch(state.clientQueries.find(({ query }) =>
            query.includes("INSERT INTO contribution_fund_allocations")
        ).query, /source_allocation_id/);
        const historyQuery = state.poolQueries.find(({ query }) =>
            query.includes("FROM contributions c")
        ).query;
        assert.match(historyQuery, /LEFT JOIN LATERAL/);
        assert.match(historyQuery, /contribution_fund_allocations/);
        assert.match(historyQuery, /cfa\.fund_name/);
    } finally {
        await api.close();
    }
});
