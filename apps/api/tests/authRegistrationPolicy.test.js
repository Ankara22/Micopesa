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
const originalSendPendingRegistrationEmail = authEmailService.sendPendingRegistrationEmail;
const originalEnforceRequestLimits = authEmailService.enforceRequestLimits;
const originalJwtSecret = process.env.JWT_SECRET;
let state;

after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    bcrypt.hash = originalHash;
    bcrypt.compare = originalCompare;
    authEmailService.issueEmailToken = originalIssueEmailToken;
    authEmailService.sendPendingRegistrationEmail = originalSendPendingRegistrationEmail;
    authEmailService.enforceRequestLimits = originalEnforceRequestLimits;
    process.env.JWT_SECRET = originalJwtSecret;
});

function createState() {
    return {
        users: [],
        accounts: [],
        kycRecords: [],
        pendingRegistrations: [],
        tokens: new Map(),
        emailAttempts: [],
        rateLimitAttempts: [],
        failNextDelivery: false,
        failPendingRegistrationInsert: false,
        registrationRollbackCount: 0,
        failKycInsert: false,
        failLoginLookup: false,
        loginQueryFailure: null,
        passwordCompareCount: 0,
        passwordHashAttempts: 0,
        nextId: 1,
    };
}

function configureDb() {
    pool.query = async (query, values = []) => {
        if (query.includes("DELETE FROM pending_registrations WHERE token_hash")) {
            state.pendingRegistrations = state.pendingRegistrations.filter(
                ({ token_hash: tokenHash }) => tokenHash !== values[0]
            );
            return { rows: [] };
        }
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
                    state.accounts = snapshot.accounts;
                    state.kycRecords = snapshot.kycRecords;
                    state.pendingRegistrations = snapshot.pendingRegistrations;
                    state.tokens = snapshot.tokens;
                    state.nextId = snapshot.nextId;
                    state.registrationRollbackCount += 1;
                    return { rows: [] };
                }
                if (query.includes("DELETE FROM pending_registrations WHERE expires_at")) {
                    return { rows: [] };
                }
                if (query.includes("INSERT INTO pending_registrations")) {
                    if (state.failPendingRegistrationInsert) {
                        throw Object.assign(new Error("synthetic pending insert failure"), { code: "23514" });
                    }
                    state.pendingRegistrations.push({
                        pending_registration_id: `pending-${state.nextId++}`,
                        full_name: values[0],
                        email: values[1],
                        phone: values[2],
                        password_hash: null,
                        occupation: values[3],
                        national_id: values[4],
                        date_of_birth: values[5],
                        token_hash: values[6],
                        expires_at: new Date(Date.now() + 30 * 60 * 1000),
                    });
                    return { rows: [] };
                }
                if (query.includes("FROM pending_registrations") && query.includes("FOR UPDATE")) {
                    const registration = state.pendingRegistrations.find((candidate) =>
                        candidate.token_hash === values[0] &&
                        new Date(candidate.expires_at).getTime() > Date.now()
                    );
                    return { rows: registration ? [{ ...registration }] : [] };
                }
                if (query.includes("DELETE FROM pending_registrations WHERE pending_registration_id")) {
                    state.pendingRegistrations = state.pendingRegistrations.filter(
                        ({ pending_registration_id: id }) => id !== values[0]
                    );
                    return { rows: [] };
                }
                if (query.includes("INSERT INTO users")) {
                    const emailVerified = query.includes("email_verified)");
                    const user = {
                        user_id: `new-user-${state.nextId++}`,
                        full_name: values[0],
                        phone: values[1],
                        email: values[2],
                        password_hash: values[3],
                        role: values[4],
                        occupation: values[5],
                        login_method: "EMAIL",
                        email_verified: emailVerified,
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
                if (query.includes("INSERT INTO pension_accounts")) {
                    state.accounts.push({ user_id: values[0] });
                    return { rows: [] };
                }
                if (query.includes("INSERT INTO kyc_records")) {
                    if (state.failKycInsert) {
                        throw Object.assign(new Error("synthetic KYC insert failure"), { code: "XX001" });
                    }
                    const isDuplicate = state.kycRecords.some(({ national_id }) => national_id === values[1]);
                    if (isDuplicate) {
                        for (const record of state.kycRecords.filter(({ national_id }) => national_id === values[1])) {
                            record.duplicate_submission = true;
                        }
                    }
                    state.kycRecords.push({
                        user_id: values[0],
                        national_id: values[1],
                        date_of_birth: values[2],
                        kyc_status: "PENDING",
                        duplicate_submission: isDuplicate,
                    });
                    return { rows: [] };
                }
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
    authEmailService.enforceRequestLimits = async ({ req, action, email }) => {
        state.rateLimitAttempts.push({ ip: req.ip || req.socket?.remoteAddress, action, email });
        if (state.rejectRegistrationRateLimit && action === "REGISTRATION") {
            const error = new Error("Too many requests");
            error.status = 429;
            throw error;
        }
    };
    authEmailService.sendPendingRegistrationEmail = async ({ email, token }) => {
        state.emailAttempts.push({ email, token, purpose: "REGISTRATION_VERIFICATION" });
        if (state.failNextDelivery) {
            state.failNextDelivery = false;
            const error = new Error("mock delivery failure");
            error.code = "EMAIL_SMTP_DELIVERY_FAILED";
            throw error;
        }
    };
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
    bcrypt.hash = async (password) => {
        state.passwordHashAttempts += 1;
        return `hashed:${password}`;
    };
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

test("valid registration attempts return the same acknowledgement for existing identifiers", async () => {
    const api = await createApi();
    try {
        const base = {
            full_name: "New Worker",
            phone: "07000000001",
            password: "secure-password",
            occupation: "OTHER_INFORMAL_WORKER",
            national_id: "12345678",
            date_of_birth: "1990-04-15",
        };
        assert.equal((await api.request("/register", base)).status, 400);
        assert.equal((await api.request("/register", { ...base, email: "not-an-email" })).status, 400);
        assert.equal(state.users.length, 0);

        const first = await api.request("/register", { ...base, email: "  New.User@Example.com " });
        const firstBody = await first.json();
        assert.equal(first.status, 202);
        assert.equal(state.passwordHashAttempts, 0);
        assert.equal(state.pendingRegistrations[0].password_hash, null);
        assert.deepEqual(firstBody, {
            status: "accepted",
            message: "If we can complete your registration, we will send verification instructions to the provided email address.",
        });
        const firstToken = state.emailAttempts[0].token;
        const finalized = await api.request("/email/verify", { token: firstToken, password: "secure-password" });
        assert.equal(finalized.status, 200);
        assert.equal(state.users[0].email, "new.user@example.com");
        assert.equal(state.users[0].email_verified, true);
        assert.equal(state.users[0].login_method, "EMAIL");
        assert.equal(state.users[0].role, "WORKER");
        assert.equal(state.users[0].password_hash, "hashed:secure-password");
        assert.deepEqual(state.kycRecords, [{
            user_id: state.users[0].user_id,
            national_id: "12345678",
            date_of_birth: "1990-04-15",
            kyc_status: "PENDING",
            duplicate_submission: false,
        }]);

        const duplicateEmail = await api.request("/register", {
            ...base,
            phone: "07000000002",
            email: "NEW.USER@example.COM",
            national_id: "12345679",
        });
        const duplicatePhone = await api.request("/register", {
            ...base,
            email: "another@example.com",
            phone: "07000000001",
            national_id: "12345679",
        });
        const duplicateNationalId = await api.request("/register", {
            ...base,
            email: "third@example.com",
            phone: "07000000003",
        });
        for (const response of [duplicateEmail, duplicatePhone, duplicateNationalId]) {
            assert.equal(response.status, 202);
            assert.deepEqual(await response.json(), firstBody);
        }
        const duplicateIdVerification = await api.request("/email/verify", {
            token: state.emailAttempts[3].token,
            password: "another-secure-password",
        });
        assert.equal(duplicateIdVerification.status, finalized.status);
        assert.deepEqual(await duplicateIdVerification.json(), await finalized.clone().json());
        assert.equal(state.users.length, 2);
        assert.equal(state.accounts.length, 2);
        assert.equal(state.kycRecords.length, 2);
        assert.equal(state.kycRecords.every((record) => record.kyc_status === "PENDING"), true);
        assert.equal(state.kycRecords.every((record) => record.duplicate_submission === true), true);
        assert.equal(state.pendingRegistrations.length, 2);
        assert.equal(state.emailAttempts.length, 4);
        assert.equal(state.rateLimitAttempts.length, 4);
        assert.ok(state.emailAttempts.every(({ purpose }) => purpose === "REGISTRATION_VERIFICATION"));
    } finally {
        await api.close();
    }
});

test("invalid, expired, and consumed registration tokens cannot create accounts", async () => {
    const api = await createApi();
    try {
        const invalid = await api.request("/email/verify", {
            token: "invalid-token-value-that-is-long-enough-to-pass-format-check",
            password: "secure-password",
        });
        assert.equal(invalid.status, 400);

        const accepted = await api.request("/register", {
            full_name: "New Worker",
            email: "new@example.com",
            phone: "07000000001",
            occupation: "OTHER_INFORMAL_WORKER",
            national_id: "12345678",
            date_of_birth: "1990-04-15",
        });
        assert.equal(accepted.status, 202);
        const token = state.emailAttempts[0].token;
        const missingPassword = await api.request("/email/verify", { token });
        assert.equal(missingPassword.status, 400);
        const missingPasswordBody = await missingPassword.json();
        assert.equal(missingPasswordBody.token, undefined);
        assert.equal(missingPasswordBody.data, undefined);
        assert.equal(state.users.length, 0);
        assert.equal(state.accounts.length, 0);
        assert.equal(state.kycRecords.length, 0);
        state.pendingRegistrations[0].expires_at = new Date(Date.now() - 1);
        const expired = await api.request("/email/verify", { token, password: "secure-password" });
        assert.equal(expired.status, 400);
        assert.equal(state.users.length, 0);

        state.pendingRegistrations[0].expires_at = new Date(Date.now() + 30 * 60 * 1000);
        const verified = await api.request("/email/verify", { token, password: "secure-password" });
        assert.equal(verified.status, 200);
        const consumed = await api.request("/email/verify", { token, password: "secure-password" });
        assert.equal(consumed.status, 400);
        assert.equal(state.users.length, 1);
        assert.equal(state.accounts.length, 1);
        assert.equal(state.kycRecords.length, 1);
    } finally {
        await api.close();
    }
});

test("rate-limited and email-delivery-failed valid submissions retain the generic acknowledgement", async () => {
    const api = await createApi();
    const originalConsoleError = console.error;
    const diagnostics = [];
    console.error = (...args) => diagnostics.push(args);
    try {
        const details = {
            full_name: "New Worker",
            email: "new@example.com",
            phone: "07000000001",
            password: "secure-password",
            occupation: "OTHER_INFORMAL_WORKER",
            national_id: "12345678",
            date_of_birth: "1990-04-15",
        };
        const first = await api.request("/register", details);
        const acceptedBody = await first.json();
        assert.equal(first.status, 202);

        state.rejectRegistrationRateLimit = true;
        const rateLimited = await api.request("/register", {
            ...details,
            email: "rate-limited@example.com",
            phone: "07000000002",
            national_id: "12345679",
        });
        assert.equal(rateLimited.status, 202);
        assert.deepEqual(await rateLimited.json(), acceptedBody);
        assert.equal(state.emailAttempts.length, 1);
        assert.equal(state.pendingRegistrations.length, 1);

        state.rejectRegistrationRateLimit = false;
        state.failNextDelivery = true;
        const deliveryFailed = await api.request("/register", {
            ...details,
            email: "delivery-failed@example.com",
            phone: "07000000003",
            national_id: "12345670",
        });
        assert.equal(deliveryFailed.status, 202);
        assert.deepEqual(await deliveryFailed.json(), acceptedBody);
        assert.equal(state.pendingRegistrations.length, 2);
        assert.deepEqual(state.rateLimitAttempts.map(({ action }) => action), [
            "REGISTRATION",
            "REGISTRATION",
            "REGISTRATION",
        ]);
        assert.doesNotMatch(JSON.stringify(diagnostics), /new@example\.com|12345678|1990-04-15|secure-password/);
        assert.deepEqual(diagnostics[0], ["Registration verification delivery failed.", {
            code: "EMAIL_SMTP_DELIVERY_FAILED",
        }]);
    } finally {
        console.error = originalConsoleError;
        await api.close();
    }
});

test("pending registration insert failure rolls back the transaction without logging personal details", async () => {
    const api = await createApi();
    const originalConsoleError = console.error;
    const diagnostics = [];
    console.error = (...args) => diagnostics.push(args);
    try {
        state.failPendingRegistrationInsert = true;
        const response = await api.request("/register", {
            full_name: "Synthetic Worker",
            email: "synthetic-worker@example.test",
            phone: "07000000001",
            password: "synthetic-password",
            occupation: "OTHER_INFORMAL_WORKER",
            national_id: "12345678",
            date_of_birth: "1990-04-15",
        });

        assert.equal(response.status, 500);
        assert.equal(state.registrationRollbackCount, 1);
        assert.equal(state.pendingRegistrations.length, 0);
        assert.equal(state.users.length, 0);
        assert.equal(state.accounts.length, 0);
        assert.equal(state.kycRecords.length, 0);
        assert.deepEqual(diagnostics, [["Registration failed:", { code: "23514" }]]);
        assert.doesNotMatch(JSON.stringify(diagnostics), /synthetic-worker|07000000001|12345678|1990-04-15|synthetic-password/);
    } finally {
        console.error = originalConsoleError;
        await api.close();
    }
});

test("registration validates National ID, calendar date, and worker age without writing records", async () => {
    const api = await createApi();
    try {
        const base = {
            full_name: "New Worker",
            email: "new@example.com",
            phone: "07000000001",
            password: "secure-password",
            occupation: "OTHER_INFORMAL_WORKER",
            national_id: "12345678",
            date_of_birth: "1990-04-15",
        };
        const invalidId = await api.request("/register", { ...base, national_id: "123456" });
        assert.equal(invalidId.status, 400);
        assert.equal((await invalidId.json()).code, "INVALID_NATIONAL_ID");

        const invalidDate = await api.request("/register", { ...base, date_of_birth: "2001-02-29" });
        assert.equal(invalidDate.status, 400);
        assert.equal((await invalidDate.json()).code, "INVALID_DATE_OF_BIRTH");

        for (const date_of_birth of ["2010-01-01", "1900-01-01"]) {
            const response = await api.request("/register", { ...base, date_of_birth });
            assert.equal(response.status, 400);
            assert.equal((await response.json()).code, "WORKER_AGE_OUT_OF_RANGE");
        }

        assert.equal(state.users.length, 0);
        assert.equal(state.accounts.length, 0);
        assert.equal(state.kycRecords.length, 0);
        assert.equal(state.emailAttempts.length, 0);
    } finally {
        await api.close();
    }
});

test("registration accepts workers at the inclusive 18 and 60 year age limits after verification", async () => {
    const api = await createApi();
    try {
        const now = new Date();
        const birthDateForAge = (age) => {
            const date = new Date(Date.UTC(now.getUTCFullYear() - age, now.getUTCMonth(), now.getUTCDate()));
            return date.toISOString().slice(0, 10);
        };
        for (const [index, age] of [18, 60].entries()) {
            const response = await api.request("/register", {
                full_name: "Eligible Worker",
                email: `eligible-${age}@example.com`,
                phone: `0700000000${index + 1}`,
                password: "secure-password",
                occupation: "OTHER_INFORMAL_WORKER",
                national_id: index === 0 ? "12345678" : "12345679",
                date_of_birth: birthDateForAge(age),
            });
            assert.equal(response.status, 202);
            const token = state.emailAttempts[index].token;
            assert.equal((await api.request("/email/verify", {
                token,
                password: "secure-password",
            })).status, 200);
        }
        assert.equal(state.users.length, 2);
        assert.equal(state.kycRecords.length, 2);
    } finally {
        await api.close();
    }
});

test("duplicate National IDs reach the same pending account state without an auth token", async () => {
    const api = await createApi();
    try {
        const details = {
            full_name: "New Worker",
            email: "new@example.com",
            phone: "07000000001",
            password: "secure-password",
            occupation: "OTHER_INFORMAL_WORKER",
            national_id: "12345678",
            date_of_birth: "1990-04-15",
        };
        const first = await api.request("/register", details);
        assert.equal(first.status, 202);
        const acceptedBody = await first.json();
        const firstVerification = await api.request("/email/verify", {
            token: state.emailAttempts[0].token,
            password: "secure-password",
        });
        const firstVerificationBody = await firstVerification.json();
        assert.equal(firstVerification.status, 200);
        assert.equal(firstVerificationBody.data, undefined);
        assert.equal(firstVerificationBody.token, undefined);
        const duplicate = await api.request("/register", {
            ...details,
            email: "another@example.com",
            phone: "07000000002",
        });
        assert.equal(duplicate.status, 202);
        assert.deepEqual(await duplicate.json(), acceptedBody);
        const completion = await api.request("/email/verify", {
            token: state.emailAttempts[1].token,
            password: "another-secure-password",
        });
        const body = await completion.json();
        assert.equal(completion.status, 200);
        assert.deepEqual(body, firstVerificationBody);
        assert.doesNotMatch(JSON.stringify(body), /12345678|uq_kyc_records_national_id|duplicate|National ID/i);
        assert.equal(state.users.length, 2);
        assert.equal(state.accounts.length, 2);
        assert.equal(state.kycRecords.length, 2);
        assert.equal(state.kycRecords.every((record) => record.kyc_status === "PENDING"), true);
        assert.equal(state.kycRecords.some((record) => record.duplicate_submission === true), true);
        assert.equal(state.pendingRegistrations.length, 0);
        assert.equal(state.emailAttempts.length, 2);
    } finally {
        await api.close();
    }
});

test("KYC insert failure rolls back final account creation without logging personal details", async () => {
    const api = await createApi();
    const originalConsoleError = console.error;
    const diagnostics = [];
    console.error = (...args) => diagnostics.push(args);
    try {
        const accepted = await api.request("/register", {
            full_name: "New Worker",
            email: "new@example.com",
            phone: "07000000001",
            password: "secure-password",
            occupation: "OTHER_INFORMAL_WORKER",
            national_id: "12345678",
            date_of_birth: "1990-04-15",
        });
        assert.equal(accepted.status, 202);
        state.failKycInsert = true;
        const response = await api.request("/email/verify", {
            token: state.emailAttempts[0].token,
            password: "secure-password",
        });
        assert.equal(response.status, 500);
        assert.equal((await response.json()).message, "Unable to verify this email address right now.");
        assert.equal(state.users.length, 0);
        assert.equal(state.accounts.length, 0);
        assert.equal(state.kycRecords.length, 0);
        assert.equal(state.pendingRegistrations.length, 1);
        assert.equal(state.emailAttempts.length, 1);
        assert.doesNotMatch(JSON.stringify(diagnostics), /12345678|1990-04-15|password123/);
        assert.deepEqual(diagnostics[0], ["Email verification failed:", "XX001"]);
    } finally {
        console.error = originalConsoleError;
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
            national_id: "12345678",
            date_of_birth: "1990-04-15",
            role: "ADMIN",
            login_method: "PHONE",
        });
        assert.equal(response.status, 202);
        assert.equal(state.users.length, 0);
        assert.equal(state.pendingRegistrations[0].occupation, "OTHER_INFORMAL_WORKER");
        assert.equal((await api.request("/email/verify", {
            token: state.emailAttempts[0].token,
            password: "secure-password",
        })).status, 200);
        assert.equal(state.users[0].role, "WORKER");
        assert.equal(state.users[0].login_method, "EMAIL");
        assert.equal(state.users[0].email_verified, true);
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
            national_id: "12345678",
            date_of_birth: "1990-04-15",
        });
        assert.equal(registration.status, 202);
        const preVerificationLogin = await api.request("/login", {
            identifier: "new@example.com",
            password: "secure-password",
        });
        assert.equal(preVerificationLogin.status, 401);

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

        const verified = await api.request("/email/verify", {
            token: state.emailAttempts[0].token,
            password: "secure-password",
        });
        assert.equal(verified.status, 200);
        assert.equal(state.users[0].email_verified, true);

        const emailLogin = await api.request("/login", {
            identifier: " NEW@example.com ",
            password: "secure-password",
        });
        assert.equal(emailLogin.status, 200);
        assert.equal((await emailLogin.json()).data.user.role, "WORKER");
        assert.equal(state.pendingRegistrations.length, 0);
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
            national_id: "12345678",
            date_of_birth: "1990-04-15",
        });
        assert.equal(request.status, 202);
        const acceptedBody = await request.json();
        assert.equal(state.users.length, 1);
        assert.equal(state.pendingRegistrations.length, 1);
        const retryRegistration = await api.request("/register", {
            full_name: "New Worker",
            email: "new@example.com",
            phone: "07000000011",
            password: "secure-password",
            occupation: "OTHER_INFORMAL_WORKER",
            national_id: "12345679",
            date_of_birth: "1990-04-15",
        });
        assert.equal(retryRegistration.status, 202);
        assert.deepEqual(await retryRegistration.json(), acceptedBody);
        assert.equal(state.users.length, 1);
        assert.equal(state.pendingRegistrations.length, 2);

        state.failNextDelivery = true;
        const resendExisting = await api.request("/email/verification-request/public", { email: "new@example.com" });
        const resendMissing = await api.request("/email/verification-request/public", { email: "missing@example.com" });
        assert.equal(resendExisting.status, 200);
        assert.equal(resendMissing.status, 200);
        assert.equal((await resendExisting.json()).message, (await resendMissing.json()).message);
        assert.equal(state.users.length, 1);
        assert.equal(state.emailAttempts.at(-1).email, "new@example.com");
    } finally {
        console.error = originalConsoleError;
        await api.close();
    }
});
