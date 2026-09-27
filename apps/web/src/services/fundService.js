import api from "./api";

export async function listFunds() {
    const res = await api.get("/api/funds");
    return res.data.data;
}

export async function getFund(fundId) {
    const res = await api.get(`/api/funds/${fundId}`);
    return res.data.data.fund;
}

export async function createFund(payload) {
    const res = await api.post("/api/funds", payload);
    return res.data.data.fund;
}

export async function updateFund(fundId, payload) {
    const res = await api.patch(`/api/funds/${fundId}`, payload);
    return res.data.data.fund;
}

export async function getFundAllocations(fundId) {
    const res = await api.get(`/api/funds/${fundId}/allocations`);
    return res.data.data;
}
