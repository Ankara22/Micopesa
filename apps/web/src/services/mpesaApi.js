import api from "./api";

const transactionStatuses = new Set([
    "PENDING",
    "COMPLETED",
    "FAILED",
    "REVERSED",
    "CANCELLED",
    "TIMED_OUT",
]);
const contributionStatuses = new Set([
    "PENDING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMED_OUT",
]);
const paymentStatuses = new Set([
    "PENDING",
    "PROMPT_ACCEPTED",
    "OUTCOME_UNKNOWN",
    "FAILED",
    "CANCELLED",
    "TIMED_OUT",
]);
const terminalStatuses = new Set([
    "FAILED",
    "CANCELLED",
    "TIMED_OUT",
]);

function invalidResponse() {
    const error = new Error("Unexpected M-Pesa response.");
    error.code = "INVALID_MPESA_RESPONSE";
    return error;
}

function getResponseData(response) {
    const data = response?.data?.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw invalidResponse();
    }
    return data;
}

export async function initiateStkPush({
    amount,
    phoneNumber,
    idempotencyKey,
    contributionId,
    provider = "DARAJA",
}) {
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
        throw new TypeError("A payment idempotency key is required.");
    }
    const request = { amount, phoneNumber, idempotencyKey };
    if (contributionId) request.contributionId = contributionId;
    const simulated = provider === "SIMULATOR";
    if (!simulated && provider !== "DARAJA") {
        throw new TypeError("Unsupported payment provider.");
    }
    if (simulated) request.provider = provider;
    const response = await api.post(
        simulated ? "/api/mpesa/payments" : "/api/mpesa/stkpush",
        request
    );
    const data = getResponseData(response);
    if (
        typeof data.attempt_id !== "string" ||
        !data.attempt_id ||
        typeof data.transaction_id !== "string" ||
        !data.transaction_id ||
        !transactionStatuses.has(data.transaction_status) ||
        (data.payment_status !== undefined && !paymentStatuses.has(data.payment_status))
    ) {
        throw invalidResponse();
    }
    return data;
}

export async function getPaymentProvider() {
    const response = await api.get("/api/mpesa/provider");
    const data = getResponseData(response);
    if (
        !["DARAJA", "SIMULATOR"].includes(data.provider) ||
        typeof data.simulator_enabled !== "boolean" ||
        (data.provider === "SIMULATOR" && data.simulator_enabled !== true)
    ) {
        throw invalidResponse();
    }
    return data;
}

export async function confirmSimulatedPayment(attemptId) {
    if (typeof attemptId !== "string" || !attemptId.trim()) {
        throw new TypeError("A simulated payment attempt ID is required.");
    }
    const response = await api.post(
        `/api/mpesa/simulator/attempts/${encodeURIComponent(attemptId)}/confirm`,
        { provider: "SIMULATOR" }
    );
    const data = getResponseData(response);
    if (
        data.payment_provider !== "SIMULATED" ||
        data.simulated !== true ||
        typeof data.payment_outcome !== "string"
    ) {
        throw invalidResponse();
    }
    return data;
}

function validatePaymentStatus(data) {
    if (
        typeof data.attempt_id !== "string" ||
        !data.attempt_id ||
        typeof data.transaction_id !== "string" ||
        !data.transaction_id ||
        !paymentStatuses.has(data.attempt_status) ||
        !transactionStatuses.has(data.transaction_status) ||
        !contributionStatuses.has(data.contribution_status) ||
        typeof data.settlement_confirmed !== "boolean" ||
        (data.settlement_confirmed && (
            data.attempt_status === "FAILED" ||
            data.transaction_status !== "COMPLETED" ||
            data.contribution_status !== "COMPLETED"
        )) ||
        (data.settled_at !== null && typeof data.settled_at !== "string") ||
        (data.receipt_reference !== null &&
            (typeof data.receipt_reference !== "string" || data.receipt_reference.length > 25)) ||
        (terminalStatuses.has(data.attempt_status) && data.settlement_confirmed)
    ) {
        throw invalidResponse();
    }
    return data;
}

export async function getStkPushStatus(statusReference) {
    if (typeof statusReference !== "string" || !statusReference.trim()) {
        throw new TypeError("A payment status reference is required.");
    }
    const response = await api.get(`/api/mpesa/status/${encodeURIComponent(statusReference)}`);
    return validatePaymentStatus(getResponseData(response));
}

export async function getStkPushStatusByIdempotencyKey(idempotencyKey) {
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
        throw new TypeError("A payment idempotency key is required.");
    }
    const response = await api.get(
        `/api/mpesa/status/idempotency/${encodeURIComponent(idempotencyKey)}`
    );
    return validatePaymentStatus(getResponseData(response));
}
