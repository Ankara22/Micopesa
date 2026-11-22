const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { requireRole } = require("../src/middleware/authMiddleware");
const withdrawalRoutes = require("../src/routes/withdrawalRoutes");
const {
    createWithdrawalPayoutOtpService,
    MAX_SENDS_PER_WINDOW,
    MAX_VERIFY_ATTEMPTS,
    OTP_TTL_MS,
    SEND_COOLDOWN_MS,
} = require("../src/services/withdrawalPayoutOtpService");

const CODE = "123456";
const CLAIM_ID = "claim-otp-1";
const OFFICER_ID = "payout-officer-1";
const WORKER_ID = "worker-1";
const START_TIME = new Date("2026-04-04T12:00:00.000Z");

function createDatabase({ failIssuedWrite = false } = {}) {
    const state = {
        claim: {
            claim_id: CLAIM_ID,
            account_id: "account-1",
            claim_status: "APPROVED",
            amount_requested: "1000.00",
            destination_phone: "+254712345678",
            transaction_id: null,
            processed_at: null,
            account_status: "ACTIVE",
            user_id: WORKER_ID,
            user_status: "ACTIVE",
            user_role: "WORKER",
            full_name: "Test Worker",
            phone: "+254712345678",
            phone_verified_at: START_TIME,
        },
        attempts: [],
        deliveries: [],
        audits: [],
        currentTime: new Date(START_TIME),
        nextAttemptId: 1,
        released: 0,
        commits: 0,
    };

    const client = {
        async query(sql, values = []) {
            const query = sql.replace(/\s+/g, " ").trim();
            if (failIssuedWrite && query.includes("SET status = 'ISSUED'")) {
                throw Object.assign(new Error("simulated delivery update failure"), {
                    code: "08006",
                });
            }
            if (query === "BEGIN" || query === "ROLLBACK") return { rows: [] };
            if (query === "COMMIT") {
                state.commits += 1;
                return { rows: [] };
            }
            if (query.startsWith("SELECT account_id FROM withdrawal_claims")) {
                return { rows: values[0] === state.claim.claim_id
                    ? [{ account_id: state.claim.account_id }]
                    : [] };
            }
            if (query.startsWith("SELECT account_id, user_id, account_status FROM pension_accounts")) {
                const userMatches = values.length < 2 || values[1] === state.claim.user_id;
                return values[0] === state.claim.account_id && userMatches
                    ? { rows: [{
                        account_id: state.claim.account_id,
                        user_id: state.claim.user_id,
                        account_status: state.claim.account_status,
                    }] }
                    : { rows: [] };
            }
            if (query.startsWith("SELECT claim_id, account_id, claim_status")) {
                return values[0] === state.claim.claim_id && values[1] === state.claim.account_id
                    ? { rows: [{
                        claim_id: state.claim.claim_id,
                        account_id: state.claim.account_id,
                        claim_status: state.claim.claim_status,
                        amount_requested: state.claim.amount_requested,
                        destination_phone: state.claim.destination_phone,
                        transaction_id: state.claim.transaction_id,
                        processed_at: state.claim.processed_at,
                    }] }
                    : { rows: [] };
            }
            if (query.startsWith("SELECT user_id, full_name, phone")) {
                return values[0] === state.claim.user_id
                    ? { rows: [{
                        user_id: state.claim.user_id,
                        full_name: state.claim.full_name,
                        phone: state.claim.phone,
                        phone_verified_at: state.claim.phone_verified_at,
                        user_status: state.claim.user_status,
                        user_role: state.claim.user_role,
                    }] }
                    : { rows: [] };
            }
            if (query.startsWith("SELECT authorization_attempt_id, claim_id, worker_user_id")) {
                const attempt = state.attempts.find((item) => item.idempotency_key === values[0]);
                return { rows: attempt ? [{
                    authorization_attempt_id: attempt.authorization_attempt_id,
                    claim_id: attempt.claim_id,
                    worker_user_id: attempt.worker_user_id,
                    status: attempt.status,
                    expires_at: attempt.expires_at,
                    verified_at: attempt.verified_at,
                    last_delivery_error_code: attempt.last_delivery_error_code,
                }] : [] };
            }
            if (query.includes("FROM withdrawal_payout_otp_authorizations") &&
                query.includes("AND status IN (")) {
                const verifyQuery = query.includes("worker_user_id = $2");
                const allowedStatuses = verifyQuery
                    ? ["DELIVERY_PENDING", "ISSUED", "VERIFIED", "EXPIRED", "LOCKED", "DELIVERY_FAILED", "DELIVERY_UNKNOWN"]
                    : ["DELIVERY_PENDING", "ISSUED", "VERIFIED"];
                const matches = state.attempts.filter((item) =>
                    item.claim_id === values[0] && allowedStatuses.includes(item.status)
                );
                if (verifyQuery) {
                    return { rows: matches
                        .filter((item) => item.worker_user_id === values[1])
                        .sort((a, b) => b.created_at - a.created_at)
                        .slice(0, 1)
                        .map((item) => ({
                            authorization_attempt_id: item.authorization_attempt_id,
                            status: item.status,
                            otp_hash: item.otp_hash,
                            otp_salt: item.otp_salt,
                            attempt_count: item.attempt_count,
                            expires_at: item.expires_at,
                            destination_phone_snapshot: item.destination_phone_snapshot,
                            destination_verified_at: item.destination_verified_at,
                        })) };
                }
                return { rows: matches.map((item) => ({
                    authorization_attempt_id: item.authorization_attempt_id,
                    status: item.status,
                    created_at: item.created_at,
                })) };
            }
            if (query.startsWith("SELECT COUNT(*)::int AS send_count")) {
                const since = new Date(values[2]).getTime();
                const matches = state.deliveries.filter((item) =>
                    item.claim_id === values[1] &&
                    item.worker_user_id === values[0] &&
                    item.requested_at.getTime() >= since
                );
                return { rows: [{
                    send_count: matches.length,
                    last_requested_at: matches.length
                        ? new Date(Math.max(...matches.map((item) => item.requested_at.getTime())))
                        : null,
                }] };
            }
            if (query.startsWith("INSERT INTO withdrawal_payout_otp_authorizations")) {
                const [
                    idempotency_key, claim_id, account_id, worker_user_id,
                    initiated_by_user_id, destination_phone_snapshot,
                    destination_verified_at, otp_hash, otp_salt, created_at,
                ] = values;
                const attempt = {
                    authorization_attempt_id: `attempt-${state.nextAttemptId++}`,
                    idempotency_key,
                    claim_id,
                    account_id,
                    worker_user_id,
                    initiated_by_user_id,
                    destination_phone_snapshot,
                    destination_verified_at,
                    otp_hash,
                    otp_salt,
                    status: "DELIVERY_PENDING",
                    attempt_count: 0,
                    created_at: new Date(created_at),
                    expires_at: null,
                    verified_at: null,
                    last_delivery_error_code: null,
                };
                state.attempts.push(attempt);
                return { rows: [{ authorization_attempt_id: attempt.authorization_attempt_id }] };
            }
            if (query.startsWith("INSERT INTO withdrawal_payout_otp_delivery_events")) {
                const [authorization_attempt_id, claim_id, worker_user_id, idempotency_key, requested_at] = values;
                state.deliveries.push({
                    authorization_attempt_id,
                    claim_id,
                    worker_user_id,
                    idempotency_key,
                    requested_at: new Date(requested_at),
                    outcome: "PENDING",
                });
                return { rows: [] };
            }
            if (query.includes("UPDATE withdrawal_payout_otp_authorizations")) {
                const attempt = state.attempts.find((item) =>
                    item.authorization_attempt_id === values[0]
                );
                if (!attempt) return { rows: [] };
                if (query.includes("SET status = 'INVALIDATED'")) {
                    attempt.status = "INVALIDATED";
                    attempt.otp_hash = null;
                    attempt.otp_salt = null;
                } else if (query.includes("SET status = $2, otp_hash = NULL")) {
                    attempt.status = values[1];
                    attempt.otp_hash = null;
                    attempt.otp_salt = null;
                    attempt.last_delivery_error_code = values[2];
                } else if (query.includes("SET status = 'ISSUED'")) {
                    attempt.status = "ISSUED";
                    attempt.issued_at = new Date(values[1]);
                    attempt.expires_at = new Date(values[2]);
                    return { rows: [{ authorization_attempt_id: attempt.authorization_attempt_id }] };
                } else if (query.includes("SET status = 'EXPIRED'")) {
                    attempt.status = "EXPIRED";
                    attempt.otp_hash = null;
                    attempt.otp_salt = null;
                } else if (query.includes("SET attempt_count = $2")) {
                    attempt.attempt_count = values[1];
                    if (values[2]) {
                        attempt.status = "LOCKED";
                        attempt.otp_hash = null;
                        attempt.otp_salt = null;
                    }
                } else if (query.includes("SET status = 'VERIFIED'")) {
                    attempt.status = "VERIFIED";
                    attempt.otp_hash = null;
                    attempt.otp_salt = null;
                    attempt.verified_at = new Date(values[1]);
                }
                return { rows: [] };
            }
            if (query.includes("UPDATE withdrawal_payout_otp_delivery_events")) {
                const event = state.deliveries.find((item) => item.idempotency_key === values[0]);
                if (event) {
                    event.outcome = query.includes("SET outcome = 'PROVIDER_ACCEPTED'")
                        ? "PROVIDER_ACCEPTED"
                        : values[1];
                }
                return { rows: [] };
            }
            if (query.startsWith("INSERT INTO audit_logs")) {
                state.audits.push({
                    userId: values[0],
                    actionType: values[1],
                    entityName: values[2],
                    entityId: values[3],
                    details: JSON.parse(values[4]),
                });
                return { rows: [] };
            }
            throw new Error(`Unexpected mocked SQL: ${query}`);
        },
        release() {
            state.released += 1;
        },
    };

    return {
        state,
        database: {
            async connect() {
                return client;
            },
        },
    };
}

function createService({
    database,
    state,
    sendSms,
    requireOtp = true,
    smsAvailable = true,
} = {}) {
    const sentMessages = [];
    const smsService = {
        getPhoneVerificationSmsConfiguration: () => ({
            available: smsAvailable,
            provider: "MOCK_SMS",
        }),
        async sendPhoneVerificationSms(request) {
            sentMessages.push(request);
            return sendSms ? sendSms(request) : {
                accepted: true,
                status: "PROVIDER_ACCEPTED",
                messageId: "mock-message",
            };
        },
    };
    const service = createWithdrawalPayoutOtpService({
        database,
        smsService,
        settingsLoader: async () => ({ require_otp_on_withdrawal: requireOtp }),
        generateCode: () => CODE,
        hashCode: async () => ({ hash: Buffer.from([1, 2, 3]), salt: Buffer.from([4, 5, 6]) }),
        verifyCode: async (code, salt, hash) =>
            code === CODE && Buffer.isBuffer(salt) && hash.equals(Buffer.from([1, 2, 3])),
        now: () => new Date(state.currentTime),
        environment: { NODE_ENV: "test" },
    });
    return { service, sentMessages };
}

function setup(options = {}) {
    const { failIssuedWrite = false, ...serviceOptions } = options;
    const { state, database } = createDatabase({ failIssuedWrite });
    const { service, sentMessages } = createService({ database, state, ...serviceOptions });
    return { state, service, sentMessages };
}

async function issue(service, idempotencyKey = cryptoKey()) {
    return service.issueOtp({
        claimId: CLAIM_ID,
        payoutOfficerUserId: OFFICER_ID,
        idempotencyKey,
    });
}

function cryptoKey() {
    return `7a8b9c10-1112-4a13-8b14-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`;
}

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

test("valid OTP is single-use, hashed at rest, and leaves the approved claim unpaid", async () => {
    const { state, service, sentMessages } = setup();
    const issued = await issue(service);
    const code = sentMessages[0].message.match(/\b(\d{6})\b/)[1];
    assert.equal(issued.status, "ISSUED");
    assert.equal(issued.expiresAt.getTime() - START_TIME.getTime(), OTP_TTL_MS);
    assert.equal(state.attempts[0].status, "ISSUED");
    assert.equal(state.attempts[0].otp_hash.toString("hex"), "010203");
    assert.notEqual(state.attempts[0].otp_hash.toString(), code);
    assert.equal(JSON.stringify(state.audits).includes(code), false);

    const verified = await service.verifyOtp({ claimId: CLAIM_ID, workerUserId: WORKER_ID, code });
    assert.equal(verified.status, "VERIFIED");
    assert.equal(verified.payoutStatus, "NOT_PROCESSED");
    assert.equal(state.attempts[0].otp_hash, null);
    assert.equal(state.attempts[0].otp_salt, null);
    assert.equal(state.claim.claim_status, "APPROVED");
    assert.equal(state.claim.transaction_id, null);
    assert.equal(state.claim.processed_at, null);
});

test("SMS dispatch starts only after the pending authorization transaction commits", async () => {
    let databaseState;
    const { state, service } = setup({
        sendSms: () => {
            assert.equal(databaseState.commits, 1);
            assert.equal(databaseState.attempts[0].status, "DELIVERY_PENDING");
            return {
                accepted: true,
                status: "PROVIDER_ACCEPTED",
                messageId: "mock-message",
            };
        },
    });
    databaseState = state;

    const issued = await issue(service);

    assert.equal(issued.status, "ISSUED");
    assert.equal(state.commits, 2);
    assert.equal(state.attempts[0].status, "ISSUED");
});

test("accepted SMS cannot authorize while post-commit delivery status remains unknown", async () => {
    const { state, service, sentMessages } = setup({ failIssuedWrite: true });

    await assert.rejects(issue(service), {
        code: "WITHDRAWAL_OTP_DELIVERY_STATUS_UNAVAILABLE",
        statusCode: 503,
    });

    const code = sentMessages[0].message.match(/\b(\d{6})\b/)[1];
    assert.equal(state.commits, 1);
    assert.equal(state.attempts[0].status, "DELIVERY_PENDING");
    assert.ok(state.attempts[0].otp_hash);
    await assert.rejects(
        service.verifyOtp({ claimId: CLAIM_ID, workerUserId: WORKER_ID, code }),
        { code: "WITHDRAWAL_OTP_NOT_ACTIVE", statusCode: 409 }
    );
    assert.equal(state.claim.claim_status, "APPROVED");
    assert.equal(state.claim.transaction_id, null);
});

test("expired OTPs are invalidated and cannot authorize a withdrawal", async () => {
    const { state, service } = setup();
    await issue(service);
    state.currentTime = new Date(START_TIME.getTime() + OTP_TTL_MS);
    await assert.rejects(
        service.verifyOtp({ claimId: CLAIM_ID, workerUserId: WORKER_ID, code: CODE }),
        { code: "WITHDRAWAL_OTP_EXPIRED", statusCode: 410 }
    );
    assert.equal(state.attempts[0].status, "EXPIRED");
    assert.equal(state.attempts[0].otp_hash, null);
    assert.equal(state.claim.claim_status, "APPROVED");
});

test("incorrect codes increment the challenge and lock it at the five-attempt limit", async () => {
    const { state, service } = setup();
    await issue(service);
    for (let count = 1; count <= MAX_VERIFY_ATTEMPTS; count += 1) {
        await assert.rejects(
            service.verifyOtp({ claimId: CLAIM_ID, workerUserId: WORKER_ID, code: "000000" }),
            { code: count === MAX_VERIFY_ATTEMPTS
                ? "WITHDRAWAL_OTP_ATTEMPTS_EXHAUSTED"
                : "WITHDRAWAL_OTP_INCORRECT" }
        );
    }
    assert.equal(state.attempts[0].attempt_count, MAX_VERIFY_ATTEMPTS);
    assert.equal(state.attempts[0].status, "LOCKED");
    assert.equal(state.attempts[0].otp_hash, null);
    assert.equal(state.claim.claim_status, "APPROVED");
});

test("a verified code cannot be reused", async () => {
    const { service } = setup();
    await issue(service);
    await service.verifyOtp({ claimId: CLAIM_ID, workerUserId: WORKER_ID, code: CODE });
    await assert.rejects(
        service.verifyOtp({ claimId: CLAIM_ID, workerUserId: WORKER_ID, code: CODE }),
        { code: "WITHDRAWAL_OTP_ALREADY_USED", statusCode: 409 }
    );
});

test("OTP sends enforce cooldown and the three-per-hour limit", async () => {
    const { state, service, sentMessages } = setup();
    await issue(service, cryptoKey());
    await assert.rejects(
        service.issueOtp({
            claimId: CLAIM_ID,
            payoutOfficerUserId: OFFICER_ID,
            idempotencyKey: cryptoKey(),
            resend: true,
        }),
        { code: "WITHDRAWAL_OTP_COOLDOWN", statusCode: 429 }
    );

    for (let count = 1; count < MAX_SENDS_PER_WINDOW; count += 1) {
        state.currentTime = new Date(state.currentTime.getTime() + SEND_COOLDOWN_MS);
        await service.issueOtp({
            claimId: CLAIM_ID,
            payoutOfficerUserId: OFFICER_ID,
            idempotencyKey: cryptoKey(),
            resend: true,
        });
    }
    state.currentTime = new Date(state.currentTime.getTime() + SEND_COOLDOWN_MS);
    await assert.rejects(
        service.issueOtp({
            claimId: CLAIM_ID,
            payoutOfficerUserId: OFFICER_ID,
            idempotencyKey: cryptoKey(),
            resend: true,
        }),
        { code: "WITHDRAWAL_OTP_SEND_LIMIT", statusCode: 429 }
    );
    assert.equal(sentMessages.length, MAX_SENDS_PER_WINDOW);
    assert.equal(state.deliveries.length, MAX_SENDS_PER_WINDOW);
});

test("idempotent duplicate requests do not send a second SMS", async () => {
    const { service, sentMessages } = setup();
    const idempotencyKey = cryptoKey();
    const first = await issue(service, idempotencyKey);
    const duplicate = await issue(service, idempotencyKey);
    assert.equal(first.authorizationAttemptId, duplicate.authorizationAttemptId);
    assert.equal(duplicate.replayed, true);
    await assert.rejects(issue(service), { code: "WITHDRAWAL_OTP_ALREADY_ACTIVE", statusCode: 409 });
    assert.equal(sentMessages.length, 1);
});

test("stale delivery-pending OTPs are invalidated before a fresh authorization", async () => {
    const { state, service } = setup();
    await issue(service);
    state.attempts[0].status = "DELIVERY_PENDING";
    state.attempts[0].otp_hash = Buffer.from([1, 2, 3]);
    state.attempts[0].otp_salt = Buffer.from([4, 5, 6]);
    state.attempts[0].created_at = new Date(
        state.currentTime.getTime() - OTP_TTL_MS - 1
    );
    state.attempts[0].expires_at = null;
    state.currentTime = new Date(state.currentTime.getTime() + SEND_COOLDOWN_MS);

    const refreshed = await issue(service, cryptoKey());

    assert.equal(state.attempts[0].status, "INVALIDATED");
    assert.equal(state.attempts[0].otp_hash, null);
    assert.equal(refreshed.status, "ISSUED");
    assert.equal(state.attempts.length, 2);
});

test("only the worker who owns the approved claim may verify its OTP", async () => {
    const { service, state } = setup();
    await issue(service);
    await assert.rejects(
        service.verifyOtp({ claimId: CLAIM_ID, workerUserId: "another-worker", code: CODE }),
        { code: "WITHDRAWAL_NOT_FOUND", statusCode: 404 }
    );
    assert.equal(state.attempts[0].status, "ISSUED");
});

test("OTP issuance requires the existing withdrawal OTP setting to be enabled", async () => {
    const { service, sentMessages, state } = setup({ requireOtp: false });
    await assert.rejects(
        issue(service),
        { code: "WITHDRAWAL_OTP_REQUIRED", statusCode: 503 }
    );
    assert.equal(sentMessages.length, 0);
    assert.equal(state.attempts.length, 0);
});

test("OTP issuance fails closed when SMS configuration is incomplete", async () => {
    const { service, sentMessages, state } = setup({ smsAvailable: false });
    await assert.rejects(
        issue(service),
        { code: "WITHDRAWAL_OTP_SMS_CONFIGURATION", statusCode: 503 }
    );
    assert.equal(sentMessages.length, 0);
    assert.equal(state.attempts.length, 0);
});

test("a pending withdrawal cannot enter payout authorization", async () => {
    const { state, service, sentMessages } = setup();
    state.claim.claim_status = "PENDING";
    await assert.rejects(
        issue(service),
        { code: "WITHDRAWAL_NOT_APPROVED", statusCode: 409 }
    );
    assert.equal(sentMessages.length, 0);
    assert.equal(state.attempts.length, 0);
});

test("SMS failure leaves no usable code and keeps the claim approved and unpaid", async () => {
    const { state, service } = setup({
        sendSms: async () => {
            throw Object.assign(new Error("provider unavailable"), { code: "SMS_PROVIDER_UNAVAILABLE" });
        },
    });
    await assert.rejects(
        issue(service),
        { code: "WITHDRAWAL_OTP_DELIVERY_FAILED", statusCode: 503 }
    );
    assert.equal(state.attempts[0].status, "DELIVERY_FAILED");
    assert.equal(state.attempts[0].otp_hash, null);
    assert.equal(state.deliveries[0].outcome, "FAILED");
    assert.equal(state.claim.claim_status, "APPROVED");
    assert.equal(state.claim.transaction_id, null);
    assert.equal(state.claim.processed_at, null);
});

test("an unconfirmed SMS result cannot leave a verifiable OTP", async () => {
    const { state, service } = setup({
        sendSms: async () => ({ accepted: false, status: "UNKNOWN" }),
    });
    await assert.rejects(
        issue(service),
        { code: "WITHDRAWAL_OTP_DELIVERY_UNKNOWN", statusCode: 503 }
    );
    assert.equal(state.attempts[0].status, "DELIVERY_UNKNOWN");
    assert.equal(state.attempts[0].otp_hash, null);
    assert.equal(state.deliveries[0].outcome, "UNKNOWN");
    assert.equal(state.claim.claim_status, "APPROVED");
});

test("verification never calls a payout provider, even when its mock would fail", async () => {
    const { state, service, sentMessages } = setup();
    const payoutProvider = {
        calls: 0,
        async processPayout() {
            this.calls += 1;
            throw new Error("mock payout failure");
        },
    };
    await issue(service);
    await service.verifyOtp({
        claimId: CLAIM_ID,
        workerUserId: WORKER_ID,
        code: CODE,
        payoutProvider,
    });
    assert.equal(payoutProvider.calls, 0);
    assert.equal(sentMessages.length, 1);
    assert.equal(state.claim.claim_status, "APPROVED");
    assert.equal(state.claim.transaction_id, null);
    assert.equal(state.claim.processed_at, null);
});

test("payout authorization routes allow only the dedicated payout role to initiate or resend", () => {
    const routeLayer = withdrawalRoutes.stack.find((layer) =>
        layer.route?.path === "/:claimId/payout-otp"
    );
    assert.ok(routeLayer);
    const roleGuard = routeLayer.route.stack[1].handle;
    let nextCalled = false;
    const denied = createResponse();
    roleGuard({ user: { role: "ADMIN" } }, denied, () => { nextCalled = true; });
    assert.equal(denied.statusCode, 403);
    assert.equal(nextCalled, false);

    const accepted = createResponse();
    roleGuard({ user: { role: "PAYOUT_OFFICER" } }, accepted, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(typeof requireRole, "function");
});

test("schema migration records hashed OTP state and invalidates codes on relevant account changes", () => {
    const databaseDirectory = path.resolve(__dirname, "../../../database");
    const schema = fs.readFileSync(path.join(databaseDirectory, "schema.sql"), "utf8");
    const migration = fs.readFileSync(
        path.join(databaseDirectory, "migration_withdrawal_payout_otp_authorization_forward.sql"),
        "utf8"
    );
    for (const source of [schema, migration]) {
        assert.match(
            source,
            /CREATE TABLE\s+(?:public\.)?withdrawal_payout_otp_authorizations\s*\(/i
        );
        assert.match(source, /otp_hash BYTEA/i);
        assert.match(source, /uq_withdrawal_payout_otp_one_active_per_claim/i);
        assert.match(source, /trg_withdrawal_claims_invalidate_payout_otp/i);
        assert.match(source, /trg_users_invalidate_payout_otp/i);
        assert.match(source, /trg_pension_accounts_invalidate_payout_otp/i);
        assert.match(source, /verified_at = NULL/i);
    }
});
