import api from "./api";

export async function getEligibility() {
    const res = await api.get("/api/withdrawals/eligibility");
    return res.data.data;
}

export async function submitClaim(payload) {
    const res = await api.post("/api/withdrawals", payload);
    return res.data.data;
}

export async function getMyClaims() {
    const res = await api.get("/api/withdrawals/my-claims");
    return res.data.data;
}

export async function getPendingClaims() {
    const res = await api.get("/api/withdrawals/pending");
    return res.data.data;
}

export async function approveClaim(claimId) {
    const res = await api.patch(`/api/withdrawals/${claimId}/approve`);
    return res.data.data;
}

export async function rejectClaim(claimId) {
    const res = await api.patch(`/api/withdrawals/${claimId}/reject`);
    return res.data.data;
}

export async function getPayoutAuthorizationQueue() {
    const res = await api.get("/api/withdrawals/payout/authorizations");
    return res.data.data;
}

export async function initiatePayoutOtp(claimId, idempotencyKey) {
    const res = await api.post(
        `/api/withdrawals/${claimId}/payout-otp`,
        {},
        { headers: { "Idempotency-Key": idempotencyKey } }
    );
    return res.data.data;
}

export async function resendPayoutOtp(claimId, idempotencyKey) {
    const res = await api.post(
        `/api/withdrawals/${claimId}/payout-otp/resend`,
        {},
        { headers: { "Idempotency-Key": idempotencyKey } }
    );
    return res.data.data;
}

export async function verifyPayoutOtp(claimId, code) {
    const res = await api.post(`/api/withdrawals/${claimId}/payout-otp/verify`, { code });
    return res.data.data;
}
