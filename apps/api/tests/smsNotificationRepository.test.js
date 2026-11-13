const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createSmsNotificationRepository,
} = require("../src/services/smsNotificationRepository");

function copy(value) {
    return JSON.parse(JSON.stringify(value));
}

function createPool(rows, { currentEligibility = true } = {}) {
    const state = {
        rows: copy(rows),
        locks: new Set(),
        statements: [],
        queries: [],
        commits: 0,
        currentEligibility,
    };

    function runQuery(sql, params, heldLocks) {
        const statement = sql.trim();
        state.statements.push(statement);
        state.queries.push({ statement, params: copy(params) });
        if (statement === "BEGIN") return { rows: [] };
        if (statement === "COMMIT") {
            state.commits += 1;
            return { rows: [] };
        }
        if (statement === "ROLLBACK") return { rows: [] };
        if (statement.startsWith("UPDATE notifications") &&
            statement.includes("SET delivery_status = 'UNKNOWN'") &&
            statement.includes("CLAIM_EXPIRED")) {
            const leaseMs = params[0];
            for (const row of state.rows) {
                if (row.delivery_status === "PROCESSING" &&
                    Date.now() - row.claimed_at >= leaseMs) {
                    row.delivery_status = "UNKNOWN";
                    row.claimed_at = null;
                    row.claim_token = null;
                    row.last_error_code = "CLAIM_EXPIRED";
                }
            }
            return { rows: [] };
        }
        if (statement.startsWith("UPDATE notifications n") &&
            statement.includes("NOTIFICATION_RECIPIENT_STALE")) {
            return { rows: [], rowCount: 0 };
        }
        if (statement.startsWith("SELECT n.notification_id") &&
            statement.includes("JOIN notification_preferences")) {
            return {
                rows: state.currentEligibility ? [{ notification_id: params[0] }] : [],
                rowCount: state.currentEligibility ? 1 : 0,
            };
        }
        if (statement.startsWith("SELECT notification_id") &&
            statement.includes("FOR UPDATE SKIP LOCKED")) {
            const [, channels, batchSize] = params;
            const eligible = state.rows.filter((row) =>
                channels.includes(row.notification_type) &&
                row.delivery_status === "PENDING" &&
                row.recipient_phone &&
                row.attempt_count < params[0] &&
                !state.locks.has(row.notification_id)
            ).slice(0, batchSize);
            for (const row of eligible) {
                state.locks.add(row.notification_id);
                heldLocks.add(row.notification_id);
            }
            return { rows: eligible.map(({ notification_id }) => ({ notification_id })) };
        }
        if (statement.startsWith("UPDATE notifications") &&
            statement.includes("SET delivery_status = 'PROCESSING'")) {
            const [claimToken, notificationId] = params;
            const row = state.rows.find((item) => item.notification_id === notificationId);
            if (!row || row.delivery_status !== "PENDING") return { rows: [] };
            row.delivery_status = "PROCESSING";
            row.claimed_at = Date.now();
            row.claim_token = claimToken;
            row.attempt_count += 1;
            row.last_attempt_at = row.claimed_at;
            return {
                rows: [{
                    notification_id: row.notification_id,
                    recipient_phone: row.recipient_phone,
                    message: row.message,
                    attempt_count: row.attempt_count,
                    claim_token: row.claim_token,
                }],
            };
        }

        const notificationId = params[params.length - 2];
        const claimToken = params[params.length - 1];
        const row = state.rows.find((item) =>
            item.notification_id === notificationId &&
            item.claim_token === claimToken &&
            item.delivery_status === "PROCESSING"
        );
        if (!row) return { rows: [], rowCount: 0 };
        if (statement.includes("SET delivery_status = 'PROVIDER_ACCEPTED'")) {
            [row.provider_message_id] = params;
            row.delivery_result = params[1] === null ? null : JSON.parse(params[1]);
            row.delivery_status = "PROVIDER_ACCEPTED";
            row.provider_accepted_at = Date.now();
        } else if (statement.includes("SET delivery_status = 'FAILED'")) {
            [row.last_error_code] = params;
            row.delivery_status = "FAILED";
        } else if (statement.includes("SET delivery_status = 'UNKNOWN'")) {
            [row.last_error_code] = params;
            row.delivery_status = "UNKNOWN";
        } else if (statement.includes("SET delivery_status = $1")) {
            const [status, delayMs, errorCode] = params;
            row.delivery_status = status;
            row.last_error_code = errorCode;
            if (status === "PENDING") row.next_attempt_at = Date.now() + delayMs;
        } else {
            throw new Error(`Unexpected mocked SQL: ${statement}`);
        }
        row.claimed_at = null;
        row.claim_token = null;
        return { rows: [], rowCount: 1 };
    }

    return {
        state,
        async connect() {
            const heldLocks = new Set();
            return {
                query: (sql, params = []) => Promise.resolve(runQuery(sql, params, heldLocks)),
                release() {
                    for (const id of heldLocks) state.locks.delete(id);
                },
            };
        },
        async query(sql, params = []) {
            return runQuery(sql, params, new Set());
        },
    };
}

function pendingNotification(overrides = {}) {
    return {
        notification_id: "notification_001",
        notification_type: "SMS",
        recipient_phone: "+254712345678",
        message: "MicoPesa contribution received",
        delivery_status: "PENDING",
        attempt_count: 0,
        ...overrides,
    };
}

test("claims eligible SMS inside a committed SKIP LOCKED transaction", async () => {
    const pool = createPool([pendingNotification()]);
    const repository = createSmsNotificationRepository(pool);
    const claimed = await repository.claimBatch(10);

    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].attempt_count, 1);
    assert.ok(claimed[0].claim_token);
    assert.equal(pool.state.rows[0].delivery_status, "PROCESSING");
    const select = pool.state.statements.find((sql) => sql.startsWith("SELECT notification_id"));
    assert.match(select, /FOR UPDATE SKIP LOCKED/);
    assert.match(select, /u\.phone_verified_at IS NOT NULL/);
    assert.match(select, /notifications\.recipient_phone/);
    assert.match(select, /admin_request_key IS NOT NULL OR EXISTS/);
    assert.ok(pool.state.statements.some((sql) =>
        sql.startsWith("UPDATE notifications n") &&
        sql.includes("NOTIFICATION_RECIPIENT_STALE")
    ));
    assert.ok(
        pool.state.statements.indexOf("COMMIT") >
        pool.state.statements.findIndex((sql) => sql.startsWith("UPDATE notifications") &&
            sql.includes("SET delivery_status = 'PROCESSING'"))
    );
});

test("revalidates the current verified recipient and preference immediately before dispatch", async () => {
    const repository = createSmsNotificationRepository(createPool([]));
    const notification = {
        notification_id: "email_001",
        notification_type: "EMAIL",
        user_id: "worker_001",
        claim_token: "claim_001",
    };

    for (const condition of [
        "u.account_status = 'ACTIVE'",
        "u.email_verified IS TRUE",
        "lower(u.email) = lower(n.recipient_email)",
        "np.email_enabled IS TRUE",
        "n.admin_request_key IS NOT NULL OR np.email_enabled IS TRUE",
        "n.claim_token = $2",
        "n.delivery_status = 'PROCESSING'",
    ]) {
        const pool = createPool([]);
        const candidateRepository = createSmsNotificationRepository(pool);
        assert.equal(await candidateRepository.isClaimEligible(notification), true);
        assert.match(pool.state.statements[0], new RegExp(condition.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    for (const staleCase of [
        "changed email address",
        "revoked email verification",
        "disabled email preference",
        "missing or inactive user",
        "already completed or lost claim",
    ]) {
        const pool = createPool([], { currentEligibility: false });
        const candidateRepository = createSmsNotificationRepository(pool);
        assert.equal(await candidateRepository.isClaimEligible(notification), false, staleCase);
    }

    assert.equal(await repository.isClaimEligible({
        ...notification,
        notification_type: "PUSH",
    }), false);
});

test("concurrent repository instances cannot claim the same notification", async () => {
    const pool = createPool([pendingNotification()]);
    const first = createSmsNotificationRepository(pool);
    const second = createSmsNotificationRepository(pool);
    const [firstClaim, secondClaim] = await Promise.all([
        first.claimBatch(1),
        second.claimBatch(1),
    ]);

    assert.equal(firstClaim.length + secondClaim.length, 1);
    assert.equal(pool.state.rows[0].attempt_count, 1);
});

test("provider acceptance and message ID persist without marking delivery", async () => {
    const pool = createPool([pendingNotification()]);
    const repository = createSmsNotificationRepository(pool);
    const [claimed] = await repository.claimBatch(1);

    await repository.markProviderAccepted(claimed, {
        messageId: "provider-msg-1",
        deliveryResult: { provider: "MOBILE_SASA" },
    });

    assert.equal(pool.state.rows[0].delivery_status, "PROVIDER_ACCEPTED");
    assert.equal(pool.state.rows[0].provider_message_id, "provider-msg-1");
    assert.deepEqual(pool.state.rows[0].delivery_result, { provider: "MOBILE_SASA" });
    assert.ok(pool.state.rows[0].provider_accepted_at);
    assert.equal(pool.state.rows[0].delivered_at, undefined);
    assert.equal(pool.state.rows[0].claim_token, null);
    const acceptanceQuery = pool.state.queries.find(({ statement }) =>
        statement.includes("SET delivery_status = 'PROVIDER_ACCEPTED'")
    );
    assert.match(acceptanceQuery.statement, /WHERE notification_id = \$3\s+AND claim_token = \$4/);
    assert.deepEqual(acceptanceQuery.params, [
        "provider-msg-1",
        JSON.stringify({ provider: "MOBILE_SASA" }),
        "notification_001",
        claimed.claim_token,
    ]);
    await assert.rejects(
        repository.markUnknown(claimed, "SMS_UNKNOWN_OUTCOME"),
        { code: "SMS_CLAIM_LOST" }
    );
    assert.equal(pool.state.rows[0].delivery_status, "PROVIDER_ACCEPTED");
});

test("expired processing claims become UNKNOWN and are never reclaimed", async () => {
    const pool = createPool([
        pendingNotification({
            delivery_status: "PROCESSING",
            attempt_count: 1,
            claimed_at: Date.now() - 120000,
            claim_token: "expired-token",
        }),
    ]);
    const repository = createSmsNotificationRepository(pool, { claimLeaseMs: 1000 });

    const claimed = await repository.claimBatch(1);

    assert.deepEqual(claimed, []);
    assert.equal(pool.state.rows[0].delivery_status, "UNKNOWN");
    assert.equal(pool.state.rows[0].last_error_code, "CLAIM_EXPIRED");
    assert.equal(pool.state.rows[0].attempt_count, 1);
    assert.equal(pool.state.rows[0].claim_token, null);
});

test("definitive rejection retries only within the configured attempt bound", async () => {
    const pool = createPool([pendingNotification()]);
    const repository = createSmsNotificationRepository(pool, { maxAttempts: 2 });
    const [firstClaim] = await repository.claimBatch(1);
    await repository.retryRejected(firstClaim, {
        errorCode: "SMS_RETRYABLE_REJECTION",
        delayMs: 30000,
    });

    assert.equal(pool.state.rows[0].delivery_status, "PENDING");
    assert.equal(pool.state.rows[0].last_error_code, "SMS_RETRYABLE_REJECTION");
    const [lastClaim] = await repository.claimBatch(1);
    await repository.retryRejected(lastClaim, {
        errorCode: "SMS_RETRYABLE_REJECTION",
        delayMs: 60000,
    });
    assert.equal(pool.state.rows[0].delivery_status, "FAILED");
    assert.equal(pool.state.rows[0].attempt_count, 2);
});
