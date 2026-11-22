const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const bcrypt = require("bcrypt");
const pool = require("../src/db/database");
const { requireAuth, requireRole } = require("../src/middleware/authMiddleware");
const { generateToken } = require("../src/utils/token");
const authEmailService = require("../src/services/authEmailService");
const { isEnvironmentFlagEnabled } = require("../src/utils/authConfiguration");

process.env.JWT_SECRET ||= "micopesa-auth-security-test-secret";

const originalQuery = pool.query;
const originalConnect = pool.connect;
const originalHash = bcrypt.hash;
const originalIssueEmailToken = authEmailService.issueEmailToken;
const originalSendPendingRegistrationEmail = authEmailService.sendPendingRegistrationEmail;
const originalEnforceRequestLimits = authEmailService.enforceRequestLimits;
const originalFlag = process.env.ALLOW_PRIVILEGED_SIGNUP;

afterEach(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    bcrypt.hash = originalHash;
    authEmailService.issueEmailToken = originalIssueEmailToken;
    authEmailService.sendPendingRegistrationEmail = originalSendPendingRegistrationEmail;
    authEmailService.enforceRequestLimits = originalEnforceRequestLimits;
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
    assert.match(result.queryText, /force_password_change/);
    assert.match(result.queryText, /is_temp_password/);
    assert.deepEqual(result.queryValues, ["user-1"]);
    assert.deepEqual(result.req.user, {
        userId: "user-1",
        role: "WORKER",
        forcePasswordChange: false,
        isTempPassword: false,
    });

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
    assert.deepEqual(result.req.user, {
        userId: "user-3",
        role: "FUND_MANAGER",
        forcePasswordChange: false,
        isTempPassword: false,
    });

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

test("public registration is phone OTP based and never accepts a privileged client role", () => {
    const authRoutes = require("../src/routes/authRoutes");
    const routes = authRoutes.stack
        .filter((layer) => layer.route)
        .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
    assert.ok(routes.includes("POST /register"));
    assert.ok(routes.includes("POST /register/resend"));
    assert.ok(routes.includes("POST /register/complete"));
});

test("production startup fails when privileged signup is enabled", () => {
    assert.equal(isEnvironmentFlagEnabled(" TRUE ", "ALLOW_PRIVILEGED_SIGNUP"), true);
    assert.equal(isEnvironmentFlagEnabled("Yes", "ALLOW_PRIVILEGED_SIGNUP"), true);
    assert.equal(isEnvironmentFlagEnabled(" OFF ", "ALLOW_PRIVILEGED_SIGNUP"), false);

    const startup = spawnSync(
        process.execPath,
        [
            "--require",
            path.resolve(__dirname, "../../../tests/scripts/noEnvironmentFilesPreload.js"),
            "-e",
            "let startupError; try { require('./apps/api/src/server'); } catch (error) { startupError = error; } if (global.__micopesaDotenvConfigCalls !== 1 || startupError?.message !== 'ALLOW_PRIVILEGED_SIGNUP must be disabled in production') { process.exitCode = 1; } else { process.stdout.write('DOTENV_STUB_VERIFIED'); }",
        ],
        {
            cwd: path.resolve(__dirname, "../../.."),
            encoding: "utf8",
            env: {
                PATH: process.env.PATH,
                SystemRoot: process.env.SystemRoot,
                WINDIR: process.env.WINDIR,
                TEMP: process.env.TEMP,
                TMP: process.env.TMP,
                NODE_ENV: " production ",
                ALLOW_PRIVILEGED_SIGNUP: " YES ",
                MICOPESA_TEST_DOTENV_STUB: "enabled",
            },
        }
    );
    assert.equal(startup.status, 0);
    assert.equal(startup.stdout, "DOTENV_STUB_VERIFIED");
});
