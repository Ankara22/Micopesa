const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");
const pool = require("../src/db/database");
const authController = require("../src/controllers/authController");
const { requireAuth } = require("../src/middleware/authMiddleware");
const { generateToken, verifyTokenString } = require("../src/utils/token");

process.env.JWT_SECRET ||= "micopesa-auth-operational-test-secret";

const originalQuery = pool.query;
const originalConnect = pool.connect;
const originalCompare = bcrypt.compare;
const originalHash = bcrypt.hash;
const originalJwtSecret = process.env.JWT_SECRET;
const settingsRows = [
    { setting_key: "assumed_yearly_growth", setting_value: "8" },
    { setting_key: "max_failed_login_attempts", setting_value: "3" },
    { setting_key: "account_lockout_duration_minutes", setting_value: "10" },
    { setting_key: "require_otp_on_withdrawal", setting_value: "true" },
];

after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    bcrypt.compare = originalCompare;
    bcrypt.hash = originalHash;
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

test("a failed password increments the account counter using configured lockout limits", async () => {
    let update;
    pool.query = async (query, values = []) => {
        if (query.includes("SELECT setting_key, setting_value")) return { rows: settingsRows };
        if (query.includes("FROM users") && query.includes("login_method = 'PHONE'")) {
            return { rows: [{
                user_id: "staff-user",
                password_hash: "stored-hash",
                role: "FUND_MANAGER",
                account_status: "ACTIVE",
                auth_version: 2,
                failed_login_attempts: 2,
                locked_until: null,
                is_temp_password: true,
                force_password_change: true,
            }] };
        }
        if (query.includes("SET failed_login_attempts = failed_login_attempts + 1")) {
            update = { query, values };
            return { rows: [] };
        }
        assert.fail(`Unexpected query: ${query}`);
    };
    bcrypt.compare = async () => false;
    const res = response();
    await authController.login({ body: { phone: "+254712345678", password: "wrong" } }, res);

    assert.equal(res.statusCode, 401);
    assert.deepEqual(update.values, ["staff-user", 3, 10]);
    assert.match(update.query, /failed_login_attempts \+ 1 >= \$2/);
    assert.match(update.query, /interval '1 minute'/);
});

test("temporary-password sessions cannot use protected API routes", async () => {
    pool.query = async () => ({
        rows: [{
            user_id: "staff-user",
            role: "ADMIN",
            account_status: "ACTIVE",
            auth_version: 0,
            force_password_change: true,
            is_temp_password: true,
        }],
    });
    const res = response();
    let nextCalled = false;
    await requireAuth({
        path: "/users",
        headers: {
            authorization: `Bearer ${generateToken({ userId: "staff-user", role: "ADMIN", authVersion: 0 })}`,
        },
    }, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "PASSWORD_CHANGE_REQUIRED");
    assert.equal(nextCalled, false);
});

test("changing a temporary password clears the forced state and rotates the auth version", async () => {
    const statements = [];
    bcrypt.hash = async () => "new-password-hash";
    pool.connect = async () => ({
        async query(query, values = []) {
            statements.push({ query, values });
            if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
            if (query.includes("UPDATE users") && query.includes("force_password_change = TRUE")) {
                return { rows: [{ user_id: "staff-user", role: "ADMIN", auth_version: 4 }] };
            }
            assert.fail(`Unexpected query: ${query}`);
        },
        release() {},
    });
    const res = response();
    await authController.changeTemporaryPassword({
        user: { userId: "staff-user" },
        body: { new_password: "a-strong-new-password" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(statements.at(-1).query, "COMMIT");
    assert.equal(verifyTokenString(res.body.data.token).authVersion, 4);
});
