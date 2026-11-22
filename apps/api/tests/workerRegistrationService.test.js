const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createWorkerRegistrationService,
} = require("../src/services/workerRegistrationService");

const environment = {
    NATIONAL_ID_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
    NATIONAL_ID_FINGERPRINT_KEY: Buffer.alloc(32, 4).toString("base64"),
};

function createRegistrationDatabase() {
    const calls = [];
    const state = {
        challenge: null,
        userId: "ABCDEF1234567890ABCDEF123",
    };
    const client = {
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
            if (sql.includes("pg_advisory_xact_lock")) return { rows: [{ pg_advisory_xact_lock: null }] };
            if (sql.includes("SELECT 1") && sql.includes("FROM users")) return { rows: [] };
            if (sql.includes("DELETE FROM worker_registration_challenges") &&
                sql.includes("WHERE challenge_id = $1")) {
                state.challenge = null;
                return { rows: [], rowCount: 1 };
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
            if (sql.includes("INSERT INTO users")) return { rows: [{ user_id: state.userId }] };
            if (sql.includes("SELECT claim_status, registration_challenge_id")) {
                return {
                    rows: [{
                        claim_status: "RESERVED",
                        registration_challenge_id: state.challenge.challenge_id,
                        expires_at: state.challenge.expires_at,
                    }],
                };
            }
            if (sql.includes("SELECT challenge_id, full_name, phone, email")) {
                return { rows: [state.challenge] };
            }
            if (sql.includes("UPDATE worker_national_id_claims") &&
                sql.includes("SET claim_status = 'CLAIMED'")) {
                return { rows: [{ national_id_fingerprint: state.challenge.national_id_fingerprint }] };
            }
            if (sql.includes("INSERT INTO audit_logs")) return { rows: [], rowCount: 1 };
            return { rows: [], rowCount: 1 };
        },
        release() {},
    };
    return {
        calls,
        state,
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (sql.includes("SELECT phone, email, national_id_fingerprint")) {
                return {
                    rows: state.challenge ? [{
                        phone: state.challenge.phone,
                        email: state.challenge.email,
                        national_id_fingerprint: state.challenge.national_id_fingerprint,
                    }] : [],
                };
            }
            return { rows: [] };
        },
        async connect() { return client; },
    };
}

test("phone OTP registration creates an active worker with a zero-balance account and pending encrypted KYC", async () => {
    const database = createRegistrationDatabase();
    const sentMessages = [];
    const service = createWorkerRegistrationService({
        database,
        environment,
        now: () => new Date("2026-03-01T12:00:00.000Z"),
        emailService: {
            async enforceRequestLimits() {},
            async issueEmailToken() { assert.fail("Optional email was not supplied."); },
            logEmailDeliveryFailure() {},
        },
        smsService: {
            getPhoneVerificationSmsConfiguration: () => ({ available: true, provider: "TEST" }),
            async sendPhoneVerificationSms(message) {
                sentMessages.push(message);
                return { accepted: true, status: "PROVIDER_ACCEPTED" };
            },
        },
    });

    const started = await service.startRegistration({
        full_name: "New Worker",
        phone: "0712345678",
        email: null,
        occupation: "MARKET_VENDOR",
        national_id: "00123456",
        date_of_birth: "1990-04-15",
    }, {});
    const code = sentMessages[0].message.match(/\b(\d{6})\b/)[1];
    const completed = await service.completeRegistration({
        challengeId: started.challengeId,
        code,
        password: "new-secure-password",
    }, {});

    assert.equal(completed.accountStatus, "ACTIVE");
    assert.equal(completed.kycStatus, "PENDING");
    assert.equal(completed.userId, database.state.userId);
    assert.equal(sentMessages.length, 1);
    assert.equal(database.state.challenge, null);
    assert.ok(database.calls.some(({ sql }) =>
        sql.includes("INSERT INTO pension_accounts") && sql.includes("0.00")
    ));
    assert.ok(database.calls.some(({ sql, values }) =>
        sql.includes("INSERT INTO users") &&
        sql.includes("'PHONE'") &&
        sql.includes("'ACTIVE'") &&
        !sql.includes("approval_status") &&
        values[1] === "+254712345678"
    ), JSON.stringify(database.calls.filter(({ sql }) => sql.includes("INSERT INTO users"))));
    const kycInsert = database.calls.find(({ sql }) => sql.includes("INSERT INTO kyc_records"));
    assert.ok(kycInsert);
    assert.equal(kycInsert.values[1].includes(Buffer.from("00123456")), false);
    assert.ok(database.calls.some(({ sql }) =>
        sql.includes("INSERT INTO notification_preferences")
    ));
});
