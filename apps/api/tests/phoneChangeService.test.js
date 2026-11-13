const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");
const {
    normalizeKenyanPhone,
    startPhoneChange,
    verifyPhoneChange,
} = require("../src/services/phoneChangeService");
const { isSmsDispatcherEnabled } = require("../src/services/smsDeliveryDispatcher");

const originalCompare = bcrypt.compare;

afterEach(() => {
    bcrypt.compare = originalCompare;
});

function createPhoneChangeDatabase() {
    const state = {
        account: {
            user_id: "same-account",
            phone: "254700000001",
            password_hash: "unchanged-password-hash",
            role: "ADMIN",
            account_status: "ACTIVE",
            auth_version: 4,
        },
        otherAccounts: [],
        challenge: null,
        queries: [],
        failPhoneUpdateWithUniqueViolation: false,
    };
    const client = {
        async query(sql, values = []) {
            state.queries.push({ sql, values });
            if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
            if (sql.includes("SELECT user_id, phone, phone_verified_at, password_hash")) {
                return { rows: state.account.user_id === values[0] ? [state.account] : [] };
            }
            if (sql.includes("SELECT user_id") && sql.includes("FROM users") &&
                sql.includes("user_id <>")) {
                const match = state.otherAccounts.find((account) =>
                    normalizeKenyanPhone(account.phone) === values[1]
                );
                return { rows: match ? [{ user_id: match.user_id }] : [] };
            }
            if (sql.includes("SELECT user_id") &&
                sql.includes("FROM phone_change_verifications")) {
                return {
                    rows: state.challenge &&
                        state.challenge.user_id !== values[0] &&
                        state.challenge.pending_phone === values[1]
                        ? [{ user_id: state.challenge.user_id }]
                        : [],
                };
            }
            if (sql.includes("SELECT send_count, window_started_at")) {
                return {
                    rows: state.challenge?.user_id === values[0] ? [state.challenge] : [],
                };
            }
            if (sql.includes("SELECT pending_phone, code_hash, code_salt")) {
                return {
                    rows: state.challenge?.user_id === values[0] ? [state.challenge] : [],
                };
            }
            if (sql.includes("INSERT INTO phone_change_verifications")) {
                const [
                    userId, phone, hash, salt, expiresAt, sendCount, windowStartedAt,
                    lastSentAt, attemptCount, attemptWindowStartedAt,
                ] = values;
                state.challenge = {
                    user_id: userId,
                    pending_phone: phone,
                    code_hash: hash,
                    code_salt: salt,
                    expires_at: expiresAt,
                    send_count: sendCount,
                    window_started_at: windowStartedAt,
                    last_sent_at: lastSentAt,
                    attempt_count: attemptCount,
                    attempt_window_started_at: attemptWindowStartedAt,
                    locked_until: null,
                };
                return { rows: [] };
            }
            if (sql.includes("UPDATE phone_change_verifications") &&
                sql.includes("SET attempt_count")) {
                state.challenge.attempt_count = values[1];
                state.challenge.attempt_window_started_at = values[2];
                state.challenge.locked_until = values[3];
                return { rows: [] };
            }
            if (sql.includes("UPDATE phone_change_verifications") &&
                sql.includes("SET locked_until")) {
                state.challenge.locked_until = values[1];
                return { rows: [] };
            }
            if (sql.includes("UPDATE phone_change_verifications") &&
                sql.includes("SET pending_phone = NULL")) {
                if (sql.includes("WHERE pending_phone = $1")) {
                    if (state.challenge?.pending_phone === values[0] &&
                        new Date(state.challenge.expires_at) <= new Date(values[1])) {
                        state.challenge.pending_phone = null;
                        state.challenge.code_hash = null;
                        state.challenge.code_salt = null;
                        state.challenge.expires_at = null;
                    }
                } else if (state.challenge) {
                    state.challenge.pending_phone = null;
                    state.challenge.code_hash = null;
                    state.challenge.code_salt = null;
                    state.challenge.expires_at = null;
                    if (sql.includes("attempt_count = 0")) {
                        state.challenge.attempt_count = 0;
                        state.challenge.attempt_window_started_at = null;
                        state.challenge.locked_until = null;
                    }
                }
                return { rows: [] };
            }
            if (sql.includes("UPDATE users") && sql.includes("phone_verified_at")) {
                if (state.failPhoneUpdateWithUniqueViolation) {
                    throw Object.assign(new Error("mock unique constraint violation"), {
                        code: "23505",
                    });
                }
                const duplicate = state.otherAccounts.some((account) =>
                    normalizeKenyanPhone(account.phone) === values[1]
                );
                if (duplicate) return { rows: [] };
                if (normalizeKenyanPhone(state.account.phone) !== values[1]) {
                    state.account.phone = values[1];
                }
                state.account.phone_verified_at = values[2];
                return { rows: [{
                    user_id: state.account.user_id,
                    phone: state.account.phone,
                    phone_verified_at: state.account.phone_verified_at,
                }] };
            }
            throw new Error(`Unexpected mocked SQL: ${sql}`);
        },
        release() {},
    };
    return {
        state,
        database: { async connect() { return client; } },
    };
}

function testEnvironment() {
    return {
        NODE_ENV: "production",
        MOBILESASA_SMS_ENABLED: "true",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };
}

function createSmsService() {
    const sent = [];
    return {
        sent,
        isPhoneVerificationSmsConfigured: () => true,
        async sendPhoneVerificationSms(request) {
            sent.push(request);
            return { accepted: true, status: "PROVIDER_ACCEPTED", messageId: "mock-1" };
        },
    };
}

async function requestCode(
    database,
    smsService,
    now = () => new Date("2026-11-05T12:00:00Z"),
    newPhone = "0712 345 678"
) {
    const result = await startPhoneChange({
        userId: "same-account",
        currentPassword: "existing-password",
        newPhone,
        confirmed: true,
    }, {
        database,
        smsService,
        environment: testEnvironment(),
        fetchImpl: async () => { throw new Error("Network must not be used by mocked SMS"); },
        now,
    });
    return result;
}

test("Kenyan phone numbers are normalized to a canonical E.164 representation", () => {
    assert.equal(normalizeKenyanPhone("0712 345 678"), "+254712345678");
    assert.equal(normalizeKenyanPhone("254112345678"), "+254112345678");
    assert.equal(normalizeKenyanPhone("+254712345678"), "+254712345678");
    assert.equal(normalizeKenyanPhone("0201234567"), null);
});

test("verified phone change preserves identity, role, account state, and password hash", async () => {
    const { state, database } = createPhoneChangeDatabase();
    const smsService = createSmsService();
    bcrypt.compare = async (password, hash) =>
        password === "existing-password" && hash === "unchanged-password-hash";
    await requestCode(database, smsService);
    const code = smsService.sent[0].message.match(/\b(\d{6})\b/)[1];
    assert.equal(Buffer.isBuffer(state.challenge.code_hash), true);
    assert.equal(state.challenge.code_hash.length, 32);
    assert.equal(state.challenge.code_salt.length, 16);
    assert.notEqual(state.challenge.code_hash.toString(), code);

    const result = await verifyPhoneChange({
        userId: "same-account",
        code,
    }, { database, now: () => new Date("2026-11-05T12:01:00Z") });

    assert.deepEqual(result, { phone: "+254712345678", phoneVerified: true });
    assert.equal(state.account.user_id, "same-account");
    assert.equal(state.account.role, "ADMIN");
    assert.equal(state.account.account_status, "ACTIVE");
    assert.equal(state.account.auth_version, 4);
    assert.equal(state.account.password_hash, "unchanged-password-hash");
    assert.equal(state.account.phone, "+254712345678");
    assert.ok(state.account.phone_verified_at);
    assert.ok(state.queries.some(({ sql }) => /SET phone = CASE[\s\S]*phone_verified_at = \$3/.test(sql)));
    assert.ok(state.queries.every(({ sql }) => !/SET[^;]*password_hash\s*=/i.test(sql)));
});

test("an unverified current phone can be verified without changing its stored value", async () => {
    const { state, database } = createPhoneChangeDatabase();
    const smsService = createSmsService();
    state.account.phone = "0700 000 001";
    state.account.phone_verified_at = null;
    bcrypt.compare = async (password, hash) =>
        password === "existing-password" && hash === "unchanged-password-hash";
    await requestCode(database, smsService, undefined, "0700 000 001");
    const code = smsService.sent[0].message.match(/\b(\d{6})\b/)[1];

    const result = await verifyPhoneChange({
        userId: "same-account",
        code,
    }, { database, now: () => new Date("2026-11-05T12:01:00Z") });

    assert.equal(result.phone, "0700 000 001");
    assert.equal(result.phoneVerified, true);
    assert.equal(state.account.phone, "0700 000 001");
    assert.ok(state.account.phone_verified_at);
});

test("an already verified current phone cannot be needlessly re-verified", async () => {
    const { state, database } = createPhoneChangeDatabase();
    const smsService = createSmsService();
    state.account.phone_verified_at = new Date("2026-01-01T00:00:00Z");
    bcrypt.compare = async () => true;

    await assert.rejects(
        requestCode(database, smsService, undefined, state.account.phone),
        { code: "PHONE_CHANGE_SAME_PHONE", statusCode: 409 }
    );
    assert.equal(smsService.sent.length, 0);
    assert.equal(state.challenge, null);
});

test("a concurrent phone uniqueness conflict is returned as a safe conflict", async () => {
    const { state, database } = createPhoneChangeDatabase();
    const smsService = createSmsService();
    bcrypt.compare = async () => true;
    await requestCode(database, smsService);
    const code = smsService.sent[0].message.match(/\b(\d{6})\b/)[1];
    state.failPhoneUpdateWithUniqueViolation = true;

    await assert.rejects(verifyPhoneChange({
        userId: "same-account",
        code,
    }, { database, now: () => new Date("2026-11-05T12:01:00Z") }), {
        code: "PHONE_CHANGE_PHONE_IN_USE",
        statusCode: 409,
    });
    assert.equal(state.account.phone, "254700000001");
    assert.ok(state.queries.some(({ sql }) => sql === "ROLLBACK"));
});

test("incorrect verification code is counted and does not change the registered phone", async () => {
    const { state, database } = createPhoneChangeDatabase();
    const smsService = createSmsService();
    bcrypt.compare = async () => true;
    await requestCode(database, smsService);
    const correctCode = smsService.sent[0].message.match(/\b(\d{6})\b/)[1];
    const wrongCode = correctCode === "000000" ? "000001" : "000000";

    const result = await verifyPhoneChange({
        userId: "same-account",
        code: wrongCode,
    }, { database, now: () => new Date("2026-11-05T12:01:00Z") });

    assert.equal(result.error.code, "PHONE_CHANGE_INVALID_CODE");
    assert.equal(state.challenge.attempt_count, 1);
    assert.equal(state.account.phone, "254700000001");
});

test("expired verification codes cannot change the registered phone", async () => {
    const { state, database } = createPhoneChangeDatabase();
    const smsService = createSmsService();
    bcrypt.compare = async () => true;
    const startedAt = new Date("2026-11-05T12:00:00Z");
    await requestCode(database, smsService, () => startedAt);
    const code = smsService.sent[0].message.match(/\b(\d{6})\b/)[1];

    const result = await verifyPhoneChange({
        userId: "same-account",
        code,
    }, { database, now: () => new Date("2026-11-05T12:10:01Z") });

    assert.equal(result.error.code, "PHONE_CHANGE_CODE_EXPIRED");
    assert.equal(state.challenge.pending_phone, null);
    assert.equal(state.account.phone, "254700000001");
});

test("five failed verification attempts lock the challenge", async () => {
    const { state, database } = createPhoneChangeDatabase();
    const smsService = createSmsService();
    bcrypt.compare = async () => true;
    await requestCode(database, smsService);
    const correctCode = smsService.sent[0].message.match(/\b(\d{6})\b/)[1];
    const wrongCode = correctCode === "000000" ? "000001" : "000000";
    let result;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        result = await verifyPhoneChange({
            userId: "same-account",
            code: wrongCode,
        }, { database, now: () => new Date("2026-11-05T12:01:00Z") });
    }

    assert.equal(result.error.code, "PHONE_CHANGE_INVALID_CODE");
    assert.equal(state.challenge.attempt_count, 5);
    const lockedAttempt = await verifyPhoneChange({
        userId: "same-account",
        code: correctCode,
    }, { database, now: () => new Date("2026-11-05T12:02:00Z") });
    assert.equal(lockedAttempt.error.code, "PHONE_CHANGE_RATE_LIMITED");
    assert.equal(state.account.phone, "254700000001");
    await requestCode(database, smsService, () => new Date("2026-11-05T12:16:00Z"));
    assert.equal(smsService.sent.length, 2);
});

test("a current phone owned by another user is rejected before sending a code", async () => {
    const { state, database } = createPhoneChangeDatabase();
    state.otherAccounts.push({ user_id: "other-account", phone: "254712345678" });
    const smsService = createSmsService();
    bcrypt.compare = async () => true;

    await assert.rejects(requestCode(database, smsService), {
        code: "PHONE_CHANGE_PHONE_IN_USE",
        statusCode: 409,
    });
    assert.equal(smsService.sent.length, 0);
    assert.equal(state.challenge, null);
});

test("a number with an active verification request for another user is rejected", async () => {
    const { state, database } = createPhoneChangeDatabase();
    state.challenge = {
        user_id: "other-account",
        pending_phone: "+254712345678",
        code_hash: Buffer.alloc(32),
        code_salt: Buffer.alloc(16),
        expires_at: new Date("2026-11-05T12:10:00Z"),
        send_count: 1,
        window_started_at: new Date("2026-11-05T12:00:00Z"),
        last_sent_at: new Date("2026-11-05T12:00:00Z"),
        attempt_count: 0,
        attempt_window_started_at: new Date("2026-11-05T12:00:00Z"),
        locked_until: null,
    };
    const smsService = createSmsService();
    bcrypt.compare = async () => true;

    await assert.rejects(requestCode(database, smsService), {
        code: "PHONE_CHANGE_PHONE_IN_USE",
        statusCode: 409,
    });
    assert.equal(smsService.sent.length, 0);
});

test("incorrect current password and absent confirmation cannot initiate a change", async () => {
    const { database } = createPhoneChangeDatabase();
    const smsService = createSmsService();
    bcrypt.compare = async () => false;
    await assert.rejects(startPhoneChange({
        userId: "same-account",
        currentPassword: "wrong-password",
        newPhone: "0712345678",
        confirmed: true,
    }, { database, smsService, environment: testEnvironment() }), {
        code: "PHONE_CHANGE_PASSWORD_INVALID",
        statusCode: 401,
    });
    await assert.rejects(startPhoneChange({
        userId: "same-account",
        currentPassword: "existing-password",
        newPhone: "0712345678",
        confirmed: false,
    }, { database, smsService, environment: testEnvironment() }), {
        code: "PHONE_CHANGE_CONFIRMATION_REQUIRED",
        statusCode: 400,
    });
    assert.equal(smsService.sent.length, 0);
});

test("SMS configuration missing in development fails without enabling the general dispatcher", async () => {
    let databaseConnections = 0;
    let sends = 0;
    const smsService = {
        isPhoneVerificationSmsConfigured: () => false,
        async sendPhoneVerificationSms() { sends += 1; },
    };
    await assert.rejects(startPhoneChange({
        userId: "same-account",
        currentPassword: "existing-password",
        newPhone: "0712345678",
        confirmed: true,
    }, {
        database: { async connect() { databaseConnections += 1; throw new Error("Should not connect"); } },
        smsService,
        environment: { NODE_ENV: "development", MOBILESASA_SMS_ENABLED: "false" },
    }), {
        code: "PHONE_CHANGE_SMS_UNAVAILABLE",
        statusCode: 503,
    });
    assert.equal(databaseConnections, 0);
    assert.equal(sends, 0);
});

test("development phone verification uses only its explicit SMS test switch", async () => {
    const { state, database } = createPhoneChangeDatabase();
    const smsService = createSmsService();
    const environment = {
        NODE_ENV: "development",
        MOBILESASA_TEST_SMS_ENABLED: "true",
        MOBILESASA_SMS_ENABLED: "false",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };
    smsService.isPhoneVerificationSmsConfigured = (settings) =>
        settings.MOBILESASA_TEST_SMS_ENABLED === "true" &&
        settings.MOBILESASA_SMS_ENABLED !== "true";
    bcrypt.compare = async () => true;
    await startPhoneChange({
        userId: "same-account",
        currentPassword: "existing-password",
        newPhone: "0712345678",
        confirmed: true,
    }, {
        database,
        smsService,
        environment,
        now: () => new Date("2026-11-05T12:00:00Z"),
    });

    assert.equal(smsService.sent.length, 1);
    assert.equal(smsService.sent[0].to, "+254712345678");
    assert.equal(isSmsDispatcherEnabled(environment), false);
    assert.equal(state.account.phone, "254700000001");
});

test("phone-code resend interval and three-per-hour limit are enforced", async () => {
    const { database } = createPhoneChangeDatabase();
    const smsService = createSmsService();
    bcrypt.compare = async () => true;
    const start = new Date("2026-11-05T12:00:00Z");
    await requestCode(database, smsService, () => start);
    await assert.rejects(requestCode(
        database,
        smsService,
        () => new Date(start.getTime() + 59_000)
    ), {
        code: "PHONE_CHANGE_RATE_LIMITED",
        statusCode: 429,
    });
    await requestCode(database, smsService, () => new Date(start.getTime() + 60_000));
    await requestCode(database, smsService, () => new Date(start.getTime() + 120_000));
    await assert.rejects(requestCode(
        database,
        smsService,
        () => new Date(start.getTime() + 180_000)
    ), {
        code: "PHONE_CHANGE_RATE_LIMITED",
        statusCode: 429,
    });
    assert.equal(smsService.sent.length, 3);
});
