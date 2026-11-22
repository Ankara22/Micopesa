const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createPhonePasswordRecoveryService,
} = require("../src/services/phonePasswordRecoveryService");

const userId = "ABCDEF1234567890ABCDEF123";
const now = new Date("2026-03-01T12:00:00.000Z");

function createRecoveryDatabase({ verified = true } = {}) {
    const calls = [];
    const user = { user_id: userId, phone: "+254712345678", auth_version: 4 };
    const state = { challenge: null };
    const client = {
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
            if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
            if (sql.includes("SELECT user_id, phone")) {
                return { rows: verified ? [{ user_id: userId, phone: user.phone }] : [] };
            }
            if (sql.includes("INSERT INTO worker_password_reset_challenges")) {
                state.challenge = {
                    challenge_id: values[0],
                    user_id: values[1],
                    code_hash: values[2],
                    code_salt: values[3],
                    expires_at: values[4],
                    attempt_count: 0,
                    attempt_window_started_at: values[5],
                    locked_until: null,
                    challenge_status: "PENDING",
                };
                return { rows: [], rowCount: 1 };
            }
            if (sql.includes("SELECT c.challenge_id, c.user_id, c.code_hash")) {
                return { rows: state.challenge ? [{ ...state.challenge, phone: user.phone }] : [] };
            }
            if (sql.includes("SET password_hash = $1, auth_version = auth_version + 1")) {
                user.auth_version += 1;
                return { rows: [], rowCount: 1 };
            }
            if (sql.includes("SET challenge_status = 'CONSUMED'")) {
                state.challenge.challenge_status = "CONSUMED";
                return { rows: [], rowCount: 1 };
            }
            if (sql.includes("INSERT INTO audit_logs")) return { rows: [], rowCount: 1 };
            return { rows: [], rowCount: 1 };
        },
        release() {},
    };
    return {
        calls,
        state,
        user,
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (sql.includes("FROM users") && sql.includes("phone_verified_at IS NOT NULL")) {
                return { rows: verified ? [{ user_id: userId }] : [] };
            }
            if (sql.includes("FROM worker_password_reset_challenges c")) {
                return {
                    rows: state.challenge?.challenge_status === "PENDING"
                        ? [{ user_id: userId }]
                        : [],
                };
            }
            return { rows: [], rowCount: 1 };
        },
        async connect() { return client; },
    };
}

function createSmsService(sentMessages) {
    return {
        getPhoneVerificationSmsConfiguration: () => ({ available: true, provider: "TEST" }),
        async sendPhoneVerificationSms(message) {
            sentMessages.push(message);
            return { accepted: true, status: "PROVIDER_ACCEPTED" };
        },
    };
}

test("phone recovery rejects unverified accounts without sending an OTP", async () => {
    const database = createRecoveryDatabase({ verified: false });
    const sentMessages = [];
    const service = createPhonePasswordRecoveryService({
        database,
        smsService: createSmsService(sentMessages),
        emailService: { async enforceRequestLimits() {} },
        notificationEnqueuer: async () => {},
        now: () => now,
    });

    const result = await service.requestCode({ phone: "+254712345678" }, {});

    assert.equal(result.accepted, true);
    assert.equal(sentMessages.length, 0);
    assert.equal(database.state.challenge, null);
});

test("phone recovery consumes the OTP, updates the password and invalidates prior authentication", async () => {
    const database = createRecoveryDatabase();
    const sentMessages = [];
    const notifications = [];
    const service = createPhonePasswordRecoveryService({
        database,
        smsService: createSmsService(sentMessages),
        emailService: { async enforceRequestLimits() {} },
        notificationEnqueuer: async (notification) => notifications.push(notification),
        now: () => now,
    });

    const requested = await service.requestCode({ phone: "0712345678" }, {});
    const code = sentMessages[0].message.match(/\b(\d{6})\b/)[1];
    await service.completeRecovery({
        challenge_id: requested.challengeId,
        phone: "0712345678",
        code,
        password: "replacement-password",
    }, {});

    assert.equal(database.state.challenge.challenge_status, "CONSUMED");
    assert.equal(database.user.auth_version, 5);
    assert.ok(database.calls.some(({ sql }) =>
        sql.includes("UPDATE users") && sql.includes("auth_version = auth_version + 1")
    ));
    assert.deepEqual(notifications, [{
        userId,
        eventType: "PASSWORD_RESET_COMPLETED",
        referenceId: requested.challengeId,
    }]);
});
