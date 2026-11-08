const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createMpesaPaymentVerificationService,
} = require("../src/services/mpesaPaymentVerificationService");

const expectedAttempt = {
    attempt_id: "attempt_001",
    provider_mode: "DARAJA",
    checkout_request_id: "checkout_001",
    merchant_request_id: "merchant_001",
    expected_amount: "2500.00",
    mpesa_phone: "254712345678",
    attempt_status: "PROMPT_ACCEPTED",
};

function successNotification(overrides = {}) {
    return {
        Body: {
            stkCallback: {
                CheckoutRequestID: "checkout_001",
                MerchantRequestID: "merchant_001",
                ResultCode: 0,
                ResultDesc: "Processed",
                CallbackMetadata: {
                    Item: [
                        { Name: "Amount", Value: 2500 },
                        { Name: "MpesaReceiptNumber", Value: "QAB123XYZ" },
                        { Name: "PhoneNumber", Value: 254712345678 },
                    ],
                },
                ...overrides,
            },
        },
    };
}

function createHarness({
    attempt = expectedAttempt,
    unmatchedInitially = false,
    simulatorProviderService,
    providerBehavior = async () => ({
        checkoutRequestId: "checkout_001",
        merchantRequestId: "merchant_001",
        resultCode: "0",
        resultDescription: "Processed",
    }),
} = {}) {
    const calls = {
        queries: [],
        claims: [],
        completions: [],
        settlements: [],
        inboxWrites: [],
        settlementWrites: 0,
    };
    const verificationRows = new Map();
    const verificationRecords = [];
    const inboxRows = new Map();
    let nextVerificationId = 1;
    let nextCallbackId = 1;
    let processing = false;
    let confirmedEvidence = null;
    let currentAttempt = attempt;
    let attemptAvailable = !unmatchedInitially;
    const repository = {
        async findByCheckoutRequestId(checkoutRequestId) {
            return attemptAvailable && checkoutRequestId === currentAttempt.checkout_request_id
                ? { ...currentAttempt }
                : null;
        },
        async findById(attemptId) {
            return attemptId === currentAttempt.attempt_id ? { ...currentAttempt } : null;
        },
        async claimVerification(input) {
            calls.claims.push(input);
            const existing = input.callbackFingerprint
                ? verificationRows.get(input.callbackFingerprint)
                : null;
            if (existing && ["VERIFIED_SUCCESS", "VERIFIED_FAILURE"].includes(existing.verification_status)) {
                return { claimed: false, verification: existing, attempt: { ...attempt } };
            }
            const lateCallback = input.source === "CALLBACK" &&
                confirmedEvidence?.verification_status === "VERIFIED_SUCCESS" &&
                confirmedEvidence.verification_source === "RECONCILIATION";
            if (confirmedEvidence && !lateCallback) {
                return { claimed: false, verification: confirmedEvidence, attempt: { ...attempt } };
            }
            if (processing) {
                return {
                    claimed: false,
                    verification: { verification_id: nextVerificationId, verification_status: "PROCESSING" },
                    attempt: { ...attempt },
                };
            }
            processing = true;
            const verification = existing || {
                verification_id: nextVerificationId++,
                attempt_id: attempt.attempt_id,
                verification_source: input.source,
                checkout_request_id: input.checkoutRequestId,
                merchant_request_id: input.merchantRequestId,
                callback_result_code: input.callbackResultCode,
                callback_amount_matches: input.callbackAmountMatches,
                callback_phone_matches: input.callbackPhoneMatches,
                callback_receipt: input.callbackReceipt,
                verification_status: "PROCESSING",
            };
            verification.verification_status = "PROCESSING";
            if (input.callbackFingerprint) verificationRows.set(input.callbackFingerprint, verification);
            if (!verificationRecords.includes(verification)) verificationRecords.push(verification);
            return { claimed: true, verification, attempt: { ...attempt } };
        },
        async completeVerification(input) {
            calls.completions.push(input);
            const verification = verificationRecords.find(
                (item) => item.verification_id === input.verificationId
            ) || {
                verification_id: input.verificationId,
                attempt_id: attempt.attempt_id,
            };
            Object.assign(verification, {
                verification_status: input.verificationStatus,
                provider_result_code: input.providerResultCode || null,
                provider_result_description: input.providerResultDescription || null,
            });
            processing = false;
            if (["VERIFIED_SUCCESS", "VERIFIED_FAILURE"].includes(input.verificationStatus)) {
                if (!confirmedEvidence || verification.verification_source === "RECONCILIATION") {
                    confirmedEvidence = verification;
                }
            }
            return { ...verification };
        },
    };
    const providerService = {
        async queryStkPush(input) {
            calls.queries.push(input);
            return providerBehavior();
        },
    };
    const simulatedProviderService = {
        async queryStkPush(input) {
            calls.queries.push(input);
            return providerBehavior();
        },
    };
    const settlementService = {
        async settleVerifiedPayment(input) {
            calls.settlements.push(input);
            return {
                alreadySettled: calls.settlements.filter(
                    (entry) => entry.attemptId === input.attemptId
                ).length > 1,
                contribution_status: "COMPLETED",
                transaction_status: "COMPLETED",
            };
        },
    };
    const callbackInboxRepository = {
        async storeCallback(callback) {
            calls.inboxWrites.push("store");
            let record = inboxRows.get(callback.fingerprint);
            const duplicate = Boolean(record);
            if (!record) {
                record = {
                    callback_id: nextCallbackId++,
                    callback_fingerprint: callback.fingerprint,
                    checkout_request_id: callback.checkoutRequestId,
                    merchant_request_id: callback.merchantRequestId,
                    callback_result_code: callback.resultCode,
                    callback_amount: callback.metadata?.amount ?? null,
                    callback_phone: callback.metadata?.phone ?? null,
                    callback_receipt: callback.metadata?.receipt ?? null,
                    callback_status: "UNMATCHED",
                    attempt_id: null,
                    verification_id: null,
                    rejection_code: null,
                    duplicate_count: 0,
                };
                inboxRows.set(callback.fingerprint, record);
            } else {
                record.duplicate_count += 1;
            }
            return { callback: { ...record }, duplicate };
        },
        async markCorrelated(callbackId, attemptId) {
            const record = [...inboxRows.values()].find((item) => item.callback_id === callbackId);
            if (record.callback_status === "UNMATCHED") {
                record.callback_status = "CORRELATED";
                record.attempt_id = attemptId;
            }
            return { ...record };
        },
        async markVerified(callbackId, attemptId, verificationId) {
            const record = [...inboxRows.values()].find((item) => item.callback_id === callbackId);
            record.callback_status = "VERIFIED";
            record.attempt_id = attemptId;
            record.verification_id = verificationId;
            return { ...record };
        },
        async markRejected(callbackId, rejectionCode) {
            const record = [...inboxRows.values()].find((item) => item.callback_id === callbackId);
            record.callback_status = "REJECTED";
            record.rejection_code = rejectionCode;
            return { ...record };
        },
        async listReplayable() {
            return [...inboxRows.values()]
                .filter((item) => ["UNMATCHED", "CORRELATED"].includes(item.callback_status))
                .map((item) => ({ ...item }));
        },
    };
    return {
        calls,
        inboxRows,
        setAttempt(value) {
            currentAttempt = value;
            attemptAvailable = true;
        },
        service: createMpesaPaymentVerificationService({
            paymentAttemptRepository: repository,
            callbackInboxRepository,
            providerService,
            simulatorProviderService: simulatorProviderService || simulatedProviderService,
            settlementService,
        }),
    };
}

test("matching success callback is verified only after matching STK Query confirmation", async () => {
    const { calls, service } = createHarness();
    const result = await service.processCallback(successNotification());

    assert.deepEqual(result, {
        accepted: true,
        duplicate: false,
        verification_id: 1,
        verification_status: "VERIFIED_SUCCESS",
        settlement: {
            alreadySettled: false,
            contribution_status: "COMPLETED",
            transaction_status: "COMPLETED",
        },
    });
    assert.deepEqual(calls.queries, [{ checkoutRequestId: "checkout_001" }]);
    assert.equal(calls.completions[0].verificationStatus, "VERIFIED_SUCCESS");
    assert.equal(calls.settlements.length, 1);
    assert.equal(calls.settlementWrites, 0);
});

test("forged success notification cannot override unsuccessful provider query evidence", async () => {
    const { calls, service } = createHarness({
        providerBehavior: async () => ({
            checkoutRequestId: "checkout_001",
            merchantRequestId: "merchant_001",
            resultCode: "1032",
            resultDescription: "Cancelled",
        }),
    });
    const result = await service.processCallback(successNotification());

    assert.equal(result.verification_status, "INCONSISTENT");
    assert.notEqual(result.verification_status, "VERIFIED_SUCCESS");
    assert.equal(calls.completions[0].verificationStatus, "INCONSISTENT");
    assert.equal(calls.settlementWrites, 0);
});

test("failed callback is verified as failure only when STK Query confirms the same result", async () => {
    const { calls, service } = createHarness({
        providerBehavior: async () => ({
            checkoutRequestId: "checkout_001",
            merchantRequestId: "merchant_001",
            resultCode: "1032",
            resultDescription: "Cancelled",
        }),
    });
    const result = await service.processCallback({
        Body: {
            stkCallback: {
                CheckoutRequestID: "checkout_001",
                MerchantRequestID: "merchant_001",
                ResultCode: 1032,
                ResultDesc: "Cancelled",
            },
        },
    });

    assert.equal(result.verification_status, "VERIFIED_FAILURE");
    assert.equal(calls.completions[0].verificationStatus, "VERIFIED_FAILURE");
    assert.equal(calls.settlements.length, 1);
});

test("unknown checkout is durably retained and mismatched merchant IDs are rejected", async () => {
    const unknown = createHarness();
    const unknownResult = await unknown.service.processCallback(
        successNotification({ CheckoutRequestID: "checkout_missing" })
    );
    assert.deepEqual(unknownResult, {
        accepted: true,
        duplicate: false,
        unmatched: true,
        verification_status: "UNVERIFIED",
    });
    assert.equal(unknown.inboxRows.size, 1);
    assert.equal([...unknown.inboxRows.values()][0].callback_status, "UNMATCHED");

    const { calls, service } = createHarness();
    const result = await service.processCallback(
        successNotification({ MerchantRequestID: "merchant_forged" })
    );
    assert.deepEqual(result, {
        accepted: true,
        duplicate: false,
        verification_status: "INCONSISTENT",
    });
    assert.equal(calls.queries.length, 0);
    assert.equal(calls.claims.length, 0);
});

test("durably stored unmatched callbacks can be replayed after exact provider IDs appear", async () => {
    const { calls, inboxRows, service, setAttempt } = createHarness({ unmatchedInitially: true });
    const callbackResult = await service.processCallback(successNotification());
    assert.equal(callbackResult.unmatched, true);

    setAttempt(expectedAttempt);
    const replay = await service.replayUnmatchedCallbacks();

    assert.equal(replay.length, 1);
    assert.equal(replay[0].verification_status, "VERIFIED_SUCCESS");
    assert.equal([...inboxRows.values()][0].callback_status, "VERIFIED");
    assert.equal(calls.queries.length, 1);
    assert.equal(calls.settlements.length, 1);
});

test("callback amount and phone must match the persisted attempt", async () => {
    for (const metadataValue of [
        { Name: "Amount", Value: 1 },
        { Name: "PhoneNumber", Value: 254712345679 },
    ]) {
        const { service } = createHarness();
        const body = successNotification();
        const item = body.Body.stkCallback.CallbackMetadata.Item.find(
            (entry) => entry.Name === metadataValue.Name
        );
        item.Value = metadataValue.Value;
        const result = await service.processCallback(body);
        assert.equal(result.verification_status, "INCONSISTENT");
    }
});

test("missing success callback metadata is rejected before provider query", async () => {
    const { calls, service } = createHarness();
    await assert.rejects(
        service.processCallback({
            Body: {
                stkCallback: {
                    CheckoutRequestID: "checkout_001",
                    MerchantRequestID: "merchant_001",
                    ResultCode: 0,
                    ResultDesc: "Processed",
                },
            },
        }),
        { code: "INVALID_MPESA_CALLBACK", statusCode: 400 }
    );
    assert.equal(calls.queries.length, 0);
});

test("duplicate callback delivery is idempotent and does not issue another query", async () => {
    const { calls, service } = createHarness();
    const payload = successNotification();
    const first = await service.processCallback(payload);
    const duplicate = await service.processCallback(payload);

    assert.equal(first.verification_status, "VERIFIED_SUCCESS");
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.verification_status, "VERIFIED_SUCCESS");
    assert.equal(calls.queries.length, 1);
    assert.equal(calls.settlements.length, 2);
});

test("concurrent duplicate callback delivery shares one provider query", async () => {
    let releaseQuery;
    const queryWait = new Promise((resolve) => { releaseQuery = resolve; });
    const { calls, service } = createHarness({
        providerBehavior: async () => {
            await queryWait;
            return {
                checkoutRequestId: "checkout_001",
                merchantRequestId: "merchant_001",
                resultCode: "0",
                resultDescription: "Processed",
            };
        },
    });
    const payload = successNotification();
    const firstPromise = service.processCallback(payload);
    await new Promise((resolve) => setImmediate(resolve));
    const second = await service.processCallback(payload);
    releaseQuery();
    const first = await firstPromise;

    assert.equal(first.verification_status, "VERIFIED_SUCCESS");
    assert.equal(second.duplicate, true);
    assert.equal(calls.queries.length, 1);
});

test("STK Query timeouts and provider outages remain unverified", async () => {
    for (const error of [new Error("timeout"), Object.assign(new Error("unavailable"), { statusCode: 503 })]) {
        const { calls, service } = createHarness({
            providerBehavior: async () => { throw error; },
        });
        const result = await service.processCallback(successNotification());
        assert.equal(result.verification_status, "UNVERIFIED");
        assert.equal(calls.completions[0].verificationStatus, "UNVERIFIED");
    }
});

test("reconciliation queries prompt-accepted and unknown attempts without creating another STK Push", async () => {
    for (const attemptStatus of ["PROMPT_ACCEPTED", "OUTCOME_UNKNOWN"]) {
        const attempt = { ...expectedAttempt, attempt_status: attemptStatus };
        const { calls, service } = createHarness({ attempt });
        const result = await service.reconcileAttempt(attempt.attempt_id);

        assert.equal(result.verification_status, "VERIFIED_SUCCESS");
        assert.deepEqual(calls.queries, [{ checkoutRequestId: "checkout_001" }]);
        assert.equal(Object.hasOwn(calls, "stkPushes"), false);
        assert.equal(calls.settlements.length, 1);
    }
});

test("reconciliation verifies query-only success and repeated reconciliation is idempotent", async () => {
    const { calls, service } = createHarness();
    const first = await service.reconcileAttempt(expectedAttempt.attempt_id);
    const repeated = await service.reconcileAttempt(expectedAttempt.attempt_id);

    assert.equal(first.verification_status, "VERIFIED_SUCCESS");
    assert.equal(repeated.verification_status, "VERIFIED_SUCCESS");
    assert.equal(repeated.duplicate, true);
    assert.equal(calls.queries.length, 1);
    assert.equal(calls.settlements.length, 2);
});

test("simulator confirmation records query-only success and settles the existing attempt", async () => {
    const attempt = {
        ...expectedAttempt,
        provider_mode: "SIMULATOR",
        checkout_request_id: `SIM${"A".repeat(22)}`,
        merchant_request_id: `SIMM${"A".repeat(21)}`,
        user_id: "worker_001",
    };
    const { calls, service } = createHarness({
        attempt,
        providerBehavior: async () => ({
            checkoutRequestId: attempt.checkout_request_id,
            merchantRequestId: attempt.merchant_request_id,
            resultCode: "0",
            resultDescription: "SIMULATED: Payment succeeded.",
        }),
    });

    const result = await service.confirmSimulatorAttempt(attempt.attempt_id, "worker_001");

    assert.equal(result.verification_status, "VERIFIED_SUCCESS");
    assert.equal(result.outcome, "SUCCESS");
    assert.deepEqual(calls.claims[0], {
        attemptId: attempt.attempt_id,
        source: "RECONCILIATION",
        callbackFingerprint: null,
        checkoutRequestId: attempt.checkout_request_id,
        merchantRequestId: attempt.merchant_request_id,
    });
    assert.deepEqual(calls.completions[0], {
        verificationId: 1,
        verificationStatus: "VERIFIED_SUCCESS",
        providerResultCode: "0",
        providerResultDescription: "SIMULATED: Payment succeeded.",
        simulatorOutcome: "SUCCESS",
    });
    assert.deepEqual(calls.settlements, [{
        attemptId: attempt.attempt_id,
        verificationId: 1,
    }]);
});

test("query-only verification requires exact identifiers and final ResultCode zero", async () => {
    const providerResponses = [
        { checkoutRequestId: "checkout_other", merchantRequestId: "merchant_001", resultCode: "0", resultDescription: "Processed" },
        { checkoutRequestId: "checkout_001", merchantRequestId: "merchant_other", resultCode: "0", resultDescription: "Processed" },
        { checkoutRequestId: "checkout_001", merchantRequestId: "merchant_001", resultCode: undefined, resultDescription: "Accepted", responseCode: "0" },
    ];
    for (const providerResult of providerResponses) {
        const { calls, service } = createHarness({
            providerBehavior: async () => providerResult,
        });
        const result = await service.reconcileAttempt(expectedAttempt.attempt_id);
        assert.notEqual(result.verification_status, "VERIFIED_SUCCESS");
        assert.equal(calls.settlements.length, 0);
    }
});

test("late matching callback enriches query-only settlement evidence without resettling", async () => {
    const { calls, service } = createHarness();
    const reconciliation = await service.reconcileAttempt(expectedAttempt.attempt_id);
    const callback = await service.processCallback(successNotification());

    assert.equal(reconciliation.verification_status, "VERIFIED_SUCCESS");
    assert.equal(callback.verification_status, "VERIFIED_SUCCESS");
    assert.equal(calls.queries.length, 2);
    assert.equal(calls.settlements.length, 2);
    assert.equal(calls.settlements[0].verificationId, 1);
    assert.equal(calls.settlements[1].verificationId, 2);
});

test("conflicting late callback remains inconsistent and cannot trigger settlement", async () => {
    const { calls, service } = createHarness();
    await service.reconcileAttempt(expectedAttempt.attempt_id);
    const callback = successNotification();
    callback.Body.stkCallback.CallbackMetadata.Item.find((item) => item.Name === "Amount").Value = 2501;
    const result = await service.processCallback(callback);

    assert.equal(result.verification_status, "INCONSISTENT");
    assert.equal(calls.settlements.length, 1);
});

test("STK Query timeout and ambiguous provider response never settle", async () => {
    for (const providerBehavior of [
        async () => { throw new Error("query timeout"); },
        async () => ({ checkoutRequestId: "checkout_001", merchantRequestId: "merchant_001", resultDescription: "Accepted" }),
    ]) {
        const { calls, service } = createHarness({ providerBehavior });
        const result = await service.reconcileAttempt(expectedAttempt.attempt_id);
        assert.equal(result.verification_status, "UNVERIFIED");
        assert.equal(calls.settlements.length, 0);
    }
});

test("reconciliation retains confirmed failure evidence and never settles financial records", async () => {
    const attempt = { ...expectedAttempt, attempt_status: "OUTCOME_UNKNOWN" };
    const { calls, service } = createHarness({
        attempt,
        providerBehavior: async () => ({
            checkoutRequestId: "checkout_001",
            merchantRequestId: "merchant_001",
            resultCode: "1037",
            resultDescription: "Timed out",
        }),
    });
    const result = await service.reconcileAttempt(attempt.attempt_id);

    assert.equal(result.verification_status, "VERIFIED_FAILURE");
    assert.equal(calls.settlementWrites, 0);
    assert.equal(calls.completions.some((entry) => /transaction|contribution|balance/i.test(entry.table || "")), false);
});

test("malformed notification structure is rejected without logging or provider activity", async () => {
    const { calls, service } = createHarness();
    await assert.rejects(service.processCallback({ Body: {} }), {
        code: "INVALID_MPESA_CALLBACK",
    });
    assert.equal(calls.queries.length, 0);
});
