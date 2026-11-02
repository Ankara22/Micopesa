const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const pool = require("../src/db/database");
const fundRoutes = require("../src/routes/fundRoutes");
const { generateToken } = require("../src/utils/token");

process.env.JWT_SECRET ||= "micopesa-fund-discovery-test-secret";

const originalQuery = pool.query;
const originalJwtSecret = process.env.JWT_SECRET;
const users = new Map([
    ["manager-1", { user_id: "manager-1", role: "FUND_MANAGER", account_status: "ACTIVE", auth_version: 0 }],
    ["manager-2", { user_id: "manager-2", role: "FUND_MANAGER", account_status: "ACTIVE", auth_version: 0 }],
    ["worker-1", { user_id: "worker-1", role: "WORKER", account_status: "ACTIVE", auth_version: 0 }],
    ["worker-no-account", { user_id: "worker-no-account", role: "WORKER", account_status: "ACTIVE", auth_version: 0 }],
    ["regulator-1", { user_id: "regulator-1", role: "REGULATOR", account_status: "ACTIVE", auth_version: 0 }],
]);
const funds = [
    { fund_id: "suspended-fund", managed_by: "manager-2", fund_name: "Paused Fund", administrator_name: "Admin B", risk_level: "LOW", expected_return: "4.00", fund_status: "SUSPENDED" },
    { fund_id: "closed-fund", managed_by: "manager-2", fund_name: "Closed Fund", administrator_name: "Admin B", risk_level: "HIGH", expected_return: "5.00", fund_status: "CLOSED" },
    { fund_id: "other-active", managed_by: "manager-2", fund_name: "Other Active Fund", administrator_name: "Admin B", risk_level: "MEDIUM", expected_return: "6.00", fund_status: "ACTIVE" },
];

pool.query = async (query, values = []) => {
    if (query.includes("SELECT user_id, role, account_status, auth_version FROM users")) {
        const user = users.get(values[0]);
        return { rows: user ? [user] : [] };
    }
    if (query.includes("SELECT account_id, account_status")) {
        return values[0] === "worker-1"
            ? { rows: [{ account_id: "worker-account", account_status: "ACTIVE" }] }
            : { rows: [] };
    }

    if (query.includes("INSERT INTO funds")) {
        const [managed_by, fund_name, administrator_name, risk_level, expected_return] = values;
        const fund = {
            fund_id: `created-${funds.length + 1}`,
            managed_by,
            fund_name,
            administrator_name,
            risk_level,
            expected_return: String(expected_return),
            fund_status: "ACTIVE",
        };
        funds.push(fund);
        return { rows: [fund] };
    }

    if (query.includes("FROM funds f") && query.includes("f.fund_status = 'ACTIVE'")) {
        return {
            rows: funds
                .filter((fund) => fund.fund_status === "ACTIVE")
                .sort((left, right) => left.fund_name.localeCompare(right.fund_name))
                .map(({ fund_id, fund_name, administrator_name, risk_level, expected_return, fund_status }) => ({
                    fund_id, fund_name, administrator_name, risk_level, expected_return, fund_status,
                })),
        };
    }

    if (query.includes("FROM funds WHERE managed_by = $1")) {
        return { rows: funds.filter((fund) => fund.managed_by === values[0]) };
    }

    if (query.includes("FROM funds ORDER BY created_at DESC")) {
        return { rows: funds };
    }

    assert.fail(`Unexpected database query in fund discovery test: ${query}`);
};

after(() => {
    pool.query = originalQuery;
    process.env.JWT_SECRET = originalJwtSecret;
});

test("manager-created active funds appear in worker discovery while role permissions and status filtering remain enforced", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/funds", fundRoutes);

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}/api/funds`;
    const tokenFor = (userId) => generateToken({ userId, authVersion: 0 });
    const request = (path, { userId, method = "GET", body } = {}) => fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            ...(userId ? { Authorization: `Bearer ${tokenFor(userId)}` } : {}),
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });

    try {
        const unauthenticated = await request("/available");
        assert.equal(unauthenticated.status, 401);
        const managerCannotUseWorkerListing = await request("/available", { userId: "manager-1" });
        assert.equal(
            managerCannotUseWorkerListing.status,
            403,
            JSON.stringify(await managerCannotUseWorkerListing.clone().json())
        );
        const regulatorCannotUseWorkerListing = await request("/available", { userId: "regulator-1" });
        assert.equal(regulatorCannotUseWorkerListing.status, 403);
        const workerWithoutAccount = await request("/available", { userId: "worker-no-account" });
        assert.equal(workerWithoutAccount.status, 403);

        const createdResponse = await request("/", {
            userId: "manager-1",
            method: "POST",
            body: {
                fund_name: "New Worker Fund",
                administrator_name: "MicoPesa",
                risk_level: "MEDIUM",
                expected_return: 7.25,
            },
        });
        assert.equal(createdResponse.status, 201);
        const created = (await createdResponse.json()).data.fund;
        assert.equal(created.managed_by, "manager-1");

        const workerFundsResponse = await request("/available", { userId: "worker-1" });
        assert.equal(workerFundsResponse.status, 200);
        const workerFunds = (await workerFundsResponse.json()).data;
        assert.ok(workerFunds.some((fund) => fund.fund_id === created.fund_id));
        assert.ok(workerFunds.every((fund) => fund.fund_status === "ACTIVE"));
        assert.deepEqual(Object.keys(workerFunds[0]).sort(), [
            "administrator_name", "expected_return", "fund_id", "fund_name", "fund_status", "risk_level",
        ]);
        assert.ok(!workerFunds.some((fund) => ["suspended-fund", "closed-fund"].includes(fund.fund_id)));

        const forbiddenCreate = await request("/", {
            userId: "worker-1",
            method: "POST",
            body: { fund_name: "Worker Fund", administrator_name: "Worker", risk_level: "LOW", expected_return: 1 },
        });
        assert.equal(forbiddenCreate.status, 403);
        const forbiddenEdit = await request(`/${created.fund_id}`, {
            userId: "worker-1",
            method: "PATCH",
            body: { fund_status: "SUSPENDED" },
        });
        assert.equal(forbiddenEdit.status, 403);

        const managerListResponse = await request("/", { userId: "manager-1" });
        const managerFunds = (await managerListResponse.json()).data;
        assert.deepEqual(managerFunds.map((fund) => fund.fund_id), [created.fund_id]);

        const regulatorListResponse = await request("/", { userId: "regulator-1" });
        const regulatorFunds = (await regulatorListResponse.json()).data;
        assert.equal(regulatorFunds.length, funds.length);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
