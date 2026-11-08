const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createMpesaPaymentOrchestrationService,
} = require("../src/services/mpesaPaymentOrchestrationService");

const pendingAttempt = {
    attempt_id: "attempt_001",
    contribution_id: "contribution_001",
    transaction_id: "transaction_001",
    expected_amount: "2500",
    attempt_status: "PENDING",
    checkout_request_id: null,
    merchant_request_id: null,
};

function createHarness({
    existingAttempt = null,
    providerBehavior = async () => ({
        checkoutRequestId: "ws_CO_mock_001",
        merchantRequestId: "mock_merchant_001",
    }),
    acceptedPersistenceError = null,
    acceptedPersistenceErrors = [],
} = {}) {
    const calls = { create: [], retryCreate: [], provider: [], accepted: [], rejected: [], started: [] };
    const persistenceErrors = [...acceptedPersistenceErrors];
    if (acceptedPersistenceError) persistenceErrors.push(acceptedPersistenceError);
    let status = pendingAttempt.attempt_status;
    async function recordAcceptance(input) {
        calls.accepted.push(input);
        const error = persistenceErrors.shift();
        if (error) throw error;
        status = "PROMPT_ACCEPTED";
        return {
            ...pendingAttempt,
            attempt_status: status,
            checkout_request_id: input.checkoutRequestId,
            merchant_request_id: input.merchantRequestId,
        };
    }
    const repository = {
        async createPendingMpesaPayment(input) {
            calls.create.push(input);
            return existingAttempt
                ? { attempt: existingAttempt, created: false }
                : { attempt: { ...pendingAttempt }, created: true };
        },
        async createPaymentAttemptForContribution(input) {
            calls.retryCreate.push(input);
            return existingAttempt
                ? { attempt: existingAttempt, created: false }
                : { attempt: { ...pendingAttempt }, created: true };
        },
        async markProviderRequestStarted(attemptId) {
            calls.started.push(attemptId);
            if (status !== "PENDING") return null;
            status = "OUTCOME_UNKNOWN";
            return { attempt_id: attemptId, attempt_status: status };
        },
        async findById(attemptId) {
            return { ...pendingAttempt, attempt_id: attemptId, attempt_status: status };
        },
        async markProviderRequestRejected(input) {
            calls.rejected.push(input);
            status = "FAILED";
            return { attempt_status: status };
        },
        async recordDispatchedProviderRequestAccepted(input) {
            return recordAcceptance(input);
        },
    };
    const providerService = {
        async initiateStkPush(input) {
            calls.provider.push(input);
            return providerBehavior();
        },
    };
    const service = createMpesaPaymentOrchestrationService({
        paymentAttemptRepository: repository,
        providerService,
        amountValidator(value) {
            if (!Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
                throw new Error("Invalid mocked amount");
            }
            return Number(value);
        },
        phoneNormalizer(value) {
            if (value !== "0712345678" && value !== "254712345678") {
                throw new Error("Invalid mocked phone");
            }
            return "254712345678";
        },
    });
    return { calls, service };
}

function paymentRequest(overrides = {}) {
    return {
        workerId: "worker_001",
        idempotencyKey: "worker-request-001",
        amount: 2500,
        phoneNumber: "0712345678",
        ...overrides,
    };
}

test("accepted prompt persists provider IDs but keeps the transaction pending", async () => {
    const { calls, service } = createHarness();
    const result = await service.initiateWorkerPayment(paymentRequest());

    assert.equal(result.payment_status, "PROMPT_ACCEPTED");
    assert.equal(result.confirmation_pending, true);
    assert.equal(result.transaction_status, "PENDING");
    assert.equal(result.outcome_unknown, false);
    assert.equal(result.checkout_request_id, "ws_CO_mock_001");
    assert.equal(calls.provider.length, 1);
    assert.equal(calls.accepted.length, 1);
    assert.equal(calls.accepted[0].providerResultCode, "0");
    assert.equal(calls.rejected.length, 0);
});

test("definitive provider rejection is recorded as failed, not paid", async () => {
    const rejection = Object.assign(new Error("Provider rejected request"), {
        requestStage: "stk_push",
        providerResultCode: "1032",
    });
    const { calls, service } = createHarness({
        providerBehavior: async () => { throw rejection; },
    });
    const result = await service.initiateWorkerPayment(paymentRequest());

    assert.equal(result.payment_status, "FAILED");
    assert.equal(result.transaction_status, "PENDING");
    assert.equal(result.confirmation_pending, false);
    assert.equal(calls.rejected.length, 1);
    assert.equal(calls.rejected[0].providerResultCode, "1032");
});

test("timeout and ambiguous provider errors remain unknown without retrying", async () => {
    const timeout = Object.assign(new Error("Request timed out"), {
        requestStage: "stk_push",
        code: "ETIMEDOUT",
    });
    const { calls, service } = createHarness({
        providerBehavior: async () => { throw timeout; },
    });
    const result = await service.initiateWorkerPayment(paymentRequest());

    assert.equal(result.payment_status, "OUTCOME_UNKNOWN");
    assert.equal(result.outcome_unknown, true);
    assert.equal(result.confirmation_pending, true);
    assert.equal(result.transaction_status, "PENDING");
    assert.equal(calls.provider.length, 1);
    assert.equal(calls.accepted.length, 0);
});

test("duplicate requests for pending, accepted, or unknown attempts do not call provider again", async () => {
    for (const attemptStatus of ["PENDING", "PROMPT_ACCEPTED", "OUTCOME_UNKNOWN"]) {
        const existingAttempt = {
            ...pendingAttempt,
            attempt_status: attemptStatus,
            checkout_request_id: attemptStatus === "PROMPT_ACCEPTED" ? "ws_CO_existing" : null,
            merchant_request_id: attemptStatus === "PROMPT_ACCEPTED" ? "merchant_existing" : null,
        };
        const { calls, service } = createHarness({ existingAttempt });
        const result = await service.initiateWorkerPayment(paymentRequest());
        assert.equal(result.payment_status, attemptStatus);
        assert.equal(result.created, false);
        assert.equal(calls.provider.length, 0);
        assert.equal(calls.started.length, 0);
    }
});

test("a conflicting idempotency request fails before provider initiation", async () => {
    const conflict = Object.assign(new Error("Key already used"), {
        code: "IDEMPOTENCY_KEY_CONFLICT",
        statusCode: 409,
    });
    const harness = createHarness();
    harness.service = createMpesaPaymentOrchestrationService({
        paymentAttemptRepository: {
            createPendingMpesaPayment: async () => { throw conflict; },
        },
        providerService: { initiateStkPush: async () => assert.fail("provider must not be called") },
        amountValidator: (value) => value,
        phoneNormalizer: (value) => value,
    });
    await assert.rejects(harness.service.initiateWorkerPayment(paymentRequest()), {
        code: "IDEMPOTENCY_KEY_CONFLICT",
    });
});

test("acceptance persistence errors are surfaced and never reclassified as provider failures", async () => {
    const persistenceError = new Error("Could not save provider identifiers");
    const { calls, service } = createHarness({ acceptedPersistenceError: persistenceError });
    await assert.rejects(service.initiateWorkerPayment(paymentRequest()), persistenceError);
    assert.equal(calls.provider.length, 1);
    assert.equal(calls.accepted.length, 1);
    assert.equal(calls.rejected.length, 0);
});

test("retry uses the existing contribution and does not create another provider request on key replay", async () => {
    const { calls, service } = createHarness();
    const request = paymentRequest({ contributionId: "contribution_existing" });
    const first = await service.retryWorkerPayment(request);
    const repeated = await service.retryWorkerPayment(request);

    assert.equal(first.payment_status, "PROMPT_ACCEPTED");
    assert.equal(repeated.payment_status, "PROMPT_ACCEPTED");
    assert.equal(repeated.created, false);
    assert.equal(calls.retryCreate.length, 2);
    assert.equal(calls.retryCreate[0].contributionId, "contribution_existing");
    assert.equal(calls.provider.length, 1);
});

test("accepted provider identifiers are retried only for transient persistence errors", async () => {
    const { calls, service } = createHarness({
        acceptedPersistenceErrors: [
            Object.assign(new Error("serialization failure"), { code: "40001" }),
            Object.assign(new Error("deadlock"), { code: "40P01" }),
        ],
    });
    const result = await service.initiateWorkerPayment(paymentRequest());

    assert.equal(result.payment_status, "PROMPT_ACCEPTED");
    assert.equal(calls.provider.length, 1);
    assert.equal(calls.accepted.length, 3);
    assert.deepEqual(
        calls.accepted.map(({ checkoutRequestId, merchantRequestId }) => ({
            checkoutRequestId,
            merchantRequestId,
        })),
        [
            { checkoutRequestId: "ws_CO_mock_001", merchantRequestId: "mock_merchant_001" },
            { checkoutRequestId: "ws_CO_mock_001", merchantRequestId: "mock_merchant_001" },
            { checkoutRequestId: "ws_CO_mock_001", merchantRequestId: "mock_merchant_001" },
        ]
    );
});

test("initiation validates amount and phone before creating pending records", async () => {
    const { calls, service } = createHarness();
    await assert.rejects(
        service.initiateWorkerPayment(paymentRequest({ amount: 0 })),
        /Invalid mocked amount/
    );
    await assert.rejects(
        service.initiateWorkerPayment(paymentRequest({ phoneNumber: "000" })),
        /Invalid mocked phone/
    );
    assert.equal(calls.create.length, 0);
});
