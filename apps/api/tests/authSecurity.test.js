const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const bcrypt = require("bcrypt");
const pool = require("../src/db/database");
const { requireAuth, requireRole } = require("../src/middleware/authMiddleware");
const { generateToken } = require("../src/utils/token");
const { register } = require("../src/controllers/authController");
const { isEnvironmentFlagEnabled } = require("../src/utils/authConfiguration");

process.env.JWT_SECRET ||= "micopesa-auth-security-test-secret";

const originalQuery = pool.query;
const originalConnect = pool.connect;
const originalHash = bcrypt.hash;
const originalFlag = process.env.ALLOW_PRIVILEGED_SIGNUP;

afterEach(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    bcrypt.hash = originalHash;
    if (originalFlag === undefined) {
        delete process.env.ALLOW_PRIVILEGED_SIGNUP;
    } else {
        process.env.ALLOW_PRIVILEGED_SIGNUP = originalFlag;
    }
});

function createResponse() {
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

async function authenticate({ token, user, lookupError } = {}) {
    let nextCalls = 0;
    let queryText;
    let queryValues;
    const req = { headers: { authorization: `Bearer ${token}` } };
    pool.query = async (query, values) => {
        queryText = query;
        queryValues = values;
        if (lookupError) throw lookupError;
        return { rows: user ? [user] : [] };
    };

    const res = createResponse();
    await requireAuth(req, res, () => { nextCalls += 1; });
    return { req, res, nextCalls, queryText, queryValues };
}

test("database role overrides an ADMIN role embedded in the token", async () => {
    const result = await authenticate({
        token: generateToken({ userId: "user-1", role: "ADMIN" }),
        user: { user_id: "user-1", role: "WORKER", account_status: "ACTIVE" },
    });
    assert.equal(result.nextCalls, 1);
    assert.equal(result.res.statusCode, null);
    assert.equal(result.queryText, "SELECT user_id, role, account_status FROM users WHERE user_id = $1");
    assert.deepEqual(result.queryValues, ["user-1"]);
    assert.deepEqual(result.req.user, { userId: "user-1", role: "WORKER" });

    let roleNextCalls = 0;
    requireRole("ADMIN")({ user: { userId: "user-1", role: "WORKER" } }, createResponse(), () => {
        roleNextCalls += 1;
    });
    assert.equal(roleNextCalls, 0);
});

test("inactive users are rejected", async () => {
    const result = await authenticate({
        token: generateToken({ userId: "user-2", role: "ADMIN" }),
        user: { user_id: "user-2", role: "ADMIN", account_status: "SUSPENDED" },
    });
    assert.equal(result.res.statusCode, 403);
    assert.equal(result.nextCalls, 0);
});

test("tokens for deleted users are rejected", async () => {
    const result = await authenticate({
        token: generateToken({ userId: "deleted-user", role: "ADMIN" }),
    });
    assert.equal(result.res.statusCode, 401);
    assert.equal(result.nextCalls, 0);
});

test("active users are authenticated with their current database role", async () => {
    const result = await authenticate({
        token: generateToken({ userId: "user-3", role: "WORKER" }),
        user: { user_id: "user-3", role: "FUND_MANAGER", account_status: "ACTIVE" },
    });
    assert.equal(result.nextCalls, 1);
    assert.deepEqual(result.req.user, { userId: "user-3", role: "FUND_MANAGER" });

    let roleNextCalls = 0;
    requireRole("FUND_MANAGER")({ user: { userId: "user-3", role: "FUND_MANAGER" } }, createResponse(), () => {
        roleNextCalls += 1;
    });
    assert.equal(roleNextCalls, 1);
});

test("invalid and expired tokens are rejected without looking up a user", async () => {
    pool.query = async () => {
        assert.fail("Invalid tokens must not query the database");
    };
    const invalid = createResponse();
    await requireAuth({ headers: { authorization: "Bearer invalid" } }, invalid, () => assert.fail());
    assert.equal(invalid.statusCode, 401);

    const missingIdentity = createResponse();
    await requireAuth(
        { headers: { authorization: `Bearer ${generateToken({ role: "ADMIN" })}` } },
        missingIdentity,
        () => assert.fail()
    );
    assert.equal(missingIdentity.statusCode, 401);

    const expiredToken = require("jsonwebtoken").sign(
        { userId: "user-expired" },
        process.env.JWT_SECRET,
        { expiresIn: -1 }
    );
    const expired = createResponse();
    await requireAuth({ headers: { authorization: `Bearer ${expiredToken}` } }, expired, () => assert.fail());
    assert.equal(expired.statusCode, 401);
    assert.match(expired.body.message, /expired/i);
});

test("database lookup failures do not grant access", async () => {
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        const result = await authenticate({
            token: generateToken({ userId: "user-4", role: "ADMIN" }),
            lookupError: new Error("database unavailable"),
        });
        assert.equal(result.res.statusCode, 500);
        assert.equal(result.nextCalls, 0);
        assert.match(result.res.body.message, /temporarily unavailable/i);
    } finally {
        console.error = originalConsoleError;
    }
});

async function registerWithMocks(body) {
    const calls = [];
    pool.query = async (query, values) => {
        calls.push({ query, values });
        return { rows: [] };
    };
    pool.connect = async () => ({
        async query(query, values) {
            calls.push({ query, values });
            if (query.includes("INSERT INTO users")) {
                return {
                    rows: [{
                        user_id: "new-worker",
                        full_name: body.full_name,
                        phone: body.phone,
                        role: values[3],
                        occupation: values[4],
                        account_status: "ACTIVE",
                    }],
                };
            }
            return { rows: [] };
        },
        release() {},
    });
    bcrypt.hash = async (password) => `hashed:${password}`;

    const res = createResponse();
    await register({ body }, res);
    return { res, calls };
}

const workerRegistration = {
    full_name: "Test Worker",
    phone: "07000000001",
    password: "password123",
    occupation: "OTHER_INFORMAL_WORKER",
};

test("public registration without a role creates a worker", async () => {
    const { res, calls } = await registerWithMocks({ ...workerRegistration });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.user.role, "WORKER");
    assert.ok(calls.some(({ query, values }) => query.includes("INSERT INTO users") && values[3] === "WORKER"));
});

for (const role of ["ADMIN", "FUND_MANAGER", "REGULATOR"]) {
    test(`public registration ignores client role ${role}`, async () => {
        process.env.ALLOW_PRIVILEGED_SIGNUP = "true";
        const { res, calls } = await registerWithMocks({
            ...workerRegistration,
            role,
            is_admin: true,
        });
        assert.equal(res.statusCode, 201);
        assert.equal(res.body.data.user.role, "WORKER");
        assert.ok(calls.some(({ query, values }) => query.includes("INSERT INTO users") && values[3] === "WORKER"));
    });
}

test("legitimate worker registration retains hashing and pension-account creation", async () => {
    const { res, calls } = await registerWithMocks({ ...workerRegistration, phone: "07000000003" });
    assert.equal(res.statusCode, 201);
    const userInsert = calls.find(({ query }) => query.includes("INSERT INTO users"));
    assert.equal(userInsert.values[2], "hashed:password123");
    assert.ok(calls.some(({ query }) => query.includes("INSERT INTO pension_accounts")));
});

test("production startup fails when privileged signup is enabled", () => {
    assert.equal(isEnvironmentFlagEnabled(" TRUE ", "ALLOW_PRIVILEGED_SIGNUP"), true);
    assert.equal(isEnvironmentFlagEnabled("Yes", "ALLOW_PRIVILEGED_SIGNUP"), true);
    assert.equal(isEnvironmentFlagEnabled(" OFF ", "ALLOW_PRIVILEGED_SIGNUP"), false);

    const startup = spawnSync(
        process.execPath,
        ["-e", "require('./apps/api/src/server')"],
        {
            cwd: path.resolve(__dirname, "../../.."),
            encoding: "utf8",
            env: {
                ...process.env,
                NODE_ENV: " production ",
                ALLOW_PRIVILEGED_SIGNUP: " YES ",
            },
        }
    );
    assert.notEqual(startup.status, 0);
    assert.match(startup.stderr, /ALLOW_PRIVILEGED_SIGNUP must be disabled in production/);
});
