const { createHash } = require("node:crypto");

const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const RESULT_CODE_PATTERN = /^-?\d{1,30}$/;

function verificationInputError(message) {
    const error = new Error(message);
    error.code = "INVALID_MPESA_CALLBACK";
    error.statusCode = 400;
    return error;
}

function parseResultCode(value, fieldName) {
    const code = typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : typeof value === "string"
            ? value
            : "";
    if (!RESULT_CODE_PATTERN.test(code)) {
        throw verificationInputError(`${fieldName} is invalid.`);
    }
    return code;
}

function requireIdentifier(value, fieldName) {
    if (typeof value !== "string" || !ID_PATTERN.test(value)) {
        throw verificationInputError(`${fieldName} is invalid.`);
    }
    return value;
}

function parseCallbackMetadata(callbackResultCode, callbackMetadata) {
    if (callbackResultCode !== "0" && callbackMetadata === undefined) return null;
    if (!callbackMetadata || !Array.isArray(callbackMetadata.Item)) {
        throw verificationInputError("Callback metadata is missing or invalid.");
    }

    const fields = new Map();
    for (const item of callbackMetadata.Item) {
        if (!item || typeof item.Name !== "string" || fields.has(item.Name)) {
            throw verificationInputError("Callback metadata is malformed.");
        }
        fields.set(item.Name, item.Value);
    }

    const amountValue = fields.get("Amount");
    const phoneValue = fields.get("PhoneNumber");
    const receiptValue = fields.get("MpesaReceiptNumber");
    const amount = typeof amountValue === "number" && Number.isSafeInteger(amountValue)
        ? amountValue
        : typeof amountValue === "string" && /^\d+$/.test(amountValue)
            ? Number(amountValue)
            : NaN;
    const phone = typeof phoneValue === "number" && Number.isSafeInteger(phoneValue)
        ? String(phoneValue)
        : typeof phoneValue === "string"
            ? phoneValue
            : "";
    if (
        !Number.isSafeInteger(amount) ||
        amount <= 0 ||
        !/^254[17]\d{8}$/.test(phone) ||
        typeof receiptValue !== "string" ||
        receiptValue.length < 1 ||
        receiptValue.length > 25 ||
        !/^[A-Za-z0-9]+$/.test(receiptValue)
    ) {
        throw verificationInputError("Callback payment metadata is incomplete or invalid.");
    }
    return { amount, phone, receipt: receiptValue };
}

function parseCallback(body) {
    const callback = body?.Body?.stkCallback;
    if (!callback || typeof callback !== "object" || Array.isArray(callback)) {
        throw verificationInputError("Daraja STK callback structure is invalid.");
    }
    const checkoutRequestId = requireIdentifier(callback.CheckoutRequestID, "CheckoutRequestID");
    const merchantRequestId = requireIdentifier(callback.MerchantRequestID, "MerchantRequestID");
    const resultCode = parseResultCode(callback.ResultCode, "ResultCode");
    if (
        typeof callback.ResultDesc !== "string" ||
        callback.ResultDesc.length > 255
    ) {
        throw verificationInputError("ResultDesc is invalid.");
    }
    const metadata = parseCallbackMetadata(resultCode, callback.CallbackMetadata);
    const fingerprint = createHash("sha256")
        .update(JSON.stringify([
            checkoutRequestId,
            merchantRequestId,
            resultCode,
            metadata?.amount ?? null,
            metadata?.phone ?? null,
            metadata?.receipt ?? null,
        ]))
        .digest("hex");
    return {
        checkoutRequestId,
        merchantRequestId,
        resultCode,
        metadata,
        fingerprint,
    };
}

function evaluateVerification(attempt, callback, providerResult) {
    if (
        providerResult.checkoutRequestId !== attempt.checkout_request_id ||
        providerResult.merchantRequestId !== attempt.merchant_request_id
    ) {
        return "INCONSISTENT";
    }

    if (callback) {
        const callbackMatches =
            callback.checkoutRequestId === attempt.checkout_request_id &&
            callback.merchantRequestId === attempt.merchant_request_id;
        const metadataMatches = callback.metadata === null
            ? callback.resultCode !== "0"
            : Number(attempt.expected_amount) === callback.metadata.amount &&
                attempt.mpesa_phone === callback.metadata.phone;
        if (!callbackMatches || !metadataMatches || callback.resultCode !== providerResult.resultCode) {
            return "INCONSISTENT";
        }
        return providerResult.resultCode === "0" ? "VERIFIED_SUCCESS" : "VERIFIED_FAILURE";
    }

    // The attempt's immutable request snapshot is authoritative for amount and phone.
    return providerResult.resultCode === "0" ? "VERIFIED_SUCCESS" : "VERIFIED_FAILURE";
}

function validProviderQueryResult(result) {
    return result &&
        typeof result === "object" &&
        ID_PATTERN.test(result.checkoutRequestId || "") &&
        ID_PATTERN.test(result.merchantRequestId || "") &&
        typeof result.resultCode === "string" &&
        RESULT_CODE_PATTERN.test(result.resultCode) &&
        (result.outcomeStatus === undefined || result.outcomeStatus === "PENDING") &&
        typeof result.resultDescription === "string" &&
        result.resultDescription.length <= 255;
}

async function atPaymentStage(stage, operation) {
    try {
        return await operation();
    } catch (error) {
        if (error && typeof error === "object" && !error.paymentStage) {
            error.paymentStage = stage;
        }
        throw error;
    }
}

function createMpesaPaymentVerificationService({
    paymentAttemptRepository,
    callbackInboxRepository,
    providerService,
    simulatorProviderService,
    settlementService,
}) {
    if (
        !paymentAttemptRepository ||
        typeof paymentAttemptRepository.findByCheckoutRequestId !== "function" ||
        typeof paymentAttemptRepository.findById !== "function" ||
        typeof paymentAttemptRepository.claimVerification !== "function" ||
        typeof paymentAttemptRepository.completeVerification !== "function"
    ) {
        throw new TypeError("A payment-attempt verification repository is required.");
    }
    if (
        !callbackInboxRepository ||
        typeof callbackInboxRepository.storeCallback !== "function" ||
        typeof callbackInboxRepository.markCorrelated !== "function" ||
        typeof callbackInboxRepository.markVerified !== "function" ||
        typeof callbackInboxRepository.markRejected !== "function" ||
        typeof callbackInboxRepository.listReplayable !== "function"
    ) {
        throw new TypeError("A durable M-Pesa callback inbox repository is required.");
    }
    if (!providerService || typeof providerService.queryStkPush !== "function") {
        throw new TypeError("An injected STK Query provider service is required.");
    }
    if (!settlementService || typeof settlementService.settleVerifiedPayment !== "function") {
        throw new TypeError("An authoritative payment settlement service is required.");
    }

    async function settleEvidence(attemptId, verification) {
        if (
            !verification?.verification_id ||
            !["VERIFIED_SUCCESS", "VERIFIED_FAILURE"].includes(verification.verification_status)
        ) {
            return null;
        }
        return atPaymentStage("payment_settlement", () => settlementService.settleVerifiedPayment({
            attemptId,
            verificationId: verification.verification_id,
        }));
    }

    function completeVerification(input) {
        return atPaymentStage(
            "verification_completion",
            () => paymentAttemptRepository.completeVerification(input)
        );
    }

    async function verifyClaim(claim, callback = null, selectedProviderService = providerService) {
        const isSimulatorConfirmation = selectedProviderService === simulatorProviderService;
        if (!claim.claimed) {
            if (
                callback?.callbackId &&
                claim.verification?.verification_id &&
                ["VERIFIED_SUCCESS", "VERIFIED_FAILURE"].includes(
                    claim.verification.verification_status
                )
            ) {
                await callbackInboxRepository.markVerified(
                    callback.callbackId,
                    claim.attempt.attempt_id,
                    claim.verification.verification_id
                );
            }
            const settlement = await settleEvidence(
                claim.attempt.attempt_id,
                claim.verification
            );
            return {
                duplicate: true,
                verification_id: claim.verification?.verification_id ?? null,
                verification_status: claim.verification?.verification_status || "PROCESSING",
                settlement,
            };
        }

        let providerResult;
        try {
            providerResult = await selectedProviderService.queryStkPush({
                checkoutRequestId: claim.attempt.checkout_request_id,
            });
        } catch (_error) {
            const evidence = await completeVerification({
                verificationId: claim.verification.verification_id,
                verificationStatus: "UNVERIFIED",
                ...(isSimulatorConfirmation ? { simulatorOutcome: "UNKNOWN" } : {}),
            });
            return {
                duplicate: false,
                verification_id: evidence.verification_id,
                verification_status: evidence.verification_status,
                ...(isSimulatorConfirmation ? { outcome: "UNKNOWN" } : {}),
                settlement: null,
            };
        }

        if (!validProviderQueryResult(providerResult)) {
            const evidence = await completeVerification({
                verificationId: claim.verification.verification_id,
                verificationStatus: "UNVERIFIED",
                ...(isSimulatorConfirmation ? { simulatorOutcome: "UNKNOWN" } : {}),
            });
            return {
                duplicate: false,
                verification_id: evidence.verification_id,
                verification_status: evidence.verification_status,
                ...(isSimulatorConfirmation ? { outcome: "UNKNOWN" } : {}),
                settlement: null,
            };
        }

        if (providerResult.outcomeStatus === "PENDING") {
            const evidence = await completeVerification({
                verificationId: claim.verification.verification_id,
                verificationStatus: "UNVERIFIED",
                providerResultDescription: providerResult.resultDescription,
                ...(isSimulatorConfirmation ? { simulatorOutcome: "PENDING" } : {}),
            });
            return {
                duplicate: false,
                verification_id: evidence.verification_id,
                verification_status: evidence.verification_status,
                ...(isSimulatorConfirmation ? { outcome: "PENDING" } : {}),
                settlement: null,
            };
        }

        const verificationStatus = evaluateVerification(claim.attempt, callback, providerResult);
        const evidence = await completeVerification({
            verificationId: claim.verification.verification_id,
            verificationStatus,
            providerResultCode: providerResult.resultCode,
            providerResultDescription: providerResult.resultDescription,
            ...(isSimulatorConfirmation ? {
                simulatorOutcome: verificationStatus === "VERIFIED_SUCCESS"
                    ? "SUCCESS"
                    : verificationStatus === "VERIFIED_FAILURE"
                        ? "FAILED"
                        : "UNKNOWN",
            } : {}),
        });
        if (
            callback?.callbackId &&
            ["VERIFIED_SUCCESS", "VERIFIED_FAILURE"].includes(evidence.verification_status)
        ) {
            await callbackInboxRepository.markVerified(
                callback.callbackId,
                claim.attempt.attempt_id,
                evidence.verification_id
            );
        }
        const settlement = await settleEvidence(claim.attempt.attempt_id, evidence);
        return {
            duplicate: false,
            verification_id: evidence.verification_id,
            verification_status: evidence.verification_status,
            ...(isSimulatorConfirmation ? {
                outcome: verificationStatus === "VERIFIED_SUCCESS"
                    ? "SUCCESS"
                    : verificationStatus === "VERIFIED_FAILURE"
                        ? "FAILED"
                        : "UNKNOWN",
            } : {}),
            settlement,
        };
    }

    async function processStoredCallback(storedCallback, duplicate = false) {
        if (storedCallback.callback_status === "REJECTED") {
            return {
                accepted: false,
                duplicate: true,
                verification_status: "INCONSISTENT",
            };
        }

        const attempt = await paymentAttemptRepository.findByCheckoutRequestId(
            storedCallback.checkout_request_id
        );
        if (!attempt) {
            return {
                accepted: true,
                duplicate,
                unmatched: true,
                verification_status: "UNVERIFIED",
            };
        }
        if (attempt.provider_mode !== "DARAJA") {
            await callbackInboxRepository.markRejected(
                storedCallback.callback_id,
                "PROVIDER_MODE_UNRESOLVED_OR_SIMULATOR"
            );
            return {
                accepted: true,
                duplicate,
                verification_status: "INCONSISTENT",
            };
        }
        if (attempt.merchant_request_id !== storedCallback.merchant_request_id) {
            await callbackInboxRepository.markRejected(
                storedCallback.callback_id,
                "PROVIDER_IDENTIFIER_MISMATCH"
            );
            return {
                accepted: true,
                duplicate,
                verification_status: "INCONSISTENT",
            };
        }

        await callbackInboxRepository.markCorrelated(
            storedCallback.callback_id,
            attempt.attempt_id
        );
        const callback = {
            callbackId: storedCallback.callback_id,
            checkoutRequestId: storedCallback.checkout_request_id,
            fingerprint: storedCallback.callback_fingerprint,
            merchantRequestId: storedCallback.merchant_request_id,
            metadata: storedCallback.callback_amount === null
                ? null
                : {
                    amount: Number(storedCallback.callback_amount),
                    phone: storedCallback.callback_phone,
                    receipt: storedCallback.callback_receipt,
                },
            resultCode: storedCallback.callback_result_code,
        };
        const claim = await paymentAttemptRepository.claimVerification({
            attemptId: attempt.attempt_id,
            source: "CALLBACK",
            callbackFingerprint: callback.fingerprint,
            callbackResultCode: callback.resultCode,
            callbackAmountMatches: callback.metadata === null
                ? null
                : Number(attempt.expected_amount) === callback.metadata.amount,
            callbackPhoneMatches: callback.metadata === null
                ? null
                : attempt.mpesa_phone === callback.metadata.phone,
            callbackReceipt: callback.metadata?.receipt ?? null,
            checkoutRequestId: callback.checkoutRequestId,
            merchantRequestId: callback.merchantRequestId,
        });
        const verification = await verifyClaim(claim, callback);
        if (verification.verification_status === "INCONSISTENT") {
            await callbackInboxRepository.markRejected(
                storedCallback.callback_id,
                "INCONSISTENT_PROVIDER_RESULT"
            );
        }
        return {
            accepted: true,
            duplicate,
            ...verification,
        };
    }

    async function processCallback(body) {
        const callback = parseCallback(body);
        const stored = await callbackInboxRepository.storeCallback(callback);
        return processStoredCallback(stored.callback, stored.duplicate);
    }

    async function replayUnmatchedCallbacks(limit = 100) {
        const callbacks = await callbackInboxRepository.listReplayable(limit);
        const results = [];
        for (const callback of callbacks) {
            results.push(await processStoredCallback(callback, true));
        }
        return results;
    }

    async function reconcileAttempt(attemptId) {
        const attempt = await atPaymentStage(
            "attempt_lookup",
            () => paymentAttemptRepository.findById(attemptId)
        );
        if (!attempt) {
            const error = new Error("Payment attempt was not found.");
            error.code = "PAYMENT_ATTEMPT_NOT_FOUND";
            error.statusCode = 404;
            throw error;
        }
        const claim = await paymentAttemptRepository.claimVerification({
            attemptId: attempt.attempt_id,
            source: "RECONCILIATION",
            callbackFingerprint: null,
            checkoutRequestId: attempt.checkout_request_id,
            merchantRequestId: attempt.merchant_request_id,
        });
        return verifyClaim(claim);
    }

    async function confirmSimulatorAttempt(attemptId, workerId) {
        if (!simulatorProviderService || typeof simulatorProviderService.queryStkPush !== "function") {
            throw new TypeError("An injected simulator provider service is required.");
        }
        const attempt = await atPaymentStage(
            "attempt_lookup",
            () => paymentAttemptRepository.findById(attemptId)
        );
        if (!attempt) {
            const error = new Error("Payment attempt was not found.");
            error.code = "PAYMENT_ATTEMPT_NOT_FOUND";
            error.statusCode = 404;
            throw error;
        }
        if (
            attempt.provider_mode !== "SIMULATOR" ||
            !attempt.checkout_request_id?.startsWith("SIM") ||
            !attempt.merchant_request_id?.startsWith("SIMM")
        ) {
            const error = new Error("Payment attempt is not a simulated payment.");
            error.code = "PAYMENT_PROVIDER_MISMATCH";
            error.statusCode = 409;
            throw error;
        }
        if (typeof workerId !== "string" || attempt.user_id !== workerId) {
            const error = new Error("Payment attempt was not found for this worker.");
            error.code = "PAYMENT_ATTEMPT_NOT_FOUND";
            error.statusCode = 404;
            throw error;
        }
        const claim = await atPaymentStage("verification_claim", () =>
            paymentAttemptRepository.claimVerification({
                attemptId: attempt.attempt_id,
                source: "RECONCILIATION",
                callbackFingerprint: null,
                checkoutRequestId: attempt.checkout_request_id,
                merchantRequestId: attempt.merchant_request_id,
            })
        );
        return atPaymentStage("verification_orchestration", () =>
            verifyClaim(claim, null, simulatorProviderService)
        );
    }

    return {
        confirmSimulatorAttempt,
        processCallback,
        reconcileAttempt,
        replayUnmatchedCallbacks,
    };
}

module.exports = {
    createMpesaPaymentVerificationService,
    parseCallback,
};
