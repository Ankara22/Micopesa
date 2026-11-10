const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const pool = require("../src/db/database");
const regulatorRoutes = require("../src/routes/regulatorRoutes");
const adminKycRoutes = require("../src/routes/adminKycRoutes");
const fundRoutes = require("../src/routes/fundRoutes");
const regulatorFundAssignmentRoutes = require("../src/routes/regulatorFundAssignmentRoutes");
const { generateToken } = require("../src/utils/token");

process.env.JWT_SECRET ||= "micopesa-regulator-authorization-test-secret";

const originalQuery = pool.query;
const originalJwtSecret = process.env.JWT_SECRET;
const users = new Map([
    ["regulator-1", { user_id: "regulator-1", role: "REGULATOR", account_status: "ACTIVE", auth_version: 0 }],
    ["admin-1", { user_id: "admin-1", role: "ADMIN", account_status: "ACTIVE", auth_version: 0 }],
    ["manager-1", { user_id: "manager-1", role: "FUND_MANAGER", account_status: "ACTIVE", auth_version: 0 }],
    ["worker-1", { user_id: "worker-1", role: "WORKER", account_status: "ACTIVE", auth_version: 0 }],
]);

pool.query = async (sql, values = []) => {
    if (sql.includes("FROM users WHERE user_id = $1")) {
        const user = users.get(values[0]);
        return { rows: user ? [user] : [] };
    }
    assert.fail(`Unexpected query: ${sql}`);
};

function createServer() {
    const app = express();
    app.use(express.json());
    app.use("/api/regulator", regulatorRoutes);
    app.use("/api/admin/kyc", adminKycRoutes);
    app.use("/api/funds", fundRoutes);
    app.use("/api/admin/regulator-fund-assignments", regulatorFundAssignmentRoutes);
    const server = http.createServer(app);

    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const baseUrl = `http://127.0.0.1:${server.address().port}`;
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

after(() => {
    pool.query = originalQuery;
    process.env.JWT_SECRET = originalJwtSecret;
});

test("only regulators can access regulator operations and no other role can review compliance reports", async () => {
    const server = await createServer();
    try {
        for (const userId of ["worker-1", "manager-1", "admin-1"]) {
            const response = await server.request("/api/regulator/reports", { userId });
            assert.equal(response.status, 403);
        }
        const unauthenticated = await server.request("/api/regulator/reports");
        assert.equal(unauthenticated.status, 401);

        const wrongRoleReview = await server.request("/api/regulator/reports/report-1/review", {
            userId: "manager-1",
            method: "POST",
            body: { decision: "ACCEPTED", submission_id: "submission-1" },
        });
        assert.equal(wrongRoleReview.status, 403);
    } finally {
        await server.close();
    }
});

test("regulators cannot access Admin KYC review, create/edit funds, or assign their own fund scope", async () => {
    const server = await createServer();
    try {
        const kycRead = await server.request("/api/admin/kyc/pending", { userId: "regulator-1" });
        const kycReview = await server.request("/api/admin/kyc/kyc-1/review", {
            userId: "regulator-1",
            method: "PATCH",
            body: { status: "VERIFIED" },
        });
        const fundCreate = await server.request("/api/funds", {
            userId: "regulator-1",
            method: "POST",
            body: {
                fund_name: "Denied Fund",
                administrator_name: "Synthetic",
                risk_level: "LOW",
                expected_return: 1,
            },
        });
        const fundUpdate = await server.request("/api/funds/fund-1", {
            userId: "regulator-1",
            method: "PATCH",
            body: { fund_status: "SUSPENDED" },
        });
        const selfAssignment = await server.request("/api/admin/regulator-fund-assignments", {
            userId: "regulator-1",
            method: "POST",
            body: { regulator_id: "regulator-1", fund_id: "fund-1" },
        });

        assert.equal(kycRead.status, 403);
        assert.equal(kycReview.status, 403);
        assert.equal(fundCreate.status, 403);
        assert.equal(fundUpdate.status, 403);
        assert.equal(selfAssignment.status, 403);
    } finally {
        await server.close();
    }
});
