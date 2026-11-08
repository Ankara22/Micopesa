const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const pool = require("../src/db/database");
const authController = require("../src/controllers/authController");
const { requireAuth } = require("../src/middleware/authMiddleware");
const authEmailService = require("../src/services/authEmailService");
const { verifyTokenString } = require("../src/utils/token");

process.env.JWT_SECRET ||= "micopesa-auth-recovery-test-secret";

const originalQuery = pool.query;
const originalConnect = pool.connect;
const originalHash = bcrypt.hash;
const originalCompare = bcrypt.compare;
const originalIssueEmailToken = authEmailService.issueEmailToken;
const originalEnforceRequestLimits = authEmailService.enforceRequestLimits;
const originalSendEmail = authEmailService.sendEmail;
const originalLogEmailDeliveryFailure = authEmailService.logEmailDeliveryFailure;
const originalCreateTransport = nodemailer.createTransport;
const originalEnv = {
    JWT_SECRET: process.env.JWT_SECRET,
    FRONTEND_BASE_URL: process.env.FRONTEND_BASE_URL,
    GMAIL_USER: process.env.GMAIL_USER,
    GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD,
    NODE_ENV: process.env.NODE_ENV,
};
const adminSettingsRows = [
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

after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    bcrypt.hash = originalHash;
    bcrypt.compare = originalCompare;
    authEmailService.issueEmailToken = originalIssueEmailToken;
    authEmailService.enforceRequestLimits = originalEnforceRequestLimits;
    authEmailService.sendEmail = originalSendEmail;
    authEmailService.logEmailDeliveryFailure = originalLogEmailDeliveryFailure;
    nodemailer.createTransport = originalCreateTransport;
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

test("legacy phone/password login remains available when the stored email is unverified", async () => {
    let queryValues;
    pool.query = async (query, values) => {
        if (query.includes("SELECT setting_key, setting_value")) return { rows: adminSettingsRows };
        if (query.includes("SET failed_login_attempts = 0")) return { rows: [] };
        queryValues = values;
        return { rows: [{
            user_id: "legacy-user",
            full_name: "Legacy User",
            phone: "07000000001",
            email: "legacy@example.com",
            email_verified: false,
            password_hash: "legacy-hash",
            role: "WORKER",
            account_status: "ACTIVE",
            auth_version: 0,
        }] };
    };
    bcrypt.compare = async (password, hash) => password === "existing-password" && hash === "legacy-hash";

    const res = response();
    await authController.login({ body: { phone: "07000000001", password: "existing-password" } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(queryValues[0], "07000000001");
    assert.equal(res.body.data.user.email_verified, false);
    assert.equal(verifyTokenString(res.body.data.token).role, "WORKER");
});

test("only verified email identifiers are used and the database role is signed at login", async () => {
    let requestedIdentifier;
    pool.query = async (query, values) => {
        if (query.includes("SELECT setting_key, setting_value")) return { rows: adminSettingsRows };
        if (query.includes("SET failed_login_attempts = 0")) return { rows: [] };
        requestedIdentifier = values[1];
        return { rows: [{
            user_id: "changed-role-user",
            full_name: "Changed Role",
            phone: "07000000002",
            email: "user@example.com",
            email_verified: true,
            password_hash: "stored-hash",
            role: "WORKER",
            account_status: "ACTIVE",
            auth_version: 4,
        }] };
    };
    bcrypt.compare = async () => true;
    const res = response();
    await authController.login({
        body: { identifier: "  USER@Example.COM ", password: "current-password" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(requestedIdentifier, "user@example.com");
    assert.equal(verifyTokenString(res.body.data.token).role, "WORKER");
    assert.equal(verifyTokenString(res.body.data.token).authVersion, 4);
});

test("unverified email cannot be used as a login identifier", async () => {
    pool.query = async (_query, values) => {
        assert.deepEqual(values, ["LEGACY@example.com", "legacy@example.com", null]);
        return { rows: [] };
    };
    const res = response();
    await authController.login({
        body: { identifier: "LEGACY@example.com", password: "existing-password" },
    }, res);
    assert.equal(res.statusCode, 401);
    assert.match(res.body.message, /Invalid phone number or password/);
});

test("a verified changed phone logs in to the same account with the existing password", async () => {
    let loginQuery;
    let loginValues;
    pool.query = async (query, values) => {
        if (query.includes("SELECT setting_key, setting_value")) return { rows: adminSettingsRows };
        if (query.includes("SET failed_login_attempts = 0")) return { rows: [] };
        loginQuery = query;
        loginValues = values;
        return { rows: [{
            user_id: "same-admin-id",
            full_name: "Existing Admin",
            phone: "+254712345678",
            phone_verified_at: new Date("2026-11-05T00:00:00.000Z"),
            email: "admin@example.com",
            email_verified: true,
            password_hash: "unchanged-password-hash",
            role: "ADMIN",
            account_status: "ACTIVE",
            auth_version: 7,
        }] };
    };
    bcrypt.compare = async (password, hash) =>
        password === "existing-password" && hash === "unchanged-password-hash";

    const res = response();
    await authController.login({
        body: { identifier: "0712 345 678", password: "existing-password" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(loginValues[2], "+254712345678");
    assert.match(loginQuery, /phone_verified_at IS NOT NULL/);
    assert.equal(res.body.data.user.user_id, "same-admin-id");
    assert.equal(res.body.data.user.phone, "+254712345678");
    assert.equal(res.body.data.user.role, "ADMIN");
    assert.equal(verifyTokenString(res.body.data.token).userId, "same-admin-id");
    assert.equal(verifyTokenString(res.body.data.token).role, "ADMIN");
    assert.equal(verifyTokenString(res.body.data.token).authVersion, 7);
});

test("password-reset requests return the same public response for missing, unverified, and verified accounts", async () => {
    const issued = [];
    authEmailService.enforceRequestLimits = async () => {};
    authEmailService.issueEmailToken = async (input) => { issued.push(input); };
    pool.query = async (query, values) => {
        assert.match(query, /email_verified IS TRUE/);
        assert.match(query, /account_status = 'ACTIVE'/);
        return {
            rows: values[0] === "verified@example.com"
                ? [{ user_id: "verified-user", email: "verified@example.com" }]
                : [],
        };
    };

    const results = [];
    for (const email of ["missing@example.com", "unverified@example.com", "verified@example.com"]) {
        const res = response();
        await authController.requestPasswordReset({ body: { email }, ip: "127.0.0.1" }, res);
        results.push([res.statusCode, res.body.message]);
    }
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[1], results[2]);
    assert.equal(issued.length, 1);
    assert.equal(issued[0].purpose, "PASSWORD_RESET");
});

test("password-reset rate limits apply before account lookup", async () => {
    let lookedUpAccount = false;
    authEmailService.enforceRequestLimits = async () => {
        const error = new Error("Too many requests. Please try again later.");
        error.status = 429;
        throw error;
    };
    pool.query = async () => {
        lookedUpAccount = true;
        return { rows: [] };
    };
    const res = response();
    await authController.requestPasswordReset({
        body: { email: "person@example.com" },
        ip: "127.0.0.1",
    }, res);
    assert.equal(res.statusCode, 429);
    assert.equal(lookedUpAccount, false);
});

test("expired and reused reset tokens are rejected without changing the password", async () => {
    let updateCount = 0;
    bcrypt.hash = async () => "hashed:new-password";
    pool.connect = async () => ({
        async query(query) {
            if (query === "BEGIN" || query === "ROLLBACK") return { rows: [] };
            if (query.includes("FROM auth_tokens")) {
                assert.match(query, /consumed_at IS NULL/);
                assert.match(query, /expires_at > now\(\)/);
                return { rows: [] };
            }
            if (query.includes("UPDATE users")) updateCount += 1;
            return { rows: [] };
        },
        release() {},
    });
    for (const token of ["a".repeat(43), "b".repeat(43)]) {
        const res = response();
        await authController.resetPassword({ body: { token, password: "new-password" } }, res);
        assert.equal(res.statusCode, 400);
        assert.match(res.body.message, /invalid or expired/i);
    }
    assert.equal(updateCount, 0);
});

test("a valid reset is single-use, changes the password, and invalidates prior access tokens", async () => {
    const token = "unit-test-reset-token-with-enough-entropy";
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const state = {
        passwordHash: "hashed:old-password",
        authVersion: 0,
        consumed: false,
        email: "verified@example.com",
    };
    bcrypt.hash = async (password) => `hashed:${password}`;
    bcrypt.compare = async (password, hash) => hash === `hashed:${password}`;
    authEmailService.sendEmail = async () => {};
    pool.connect = async () => ({
        async query(query, values = []) {
            if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
            if (query.includes("FROM auth_tokens")) {
                assert.match(query, /consumed_at IS NULL/);
                assert.match(query, /expires_at > now\(\)/);
                return values[0] === tokenHash && !state.consumed
                    ? { rows: [{ auth_token_id: 1, user_id: "user-1", email_address: state.email }] }
                    : { rows: [] };
            }
            if (query.includes("UPDATE users")) {
                state.passwordHash = values[0];
                state.authVersion += 1;
                return { rows: [{ user_id: "user-1" }] };
            }
            if (query.includes("UPDATE auth_tokens")) {
                state.consumed = true;
                return { rows: [] };
            }
            assert.fail(`Unexpected transaction query: ${query}`);
        },
        release() {},
    });

    const oldToken = require("../src/utils/token").generateToken({
        userId: "user-1",
        role: "WORKER",
        authVersion: 0,
    });
    const res = response();
    await authController.resetPassword({ body: { token, password: "new-password" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(state.passwordHash, "hashed:new-password");
    assert.equal(state.authVersion, 1);
    assert.equal(state.consumed, true);

    const reused = response();
    await authController.resetPassword({ body: { token, password: "another-password" } }, reused);
    assert.equal(reused.statusCode, 400);

    pool.query = async (query) => {
        if (query.includes("SELECT setting_key, setting_value")) return { rows: adminSettingsRows };
        if (query.includes("SET failed_login_attempts = 0")) return { rows: [] };
        return {
        rows: [{
            user_id: "user-1",
            full_name: "User",
            phone: "07000000001",
            email: state.email,
            email_verified: true,
            password_hash: state.passwordHash,
            role: "WORKER",
            account_status: "ACTIVE",
            auth_version: state.authVersion,
        }],
        };
    };
    const oldPasswordLogin = response();
    await authController.login({ body: { phone: "07000000001", password: "old-password" } }, oldPasswordLogin);
    assert.equal(oldPasswordLogin.statusCode, 401);
    const newPasswordLogin = response();
    await authController.login({ body: { phone: "07000000001", password: "new-password" } }, newPasswordLogin);
    assert.equal(newPasswordLogin.statusCode, 200);
    assert.notEqual(verifyTokenString(oldToken).authVersion, state.authVersion);

    let nextCalled = false;
    const invalidatedSession = response();
    await requireAuth({
        headers: { authorization: `Bearer ${oldToken}` },
    }, invalidatedSession, () => { nextCalled = true; });
    assert.equal(invalidatedSession.statusCode, 401);
    assert.equal(nextCalled, false);
});

test("email verification transfers a pending address only once", async () => {
    const token = "unit-test-email-verification-token-long-enough";
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const state = {
        email: "legacy@example.com",
        pendingEmail: "new@example.com",
        verified: false,
        consumed: false,
        updateCount: 0,
    };
    pool.connect = async () => ({
        async query(query, values = []) {
            if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
            if (query.includes("FROM auth_tokens")) {
                return values[0] === tokenHash && !state.consumed
                    ? { rows: [{ auth_token_id: 7, user_id: "user-1", email_address: state.pendingEmail }] }
                    : { rows: [] };
            }
            if (query.includes("UPDATE users")) {
                state.updateCount += 1;
                state.email = state.pendingEmail;
                state.pendingEmail = null;
                state.verified = true;
                return { rows: [{ user_id: "user-1" }] };
            }
            if (query.includes("UPDATE auth_tokens")) {
                state.consumed = true;
                return { rows: [] };
            }
            assert.fail(`Unexpected transaction query: ${query}`);
        },
        release() {},
    });

    const res = response();
    await authController.verifyEmail({ body: { token } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(state.email, "new@example.com");
    assert.equal(state.pendingEmail, null);
    assert.equal(state.verified, true);
    assert.equal(state.consumed, true);

    const reused = response();
    await authController.verifyEmail({ body: { token } }, reused);
    assert.equal(reused.statusCode, 400);
    assert.equal(state.updateCount, 1);
});

test("email-verification conflicts do not disclose that another account owns the address", async () => {
    const token = "unit-test-email-verification-conflict-token";
    pool.connect = async () => ({
        async query(query) {
            if (query === "BEGIN" || query === "ROLLBACK") return { rows: [] };
            if (query.includes("FROM auth_tokens")) {
                return { rows: [{ auth_token_id: 8, user_id: "user-1", email_address: "claimed@example.com" }] };
            }
            if (query.includes("UPDATE users")) {
                const error = new Error("unique violation");
                error.code = "23505";
                throw error;
            }
            assert.fail(`Unexpected transaction query: ${query}`);
        },
        release() {},
    });

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        const res = response();
        await authController.verifyEmail({ body: { token } }, res);
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.message, "This verification link is invalid or expired.");
        assert.doesNotMatch(res.body.message, /already in use|claimed@example\.com/i);
    } finally {
        console.error = originalConsoleError;
    }
});

test("verification email tokens are random, hashed at rest, time-limited, and use the trusted frontend URL", async () => {
    process.env.FRONTEND_BASE_URL = "https://frontend.example.test";
    process.env.GMAIL_USER = "noreply@gmail.com";
    process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
    process.env.NODE_ENV = "test";
    const statements = [];
    let sentMessage;
    const originalConsoleInfo = console.info;
    pool.query = async (query, values) => {
        statements.push({ query, values });
        return { rows: [] };
    };
    nodemailer.createTransport = () => ({
        sendMail: async (message) => {
            sentMessage = message;
            return { accepted: [message.to], rejected: [], messageId: "mock-smtp-message-id" };
        },
    });

    try {
        authEmailService.issueEmailToken = originalIssueEmailToken;
        authEmailService.sendEmail = originalSendEmail;
        console.info = () => {};
        await authEmailService.issueEmailToken({
            userId: "user-1",
            email: "new@example.com",
            purpose: "EMAIL_VERIFICATION",
        });
        assert.equal(sentMessage.to, "new@example.com");
        assert.equal(sentMessage.from, "noreply@gmail.com");
        const link = new URL(sentMessage.text.match(/https:\/\/\S+/)[0]);
        assert.equal(link.origin, "https://frontend.example.test");
        const rawToken = link.searchParams.get("token");
        assert.ok(rawToken && rawToken.length >= 40);
        assert.ok(statements.some(({ query, values }) =>
            query.includes("INSERT INTO auth_tokens") &&
            values[3] === crypto.createHash("sha256").update(rawToken).digest("hex") &&
            values[3] !== rawToken
        ));
        const insert = statements.find(({ query }) => query.includes("INSERT INTO auth_tokens"));
        assert.match(insert.query, /interval '1 minute'/);
        assert.equal(insert.values[4], 30);
    } finally {
        console.info = originalConsoleInfo;
        nodemailer.createTransport = originalCreateTransport;
    }
});

test("public verification resend remains generic when SMTP fails and never creates another account", async () => {
    const originalLimits = authEmailService.enforceRequestLimits;
    const originalIssue = authEmailService.issueEmailToken;
    const originalLogger = authEmailService.logEmailDeliveryFailure;
    const originalQueryForResend = pool.query;
    const issued = [];
    const logged = [];
    authEmailService.enforceRequestLimits = async () => {};
    authEmailService.issueEmailToken = async (input) => {
        issued.push(input);
        throw Object.assign(new Error("SMTP authentication failed"), { code: "EAUTH", responseCode: 535 });
    };
    authEmailService.logEmailDeliveryFailure = (purpose, error) => logged.push([purpose, error.code]);
    pool.query = async (_query, values) => ({
        rows: values[0] === "unverified@example.com"
            ? [{ user_id: "existing-user", email: "unverified@example.com" }]
            : [],
    });

    try {
        const responses = [];
        for (const email of ["unknown@example.com", "unverified@example.com"]) {
            const res = response();
            await authController.requestPublicEmailVerification(
                { body: { email }, ip: "127.0.0.1" },
                res,
            );
            responses.push([res.statusCode, res.body.message]);
        }
        assert.deepEqual(responses[0], responses[1]);
        assert.equal(responses[0][0], 200);
        assert.equal(issued.length, 1);
        assert.equal(issued[0].purpose, "EMAIL_VERIFICATION");
        assert.deepEqual(logged, [["EMAIL_VERIFICATION", "EAUTH"]]);
    } finally {
        authEmailService.enforceRequestLimits = originalLimits;
        authEmailService.issueEmailToken = originalIssue;
        authEmailService.logEmailDeliveryFailure = originalLogger;
        pool.query = originalQueryForResend;
    }
});

test("forgot-password SMTP failure keeps the public response generic", async () => {
    const originalLimits = authEmailService.enforceRequestLimits;
    const originalIssue = authEmailService.issueEmailToken;
    const originalLogger = authEmailService.logEmailDeliveryFailure;
    const originalQueryForReset = pool.query;
    authEmailService.enforceRequestLimits = async () => {};
    authEmailService.issueEmailToken = async () => {
        throw Object.assign(new Error("SMTP authentication failed"), { code: "EAUTH" });
    };
    authEmailService.logEmailDeliveryFailure = () => {};
    pool.query = async () => ({
        rows: [{ user_id: "verified-user", email: "verified@example.com" }],
    });

    try {
        const res = response();
        await authController.requestPasswordReset({
            body: { email: "verified@example.com" },
            ip: "127.0.0.1",
        }, res);
        assert.equal(res.statusCode, 200);
        assert.match(res.body.message, /delivery is not confirmed/i);
        assert.doesNotMatch(res.body.message, /verified@example\.com/);
    } finally {
        authEmailService.enforceRequestLimits = originalLimits;
        authEmailService.issueEmailToken = originalIssue;
        authEmailService.logEmailDeliveryFailure = originalLogger;
        pool.query = originalQueryForReset;
    }
});
