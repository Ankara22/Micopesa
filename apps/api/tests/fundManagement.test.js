const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const pool = require("../src/db/database");
const fundRoutes = require("../src/routes/fundRoutes");
const { generateToken } = require("../src/utils/token");

process.env.JWT_SECRET ||= "micopesa-fund-management-test-secret";

const originalQuery = pool.query;
const originalConnect = pool.connect;
const originalJwtSecret = process.env.JWT_SECRET;

function createState() {
    return {
        users: new Map([
            ["manager-1", { user_id: "manager-1", role: "FUND_MANAGER", account_status: "ACTIVE", auth_version: 0 }],
            ["manager-2", { user_id: "manager-2", role: "FUND_MANAGER", account_status: "ACTIVE", auth_version: 0 }],
            ["worker-1", { user_id: "worker-1", role: "WORKER", account_status: "ACTIVE", auth_version: 0 }],
        ]),
        funds: [
            {
                fund_id: "fund-1",
                managed_by: "manager-1",
                fund_name: "Synthetic Growth",
                administrator_name: "MicoPesa",
                risk_level: "MEDIUM",
                expected_return: "7.00",
                fund_status: "ACTIVE",
            },
            {
                fund_id: "fund-2",
                managed_by: "manager-2",
                fund_name: "Other Manager Fund",
                administrator_name: "MicoPesa",
                risk_level: "LOW",
                expected_return: "4.00",
                fund_status: "ACTIVE",
            },
        ],
        audit: [],
        failAudit: false,
        nextFundId: 1,
    };
}

function createApi(state) {
    pool.query = async (query, values = []) => {
        if (query.includes("SELECT user_id, role, account_status, auth_version")) {
            const user = state.users.get(values[0]);
            return { rows: user ? [user] : [] };
        }
        if (query.includes("FROM funds WHERE managed_by = $1")) {
            return { rows: state.funds.filter((fund) => fund.managed_by === values[0]) };
        }
        assert.fail(`Unexpected pool query: ${query}`);
    };

    pool.connect = async () => {
        let snapshot;
        return {
            async query(query, values = []) {
                if (query === "BEGIN") {
                    snapshot = {
                        funds: structuredClone(state.funds),
                        audit: structuredClone(state.audit),
                    };
                    return { rows: [] };
                }
                if (query === "ROLLBACK") {
                    state.funds = snapshot.funds;
                    state.audit = snapshot.audit;
                    return { rows: [] };
                }
                if (query === "COMMIT") return { rows: [] };
                if (query.includes("INSERT INTO funds")) {
                    const [managed_by, fund_name, administrator_name, risk_level, expected_return] = values;
                    const fund = {
                        fund_id: `created-${state.nextFundId++}`,
                        managed_by,
                        fund_name,
                        administrator_name,
                        risk_level,
                        expected_return: String(expected_return),
                        fund_status: "ACTIVE",
                    };
                    state.funds.push(fund);
                    return { rows: [fund] };
                }
                if (query.includes("SELECT managed_by FROM funds")) {
                    const fund = state.funds.find(({ fund_id }) => fund_id === values[0]);
                    return { rows: fund ? [{ managed_by: fund.managed_by }] : [] };
                }
                if (query.includes("UPDATE funds SET")) {
                    const [fund_name, administrator_name, risk_level, expected_return, fund_status, fundId, userId] = values;
                    const fund = state.funds.find((row) => row.fund_id === fundId && row.managed_by === userId);
                    if (!fund) return { rows: [] };
                    Object.assign(fund, {
                        fund_name: fund_name ?? fund.fund_name,
                        administrator_name: administrator_name ?? fund.administrator_name,
                        risk_level: risk_level ?? fund.risk_level,
                        expected_return: expected_return === null ? fund.expected_return : String(expected_return),
                        fund_status: fund_status ?? fund.fund_status,
                    });
                    return { rows: [fund] };
                }
                if (query.includes("INSERT INTO audit_logs")) {
                    if (state.failAudit) throw new Error("simulated audit write failure");
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
                            ...(userId ? { Authorization: `Bearer ${generateToken({ userId, authVersion: 0 })}` } : {}),
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

test("Fund Manager fund creation and updates are scoped and audited transactionally", async () => {
    await withApi(async ({ api, state }) => {
        const createdResponse = await api.request("/", {
            userId: "manager-1",
            method: "POST",
            body: {
                fund_name: "Synthetic Balanced",
                administrator_name: "MicoPesa",
                risk_level: "MEDIUM",
                expected_return: 6.5,
            },
        });
        assert.equal(createdResponse.status, 201);
        const created = (await createdResponse.json()).data.fund;
        assert.equal(created.managed_by, "manager-1");
        assert.deepEqual(state.audit.map(([userId, actionType, entityName, entityId]) => ({
            userId, actionType, entityName, entityId,
        })), [{
            userId: "manager-1",
            actionType: "CREATE",
            entityName: "FUNDS",
            entityId: created.fund_id,
        }]);

        const updatedResponse = await api.request(`/${created.fund_id}`, {
            userId: "manager-1",
            method: "PATCH",
            body: { expected_return: 7.25 },
        });
        assert.equal(updatedResponse.status, 200);
        assert.equal((await updatedResponse.json()).data.fund.expected_return, "7.25");
        assert.equal(state.audit.length, 2);
        assert.deepEqual(state.audit[1].slice(0, 4), ["manager-1", "UPDATE", "FUNDS", created.fund_id]);

        const otherManagerUpdate = await api.request("/fund-1", {
            userId: "manager-2",
            method: "PATCH",
            body: { fund_status: "SUSPENDED" },
        });
        assert.equal(otherManagerUpdate.status, 403);
        assert.equal(state.funds.find(({ fund_id }) => fund_id === "fund-1").fund_status, "ACTIVE");
        assert.equal(state.audit.length, 2);
    });
});

test("failed fund audit insertion rolls back the fund write", async () => {
    await withApi(async ({ api, state }) => {
        state.failAudit = true;
        const originalConsoleError = console.error;
        console.error = () => {};
        try {
            const response = await api.request("/", {
                userId: "manager-1",
                method: "POST",
                body: {
                    fund_name: "Audit Failure Fund",
                    administrator_name: "MicoPesa",
                    risk_level: "LOW",
                    expected_return: 3,
                },
            });
            assert.equal(response.status, 500);
        } finally {
            console.error = originalConsoleError;
        }
        assert.equal(state.funds.length, 2);
        assert.deepEqual(state.audit, []);
    });
});

test("non-manager roles cannot create or update funds", async () => {
    await withApi(async ({ api, state }) => {
        const createResponse = await api.request("/", {
            userId: "worker-1",
            method: "POST",
            body: {
                fund_name: "Denied Fund",
                administrator_name: "MicoPesa",
                risk_level: "LOW",
                expected_return: 1,
            },
        });
        const updateResponse = await api.request("/fund-1", {
            userId: "worker-1",
            method: "PATCH",
            body: { fund_status: "SUSPENDED" },
        });
        assert.equal(createResponse.status, 403);
        assert.equal(updateResponse.status, 403);
        assert.equal(state.funds.length, 2);
        assert.deepEqual(state.audit, []);
    });
});
