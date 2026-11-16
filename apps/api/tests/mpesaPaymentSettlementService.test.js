const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createMpesaPaymentSettlementService,
} = require("../src/services/mpesaPaymentSettlementService");

test("settlement service delegates without sending SMS directly", async () => {
    const calls = [];
    const settled = {
        attempt_id: "attempt_001",
        alreadySettled: false,
        contribution_status: "COMPLETED",
        transaction_status: "COMPLETED",
    };
    const service = createMpesaPaymentSettlementService({
        paymentAttemptRepository: {
            async settleVerifiedPayment(input) {
                calls.push(input);
                return settled;
            },
        },
    });

    test("settlement forwards its injected environment provider to the repository", async () => {
        const environmentProvider = () => ({
            MPESA_LEDGER_ENFORCEMENT_ENABLED: "true",
        });
        let repositoryEnvironmentProvider;
        const service = createMpesaPaymentSettlementService({
            paymentAttemptRepository: {
                async settleVerifiedPayment(_input, options) {
                    repositoryEnvironmentProvider = options.environmentProvider;
                    return { alreadySettled: true };
                },
            },
            environmentProvider,
        });

        await service.settleVerifiedPayment({
            attemptId: "attempt_001",
            verificationId: 1,
        });

        assert.equal(repositoryEnvironmentProvider, environmentProvider);
    });

    const result = await service.settleVerifiedPayment({
        attemptId: "attempt_001",
        verificationId: 1,
    });

    assert.deepEqual(calls, [{ attemptId: "attempt_001", verificationId: 1 }]);
    assert.equal(result, settled);
});

test("enqueues contribution notification only after newly confirmed settlement commits", async () => {
    const calls = [];
    const service = createMpesaPaymentSettlementService({
        paymentAttemptRepository: {
            async settleVerifiedPayment(input) {
                calls.push(["settlement_start", input]);
                calls.push(["commit"]);
                return {
                    attempt_id: "attempt_001",
                    alreadySettled: false,
                    contribution_id: "contribution_001",
                    contribution_status: "COMPLETED",
                    transaction_status: "COMPLETED",
                    user_id: "worker_001",
                    verification_status: "VERIFIED_SUCCESS",
                };
            },
        },
        async enqueueBusinessNotification(input) {
            calls.push(["notification", input]);
        },
    });

    const result = await service.settleVerifiedPayment({
        attemptId: "attempt_001",
        verificationId: 1,
    });

    assert.deepEqual(calls, [
        ["settlement_start", { attemptId: "attempt_001", verificationId: 1 }],
        ["commit"],
        ["notification", {
            userId: "worker_001",
            eventType: "CONTRIBUTION_CONFIRMED",
            referenceId: "contribution_001",
        }],
    ]);
    assert.equal(result.alreadySettled, false);
});

test("simulated settlement queues an explicitly simulated essential confirmation", async () => {
    const notifications = [];
    const service = createMpesaPaymentSettlementService({
        paymentAttemptRepository: {
            async settleVerifiedPayment() {
                return {
                    alreadySettled: false,
                    contribution_id: "contribution_simulated",
                    contribution_status: "COMPLETED",
                    transaction_status: "COMPLETED",
                    user_id: "worker_001",
                    verification_status: "VERIFIED_SUCCESS",
                    provider_mode: "SIMULATOR",
                };
            },
        },
        async enqueueBusinessNotification(input) {
            notifications.push(input);
        },
    });

    await service.settleVerifiedPayment({ attemptId: "attempt_simulated" });

    assert.deepEqual(notifications, [{
        userId: "worker_001",
        eventType: "CONTRIBUTION_CONFIRMED",
        referenceId: "contribution_simulated",
        simulated: true,
    }]);
});

test("does not enqueue notifications for failed, pending, unverified, or duplicate settlement", async () => {
    const notifications = [];
    const results = [
        {
            alreadySettled: false,
            contribution_status: "PENDING",
            transaction_status: "PENDING",
            user_id: "worker_001",
            contribution_id: "contribution_pending",
            verification_status: "UNVERIFIED",
        },
        {
            alreadySettled: false,
            contribution_status: "FAILED",
            transaction_status: "FAILED",
            user_id: "worker_001",
            contribution_id: "contribution_failed",
            verification_status: "VERIFIED_FAILURE",
        },
        {
            alreadySettled: true,
            contribution_status: "COMPLETED",
            transaction_status: "COMPLETED",
            user_id: "worker_001",
            contribution_id: "contribution_duplicate",
            verification_status: "VERIFIED_SUCCESS",
        },
        {
            alreadySettled: false,
            contribution_status: "COMPLETED",
            transaction_status: "COMPLETED",
            verification_status: "VERIFIED_SUCCESS",
        },
    ];
    const service = createMpesaPaymentSettlementService({
        paymentAttemptRepository: {
            async settleVerifiedPayment() {
                return results.shift();
            },
        },
        async enqueueBusinessNotification(input) {
            notifications.push(input);
        },
    });

    for (let index = 0; index < 4; index += 1) {
        await service.settleVerifiedPayment({ attemptId: `attempt_${index}` });
    }

    assert.deepEqual(notifications, []);
});

test("notification failure cannot mask a committed settlement result", async () => {
    const logs = [];
    const settled = {
        attempt_id: "attempt_001",
        alreadySettled: false,
        contribution_id: "contribution_001",
        contribution_status: "COMPLETED",
        transaction_status: "COMPLETED",
        user_id: "worker_001",
        verification_status: "VERIFIED_SUCCESS",
    };
    const service = createMpesaPaymentSettlementService({
        paymentAttemptRepository: {
            async settleVerifiedPayment() {
                return settled;
            },
        },
        async enqueueBusinessNotification() {
            throw Object.assign(new Error("offline notification mock failure"), {
                code: "DB_ERROR",
            });
        },
        logger: { error(...args) { logs.push(args); } },
    });

    assert.equal(
        await service.settleVerifiedPayment({ attemptId: "attempt_001" }),
        settled
    );
    assert.deepEqual(logs, [[
        "Settled contribution notification could not be enqueued.",
        { code: "NOTIFICATION_ENQUEUE_FAILED" },
    ]]);
});
