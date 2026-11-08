function createMpesaPaymentSettlementService({ paymentAttemptRepository }) {
    if (!paymentAttemptRepository ||
        typeof paymentAttemptRepository.settleVerifiedPayment !== "function") {
        throw new TypeError("A payment-attempt settlement repository is required.");
    }

    return {
        settleVerifiedPayment(input) {
            return paymentAttemptRepository.settleVerifiedPayment(input);
        },
    };
}

module.exports = { createMpesaPaymentSettlementService };
