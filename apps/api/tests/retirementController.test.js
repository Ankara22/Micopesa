const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const pool = {
    query: async () => ({ rows: [] }),
    connect: async () => assert.fail("Unexpected database connection"),
};
const databaseModulePath = require.resolve("../src/db/database");
const originalModuleLoad = Module._load;
Module._load = function loadWithMockedDatabase(request, parent, isMain) {
    if (request === "jsonwebtoken") {
        return { sign: () => "", verify: () => ({}) };
    }
    if (Module._resolveFilename(request, parent, isMain) === databaseModulePath) return pool;
    return originalModuleLoad.call(this, request, parent, isMain);
};
const { getPlan, upsertPlan } = require("../src/controllers/retirementController");
const { getMyContributions } = require("../src/controllers/accountController");
const { requireRole } = require("../src/middleware/authMiddleware");
Module._load = originalModuleLoad;

const originalQuery = pool.query;
const originalConnect = pool.connect;

after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
});

const settings = [
    { setting_key: "assumed_yearly_growth", setting_value: "8" },
    { setting_key: "max_failed_login_attempts", setting_value: "5" },
    { setting_key: "account_lockout_duration_minutes", setting_value: "15" },
    { setting_key: "require_otp_on_withdrawal", setting_value: "true" },
];

function response() {
    return {
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
}

function projectionClient({ failProjectionInsert = false } = {}) {
    const queries = [];
    const client = {
        async query(query, values = []) {
            queries.push({ query, values });
            if (["BEGIN", "COMMIT", "ROLLBACK"].includes(query)) return { rows: [] };
            if (query.includes("FROM pension_accounts")) {
                return { rows: [{ account_id: "account-worker-1", current_balance: "1250.00" }] };
            }
            if (query.includes("SELECT setting_key, setting_value")) return { rows: settings };
            if (query.includes("SELECT plan_id FROM retirement_plans")) return { rows: [] };
            if (query.includes("INSERT INTO retirement_plans")) {
                return { rows: [{
                    plan_id: "plan-worker-1",
                    account_id: values[0],
                    target_amount: values[1],
                    target_age: values[2],
                    expected_return: values[3],
                }] };
            }
            if (query.includes("INSERT INTO retirement_projections")) {
                if (failProjectionInsert) throw Object.assign(new Error("mock persistence failure"), { code: "23505" });
                const yearByYear = JSON.parse(values[7]);
                return { rows: [{
                    projection_id: "projection-1",
                    plan_id: values[0],
                    assumed_contribution: values[1],
                    assumed_return: values[2],
                    projected_amount: values[3],
                    projection_years: values[4],
                    current_age: values[5],
                    starting_balance: values[6],
                    yearly_projection: yearByYear,
                }] };
            }
            assert.fail(`Unexpected query: ${query}`);
        },
        release() {},
    };
    return { client, queries };
}

test("saves owner-scoped annual projection snapshots using only the credited account balance", async () => {
    const { client, queries } = projectionClient();
    pool.connect = async () => client;
    const res = response();

    await upsertPlan({
        user: { userId: "worker-user-1" },
        body: {
            target_amount: "500000.00",
            target_retirement_age: "35",
            monthly_contribution_target: "500.00",
            current_age: "30",
            account_id: "another-users-account",
        },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.projection.starting_balance, "1250.00");
    assert.equal(res.body.data.projection.current_age, 30);
    assert.equal(res.body.data.projection.yearly_projection.length, 6);
    assert.equal(res.body.data.assumed_yearly_growth, 8);
    assert.equal(queries[1].query.includes("FROM pension_accounts"), true);
    assert.deepEqual(queries[1].values, ["worker-user-1"]);
    assert.equal(queries.some(({ query }) => query.includes("FROM contributions")), false);
    assert.equal(queries.some(({ query }) => query === "COMMIT"), true);
    assert.equal(queries.some(({ query }) => query === "ROLLBACK"), false);
});

test("returns 404 with the authenticated user's account context when no active plan exists", async () => {
    const queries = [];
    pool.query = async (query, values = []) => {
        queries.push({ query, values });
        if (query.includes("FROM pension_accounts")) {
            return { rows: [{ account_id: "account-worker-1", current_balance: "1250.00" }] };
        }
        if (query.includes("SELECT setting_key, setting_value")) return { rows: settings };
        if (query.includes("FROM retirement_plans")) return { rows: [] };
        assert.fail(`Unexpected query: ${query}`);
    };
    const res = response();

    await getPlan({ user: { userId: "worker-user-1" } }, res);

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, "RETIREMENT_PLAN_NOT_FOUND");
    assert.equal(res.body.data.plan, null);
    assert.equal(res.body.data.projection, null);
    assert.equal(res.body.data.account.current_balance, "1250.00");
    assert.equal(res.body.data.assumed_yearly_growth, 8);
    assert.deepEqual(queries[0].values, ["worker-user-1"]);
});

test("returns only an active plan belonging to the authenticated user's account", async () => {
    const queries = [];
    pool.query = async (query, values = []) => {
        queries.push({ query, values });
        if (query.includes("FROM pension_accounts")) {
            return { rows: [{ account_id: "account-worker-1", current_balance: "1250.00" }] };
        }
        if (query.includes("SELECT setting_key, setting_value")) return { rows: settings };
        if (query.includes("FROM retirement_plans")) {
            assert.deepEqual(values, ["account-worker-1"]);
            return { rows: [{
                plan_id: "plan-worker-1",
                account_id: "account-worker-1",
                plan_status: "ACTIVE",
            }] };
        }
        if (query.includes("FROM retirement_projections")) {
            assert.deepEqual(values, ["plan-worker-1"]);
            return { rows: [{ projection_id: "projection-worker-1", plan_id: "plan-worker-1" }] };
        }
        assert.fail(`Unexpected query: ${query}`);
    };
    const res = response();

    await getPlan({
        user: { userId: "worker-user-1" },
        params: { accountId: "account-worker-2", planId: "plan-worker-2" },
        query: { account_id: "account-worker-2", plan_id: "plan-worker-2" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.plan.plan_id, "plan-worker-1");
    assert.equal(res.body.data.projection.projection_id, "projection-worker-1");
    assert.deepEqual(queries[0].values, ["worker-user-1"]);
    assert.equal(queries.some(({ values }) => values.includes("account-worker-2")), false);
    assert.equal(queries.some(({ values }) => values.includes("plan-worker-2")), false);
});

test("worker reads their own contributions using only the authenticated account", async () => {
    const queries = [];
    pool.query = async (query, values = []) => {
        queries.push({ query, values });
        if (query.includes("FROM pension_accounts")) {
            return { rows: [{ account_id: "account-worker-1" }] };
        }
        if (query.includes("FROM contributions c")) {
            return { rows: [{
                contribution_id: "contribution-worker-1",
                amount: "1200.00",
                account_id: "account-worker-1",
            }] };
        }
        assert.fail(`Unexpected query: ${query}`);
    };
    const res = response();

    await getMyContributions({
        user: { userId: "worker-user-1", role: "WORKER" },
        body: { account_id: "account-worker-2" },
        query: { account_id: "account-worker-2" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data[0].contribution_id, "contribution-worker-1");
    assert.deepEqual(queries[0].values, ["worker-user-1"]);
    assert.deepEqual(queries[1].values, ["account-worker-1"]);
    assert.match(queries[1].query, /WHERE c\.account_id = \$1/);
});

test("worker cannot retrieve another worker's contributions by supplying account identifiers", async () => {
    const queries = [];
    pool.query = async (query, values = []) => {
        queries.push({ query, values });
        if (query.includes("FROM pension_accounts")) {
            return { rows: [{ account_id: "account-worker-1" }] };
        }
        if (query.includes("FROM contributions c")) {
            assert.deepEqual(values, ["account-worker-1"]);
            return { rows: [{
                contribution_id: "contribution-worker-1",
                amount: "1200.00",
                account_id: "account-worker-1",
            }] };
        }
        assert.fail(`Unexpected query: ${query}`);
    };
    const res = response();

    await getMyContributions({
        user: { userId: "worker-user-1", role: "WORKER" },
        params: { accountId: "account-worker-2" },
        body: { account_id: "account-worker-2" },
        query: { account_id: "account-worker-2" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data.map((row) => row.contribution_id), ["contribution-worker-1"]);
    assert.equal(queries.some(({ values }) => values.includes("account-worker-2")), false);
});

test("returns 404 when the authenticated worker has no pension account for contributions", async () => {
    let queryCount = 0;
    pool.query = async (query, values = []) => {
        queryCount += 1;
        assert.match(query, /FROM pension_accounts/);
        assert.deepEqual(values, ["worker-without-account"]);
        return { rows: [] };
    };
    const res = response();

    await getMyContributions({ user: { userId: "worker-without-account" } }, res);

    assert.equal(res.statusCode, 404);
    assert.equal(queryCount, 1);
});

test("worker receives 404 rather than another worker's retirement plan", async () => {
    const queries = [];
    pool.query = async (query, values = []) => {
        queries.push({ query, values });
        if (query.includes("FROM pension_accounts")) {
            return { rows: [{ account_id: "account-worker-1", current_balance: "0.00" }] };
        }
        if (query.includes("SELECT setting_key, setting_value")) return { rows: settings };
        if (query.includes("FROM retirement_plans")) {
            assert.deepEqual(values, ["account-worker-1"]);
            return { rows: [] };
        }
        assert.fail(`A missing owned plan must stop before projection lookup: ${query}`);
    };
    const res = response();

    await getPlan({
        user: { userId: "worker-user-1" },
        params: { accountId: "account-worker-2", planId: "plan-worker-2" },
        query: { account_id: "account-worker-2", plan_id: "plan-worker-2" },
    }, res);

    assert.equal(res.statusCode, 404);
    assert.equal(res.body.data.plan, null);
    assert.deepEqual(queries[0].values, ["worker-user-1"]);
    assert.equal(queries.some(({ values }) => values.includes("account-worker-2")), false);
    assert.equal(queries.some(({ values }) => values.includes("plan-worker-2")), false);
});

test("worker-only route role guard rejects unauthorized roles", () => {
    const middleware = requireRole("WORKER");
    let nextCalled = false;
    const res = response();
    middleware(
        { user: { userId: "manager-user-1", role: "FUND_MANAGER" } },
        res,
        () => { nextCalled = true; }
    );

    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
});

test("cannot read another user's projection by supplying an account identifier", async () => {
    const queries = [];
    pool.query = async (query, values = []) => {
        queries.push({ query, values });
        if (query.includes("FROM pension_accounts")) return { rows: [] };
        assert.fail(`A missing owned account must stop before this query: ${query}`);
    };
    const res = response();

    await getPlan({
        user: { userId: "worker-user-1" },
        params: { accountId: "another-users-account" },
        query: { account_id: "another-users-account" },
    }, res);

    assert.equal(res.statusCode, 404);
    assert.deepEqual(queries[0].values, ["worker-user-1"]);
    assert.equal(queries.length, 1);
});

test("rejects invalid assumptions before connecting to the database", async () => {
    pool.connect = async () => assert.fail("Invalid assumptions must not connect to the database");
    const res = response();

    await upsertPlan({
        user: { userId: "worker-user-1" },
        body: {
            target_amount: "1000",
            target_retirement_age: 30,
            monthly_contribution_target: -1,
            current_age: 30,
        },
    }, res);

    assert.equal(res.statusCode, 400);
});

test("rolls back plan changes when projection persistence fails", async () => {
    const { client, queries } = projectionClient({ failProjectionInsert: true });
    pool.connect = async () => client;
    const res = response();
    const originalConsoleError = console.error;
    console.error = () => {};

    try {
        await upsertPlan({
            user: { userId: "worker-user-1" },
            body: {
                target_amount: "500000.00",
                target_retirement_age: "35",
                monthly_contribution_target: "500.00",
                current_age: "30",
            },
        }, res);

        assert.equal(res.statusCode, 500);
        assert.equal(queries.some(({ query }) => query === "ROLLBACK"), true);
        assert.equal(queries.some(({ query }) => query === "COMMIT"), false);
    } finally {
        console.error = originalConsoleError;
    }
});
