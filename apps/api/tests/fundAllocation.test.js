const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const pool = require("../src/db/database");
const fundRoutes = require("../src/routes/fundRoutes");
const { generateToken } = require("../src/utils/token");

process.env.JWT_SECRET ||= "micopesa-fund-allocation-test-secret";

const originalQuery = pool.query;
const originalConnect = pool.connect;
const originalJwtSecret = process.env.JWT_SECRET;
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function createState() {
    return {
        accounts: new Map([
            ["worker-1", "account-1"],
            ["worker-2", "account-2"],
            ["worker-inactive-account", "account-inactive"],
        ]),
        accountStatuses: new Map([
            ["account-1", "ACTIVE"],
            ["account-2", "ACTIVE"],
            ["account-inactive", "SUSPENDED"],
        ]),
        funds: [
            { fund_id: "fund-1", managed_by: "manager-1", fund_name: "Growth", administrator_name: "Admin", risk_level: "HIGH", expected_return: "8.00", fund_status: "ACTIVE" },
            { fund_id: "fund-2", managed_by: "manager-1", fund_name: "Balanced", administrator_name: "Admin", risk_level: "MEDIUM", expected_return: "6.00", fund_status: "ACTIVE" },
            { fund_id: "fund-inactive", managed_by: "manager-2", fund_name: "Closed", administrator_name: "Admin", risk_level: "LOW", expected_return: "3.00", fund_status: "SUSPENDED" },
            { fund_id: "fund-closed", managed_by: "manager-2", fund_name: "Closed Legacy", administrator_name: "Admin", risk_level: "LOW", expected_return: "2.00", fund_status: "CLOSED" },
        ],
        users: new Map([
            ["worker-1", { user_id: "worker-1", role: "WORKER", account_status: "ACTIVE" }],
            ["worker-2", { user_id: "worker-2", role: "WORKER", account_status: "ACTIVE" }],
            ["worker-no-account", { user_id: "worker-no-account", role: "WORKER", account_status: "ACTIVE" }],
            ["worker-inactive-account", { user_id: "worker-inactive-account", role: "WORKER", account_status: "ACTIVE" }],
            ["manager-1", { user_id: "manager-1", role: "FUND_MANAGER", account_status: "ACTIVE" }],
            ["manager-2", { user_id: "manager-2", role: "FUND_MANAGER", account_status: "ACTIVE" }],
            ["regulator-1", { user_id: "regulator-1", role: "REGULATOR", account_status: "ACTIVE" }],
            ["admin-1", { user_id: "admin-1", role: "ADMIN", account_status: "ACTIVE" }],
        ]),
        allocations: [],
        audit: [],
        contributionRows: [],
        transactionRows: [],
        balances: new Map([["account-1", "1234.56"], ["account-2", "900.00"]]),
        connectCalls: 0,
        lockQueries: [],
        failInsert: false,
        suspendFundOnBegin: null,
        nextAllocationId: 1,
    };
}

function createApi(state) {
    pool.query = async (query, values = []) => {
        if (query.includes("SELECT user_id, role, account_status, auth_version")) {
            const user = state.users.get(values[0]);
            return { rows: user ? [user] : [] };
        }
        if (query.includes("LEFT JOIN LATERAL")) {
            const [fundId, role] = values;
            const fund = state.funds.find(({ fund_id }) => fund_id === fundId);
            if (!fund || role === "REGULATOR") return { rows: [] };
            const allocations = state.allocations
                .filter(({ fund_id }) => fund_id === fundId)
                .map((allocation) => ({ managed_by: fund.managed_by, ...allocation }));
            return {
                rows: allocations.length > 0
                    ? allocations
                    : [{
                        managed_by: fund.managed_by,
                        allocation_id: null,
                        account_id: null,
                        fund_id: null,
                        percentage: null,
                        effective_from: null,
                        effective_to: null,
                    }],
            };
        }
        if (query.includes("SELECT managed_by FROM funds WHERE fund_id")) {
            const fund = state.funds.find(({ fund_id }) => fund_id === values[0]);
            return { rows: fund ? [{ managed_by: fund.managed_by }] : [] };
        }
        if (query.includes("SELECT allocation_id, account_id, fund_id, percentage, effective_from, effective_to")) {
            return {
                rows: state.allocations
                    .filter(({ fund_id }) => fund_id === values[0])
                    .map(({ allocation_id, account_id, fund_id, percentage, effective_from, effective_to }) => ({
                        allocation_id, account_id, fund_id, percentage, effective_from, effective_to,
                    })),
            };
        }
        if (query.includes("SELECT account_id, account_status")) {
            const accountId = state.accounts.get(values[0]);
            const status = state.accountStatuses.get(accountId);
            return { rows: status === "ACTIVE" ? [{ account_id: accountId, account_status: status }] : [] };
        }
        if (query.includes("FROM funds f") && query.includes("f.fund_status = 'ACTIVE'")) {
            return {
                rows: state.funds
                    .filter((fund) => fund.fund_status === "ACTIVE")
                    .map(({ fund_id, fund_name, administrator_name, risk_level, expected_return, fund_status }) => ({
                        fund_id, fund_name, administrator_name, risk_level, expected_return, fund_status,
                    })),
            };
        }
        if (query.includes("FROM pension_accounts pa")) {
            const accountId = state.accounts.get(values[0]);
            const rows = state.allocations
                .filter((allocation) => allocation.account_id === accountId)
                .filter((allocation) => allocation.effective_from <= today &&
                    (allocation.effective_to === null || allocation.effective_to >= today))
                .map((allocation) => {
                    const fund = state.funds.find((item) => item.fund_id === allocation.fund_id);
                    return {
                        allocation_id: allocation.allocation_id,
                        fund_id: allocation.fund_id,
                        fund_name: fund.fund_name,
                        administrator_name: fund.administrator_name,
                        risk_level: fund.risk_level,
                        expected_return: fund.expected_return,
                        fund_status: fund.fund_status,
                        allocation_percentage: allocation.percentage,
                        effective_from: allocation.effective_from,
                        effective_to: allocation.effective_to,
                    };
                });
            return { rows };
        }
        assert.fail(`Unexpected pool query: ${query}`);
    };

    pool.connect = async () => {
        state.connectCalls += 1;
        let snapshot;
        return {
            async query(query, values = []) {
                state.lockQueries.push(query);
                if (query === "BEGIN") {
                    if (state.suspendFundOnBegin) {
                        const fund = state.funds.find(({ fund_id }) => fund_id === state.suspendFundOnBegin);
                        fund.fund_status = "SUSPENDED";
                        state.suspendFundOnBegin = null;
                    }
                    snapshot = {
                        allocations: structuredClone(state.allocations),
                        audit: structuredClone(state.audit),
                    };
                    return { rows: [] };
                }
                if (query === "ROLLBACK") {
                    state.allocations = snapshot.allocations;
                    state.audit = snapshot.audit;
                    return { rows: [] };
                }
                if (query === "COMMIT") return { rows: [] };
                if (query.includes("FROM pension_accounts") && query.includes("FOR UPDATE")) {
                    const accountId = state.accounts.get(values[0]);
                    return {
                        rows: accountId && state.accountStatuses.get(accountId) === "ACTIVE"
                            ? [{ account_id: accountId, account_status: "ACTIVE" }]
                            : [],
                    };
                }
                if (query.includes("FROM funds") && query.includes("FOR SHARE")) {
                    return {
                        rows: state.funds
                            .filter((fund) => values[0].includes(fund.fund_id) && fund.fund_status === "ACTIVE")
                            .map(({ fund_id }) => ({ fund_id })),
                    };
                }
                if (query.includes("effective_from = CURRENT_DATE")) {
                    return {
                        rows: state.allocations
                            .filter((allocation) => allocation.account_id === values[0] &&
                                allocation.effective_from === today)
                            .map(({ allocation_id }) => ({ allocation_id })),
                    };
                }
                if (query.includes("effective_from > CURRENT_DATE")) {
                    return {
                        rows: state.allocations
                            .filter((allocation) => allocation.account_id === values[0] &&
                                allocation.effective_from > today)
                            .map(({ allocation_id }) => ({ allocation_id })),
                    };
                }
                if (query.includes("UPDATE fund_allocations")) {
                    for (const allocation of state.allocations) {
                        if (
                            allocation.account_id === values[0] &&
                            allocation.effective_from < today &&
                            (allocation.effective_to === null || allocation.effective_to >= today)
                        ) {
                            allocation.effective_to = yesterday;
                        }
                    }
                    return { rows: [] };
                }
                if (query.includes("INSERT INTO fund_allocations")) {
                    if (state.failInsert) throw new Error("simulated allocation insert failure");
                    const allocation = {
                        allocation_id: `allocation-${state.nextAllocationId++}`,
                        account_id: values[0],
                        fund_id: values[1],
                        percentage: values[2],
                        effective_from: today,
                        effective_to: null,
                    };
                    state.allocations.push(allocation);
                    return {
                        rows: [{
                            allocation_id: allocation.allocation_id,
                            fund_id: allocation.fund_id,
                            allocation_percentage: allocation.percentage,
                            effective_from: allocation.effective_from,
                            effective_to: allocation.effective_to,
                        }],
                    };
                }
                if (query.includes("INSERT INTO audit_logs")) {
                    state.audit.push(values);
                    return { rows: [] };
                }
                assert.fail(`Unexpected transaction query: ${query}`);
            },
            release() {},
        };
    };

    const app = express();
    app.use(express.json());
    app.use("/api/funds", fundRoutes);
    const server = http.createServer(app);
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const baseUrl = `http://127.0.0.1:${server.address().port}/api/funds`;
            resolve({
                async request(path, { userId, method = "GET", body } = {}) {
                    return fetch(`${baseUrl}${path}`, {
                        method,
                        headers: {
                            ...(userId ? { Authorization: `Bearer ${generateToken({ userId })}` } : {}),
                            ...(body ? { "Content-Type": "application/json" } : {}),
                        },
                        ...(body ? { body: JSON.stringify(body) } : {}),
                    });
                },
                close: () => new Promise((closeResolve, closeReject) => {
                    server.close((error) => error ? closeReject(error) : closeResolve());
                }),
            });
        });
    });
}

async function withApi(callback) {
    const state = createState();
    const api = await createApi(state);
    try {
        await callback({ api, state });
    } finally {
        await api.close();
    }
}

after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    process.env.JWT_SECRET = originalJwtSecret;
});

test("workers read only their own active allocations and suspended funds remain visible", async () => {
    await withApi(async ({ api, state }) => {
        state.allocations = [
            { allocation_id: "current", account_id: "account-1", fund_id: "fund-inactive", percentage: "100.00", effective_from: "2026-10-01", effective_to: null },
            { allocation_id: "other-worker", account_id: "account-2", fund_id: "fund-1", percentage: "100.00", effective_from: "2026-10-01", effective_to: null },
        ];
        const response = await api.request("/my-allocations", { userId: "worker-1" });
        assert.equal(response.status, 200);
        const rows = (await response.json()).data;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].fund_status, "SUSPENDED");
        assert.equal(rows[0].allocation_percentage, "100.00");
        assert.equal(Object.hasOwn(rows[0], "account_id"), false);
    });
});

test("invalid distributions are rejected before opening a database transaction", async () => {
    await withApi(async ({ api, state }) => {
        const invalidDistributions = [
            [],
            [{ fund_id: "fund-1", allocation_percentage: 99.99 }],
            [{ fund_id: "fund-1", allocation_percentage: 100.01 }],
            [
                { fund_id: "fund-1", allocation_percentage: 50 },
                { fund_id: "fund-1", allocation_percentage: 50 },
            ],
            [{ fund_id: "fund-1", allocation_percentage: 0 }],
            [{ fund_id: "fund-1", allocation_percentage: -100 }],
            [{ fund_id: "fund-1", allocation_percentage: "not-a-number" }],
            [{ fund_id: "fund-1", allocation_percentage: "Infinity" }],
            [{ fund_id: "fund-1", allocation_percentage: 100.001 }],
            [{ fund_id: "fund-1", allocation_percentage: true }],
        ];

        for (const allocations of invalidDistributions) {
            const response = await api.request("/my-allocations", {
                userId: "worker-1",
                method: "PUT",
                body: { allocations },
            });
            assert.equal(response.status, 400);
        }
        assert.equal(state.connectCalls, 0);
        assert.deepEqual(state.allocations, []);
    });
});

test("valid replacements total 100%, preserve older history, and reject same-day rewrites", async () => {
    await withApi(async ({ api, state }) => {
        state.allocations.push({
            allocation_id: "historical",
            account_id: "account-1",
            fund_id: "fund-1",
            percentage: "100.00",
            effective_from: "2026-09-01",
            effective_to: null,
        });
        const initialBalance = state.balances.get("account-1");

        const firstResponse = await api.request("/my-allocations", {
            userId: "worker-1",
            method: "PUT",
            body: {
                allocations: [
                    { fund_id: "fund-1", allocation_percentage: "60.00" },
                    { fund_id: "fund-2", allocation_percentage: 40 },
                ],
                account_id: "account-2",
            },
        });
        assert.equal(firstResponse.status, 200);
        const firstRows = (await firstResponse.json()).data;
        assert.equal(firstRows.reduce((total, row) => total + Number(row.allocation_percentage), 0), 100);
        assert.ok(state.lockQueries.some((query) => query.includes("FOR UPDATE")));
        assert.ok(state.lockQueries.some((query) => query.includes("FOR SHARE")));
        assert.deepEqual(state.audit[0], ["worker-1", "UPDATE", "FUND_ALLOCATIONS", "account-1", null]);
        assert.equal(state.allocations.find((row) => row.allocation_id === "historical").effective_to, yesterday);
        assert.ok(state.allocations.filter((row) => row.effective_from === today)
            .every((row) => row.account_id === "account-1"));
        assert.equal(state.balances.get("account-1"), initialBalance);
        assert.deepEqual(state.contributionRows, []);
        assert.deepEqual(state.transactionRows, []);

        const rowsBeforeSameDaySave = structuredClone(state.allocations);
        const secondResponse = await api.request("/my-allocations", {
            userId: "worker-1",
            method: "PUT",
            body: { allocations: [{ fund_id: "fund-2", allocation_percentage: "100.00" }] },
        });
        assert.equal(secondResponse.status, 409);
        assert.match((await secondResponse.json()).message, /already changed today/i);
        assert.deepEqual(state.allocations, rowsBeforeSameDaySave);
        assert.equal(state.audit.length, 1);
    });
});

test("Fund Manager allocation endpoint exposes worker-saved dated records", async () => {
    await withApi(async ({ api, state }) => {
        const saved = await api.request("/my-allocations", {
            userId: "worker-1",
            method: "PUT",
            body: { allocations: [{ fund_id: "fund-1", allocation_percentage: "100.00" }] },
        });
        assert.equal(saved.status, 200);

        const managerResponse = await api.request("/fund-1/allocations", { userId: "manager-1" });
        assert.equal(managerResponse.status, 200);
        const rows = (await managerResponse.json()).data;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].account_id, "account-1");
        assert.equal(rows[0].fund_id, "fund-1");
        assert.equal(rows[0].percentage, "100.00");
        assert.equal(rows[0].effective_from, today);
        assert.equal(rows[0].effective_to, null);
    });
});

test("inactive or missing funds and workers without active accounts cannot write allocations", async () => {
    await withApi(async ({ api, state }) => {
        for (const fundId of ["fund-inactive", "fund-closed", "missing-fund"]) {
            const response = await api.request("/my-allocations", {
                userId: "worker-1",
                method: "PUT",
                body: { allocations: [{ fund_id: fundId, allocation_percentage: 100 }] },
            });
            assert.equal(response.status, 409);
        }
        const missingAccount = await api.request("/my-allocations", {
            userId: "worker-no-account",
            method: "PUT",
            body: { allocations: [{ fund_id: "fund-1", allocation_percentage: 100 }] },
        });
        assert.equal(missingAccount.status, 404);
        const inactiveAccount = await api.request("/my-allocations", {
            userId: "worker-inactive-account",
            method: "PUT",
            body: { allocations: [{ fund_id: "fund-1", allocation_percentage: 100 }] },
        });
        assert.equal(inactiveAccount.status, 404);
        const missingAccountRead = await api.request("/my-allocations", { userId: "worker-no-account" });
        assert.equal(missingAccountRead.status, 403);
        assert.deepEqual(state.allocations, []);
        assert.deepEqual(state.audit, []);
    });

    test("a fund that becomes ineligible before the save transaction is rejected without changing history", async () => {
        await withApi(async ({ api, state }) => {
            const historical = {
                allocation_id: "historical-before-fund-suspension",
                account_id: "account-1",
                fund_id: "fund-1",
                percentage: "100.00",
                effective_from: "2026-09-01",
                effective_to: null,
            };
            state.allocations.push(historical);
            state.suspendFundOnBegin = "fund-2";
            const allocationsBefore = structuredClone(state.allocations);

            const response = await api.request("/my-allocations", {
                userId: "worker-1",
                method: "PUT",
                body: { allocations: [{ fund_id: "fund-2", allocation_percentage: 100 }] },
            });

            assert.equal(response.status, 409);
            assert.match((await response.json()).message, /not currently active/i);
            assert.deepEqual(state.allocations, allocationsBefore);
            assert.deepEqual(state.audit, []);
            assert.equal(state.funds.find(({ fund_id }) => fund_id === "fund-2").fund_status, "SUSPENDED");
        });
    });
});

test("future-effective allocation records block replacement without changing history", async () => {
    await withApi(async ({ api, state }) => {
        const scheduled = {
            allocation_id: "scheduled",
            account_id: "account-1",
            fund_id: "fund-1",
            percentage: "100.00",
            effective_from: "2999-01-01",
            effective_to: null,
        };
        state.allocations.push(scheduled);
        const before = structuredClone(state.allocations);

        const response = await api.request("/my-allocations", {
            userId: "worker-1",
            method: "PUT",
            body: { allocations: [{ fund_id: "fund-2", allocation_percentage: 100 }] },
        });
        assert.equal(response.status, 409);
        assert.match((await response.json()).message, /future-effective/i);
        assert.deepEqual(state.allocations, before);
        assert.deepEqual(state.audit, []);
    });
});

test("failed replacement rolls back closed intervals, inserted rows, and audit events", async () => {
    await withApi(async ({ api, state }) => {
        const existing = {
            allocation_id: "active-old",
            account_id: "account-1",
            fund_id: "fund-1",
            percentage: "100.00",
            effective_from: "2026-09-01",
            effective_to: null,
        };
        state.allocations.push(existing);
        const existingBeforeSave = structuredClone(state.allocations);
        state.failInsert = true;
        const originalConsoleError = console.error;
        console.error = () => {};
        try {
            const response = await api.request("/my-allocations", {
                userId: "worker-1",
                method: "PUT",
                body: { allocations: [{ fund_id: "fund-2", allocation_percentage: 100 }] },
            });
            assert.equal(response.status, 500);
        } finally {
            console.error = originalConsoleError;
        }
        assert.deepEqual(state.allocations, existingBeforeSave);
        assert.deepEqual(state.audit, []);
    });
});

test("unauthenticated and non-worker writes are rejected while manager and regulator routes remain role-scoped", async () => {
    await withApi(async ({ api }) => {
        const noToken = await api.request("/my-allocations", { method: "PUT", body: { allocations: [] } });
        assert.equal(noToken.status, 401);
        assert.equal((await api.request("/available")).status, 401);
        assert.equal((await api.request("/my-allocations")).status, 401);
        assert.equal((await api.request("/available", { userId: "manager-1" })).status, 403);
        assert.equal((await api.request("/my-allocations", { userId: "regulator-1" })).status, 403);
        const managerWrite = await api.request("/my-allocations", {
            userId: "manager-1",
            method: "PUT",
            body: { allocations: [{ fund_id: "fund-1", allocation_percentage: 100 }] },
        });
        assert.equal(managerWrite.status, 403);
        const workerManagerRoute = await api.request("/", {
            userId: "worker-1",
            method: "POST",
            body: { fund_name: "Denied", administrator_name: "Admin", risk_level: "LOW", expected_return: 3 },
        });
        assert.equal(workerManagerRoute.status, 403);
        const regulatorManagerRoute = await api.request("/fund-1", {
            userId: "regulator-1",
            method: "PATCH",
            body: { fund_status: "SUSPENDED" },
        });
        assert.equal(regulatorManagerRoute.status, 403);
        assert.equal((await api.request("/fund-1", { userId: "admin-1" })).status, 403);
        assert.equal((await api.request("/fund-1/allocations", { userId: "admin-1" })).status, 403);
    });
});
