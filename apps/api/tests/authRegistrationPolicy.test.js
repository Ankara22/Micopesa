const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../src/db/database");
const authEmailService = require("../src/services/authEmailService");
const authRoutes = require("../src/routes/authRoutes");
const { hashOpaque } = require("../src/services/authEmailService");

process.env.JWT_SECRET ||= "micopesa-registration-policy-test-secret";

const originalQuery = pool.query;
const originalConnect = pool.connect;
const originalHash = bcrypt.hash;
const originalCompare = bcrypt.compare;
const originalIssueEmailToken = authEmailService.issueEmailToken;
const originalEnforceRequestLimits = authEmailService.enforceRequestLimits;
const originalJwtSecret = process.env.JWT_SECRET;
let state;

after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    bcrypt.hash = originalHash;
    bcrypt.compare = originalCompare;
    authEmailService.issueEmailToken = originalIssueEmailToken;
    authEmailService.enforceRequestLimits = originalEnforceRequestLimits;
    process.env.JWT_SECRET = originalJwtSecret;
});

function createState() {
    return {
        users: [],
        tokens: new Map(),
        emailAttempts: [],
        failNextDelivery: false,
        failLoginLookup: false,
        loginQueryFailure: null,
        passwordCompareCount: 0,
        nextId: 1,
    };
}

function configureDb() {
    pool.query = async (query, values = []) => {
        if (query.includes("SELECT setting_key, setting_value")) {
            return { rows: [
                { setting_key: "assumed_yearly_growth", setting_value: "8" },
                { setting_key: "max_failed_login_attempts", setting_value: "5" },
                { setting_key: "account_lockout_duration_minutes", setting_value: "15" },
                { setting_key: "require_otp_on_withdrawal", setting_value: "true" },
            ] };
        }
        if (query.includes("SET failed_login_attempts = 0, locked_until = NULL")) {
            return { rows: [] };
        }
        if (query.includes("SELECT user_id FROM users") && query.includes("lower(pending_email)")) {
            const duplicate = state.users.find((user) =>
                user.phone === values[0] ||
                user.email?.toLowerCase() === values[1] ||
                user.pending_email?.toLowerCase() === values[1]
            );
            return { rows: duplicate ? [{ user_id: duplicate.user_id }] : [] };
        }
        if (query.includes("SELECT user_id, full_name, phone, email, password_hash")) {
            if (state.failLoginLookup) {
                state.loginQueryFailure = { code: "42703", missingColumn: "failed_login_attempts" };
                throw Object.assign(new Error('column "failed_login_attempts" does not exist'), { code: "42703" });
            }
            const identifier = values[0];
            const email = values[1];
            const user = state.users.find((candidate) =>
                (candidate.login_method === "PHONE" && candidate.phone === identifier) ||
                (email && candidate.email_verified && candidate.email?.toLowerCase() === email)
            );
            return { rows: user ? [{
                ...user,
                occupation: user.occupation || null,
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
                profile_photo_available: false,
            }] : [] };
        }
        if (query.includes("SELECT user_id, email") && query.includes("login_method = 'EMAIL'")) {
            const user = state.users.find((candidate) =>
                candidate.login_method === "EMAIL" &&
                candidate.email_verified === false &&
                candidate.account_status === "ACTIVE" &&
                candidate.email?.toLowerCase() === values[0]
            );
            return { rows: user ? [{ user_id: user.user_id, email: user.email }] : [] };
        }
        assert.fail(`Unexpected pool query: ${query}`);
    };

    pool.connect = async () => {
        let snapshot;
        return {
            async query(query, values = []) {
                if (query === "BEGIN") {
                    snapshot = structuredClone(state);
                    return { rows: [] };
                }
                if (query === "COMMIT") return { rows: [] };
                if (query === "ROLLBACK") {
                    state.users = snapshot.users;
                    state.tokens = snapshot.tokens;
                    state.nextId = snapshot.nextId;
                    return { rows: [] };
                }
                if (query.includes("INSERT INTO users")) {
                    const user = {
                        user_id: `new-user-${state.nextId++}`,
                        full_name: values[0],
                        phone: values[1],
                        email: values[2],
                        password_hash: values[3],
                        role: values[4],
                        occupation: values[5],
                        login_method: "EMAIL",
                        email_verified: false,
                        pending_email: null,
                        auth_version: 0,
                        account_status: "ACTIVE",
                    };
                    state.users.push(user);
                    return { rows: [{
                        ...user,
                        created_at: "2026-01-01T00:00:00.000Z",
                        updated_at: "2026-01-01T00:00:00.000Z",
                        profile_photo_available: false,
                    }] };
                }
                if (query.includes("INSERT INTO pension_accounts")) return { rows: [] };
                if (query.includes("FROM auth_tokens")) {
                    const token = state.tokens.get(values[0]);
                    return token && !token.consumed
                        ? { rows: [{
                            auth_token_id: token.id,
                            user_id: token.user_id,
                            email_address: token.email,
                        }] }
                        : { rows: [] };
                }
                if (query.includes("UPDATE users") && query.includes("email_verified = TRUE")) {
                    const user = state.users.find((candidate) =>
                        candidate.user_id === values[0] &&
                        candidate.login_method === "EMAIL" &&
                        !candidate.email_verified &&
                        candidate.email.toLowerCase() === values[1].toLowerCase()
                    );
                    if (!user) return { rows: [] };
                    user.email_verified = true;
                    return { rows: [{ user_id: user.user_id }] };
                }
                if (query.includes("UPDATE auth_tokens")) {
                    const token = [...state.tokens.values()].find((item) => item.id === values[0]);
                    if (token) token.consumed = true;
                    return { rows: [] };
                }
                assert.fail(`Unexpected transaction query: ${query}`);
            },
            release() {},
        };
    };
}

function configureEmailService() {
    authEmailService.enforceRequestLimits = async () => {};
    authEmailService.issueEmailToken = async ({ userId, email, purpose }) => {
        state.emailAttempts.push({ userId, email, purpose });
        const token = `secure-verification-token-${state.emailAttempts.length}-long-enough-x`;
        state.tokens.set(hashOpaque(token), {
            id: state.emailAttempts.length,
            user_id: userId,
            email,
            purpose,
            consumed: false,
        });
        if (state.failNextDelivery) {
            state.failNextDelivery = false;
            const error = new Error("mock delivery failure");
            error.code = "EMAIL_SMTP_DELIVERY_FAILED";
            throw error;
        }
        return { messageId: `mock-message-${state.emailAttempts.length}` };
    };
}

async function createApi() {
    state = createState();
    configureDb();
    configureEmailService();
    bcrypt.hash = async (password) => `hashed:${password}`;
    bcrypt.compare = async (password, passwordHash) => {
        state.passwordCompareCount += 1;
        return passwordHash === `hashed:${password}`;
    };
    const app = express();
    app.use(express.json());
    app.use("/api/auth", authRoutes);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/auth`;
    return {
        request(path, body) {
            return fetch(`${baseUrl}${path}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
        },
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        }),
    };
}

test("registration requires a valid normalized email and rejects duplicate addresses", async () => {
    const api = await createApi();
    try {
        const base = {
            full_name: "New Worker",
            phone: "07000000001",
            password: "secure-password",
            occupation: "OTHER_INFORMAL_WORKER",
        };
        assert.equal((await api.request("/register", base)).status, 400);
        assert.equal((await api.request("/register", { ...base, email: "not-an-email" })).status, 400);
        assert.equal(state.users.length, 0);

        const first = await api.request("/register", { ...base, email: "  New.User@Example.com " });
        assert.equal(first.status, 201);
        const firstBody = await first.json();
        assert.equal(firstBody.data.user.email, "new.user@example.com");
        assert.equal(firstBody.data.user.email_verified, false);
        assert.equal(firstBody.data.user.login_method, "EMAIL");
        assert.equal(firstBody.data.user.role, "WORKER");
        assert.equal(firstBody.data.token, undefined);
        assert.equal(firstBody.data.verificationEmailSent, true);
        assert.equal(state.emailAttempts[0].purpose, "EMAIL_VERIFICATION");

        const duplicate = await api.request("/register", {
            ...base,
            phone: "07000000002",
            email: "NEW.USER@example.COM",
        });
        assert.equal(duplicate.status, 409);
        assert.equal(state.users.length, 1);
    } finally {
        await api.close();
    }
});

test("client role and login-method overrides cannot change the EMAIL/WORKER registration policy", async () => {
    const api = await createApi();
    try {
        const response = await api.request("/register", {
            full_name: "New Worker",
            email: "new@example.com",
            phone: "07000000001",
            password: "secure-password",
            occupation: "OTHER_INFORMAL_WORKER",
            role: "ADMIN",
            login_method: "PHONE",
        });
        assert.equal(response.status, 201);
        assert.equal(state.users[0].role, "WORKER");
        assert.equal(state.users[0].login_method, "EMAIL");
        assert.equal(state.users[0].email_verified, false);
    } finally {
        await api.close();
    }
});

test("EMAIL-policy accounts cannot use phone or unverified email; verified email succeeds", async () => {
    const api = await createApi();
    try {
        const registration = await api.request("/register", {
            full_name: "New Worker",
            email: "new@example.com",
            phone: "07000000001",
            password: "secure-password",
            occupation: "OTHER_INFORMAL_WORKER",
        });
        assert.equal(registration.status, 201);

        const phoneLogin = await api.request("/login", {
            identifier: "07000000001",
            password: "secure-password",
        });
        const unverifiedEmailLogin = await api.request("/login", {
            identifier: "new@example.com",
            password: "secure-password",
        });
        assert.equal(phoneLogin.status, 401);
        assert.equal(unverifiedEmailLogin.status, 401);
        assert.equal((await phoneLogin.json()).message, (await unverifiedEmailLogin.json()).message);

        const token = [...state.tokens.values()][0];
        const rawToken = `secure-verification-token-1-long-enough-x`;
        const verified = await api.request("/email/verify", { token: rawToken });
        assert.equal(verified.status, 200);
        assert.equal(state.users[0].email_verified, true);

        const emailLogin = await api.request("/login", {
            identifier: " NEW@example.com ",
            password: "secure-password",
        });
        assert.equal(emailLogin.status, 200);
        assert.equal((await emailLogin.json()).data.user.role, "WORKER");
        assert.equal(token.consumed, true);
        const verifiedPhoneLogin = await api.request("/login", {
            identifier: "07000000001",
            password: "secure-password",
        });
        assert.equal(verifiedPhoneLogin.status, 401);
    } finally {
        await api.close();
    }
});

test("a missing login column is logged safely while the public error remains generic", async () => {
    const api = await createApi();
    const originalConsoleError = console.error;
    const diagnostics = [];
    console.error = (...args) => diagnostics.push(args);
    try {
        state.failLoginLookup = true;
        const response = await api.request("/login", {
            identifier: `diagnostic-${Date.now()}`,
            password: "not-a-real-account-password",
        });
        assert.equal(response.status, 500);
        assert.equal((await response.json()).message, "Login failed due to a server error");
        assert.deepEqual(state.loginQueryFailure, { code: "42703", missingColumn: "failed_login_attempts" });
        assert.equal(state.passwordCompareCount, 0);
        assert.equal(diagnostics[0][0], "Login failed:");
        assert.equal(diagnostics[0][1], 'column "failed_login_attempts" does not exist');
    } finally {
        console.error = originalConsoleError;
        await api.close();
    }
});

test("legacy PHONE-policy accounts keep phone login and public resend remains generic after delivery failure", async () => {
    const api = await createApi();
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        state.users.push({
            user_id: "legacy-user",
            full_name: "Legacy User",
            phone: "07000000009",
            email: "legacy@example.com",
            password_hash: "hashed:legacy-password",
            role: "WORKER",
            occupation: null,
            login_method: "PHONE",
            email_verified: true,
            pending_email: null,
            auth_version: 0,
            account_status: "ACTIVE",
        });
        const legacyLogin = await api.request("/login", {
            identifier: "07000000009",
            password: "legacy-password",
        });
        assert.equal(legacyLogin.status, 200);
        const legacyEmailLogin = await api.request("/login", {
            identifier: "legacy@example.com",
            password: "legacy-password",
        });
        assert.equal(legacyEmailLogin.status, 200);

        state.failNextDelivery = true;
        const request = await api.request("/register", {
            full_name: "New Worker",
            email: "new@example.com",
            phone: "07000000010",
            password: "secure-password",
            occupation: "OTHER_INFORMAL_WORKER",
        });
        assert.equal(request.status, 201);
        assert.equal((await request.clone().json()).data.verificationEmailSent, false);
        assert.equal(state.users.length, 2);
        const newUser = state.users.find(({ email }) => email === "new@example.com");
        assert.equal(newUser.email_verified, false);
        assert.equal(newUser.login_method, "EMAIL");
        const retryRegistration = await api.request("/register", {
            full_name: "New Worker",
            email: "new@example.com",
            phone: "07000000011",
            password: "secure-password",
            occupation: "OTHER_INFORMAL_WORKER",
        });
        assert.equal(retryRegistration.status, 409);
        assert.equal(state.users.length, 2);

        state.failNextDelivery = true;
        const resendExisting = await api.request("/email/verification-request/public", { email: "new@example.com" });
        const resendMissing = await api.request("/email/verification-request/public", { email: "missing@example.com" });
        assert.equal(resendExisting.status, 200);
        assert.equal(resendMissing.status, 200);
        assert.equal((await resendExisting.json()).message, (await resendMissing.json()).message);
        assert.equal(state.users.length, 2);
        assert.equal(state.emailAttempts.at(-1).email, "new@example.com");
    } finally {
        console.error = originalConsoleError;
        await api.close();
    }
});
