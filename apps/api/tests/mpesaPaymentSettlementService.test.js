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

    const result = await service.settleVerifiedPayment({
        attemptId: "attempt_001",
        verificationId: 1,
    });

    assert.deepEqual(calls, [{ attemptId: "attempt_001", verificationId: 1 }]);
    assert.equal(result, settled);
});
