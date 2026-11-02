import api from "./api";

export async function getFundPerformance() {
    const response = await api.get("/api/fund-manager/performance");
    return response.data.data;
}

export async function getWithdrawalClaims() {
    const response = await api.get("/api/fund-manager/withdrawals");
    return response.data.data;
}

export async function reviewWithdrawal(claimId, decision) {
    const response = await api.patch(`/api/fund-manager/withdrawals/${claimId}/review`, { decision });
    return response.data.data.claim;
}
