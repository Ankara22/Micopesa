const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const pool = require("../src/db/database");
const adminUserRoutes = require("../src/routes/adminUserRoutes");
const adminUserController = require("../src/controllers/adminUserController");
const { generateToken } = require("../src/utils/token");

process.env.JWT_SECRET ||= "micopesa-admin-deletion-test-secret";

const originalQuery = pool.query;
const originalConnect = pool.connect;
const originalJwtSecret = process.env.JWT_SECRET;
const ADMIN_ID = "A".repeat(25);
const TARGET_ID = "B".repeat(25);
const OTHER_ADMIN_ID = "C".repeat(25);
const WORKER_ID = "D".repeat(25);

after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    process.env.JWT_SECRET = originalJwtSecret;
});

function createState({
    activeAdmins = [ADMIN_ID, OTHER_ADMIN_ID],
    includeTarget = true,
    otherAccountReferences = [],
    targetClaimTransactionIds = [],
} = {}) {
    return {
        users: new Map([
            [ADMIN_ID, { user_id: ADMIN_ID, role: "ADMIN", account_status: "ACTIVE", auth_version: 0 }],
            ...(includeTarget ? [[TARGET_ID, {
                user_id: TARGET_ID,
                role: "FUND_MANAGER",
                account_status: "ACTIVE",
                email: "worker@example.test",
                pending_email: null,
                profile_photo_ref: null,
            }]] : []),
            ...(activeAdmins.includes(OTHER_ADMIN_ID) ? [[OTHER_ADMIN_ID, {
                user_id: OTHER_ADMIN_ID,
                role: "ADMIN",
                account_status: "ACTIVE",
                auth_version: 0,
            }]] : []),
            [WORKER_ID, { user_id: WORKER_ID, role: "WORKER", account_status: "ACTIVE", auth_version: 0 }],
        ]),
        activeAdmins,
        funds: [{ managed_by: TARGET_ID, administrator_name: "Target Name" }],
        reports: [{ generated_by: TARGET_ID }],
        auditEntityIds: [TARGET_ID, TARGET_ID],
        rateLimitHashes: [],
        transactions: ["T".repeat(25), "U".repeat(25)],
        contributions: ["T".repeat(25)],
        claims: targetClaimTransactionIds.slice(),
        otherAccountReferences,
        associatedRecords: {
            kyc: [TARGET_ID],
            tokens: [TARGET_ID],
            notifications: [TARGET_ID],
            sessions: [TARGET_ID],
            accounts: [TARGET_ID],
        },
        auditEvents: [],
    };
}

function installDatabase(state, { failOn } = {}) {
    const clientQueries = [];
    state.clientQueries = clientQueries;
    state.poolQueries = [];
    pool.query = async (query, values = []) => {
        state.poolQueries.push(query);
        if (query.includes("SELECT user_id, role, account_status, auth_version")) {
            const user = state.users.get(values[0]);
            return { rows: user ? [user] : [] };
        }
        assert.fail(`Unexpected pool query: ${query}`);
    };
    pool.connect = async () => {
        let snapshot;
        return {
            async query(query, values = []) {
                clientQueries.push({ query, values });
                if (query === "BEGIN") {
                    snapshot = structuredClone(state);
                    return { rows: [] };
                }
                if (query === "ROLLBACK") {
                    for (const key of Object.keys(state)) delete state[key];
                    Object.assign(state, snapshot);
                    return { rows: [] };
                }
                if (query === "COMMIT") return { rows: [] };
                if (failOn && query.includes(failOn)) {
                    const error = new Error("simulated database constraint failure");
                    error.code = "23503";
                    throw error;
                }
                if (query.includes("SELECT user_id FROM users") && query.includes("FOR UPDATE")) {
                    return { rows: state.activeAdmins.map((user_id) => ({ user_id })) };
                }
                if (query.includes("SELECT user_id, role, account_status, email, pending_email, profile_photo_ref")) {
                    const user = state.users.get(values[0]);
                    return { rows: user ? [user] : [] };
                }
                if (query.includes("FROM transactions t") && query.includes("FOR UPDATE OF t")) {
                    return {
                        rows: [...state.contributions, ...state.claims]
                            .map((transaction_id) => ({ transaction_id })),
                    };
                }
                if (query.includes("UPDATE funds")) {
                    for (const fund of state.funds.filter((row) => row.managed_by === values[0])) {
                        fund.managed_by = null;
                        fund.administrator_name = "Unassigned";
                    }
                    return { rows: [] };
                }
                if (query.includes("UPDATE compliance_reports")) {
                    for (const report of state.reports.filter((row) => row.generated_by === values[0])) {
                        report.generated_by = null;
                    }
                    return { rows: [] };
                }
                if (query.includes("UPDATE audit_logs")) {
                    state.auditEntityIds = state.auditEntityIds.map((id) => id === values[0] ? "REDACTED" : id);
                    return { rows: [] };
                }
                if (query.includes("DELETE FROM auth_rate_limits")) return { rows: [] };
                if (query.includes("DELETE FROM contributions")) {
                    state.contributions = [];
                    return { rows: [] };
                }
                if (query.includes("DELETE FROM users")) {
                    const user = state.users.get(values[0]);
                    if (!user) return { rows: [] };
                    state.users.delete(values[0]);
                    for (const records of Object.values(state.associatedRecords)) {
                        for (let index = records.length - 1; index >= 0; index -= 1) {
                            if (records[index] === values[0]) records.splice(index, 1);
                        }
                    }
                    state.claims = [];
                    return { rows: [{ user_id: values[0] }] };
                }
                if (query.includes("DELETE FROM transactions")) {
                    assert.equal(state.contributions.length, 0, "contributions must be removed before their transactions");
                    state.transactions = state.transactions.filter((id) =>
                        !values[0].includes(id) || state.otherAccountReferences.includes(id)
                    );
                    return { rows: [] };
                }
                if (query.includes("INSERT INTO audit_logs")) {
                    state.auditEvents.push(values);
                    return { rows: [] };
                }
                assert.fail(`Unexpected transaction query: ${query}`);
            },
            release() {},
        };
    };
}

async function createApi(state, options) {
    installDatabase(state, options);
    const app = express();
    app.use("/api/admin/users", adminUserRoutes);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return {
        request(path, { userId = ADMIN_ID, role = "ADMIN", method = "DELETE" } = {}) {
            const token = generateToken({ userId, role, authVersion: 0 });
            return fetch(`${baseUrl}${path}`, {
                method,
                headers: { Authorization: `Bearer ${token}` },
            });
        },
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        }),
    };
}

test("admin deletion removes account-owned records and unlinks retained shared records", async () => {
    const state = createState({ targetClaimTransactionIds: ["U".repeat(25)] });
    const api = await createApi(state);
    try {
        const response = await api.request(`/api/admin/users/${TARGET_ID}`);
        assert.equal(response.status, 200);
        assert.equal(state.users.has(TARGET_ID), false);
        assert.deepEqual(state.associatedRecords, {
            kyc: [],
            tokens: [],
            notifications: [],
            sessions: [],
            accounts: [],
        });
        assert.equal(state.funds[0].managed_by, null);
        assert.equal(state.funds[0].administrator_name, "Unassigned");
        assert.equal(state.reports[0].generated_by, null);
        assert.deepEqual(state.auditEntityIds, ["REDACTED", "REDACTED"]);
        assert.equal(state.transactions.length, 0);
        assert.equal(state.auditEvents.length, 1);
        const contributionDeleteIndex = state.clientQueries.findIndex(({ query }) =>
            query.includes("DELETE FROM contributions")
        );
        const userDeleteIndex = state.clientQueries.findIndex(({ query }) =>
            query.includes("DELETE FROM users")
        );
        const transactionDeleteIndex = state.clientQueries.findIndex(({ query }) =>
            query.includes("DELETE FROM transactions")
        );
        assert.ok(contributionDeleteIndex >= 0);
        assert.ok(contributionDeleteIndex < userDeleteIndex);
        assert.ok(userDeleteIndex < transactionDeleteIndex);
        assert.ok(state.poolQueries.every((query) =>
            query.includes("SELECT user_id, role, account_status, auth_version")
        ));
    } finally {
        await api.close();
    }
});

test("keeps candidate transactions referenced by another account and never selects unrelated transactions", async () => {
    const state = createState({
        targetClaimTransactionIds: ["U".repeat(25)],
        otherAccountReferences: ["U".repeat(25)],
    });
    const api = await createApi(state);
    try {
        const response = await api.request(`/api/admin/users/${TARGET_ID}`);
        assert.equal(response.status, 200);
        assert.deepEqual(state.transactions, ["U".repeat(25)]);
        const transactionDelete = state.clientQueries.find(({ query }) =>
            query.includes("DELETE FROM transactions")
        );
        assert.deepEqual(transactionDelete.values[0], ["T".repeat(25), "U".repeat(25)]);
        assert.match(transactionDelete.query, /NOT EXISTS\s*\(\s*SELECT 1 FROM contributions/);
        assert.match(transactionDelete.query, /NOT EXISTS\s*\(\s*SELECT 1 FROM withdrawal_claims/);
    } finally {
        await api.close();
    }
});

test("non-admins are denied, nonexistent users return 404, and self-deletion is rejected", async () => {
    const state = createState();
    const api = await createApi(state);
    try {
        assert.equal((await api.request(`/api/admin/users/${TARGET_ID}`, { userId: WORKER_ID })).status, 403);
        assert.equal((await api.request(`/api/admin/users/${"E".repeat(25)}`)).status, 404);
        assert.equal((await api.request(`/api/admin/users/${ADMIN_ID}`)).status, 400);
        assert.equal(state.users.has(TARGET_ID), true);
    } finally {
        await api.close();
    }
});

test("a failure after dependent rows are removed rolls back all database changes", async () => {
    const state = createState();
    const api = await createApi(state, { failOn: "DELETE FROM transactions" });
    try {
        const response = await api.request(`/api/admin/users/${TARGET_ID}`);
        assert.equal(response.status, 409);
        assert.equal(state.users.has(TARGET_ID), true);
        assert.equal(state.funds[0].managed_by, TARGET_ID);
        assert.equal(state.reports[0].generated_by, TARGET_ID);
        assert.deepEqual(state.contributions, ["T".repeat(25)]);
        assert.deepEqual(state.transactions, ["T".repeat(25), "U".repeat(25)]);
        assert.deepEqual(state.auditEvents, []);
    } finally {
        await api.close();
    }
});

test("deletion controller independently protects the last active administrator", async () => {
    const state = createState({ activeAdmins: [TARGET_ID], includeTarget: false });
    state.users.set(TARGET_ID, {
        user_id: TARGET_ID,
        role: "ADMIN",
        account_status: "ACTIVE",
        email: null,
        pending_email: null,
        profile_photo_ref: null,
    });
    installDatabase(state);
    const res = {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
    await adminUserController.deleteUser({ user: { userId: "Z".repeat(25) }, params: { userId: TARGET_ID } }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(state.users.has(TARGET_ID), true);
});
