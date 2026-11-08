const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../src/db/database");
const adminUserRoutes = require("../src/routes/adminUserRoutes");
const authRoutes = require("../src/routes/authRoutes");
const { generateToken } = require("../src/utils/token");

process.env.JWT_SECRET ||= "micopesa-admin-role-login-test-secret";

const originalQuery = pool.query;
const originalConnect = pool.connect;
const originalCompare = bcrypt.compare;
const originalJwtSecret = process.env.JWT_SECRET;
const supportedRoles = ["WORKER", "FUND_MANAGER", "REGULATOR", "ADMIN"];
const ROLE_TEST_PATH = {
    WORKER: "worker",
    FUND_MANAGER: "fund-manager",
    REGULATOR: "regulator",
    ADMIN: "admin",
};

after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    bcrypt.compare = originalCompare;
    process.env.JWT_SECRET = originalJwtSecret;
});

function createRoleApi(initialRole) {
    const users = new Map([
        ["admin-1", {
            user_id: "admin-1",
            role: "ADMIN",
            account_status: "ACTIVE",
            auth_version: 0,
            login_method: "PHONE",
            full_name: "Test Admin",
            phone: "07000000001",
            password_hash: "admin-hash",
        }],
        ["target-1", {
            user_id: "target-1",
            role: "REGULATOR",
            account_status: "ACTIVE",
            auth_version: 0,
            login_method: "PHONE",
            full_name: "Test User",
            phone: "07000000002",
            password_hash: "target-hash",
            email: "test@example.com",
            email_verified: false,
        }],
    ]);

    pool.query = async (query, values = []) => {
        if (query.includes("SELECT setting_key, setting_value")) {
            return { rows: [
                { setting_key: "assumed_yearly_growth", setting_value: "8" },
                { setting_key: "max_failed_login_attempts", setting_value: "5" },
                { setting_key: "account_lockout_duration_minutes", setting_value: "15" },
                { setting_key: "require_otp_on_withdrawal", setting_value: "true" },
            ] };
        }
        if (query.includes("UPDATE users SET failed_login_attempts")) return { rows: [] };
        if (query.includes("SELECT user_id, role, account_status, auth_version")) {
            const user = users.get(values[0]);
            return { rows: user ? [user] : [] };
        }
        if (query.includes("FROM users") && query.includes("login_method = 'PHONE'")) {
            const user = [...users.values()].find((item) =>
                item.phone === values[0] || item.phone === values[2]
            );
            return {
                rows: user ? [{
                    ...user,
                    occupation: null,
                    created_at: "2026-01-01T00:00:00.000Z",
                    updated_at: "2026-01-01T00:00:00.000Z",
                    profile_photo_available: false,
                }] : [],
            };
        }
        if (query.includes("SET failed_login_attempts = 0")) return { rows: [] };
        assert.fail(`Unexpected pool query: ${query}`);
    };

    pool.connect = async () => ({
        async query(query, values = []) {
            if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") {
                return { rows: [] };
            }
            if (query.includes("UPDATE users SET role = $1")) {
                const user = users.get(values[1]);
                if (!user) return { rows: [] };
                user.role = values[0];
                return {
                    rows: [{
                        user_id: user.user_id,
                        full_name: user.full_name,
                        phone: user.phone,
                        role: user.role,
                        occupation: null,
                        account_status: user.account_status,
                        created_at: "2026-01-01T00:00:00.000Z",
                        updated_at: "2026-10-28T00:00:00.000Z",
                    }],
                };
            }
            if (query.includes("INSERT INTO audit_logs")) return { rows: [] };
            assert.fail(`Unexpected transaction query: ${query}`);
        },
        release() {},
    });

    bcrypt.compare = async (_password, _passwordHash) => true;
    users.get("target-1").role = initialRole;

    const app = express();
    app.use(express.json());
    app.use("/api/admin/users", adminUserRoutes);
    app.use("/api/auth", authRoutes);
    const server = http.createServer(app);

    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const baseUrl = `http://127.0.0.1:${server.address().port}`;
            resolve({
                users,
                request(path, { token, method = "GET", body } = {}) {
                    return fetch(`${baseUrl}${path}`, {
                        method,
                        headers: {
                            ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

test("Admin role changes persist to the authoritative user and govern login and old-role API access", async (t) => {
    for (const previousRole of supportedRoles) {
        for (const role of supportedRoles.filter((candidate) => candidate !== previousRole)) {
            await t.test(`${previousRole} changes to ${role}`, async () => {
                const api = await createRoleApi(previousRole);
                try {
                    const adminToken = generateToken({ userId: "admin-1", role: "ADMIN", authVersion: 0 });
                    const oldRoleToken = generateToken({
                        userId: "target-1",
                        role: previousRole,
                        authVersion: 0,
                    });
                    const changed = await api.request("/api/admin/users/target-1/role", {
                        token: adminToken,
                        method: "PATCH",
                        body: { role },
                    });
                    assert.equal(changed.status, 200);
                    assert.equal(api.users.get("target-1").role, role);
                    assert.equal((await changed.json()).data.user.role, role);

                    const nextLogin = await api.request("/api/auth/login", {
                        method: "POST",
                        body: { phone: "07000000002", password: "existing-password" },
                    });
                    assert.equal(nextLogin.status, 200);
                    const loginUser = (await nextLogin.json()).data.user;
                    assert.equal(loginUser.role, role);
                    assert.equal(api.users.get("target-1").role, loginUser.role);

                    const previousRoleApi = await api.request(
                        `/api/auth/test/${ROLE_TEST_PATH[previousRole]}`,
                        { token: oldRoleToken }
                    );
                    assert.equal(previousRoleApi.status, 403);
                } finally {
                    await api.close();
                }
            });
        }
    }
});
