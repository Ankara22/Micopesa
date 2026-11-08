const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createMpesaPaymentVerificationService,
} = require("../src/services/mpesaPaymentVerificationService");
const { createMpesaSimulatorService } = require("../src/services/mpesaSimulatorService");

function createWorkflow(outcome) {
    const environment = {
        NODE_ENV: "test",
        MPESA_PAYMENT_PROVIDER: "SIMULATOR",
        MPESA_SIMULATOR_ENABLED: "true",
        MPESA_SIMULATOR_OUTCOME: outcome,
    };
    const attempt = {
        attempt_id: "attempt_sim_001",
        provider_mode: "SIMULATOR",
        user_id: "worker_001",
        checkout_request_id: `SIM${"A".repeat(22)}`,
        merchant_request_id: `SIMM${"A".repeat(21)}`,
        attempt_status: "PROMPT_ACCEPTED",
    };
    const verifications = [];
    const settledAttemptIds = new Set();
    const calls = {
        settlement: 0,
        successfulSettlements: 0,
        contributionCredits: 0,
        balance: 1000,
        simulatorQueries: 0,
        darajaQueries: 0,
        callbackRejections: [],
    };
    let nextVerificationId = 1;
    const paymentAttemptRepository = {
        async findByCheckoutRequestId(checkoutRequestId) {
            return checkoutRequestId === attempt.checkout_request_id ? { ...attempt } : null;
        },
        async findById(attemptId) {
            return attemptId === attempt.attempt_id ? { ...attempt } : null;
        },
        async claimVerification(input) {
            const confirmed = verifications.find((item) =>
                ["VERIFIED_SUCCESS", "VERIFIED_FAILURE"].includes(item.verification_status)
            );
            if (confirmed) {
                return {
                    attempt: { ...attempt },
                    claimed: false,
                    verification: confirmed,
                };
            }
            const verification = {
                verification_id: nextVerificationId++,
                verification_status: "PROCESSING",
                verification_source: "RECONCILIATION",
            };
            verifications.push(verification);
            return { attempt: { ...attempt }, claimed: true, verification };
        },
        async completeVerification(input) {
            const verification = verifications.find(
                (item) => item.verification_id === input.verificationId
            );
            Object.assign(verification, input, {
                verification_status: input.verificationStatus,
            });
            return verification;
        },
    };
    const settlementService = {
        async settleVerifiedPayment({ verificationId }) {
            calls.settlement += 1;
            const evidence = verifications.find((item) => item.verification_id === verificationId);
            if (evidence.verification_status === "VERIFIED_SUCCESS" &&
                !settledAttemptIds.has(attempt.attempt_id)) {
                settledAttemptIds.add(attempt.attempt_id);
                calls.balance += 250;
                calls.contributionCredits += 1;
                calls.successfulSettlements += 1;
                return { alreadySettled: false };
            }
            return { alreadySettled: true };
        },
    };
    const simulator = createMpesaSimulatorService({
        environmentProvider: () => environment,
    });
    const verificationService = createMpesaPaymentVerificationService({
        paymentAttemptRepository,
        simulatorProviderService: {
            async queryStkPush(input) {
                calls.simulatorQueries += 1;
                return simulator.queryStkPush(input);
            },
        },
        providerService: {
            async queryStkPush() {
                calls.darajaQueries += 1;
                assert.fail("simulator confirmation must never query Daraja");
            },
        },
        settlementService,
        callbackInboxRepository: {
            async storeCallback(callback) {
                return {
                    duplicate: false,
                    callback: {
                        callback_id: 1,
                        callback_fingerprint: callback.fingerprint,
                        checkout_request_id: callback.checkoutRequestId,
                        merchant_request_id: callback.merchantRequestId,
                        callback_result_code: callback.resultCode,
                        callback_amount: callback.metadata?.amount ?? null,
                        callback_phone: callback.metadata?.phone ?? null,
                        callback_receipt: callback.metadata?.receipt ?? null,
                        callback_status: "UNMATCHED",
                    },
                };
            },
            async markCorrelated() {},
            async markVerified() {},
            async markRejected(...args) {
                calls.callbackRejections.push(args);
            },
            async listReplayable() { return []; },
        },
    });
    return { attempt, calls, environment, verificationService, verifications };
}

test("successful simulated payment reaches one clearly identified simulated contribution credit", async () => {
    const { attempt, calls, verificationService, verifications } = createWorkflow("SUCCESS");
    const result = await verificationService.confirmSimulatorAttempt(
        attempt.attempt_id,
        attempt.user_id
    );

    assert.equal(result.verification_status, "VERIFIED_SUCCESS");
    assert.equal(result.outcome, "SUCCESS");
    assert.equal(calls.balance, 1250);
    assert.equal(calls.settlement, 1);
    assert.equal(calls.successfulSettlements, 1);
    assert.equal(calls.contributionCredits, 1);
    assert.equal(calls.darajaQueries, 0);
    assert.match(attempt.checkout_request_id, /^SIM[A-F0-9]{22}$/);
    assert.doesNotMatch(attempt.checkout_request_id, /^[A-Z0-9]{10}$/);
    assert.equal(verifications[0].verification_source, "RECONCILIATION");
    assert.equal(verifications[0].verification_status, "VERIFIED_SUCCESS");
    assert.match(verifications[0].providerResultDescription, /^SIMULATED:/);
    assert.match(verifications[0].providerResultDescription, /no real money was transferred/i);
});

test("pending simulated payment remains unverified and does not change the balance", async () => {
    const { attempt, calls, verificationService } = createWorkflow("PENDING");
    const result = await verificationService.confirmSimulatorAttempt(
        attempt.attempt_id,
        attempt.user_id
    );

    assert.equal(result.verification_status, "UNVERIFIED");
    assert.equal(result.outcome, "PENDING");
    assert.equal(result.settlement, null);
    assert.equal(calls.balance, 1000);
    assert.equal(calls.settlement, 0);
    assert.equal(calls.contributionCredits, 0);
});

test("failed simulated payment is verified as failure without settlement or balance increase", async () => {
    const { attempt, calls, verificationService } = createWorkflow("FAILED");
    const result = await verificationService.confirmSimulatorAttempt(
        attempt.attempt_id,
        attempt.user_id
    );

    assert.equal(result.verification_status, "VERIFIED_FAILURE");
    assert.equal(result.outcome, "FAILED");
    assert.ok(result.settlement);
    assert.equal(calls.balance, 1000);
    assert.equal(calls.contributionCredits, 0);
    assert.equal(calls.successfulSettlements, 0);
});

test("unknown simulated payment remains unresolved and can be safely retried", async () => {
    const { attempt, calls, environment, verificationService } = createWorkflow("UNKNOWN");
    const unknown = await verificationService.confirmSimulatorAttempt(
        attempt.attempt_id,
        attempt.user_id
    );
    assert.equal(unknown.verification_status, "UNVERIFIED");
    assert.equal(unknown.outcome, "UNKNOWN");
    assert.equal(calls.balance, 1000);
    assert.equal(calls.contributionCredits, 0);

    environment.MPESA_SIMULATOR_OUTCOME = "SUCCESS";
    const retried = await verificationService.confirmSimulatorAttempt(
        attempt.attempt_id,
        attempt.user_id
    );
    assert.equal(retried.verification_status, "VERIFIED_SUCCESS");
    assert.equal(calls.balance, 1250);
    assert.equal(calls.contributionCredits, 1);
});

test("duplicate simulated confirmations cannot credit a contribution twice", async () => {
    const { attempt, calls, verificationService } = createWorkflow("SUCCESS");
    await verificationService.confirmSimulatorAttempt(attempt.attempt_id, attempt.user_id);
    const duplicate = await verificationService.confirmSimulatorAttempt(
        attempt.attempt_id,
        attempt.user_id
    );

    assert.equal(duplicate.duplicate, true);
    assert.equal(calls.balance, 1250);
    assert.equal(calls.settlement, 2);
    assert.equal(calls.successfulSettlements, 1);
    assert.equal(calls.contributionCredits, 1);
});

test("simulated confirmation is scoped to the owning worker", async () => {
    const { attempt, verificationService } = createWorkflow("SUCCESS");
    await assert.rejects(
        verificationService.confirmSimulatorAttempt(attempt.attempt_id, "different_worker"),
        { statusCode: 404 }
    );
});

test("a synthetic simulator result is never verified through the public Daraja callback path", async () => {
    const { attempt, calls, verificationService } = createWorkflow("SUCCESS");
    const callback = await verificationService.processCallback({
        Body: {
            stkCallback: {
                CheckoutRequestID: attempt.checkout_request_id,
                MerchantRequestID: attempt.merchant_request_id,
                ResultCode: 0,
                ResultDesc: "Processed",
                CallbackMetadata: {
                    Item: [
                        { Name: "Amount", Value: 250 },
                        { Name: "MpesaReceiptNumber", Value: "QAB123XYZ" },
                        { Name: "PhoneNumber", Value: 254712345678 },
                    ],
                },
            },
        },
    });

    assert.equal(callback.verification_status, "INCONSISTENT");
    assert.deepEqual(calls.callbackRejections, [[1, "PROVIDER_MODE_UNRESOLVED_OR_SIMULATOR"]]);
    assert.equal(calls.simulatorQueries, 0);
    assert.equal(calls.settlement, 0);
    assert.equal(calls.balance, 1000);
});
