function createMpesaPaymentOrchestrationService({
    paymentAttemptRepository,
    providerService,
    amountValidator = require("./mpesaService").validateAmount,
    phoneNormalizer = require("./mpesaService").normalizePhoneNumber,
}) {
    if (!paymentAttemptRepository ||
        typeof paymentAttemptRepository.createPendingMpesaPayment !== "function") {
        throw new TypeError("A payment-attempt repository is required.");
    }
    if (!providerService || typeof providerService.initiateStkPush !== "function") {
        throw new TypeError("An injected M-Pesa provider service is required.");
    }

    async function persistProviderAcceptance(input) {
        const retryableCodes = new Set([
            "40001",
            "40P01",
            "55P03",
            "08000",
            "08003",
            "08006",
            "57P01",
            "ECONNRESET",
            "ECONNREFUSED",
            "ETIMEDOUT",
        ]);
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                return await paymentAttemptRepository.recordDispatchedProviderRequestAccepted(input);
            } catch (error) {
                if (!retryableCodes.has(error?.code) || attempt === 3) throw error;
                await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
            }
        }
        throw new Error("Provider acceptance persistence retry loop exited unexpectedly.");
    }

    function toPendingResult(attempt, { created }) {
        const status = attempt.attempt_status;
        return {
            amount: Number(attempt.expected_amount),
            attempt_id: attempt.attempt_id,
            confirmation_pending: status === "PROMPT_ACCEPTED" || status === "OUTCOME_UNKNOWN",
            contribution_id: attempt.contribution_id,
            created,
            checkout_request_id: attempt.checkout_request_id || null,
            merchant_request_id: attempt.merchant_request_id || null,
            outcome_unknown: status === "OUTCOME_UNKNOWN",
            payment_status: status,
            transaction_id: attempt.transaction_id,
            transaction_status: "PENDING",
        };
    }

    async function dispatchPaymentAttempt(pending, validatedAmount, normalizedPhone) {
        if (!pending.created) return toPendingResult(pending.attempt, { created: false });

        const dispatch = await paymentAttemptRepository.markProviderRequestStarted(
            pending.attempt.attempt_id
        );
        if (!dispatch) {
            const attempt = await paymentAttemptRepository.findById(pending.attempt.attempt_id);
            return toPendingResult(attempt || pending.attempt, { created: false });
        }

        let providerResult;
        try {
            providerResult = await providerService.initiateStkPush({
                amount: validatedAmount,
                phoneNumber: normalizedPhone,
            });
        } catch (error) {
            const definitiveRejection =
                error?.definitiveRejection === true ||
                error?.requestStage === "oauth" ||
                (
                    error?.requestStage === "stk_push" &&
                    (
                        error?.providerResultCode !== undefined ||
                        (error?.providerHttpStatus >= 400 && error?.providerHttpStatus < 500)
                    )
                );
            if (definitiveRejection) {
                const rejected = await paymentAttemptRepository.markProviderRequestRejected({
                    attemptId: pending.attempt.attempt_id,
                    providerResultCode: error.providerResultCode ?? null,
                    providerResultDescription: "M-Pesa did not accept the STK Push request.",
                });
                if (!rejected) {
                    const attempt = await paymentAttemptRepository.findById(
                        pending.attempt.attempt_id
                    );
                    return toPendingResult(attempt || {
                        ...pending.attempt,
                        attempt_status: "OUTCOME_UNKNOWN",
                    }, { created: true });
                }
                return toPendingResult({
                    ...pending.attempt,
                    ...rejected,
                    attempt_status: "FAILED",
                }, { created: true });
            }

            return toPendingResult({
                ...pending.attempt,
                attempt_status: "OUTCOME_UNKNOWN",
            }, { created: true });
        }

        const accepted = await persistProviderAcceptance({
            attemptId: pending.attempt.attempt_id,
            checkoutRequestId: providerResult.checkoutRequestId,
            merchantRequestId: providerResult.merchantRequestId,
            providerResultCode: "0",
        });
        return toPendingResult({
            ...pending.attempt,
            ...accepted,
            attempt_status: "PROMPT_ACCEPTED",
            checkout_request_id: providerResult.checkoutRequestId,
            merchant_request_id: providerResult.merchantRequestId,
        }, { created: true });
    }

    async function initiateWorkerPayment({ workerId, idempotencyKey, amount, phoneNumber }) {
        const validatedAmount = amountValidator(amount);
        const normalizedPhone = phoneNormalizer(phoneNumber);
        const pending = await paymentAttemptRepository.createPendingMpesaPayment({
            workerId,
            idempotencyKey,
            amount: validatedAmount,
            phoneNumber: normalizedPhone,
        });
        return dispatchPaymentAttempt(
            { ...pending, workerId },
            validatedAmount,
            normalizedPhone
        );
    }

    async function retryWorkerPayment({
        workerId,
        contributionId,
        idempotencyKey,
        amount,
        phoneNumber,
    }) {
        if (typeof paymentAttemptRepository.createPaymentAttemptForContribution !== "function") {
            throw new TypeError("An existing-contribution payment attempt repository is required.");
        }
        const validatedAmount = amountValidator(amount);
        const normalizedPhone = phoneNormalizer(phoneNumber);
        const pending = await paymentAttemptRepository.createPaymentAttemptForContribution({
            workerId,
            contributionId,
            idempotencyKey,
            amount: validatedAmount,
            phoneNumber: normalizedPhone,
        });
        return dispatchPaymentAttempt(
            { ...pending, workerId },
            validatedAmount,
            normalizedPhone
        );
    }

    return { initiateWorkerPayment, retryWorkerPayment };
}

module.exports = { createMpesaPaymentOrchestrationService };
