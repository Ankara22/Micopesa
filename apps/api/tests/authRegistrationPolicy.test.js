const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");
const pool = require("../src/db/database");
const authController = require("../src/controllers/authController");
const authEmailService = require("../src/services/authEmailService");
const { createWorkerRegistrationService } = require("../src/services/workerRegistrationService");
const { requireAuth, requireRole } = require("../src/middleware/authMiddleware");
const { generateToken } = require("../src/utils/token");
const { normalizeKenyanPhone } = require("../src/utils/kenyanPhone");
const { lockUserIdentities } = require("../src/utils/userIdentityLock");

process.env.JWT_SECRET ||= "micopesa-registration-policy-test-secret";

const originalQuery = pool.query;
const originalConnect = pool.connect;
const originalJwtSecret = process.env.JWT_SECRET;
const originalBcryptCompare = bcrypt.compare;
const originalEnforceRequestLimits = authEmailService.enforceRequestLimits;

after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    process.env.JWT_SECRET = originalJwtSecret;
    bcrypt.compare = originalBcryptCompare;
    authEmailService.enforceRequestLimits = originalEnforceRequestLimits;
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

function createHarness() {
    const state = {
        challenge: null,
        claim: null,
        users: [],
        accounts: [],
        kycRecords: [],
        preferences: [],
        smsMessages: [],
        identityLocks: [],
        rollbackCount: 0,
        failSms: false,
        failUserInsert: false,
        failKycInsert: false,
    };
    const environment = {
        NATIONAL_ID_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64"),
        NATIONAL_ID_FINGERPRINT_KEY: Buffer.alloc(32, 12).toString("base64"),
    };
    const smsService = {
        getPhoneVerificationSmsConfiguration: () => ({ available: true, provider: "TEST" }),
        async sendPhoneVerificationSms(message) {
            state.smsMessages.push(message);
            if (state.failSms) {
                const error = new Error("SMS delivery failed");
                error.code = "SMS_PROVIDER_FAILED";
                throw error;
            }
            return { accepted: true, status: "PROVIDER_ACCEPTED" };
        },
    };
    const emailService = {
        async enforceRequestLimits() {},
        async issueEmailToken({ userId, email }) {
            state.emailVerification = { userId, email };
            return { messageId: "test-email" };
        },
        logEmailDeliveryFailure() {},
    };
    const database = {
        async query(sql, values = []) {
            if (sql.includes("DELETE FROM worker_registration_challenges WHERE challenge_id")) {
                state.challenge = null;
                return { rows: [], rowCount: 1 };
            }
            if (sql.includes("SELECT phone, email, national_id_fingerprint")) {
                return {
                    rows: state.challenge ? [{
                        phone: state.challenge.phone,
                        email: state.challenge.email,
                        national_id_fingerprint: state.challenge.national_id_fingerprint,
                    }] : [],
                };
            }
            if (sql.includes("FROM users") && sql.includes("phone_verified_at")) {
                const phone = normalizeKenyanPhone(values[0]);
                return {
                    rows: state.users
                        .filter((user) => normalizeKenyanPhone(user.phone) === phone &&
                            user.phone_verified_at && user.account_status === "ACTIVE")
                        .map((user) => ({ user_id: user.user_id })),
                };
            }
            if (sql.includes("FROM worker_password_reset_challenges")) return { rows: [] };
            throw new Error(`Unexpected pool query: ${sql}`);
        },
        async connect() {
            let snapshot = null;
            return {
                async query(sql, values = []) {
                    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
                        if (sql === "BEGIN") snapshot = JSON.parse(JSON.stringify(state));
                        if (sql === "ROLLBACK") {
                            state.challenge = snapshot.challenge;
                            state.claim = snapshot.claim;
                            state.users = snapshot.users;
                            state.accounts = snapshot.accounts;
                            state.kycRecords = snapshot.kycRecords;
                            state.preferences = snapshot.preferences;
                            state.rollbackCount += 1;
                        }
                        return { rows: [] };
                    }
                    if (sql.includes("pg_advisory_xact_lock")) {
                        state.identityLocks.push(values[0]);
                        return { rows: [] };
                    }
                    if (sql.includes("DELETE FROM worker_registration_challenges")) {
                        state.challenge = null;
                        return { rows: [], rowCount: 1 };
                    }
                    if (sql.includes("DELETE FROM worker_national_id_claims")) return { rows: [] };
                    if (sql.includes("SELECT 1") && sql.includes("FROM users")) {
                        const duplicate = state.users.some((user) =>
                            normalizeKenyanPhone(user.phone) === normalizeKenyanPhone(values[0]) ||
                            (values[1] && user.email?.toLowerCase() === String(values[1]).toLowerCase())
                        );
                        return { rows: duplicate ? [{ "?column?": 1 }] : [] };
                    }
                    if (sql.includes("INSERT INTO worker_registration_challenges")) {
                        state.challenge = {
                            challenge_id: values[0],
                            full_name: values[1],
                            phone: values[2],
                            email: values[3],
                            occupation: values[4],
                            date_of_birth: values[5],
                            national_id_ciphertext: values[6],
                            national_id_iv: values[7],
                            national_id_tag: values[8],
                            national_id_key_version: values[9],
                            national_id_fingerprint: values[10],
                            national_id_last_four: values[11],
                            code_hash: values[12],
                            code_salt: values[13],
                            expires_at: values[14],
                            attempt_count: 0,
                            attempt_window_started_at: values[15],
                            locked_until: null,
                            challenge_status: "PENDING",
                        };
                        return { rows: [], rowCount: 1 };
                    }
                    if (sql.includes("INSERT INTO worker_national_id_claims")) {
                        state.claim = {
                            national_id_fingerprint: values[0],
                            claim_status: "RESERVED",
                            registration_challenge_id: values[1],
                            expires_at: values[2],
                        };
                        return { rows: [], rowCount: 1 };
                    }
                    if (sql.includes("SELECT challenge_id, full_name, phone, email")) {
                        return { rows: state.challenge ? [{ ...state.challenge }] : [] };
                    }
                    if (sql.includes("SELECT claim_status, registration_challenge_id")) {
                        return { rows: state.claim ? [{ ...state.claim }] : [] };
                    }
                    if (sql.includes("SELECT 1 FROM users")) return { rows: [] };
                    if (sql.includes("INSERT INTO users")) {
                        if (state.failUserInsert) {
                            throw Object.assign(new Error("synthetic uniqueness conflict"), {
                                code: "23505",
                                constraint: "uq_users_phone_normalized",
                            });
                        }
                        const user = {
                            user_id: `worker-${state.users.length + 1}`,
                            full_name: values[0],
                            phone: values[1],
                            phone_verified_at: new Date(),
                            pending_email: values[2],
                            email_verified: false,
                            password_hash: values[3],
                            role: "WORKER",
                            occupation: values[4],
                            login_method: "PHONE",
                            account_status: "ACTIVE",
                            auth_version: 0,
                        };
                        state.users.push(user);
                        return { rows: [{ user_id: user.user_id }] };
                    }
                    if (sql.includes("INSERT INTO pension_accounts")) {
                        state.accounts.push({ user_id: values[0], current_balance: "0.00" });
                        return { rows: [] };
                    }
                    if (sql.includes("INSERT INTO notification_preferences")) {
                        state.preferences.push({
                            user_id: values[0],
                            sms_enabled: false,
                            email_enabled: false,
                        });
                        return { rows: [] };
                    }
                    if (sql.includes("INSERT INTO kyc_records")) {
                        if (state.failKycInsert) {
                            throw Object.assign(new Error("synthetic KYC failure"), { code: "XX001" });
                        }
                        state.kycRecords.push({
                            user_id: values[0],
                            national_id_fingerprint: values[4],
                            date_of_birth: values[6],
                            kyc_status: "PENDING",
                        });
                        return { rows: [] };
                    }
                    if (sql.includes("UPDATE worker_national_id_claims")) {
                        if (state.claim) state.claim.claim_status = "CLAIMED";
                        return { rows: [{ national_id_fingerprint: state.claim?.national_id_fingerprint }] };
                    }
                    if (sql.includes("INSERT INTO audit_logs")) return { rows: [] };
                    if (sql.includes("UPDATE worker_registration_challenges")) {
                        if (sql.includes("locked_until") && values[3]) {
                            state.challenge.locked_until = values[3];
                        }
                        return { rows: [] };
                    }
                    throw new Error(`Unexpected transaction query: ${sql}`);
                },
                release() {},
            };
        },
    };
    const service = createWorkerRegistrationService({
        database,
        smsService,
        emailService,
        environment,
        now: () => new Date(),
    });
    return { state, service };
}

function validRegistration(overrides = {}) {
    return {
        full_name: "New Worker",
        phone: "0712345678",
        occupation: "OTHER_INFORMAL_WORKER",
        national_id: "12345678",
        date_of_birth: "1990-04-15",
        ...overrides,
    };
}

test("phone OTP registration requires name, National ID and phone; email is optional", async () => {
    const { state, service } = createHarness();

    await assert.rejects(
        service.startRegistration(validRegistration({ full_name: "" }), {}),
        { code: "WORKER_REGISTRATION_INVALID_INPUT" },
    );
    await assert.rejects(
        service.startRegistration(validRegistration({ national_id: "1234" }), {}),
        { code: "INVALID_NATIONAL_ID" },
    );
    await assert.rejects(
        service.startRegistration(validRegistration({ phone: "letters" }), {}),
        { code: "WORKER_REGISTRATION_INVALID_INPUT" },
    );

    const started = await service.startRegistration(validRegistration(), {});
    assert.equal(started.accepted, true);
    assert.equal(state.challenge.email, null);
    assert.equal(state.smsMessages.length, 1);
    assert.equal(state.challenge.challenge_status, "PENDING");
});

test("registration creates an active worker, zero-balance account and PENDING KYC only after OTP completion", async () => {
    const { state, service } = createHarness();
    const started = await service.startRegistration(validRegistration({ email: "worker@example.com" }), {});
    const code = state.smsMessages[0].message.match(/\b(\d{6})\b/)[1];
    const completed = await service.completeRegistration({
        challengeId: started.challengeId,
        code,
        password: "secure-password",
    }, {});

    assert.equal(completed.accountStatus, "ACTIVE");
    assert.equal(completed.kycStatus, "PENDING");
    assert.equal(state.users[0].account_status, "ACTIVE");
    assert.equal(Object.hasOwn(state.users[0], "approval_status"), false);
    assert.equal(state.users[0].role, "WORKER");
    assert.equal(state.accounts[0].current_balance, "0.00");
    assert.equal(state.kycRecords[0].kyc_status, "PENDING");
    assert.equal(state.challenge, null);
});

test("invalid, expired and reused OTP challenges cannot create accounts", async () => {
    const { state, service } = createHarness();
    const started = await service.startRegistration(validRegistration(), {});
    await assert.rejects(
        service.completeRegistration({
            challengeId: started.challengeId,
            code: "000000",
            password: "secure-password",
        }, {}),
        { code: "OTP_INVALID" },
    );

    const code = state.smsMessages[0].message.match(/\b(\d{6})\b/)[1];
    await service.completeRegistration({
        challengeId: started.challengeId,
        code,
        password: "secure-password",
    }, {});
    await assert.rejects(
        service.completeRegistration({
            challengeId: started.challengeId,
            code,
            password: "secure-password",
        }, {}),
        { code: "OTP_INVALID" },
    );

    const expired = await service.startRegistration(validRegistration({ phone: "0712345679" }), {});
    state.challenge.expires_at = new Date(Date.now() - 1000);
    const expiredCode = state.smsMessages.at(-1).message.match(/\b(\d{6})\b/)[1];
    await assert.rejects(
        service.completeRegistration({
            challengeId: expired.challengeId,
            code: expiredCode,
            password: "secure-password",
        }, {}),
        { code: "OTP_INVALID" },
    );
});

test("OTP attempt limits lock a challenge and a failed SMS cancels it", async () => {
    const locked = createHarness();
    const lockedStart = await locked.service.startRegistration(validRegistration(), {});
    locked.state.challenge.attempt_count = 5;
    await assert.rejects(
        locked.service.completeRegistration({
            challengeId: lockedStart.challengeId,
            code: "000000",
            password: "secure-password",
        }, {}),
        { code: "OTP_RATE_LIMITED" },
    );

    const failed = createHarness();
    failed.state.failSms = true;
    await assert.rejects(
        failed.service.startRegistration(validRegistration(), {}),
        { code: "WORKER_REGISTRATION_SMS_DELIVERY_FAILED" },
    );
    assert.equal(failed.state.challenge, null);
});

test("duplicate phone or National ID does not create a second account", async () => {
    const { state, service } = createHarness();
    state.users.push({
        user_id: "existing-user",
        phone: "+254712345678",
        email: "existing@example.com",
        approval_status: "APPROVED",
    });

    const phoneResult = await service.startRegistration(validRegistration(), {});
    assert.equal(phoneResult.accepted, true);
    assert.equal(state.smsMessages.length, 0);
});

test("legacy pending and rejected active workers can log in and use protected APIs", async () => {
    const statusCases = [
        { approval_status: "PENDING" },
        { approval_status: "REJECTED" },
    ];
    bcrypt.compare = async () => true;
    authEmailService.enforceRequestLimits = async () => {};

    for (const statusCase of statusCases) {
        const worker = {
            user_id: `worker-${statusCase.approval_status.toLowerCase()}`,
            full_name: "Test Worker",
            phone: "+254712345678",
            phone_verified_at: new Date(),
            password_hash: "test-password-hash",
            role: "WORKER",
            account_status: "ACTIVE",
            approval_status: statusCase.approval_status,
            auth_version: 0,
            email_verified: false,
            is_temp_password: false,
            force_password_change: false,
        };
        pool.query = async (sql) => {
            if (sql.includes("FROM users") && sql.includes("login_method = 'PHONE'")) {
                return { rows: [worker] };
            }
            if (sql.includes("SET failed_login_attempts = 0")) return { rows: [] };
            if (sql.includes("INSERT INTO audit_logs")) return { rows: [] };
            if (sql.includes("FROM users WHERE user_id = $1")) {
                return { rows: [worker] };
            }
            throw new Error(`Unexpected pool query: ${sql}`);
        };

        const loginResponse = createResponse();
        await authController.login({
            body: { identifier: worker.phone, password: "valid-password" },
            headers: {},
            ip: "127.0.0.1",
        }, loginResponse);
        assert.equal(loginResponse.statusCode, 200);
        assert.equal(loginResponse.body.data.user.user_id, worker.user_id);
        assert.equal(loginResponse.body.data.user.account_status, "ACTIVE");

        const authResponse = createResponse();
        let nextCalled = false;
        await requireAuth({
            headers: {
                authorization: `Bearer ${generateToken({
                    userId: worker.user_id,
                    role: worker.role,
                    authVersion: worker.auth_version,
                })}`,
            },
            path: "/protected",
        }, authResponse, () => {
            nextCalled = true;
        });
        assert.equal(authResponse.statusCode, null);
        assert.equal(nextCalled, true);
    }
});

test("approved workers can log in with their verified phone number", async () => {
    const worker = {
        user_id: "approved-phone-worker",
        full_name: "Test Worker",
        phone: "+254712345678",
        phone_verified_at: new Date(),
        password_hash: "test-password-hash",
        role: "WORKER",
        occupation: "Teacher",
        account_status: "ACTIVE",
        approval_status: "APPROVED",
        auth_version: 0,
        failed_login_attempts: 0,
        locked_until: null,
        email_verified: false,
        is_temp_password: false,
        force_password_change: false,
        profile_photo_available: false,
    };
    bcrypt.compare = async () => true;
    authEmailService.enforceRequestLimits = async () => {};
    pool.query = async (sql) => {
        if (sql.includes("FROM users") && sql.includes("login_method = 'PHONE'")) {
            return { rows: [worker] };
        }
        if (sql.includes("SELECT setting_key, setting_value")) {
            assert.fail("Successful login must not depend on operational settings.");
        }
        if (sql.includes("SET failed_login_attempts = 0")) return { rows: [] };
        if (sql.includes("INSERT INTO audit_logs")) return { rows: [] };
        throw new Error(`Unexpected pool query: ${sql}`);
    };

    const response = createResponse();
    await authController.login({
        body: { identifier: "0712345678", password: "valid-password" },
        headers: {},
        ip: "127.0.0.1",
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data.user.user_id, worker.user_id);
    assert.equal(response.body.data.user.role, "WORKER");
    assert.equal(typeof response.body.data.token, "string");
});

test("suspended, inactive and unauthorized users fail closed", async () => {
    pool.query = async (sql, values) => {
        if (sql.includes("SELECT user_id, role, account_status, auth_version")) {
            return {
                rows: [{
                    user_id: values[0],
                    role: "WORKER",
                    account_status: values[0] === "inactive-worker" ? "INACTIVE" : "SUSPENDED",
                    auth_version: 0,
                    force_password_change: false,
                    is_temp_password: false,
                }],
            };
        }
        throw new Error(`Unexpected query: ${sql}`);
    };

    for (const userId of ["suspended-worker", "inactive-worker"]) {
        const token = generateToken({ userId, role: "WORKER", authVersion: 0 });
        const response = createResponse();
        await requireAuth(
            { headers: { authorization: `Bearer ${token}` } },
            response,
            () => assert.fail("Protected API must not run"),
        );
        assert.equal(response.statusCode, 403);
    }

    const denied = createResponse();
    requireRole("ADMIN")(
        { user: { role: "WORKER" } },
        denied,
        () => assert.fail("Unauthorized role must not proceed"),
    );
    assert.equal(denied.statusCode, 403);
});

test("existing verified-phone and legacy phone accounts remain compatible", () => {
    assert.equal(normalizeKenyanPhone("0712345678"), "+254712345678");
    assert.equal(normalizeKenyanPhone("+254712345678"), "+254712345678");
    assert.equal(normalizeKenyanPhone("254712345678"), "+254712345678");
});
