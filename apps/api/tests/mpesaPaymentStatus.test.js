const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createMpesaStatusController,
} = require("../src/controllers/mpesaController");
const {
    createMpesaPaymentAttemptRepository,
} = require("../src/services/mpesaPaymentAttemptRepository");

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

function createHarness({ ownerId = "worker_001", row = {}, queryError = null } = {}) {
    const calls = [];
    const databasePool = {
        connect() {
            throw new Error("Status lookup must not open a transaction.");
        },
        async query(sql, params) {
            calls.push({ sql, params });
            if (queryError) throw queryError;
            if (
                params[1] !== ownerId ||
                !["attempt_001", "retry-key-001"].includes(params[0])
            ) {
                return { rows: [] };
            }
            return {
                rows: [{
                    attempt_id: "attempt_001",
                    transaction_id: "transaction_001",
                    amount: "2500.00",
                    attempt_status: "OUTCOME_UNKNOWN",
                    transaction_status: "PENDING",
                    contribution_status: "PENDING",
                    checkout_request_id: null,
                    settlement_confirmed: false,
                    receipt_reference: null,
                    settled_at: null,
                    ...row,
                }],
            };
        },
    };
    const repository = createMpesaPaymentAttemptRepository(databasePool);
    return {
        calls,
        controller: createMpesaStatusController(repository),
    };
}

test("worker status lookup returns persisted unknown attempt and pending linked records", async () => {
    const { calls, controller } = createHarness();
    const res = response();
    await controller.getStkPushStatus({
        params: { statusReference: "attempt_001" },
        user: { userId: "worker_001" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, {
        attempt_id: "attempt_001",
        transaction_id: "transaction_001",
        amount: "2500.00",
        attempt_status: "OUTCOME_UNKNOWN",
        transaction_status: "PENDING",
        contribution_status: "PENDING",
        checkout_request_id: null,
        settlement_confirmed: false,
        receipt_reference: null,
        settled_at: null,
    });
    assert.match(calls[0].sql, /a\.attempt_id = \$1 OR a\.checkout_request_id = \$1 OR a\.transaction_id = \$1/);
    assert.match(calls[0].sql, /p\.user_id = \$2/);
    assert.deepEqual(calls[0].params, ["attempt_001", "worker_001"]);
});

test("another worker cannot retrieve the attempt", async () => {
    const { controller } = createHarness();
    const res = response();
    await controller.getStkPushStatus({
        params: { statusReference: "attempt_001" },
        user: { userId: "worker_002" },
    }, res);

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, {
        status: "error",
        message: "Payment was not found for this account",
    });
});

test("status response preserves prompt acceptance without claiming settlement", async () => {
    const { controller } = createHarness({
        row: { attempt_status: "PROMPT_ACCEPTED" },
    });
    const res = response();
    await controller.getStkPushStatus({
        params: { statusReference: "attempt_001" },
        user: { userId: "worker_001" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.attempt_status, "PROMPT_ACCEPTED");
    assert.equal(res.body.data.settlement_confirmed, false);
});

test("status response identifies confirmed settlement and safe receipt reference", async () => {
    const { controller } = createHarness({
        row: {
            attempt_status: "PROMPT_ACCEPTED",
            transaction_status: "COMPLETED",
            contribution_status: "COMPLETED",
            settlement_confirmed: true,
            receipt_reference: "QBC123XYZ",
            settled_at: "2026-11-04T08:00:00.000Z",
        },
    });
    const res = response();
    await controller.getStkPushStatus({
        params: { statusReference: "attempt_001" },
        user: { userId: "worker_001" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.settlement_confirmed, true);
    assert.equal(res.body.data.receipt_reference, "QBC123XYZ");
    assert.equal(res.body.data.settled_at, "2026-11-04T08:00:00.000Z");
    assert.equal(res.body.data.checkout_request_id, null);
    assert.equal("merchant_request_id" in res.body.data, false);
});

test("idempotency-key status lookup is authenticated, worker-scoped, and read-only", async () => {
    const { calls, controller } = createHarness();
    const res = response();
    await controller.getStkPushStatusByIdempotencyKey({
        params: { idempotencyKey: "retry-key-001" },
        user: { userId: "worker_001" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.attempt_id, "attempt_001");
    assert.match(calls[0].sql, /FROM mpesa_payment_attempts a/);
    assert.match(calls[0].sql, /FROM mpesa_payment_verifications/);
    assert.match(calls[0].sql, /a\.idempotency_key = \$1/);
    assert.match(calls[0].sql, /p\.user_id = \$2/);
    assert.deepEqual(calls[0].params, ["retry-key-001", "worker_001"]);
});

test("idempotency-key status lookup hides attempts owned by another worker", async () => {
    const { calls, controller } = createHarness();
    const res = response();
    await controller.getStkPushStatusByIdempotencyKey({
        params: { idempotencyKey: "retry-key-001" },
        user: { userId: "worker_002" },
    }, res);

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, {
        status: "error",
        message: "Payment was not found for this account",
    });
    assert.deepEqual(calls[0].params, ["retry-key-001", "worker_002"]);
});

test("a missing idempotency key is rejected before the status query", async () => {
    const { calls, controller } = createHarness();
    const res = response();
    await controller.getStkPushStatusByIdempotencyKey({
        params: { idempotencyKey: "" },
        user: { userId: "worker_001" },
    }, res);

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, {
        status: "error",
        message: "Invalid payment status reference",
    });
    assert.equal(calls.length, 0);
});

test("an absent idempotency key returns a clear not-found response", async () => {
    const { calls, controller } = createHarness();
    const res = response();
    await controller.getStkPushStatusByIdempotencyKey({
        params: { idempotencyKey: "never-persisted-key" },
        user: { userId: "worker_001" },
    }, res);

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, {
        status: "error",
        message: "Payment was not found for this account",
    });
    assert.deepEqual(calls[0].params, ["never-persisted-key", "worker_001"]);
});

test("idempotency-key status lookup supports simulated attempts", async () => {
    const { controller } = createHarness({
        row: {
            payment_provider: "SIMULATED",
            payment_outcome: "UNKNOWN",
            checkout_request_id: "SIM0123456789ABCDEF012345",
            attempt_status: "OUTCOME_UNKNOWN",
            transaction_status: "PENDING",
            contribution_status: "PENDING",
            settlement_confirmed: false,
        },
    });
    const res = response();
    await controller.getStkPushStatusByIdempotencyKey({
        params: { idempotencyKey: "retry-key-001" },
        user: { userId: "worker_001" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.payment_provider, "SIMULATED");
    assert.equal(res.body.data.payment_outcome, "UNKNOWN");
    assert.equal(res.body.data.checkout_request_id, "SIM0123456789ABCDEF012345");
    assert.equal(res.body.data.settlement_confirmed, false);
});

test("idempotency-key status lookup logs missing payment-attempt table errors", async () => {
    const databaseError = new Error('relation "mpesa_payment_attempts" does not exist');
    databaseError.code = "42P01";
    const { controller } = createHarness({ queryError: databaseError });
    const logs = [];
    const originalConsoleError = console.error;
    console.error = (...args) => logs.push(args);

    try {
        const res = response();
        await controller.getStkPushStatusByIdempotencyKey({
            params: { idempotencyKey: "retry-key-001" },
            user: { userId: "worker_001" },
        }, res);

        assert.equal(res.statusCode, 500);
        assert.equal(logs.length, 1);
        assert.equal(logs[0][0], "Failed to retrieve M-Pesa payment by idempotency key.");
        assert.deepEqual(logs[0][1], {
            code: "42P01",
            message: 'relation "mpesa_payment_attempts" does not exist',
        });
    } finally {
        console.error = originalConsoleError;
    }
});

test("malformed status references receive a safe client error", async () => {
    const { controller, calls } = createHarness();
    const res = response();
    await controller.getStkPushStatus({
        params: { statusReference: "bad reference" },
        user: { userId: "worker_001" },
    }, res);

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, {
        status: "error",
        message: "Invalid payment status reference",
    });
    assert.equal(calls.length, 0);
});
