const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../src/db/database");
const authController = require("../src/controllers/authController");
const authRoutes = require("../src/routes/authRoutes");
const auditLogRoutes = require("../src/routes/auditLogRoutes");
const { writeAuditLog } = require("../src/utils/auditLog");
const { requireAuth } = require("../src/middleware/authMiddleware");
const { generateToken } = require("../src/utils/token");

process.env.JWT_SECRET ||= "micopesa-auth-audit-test-secret";

const originalQuery = pool.query;
const originalCompare = bcrypt.compare;
const originalJwtSecret = process.env.JWT_SECRET;

after(() => {
    pool.query = originalQuery;
    bcrypt.compare = originalCompare;
    process.env.JWT_SECRET = originalJwtSecret;
});

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

function activeUser(overrides = {}) {
    return {
        user_id: "auth-audit-user",
        full_name: "Audit Test User",
        phone: "07000000001",
        email: "audit-user@example.test",
        email_verified: true,
        password_hash: "stored-hash",
        role: "ADMIN",
        account_status: "ACTIVE",
        auth_version: 3,
        failed_login_attempts: 0,
        locked_until: null,
        ...overrides,
    };
}

test("successful login records exactly one safe LOGIN event for the database user", async () => {
    const calls = [];
    pool.query = async (sql, params = []) => {
        calls.push({ sql, params });
        if (sql.includes("FROM users") && sql.includes("login_method = 'PHONE'")) {
            return { rows: [activeUser()] };
        }
        if (sql.includes("SELECT setting_key, setting_value")) {
            return { rows: [
                { setting_key: "max_failed_login_attempts", setting_value: "5" },
                { setting_key: "account_lockout_duration_minutes", setting_value: "15" },
                { setting_key: "assumed_yearly_growth", setting_value: "8" },
                { setting_key: "require_otp_on_withdrawal", setting_value: "true" },
            ] };
        }
        if (sql.includes("SET failed_login_attempts = 0")) return { rows: [] };
        if (sql.includes("INSERT INTO audit_logs")) return { rows: [], rowCount: 1 };
        assert.fail(`Unexpected query: ${sql}`);
    };
    bcrypt.compare = async (password, hash) => password === "correct-password" && hash === "stored-hash";

    const res = response();
    await authController.login({
        body: { identifier: "07000000001", password: "correct-password" },
    }, res);

    const loginEvents = calls.filter(({ sql, params }) =>
        sql.includes("INSERT INTO audit_logs") && params[1] === "LOGIN"
    );
    assert.equal(res.statusCode, 200);
    assert.equal(loginEvents.length, 1);
    assert.deepEqual(loginEvents[0].params.slice(0, 4), [
        "auth-audit-user", "LOGIN", "AUTHENTICATION", "auth-audit-user",
    ]);
    assert.deepEqual(JSON.parse(loginEvents[0].params[4]), { role: "ADMIN" });
    assert.match(loginEvents[0].sql, /INSERT INTO audit_logs/);
    assert.doesNotMatch(loginEvents[0].sql, /password|token/i);
    assert.doesNotMatch(loginEvents[0].params.join(" "), /correct-password|stored-hash|Bearer /i);
});

test("incorrect credentials do not create a successful LOGIN audit event", async () => {
    const calls = [];
    pool.query = async (sql, params = []) => {
        calls.push({ sql, params });
        if (sql.includes("FROM users") && sql.includes("login_method = 'PHONE'")) {
            return { rows: [activeUser()] };
        }
        if (sql.includes("SELECT setting_key, setting_value")) {
            return { rows: [
                { setting_key: "max_failed_login_attempts", setting_value: "5" },
                { setting_key: "account_lockout_duration_minutes", setting_value: "15" },
                { setting_key: "assumed_yearly_growth", setting_value: "8" },
                { setting_key: "require_otp_on_withdrawal", setting_value: "true" },
            ] };
        }
        if (sql.includes("SET failed_login_attempts = failed_login_attempts + 1")) {
            return { rows: [] };
        }
        assert.fail(`Unexpected query: ${sql}`);
    };
    bcrypt.compare = async () => false;

    const res = response();
    await authController.login({
        body: { identifier: "07000000001", password: "incorrect-password" },
    }, res);

    assert.equal(res.statusCode, 401);
    assert.equal(calls.filter(({ sql }) => sql.includes("INSERT INTO audit_logs")).length, 0);
});

test("authenticated logout records one LOGOUT event using middleware identity", async () => {
    const calls = [];
    pool.query = async (sql, params = []) => {
        calls.push({ sql, params });
        if (sql.includes("FROM users WHERE user_id = $1")) {
            return { rows: [{
                user_id: "database-user",
                role: "FUND_MANAGER",
                account_status: "ACTIVE",
                auth_version: 0,
                force_password_change: false,
                is_temp_password: false,
            }] };
        }
        if (sql.includes("INSERT INTO audit_logs")) return { rows: [], rowCount: 1 };
        assert.fail(`Unexpected query: ${sql}`);
    };

    const req = {
        path: "/logout",
        headers: { authorization: `Bearer ${generateToken({ userId: "database-user", role: "WORKER" })}` },
        body: { user_id: "attacker-selected-user" },
    };
    const res = response();
    let logoutPromise;
    await requireAuth(req, res, () => {
        logoutPromise = authController.logout(req, res);
    });
    await logoutPromise;

    const logoutEvents = calls.filter(({ sql, params }) =>
        sql.includes("INSERT INTO audit_logs") && params[1] === "LOGOUT"
    );
    assert.equal(res.statusCode, 200);
    assert.equal(logoutEvents.length, 1);
    assert.deepEqual(logoutEvents[0].params.slice(0, 4), [
        "database-user", "LOGOUT", "AUTHENTICATION", "database-user",
    ]);
    assert.deepEqual(JSON.parse(logoutEvents[0].params[4]), { role: "FUND_MANAGER" });
    assert.doesNotMatch(logoutEvents[0].params.join(" "), /Bearer |attacker-selected-user/i);
});

test("unauthenticated or expired logout requests cannot create audit records", async () => {
    let queries = 0;
    pool.query = async () => {
        queries += 1;
        return { rows: [] };
    };

    const missingAuth = response();
    await requireAuth({ path: "/logout", headers: {} }, missingAuth, () => {
        assert.fail("Unauthenticated logout must not reach its controller.");
    });
    assert.equal(missingAuth.statusCode, 401);
    assert.equal(queries, 0);

    const expiredToken = jwt.sign(
        { userId: "database-user" },
        process.env.JWT_SECRET,
        { expiresIn: -1 }
    );
    const expired = response();
    await requireAuth({
        path: "/logout",
        headers: { authorization: `Bearer ${expiredToken}` },
    }, expired, () => {
        assert.fail("Expired sessions must not reach the logout controller.");
    });
    assert.equal(expired.statusCode, 401);
    assert.equal(queries, 0);
});

test("audit insert diagnostics report only the action, entity and sanitized error code", async () => {
    const originalConsoleError = console.error;
    let diagnostic;
    console.error = (...args) => { diagnostic = args; };
    try {
        await assert.rejects(writeAuditLog({
            async query() {
                throw Object.assign(new Error("sensitive driver detail"), {
                    code: "23503",
                    detail: "private database detail",
                });
            },
        }, {
            userId: "synthetic-user",
            actionType: "LOGIN",
            entityName: "AUTHENTICATION",
            entityId: "synthetic-user",
            details: { role: "ADMIN" },
        }), { code: "23503" });
    } finally {
        console.error = originalConsoleError;
    }

    assert.equal(diagnostic[0], "Audit log insert failed:");
    assert.deepEqual(diagnostic[1], {
        actionType: "LOGIN",
        entityName: "AUTHENTICATION",
        code: "23503",
    });
    assert.doesNotMatch(JSON.stringify(diagnostic), /sensitive|private|synthetic-user/);
});

test("login and explicit logout audit events are returned by the authenticated system audit API", async (t) => {
    const auditRows = [];
    bcrypt.compare = async (password, hash) => password === "correct-password" && hash === "stored-hash";
    pool.query = async (sql, params = []) => {
        if (sql.includes("FROM users") && sql.includes("login_method = 'PHONE'")) {
            return { rows: [activeUser()] };
        }
        if (sql.includes("SELECT setting_key, setting_value")) {
            return { rows: [
                { setting_key: "max_failed_login_attempts", setting_value: "5" },
                { setting_key: "account_lockout_duration_minutes", setting_value: "15" },
                { setting_key: "assumed_yearly_growth", setting_value: "8" },
                { setting_key: "require_otp_on_withdrawal", setting_value: "true" },
            ] };
        }
        if (sql.includes("SET failed_login_attempts = 0")) return { rows: [] };
        if (sql.includes("FROM users WHERE user_id = $1")) {
            const user = params[0] === "auth-audit-user" ? activeUser() : null;
            return {
                rows: user ? [{
                    user_id: user.user_id,
                    role: user.role,
                    account_status: user.account_status,
                    auth_version: user.auth_version,
                    force_password_change: false,
                    is_temp_password: false,
                }] : [],
            };
        }
        if (sql.includes("INSERT INTO audit_logs")) {
            auditRows.push({
                log_id: `audit-${auditRows.length + 1}`,
                user_id: params[0],
                action_type: params[1],
                entity_name: params[2],
                entity_id: params[3],
                details: params[4] ? JSON.parse(params[4]) : null,
                timestamp: new Date(Date.now() + auditRows.length).toISOString(),
                full_name: "Audit Test User",
                user_role: "ADMIN",
            });
            return { rows: [], rowCount: 1 };
        }
        if (sql.includes("FROM audit_logs al")) {
            return { rows: [...auditRows].reverse() };
        }
        assert.fail(`Unexpected query: ${sql}`);
    };

    const app = express();
    app.use(express.json());
    app.use("/api/auth", authRoutes);
    app.use("/api/audit-logs", auditLogRoutes);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    }));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "07000000001", password: "correct-password" }),
    });
    assert.equal(loginResponse.status, 200);
    const { data: session } = await loginResponse.json();

    const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.equal(logoutResponse.status, 200);
    assert.match((await logoutResponse.json()).message, /recorded/i);

    const logsResponse = await fetch(`${baseUrl}/api/audit-logs/system`, {
        headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.equal(logsResponse.status, 200);
    const { data: logs } = await logsResponse.json();
    assert.deepEqual(logs.map(({ action_type }) => action_type), ["LOGOUT", "LOGIN"]);
    assert.ok(logs.every(({ full_name, user_role, timestamp }) =>
        full_name === "Audit Test User" && user_role === "ADMIN" && Number.isFinite(Date.parse(timestamp))
    ));
    assert.deepEqual(auditRows.map(({ action_type }) => action_type), ["LOGIN", "LOGOUT"]);
});
