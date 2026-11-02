import api from "./api";

function requireRows(response, endpoint) {
    const rows = response?.data?.data;
    if (!Array.isArray(rows)) {
        throw new Error(`Unexpected response from ${endpoint}: expected an array of records.`);
    }
    return rows;
}

async function getRows(endpoint, request) {
    try {
        return requireRows(await request(), endpoint);
    } catch (error) {
        if (error?.message?.startsWith("Unexpected response from ")) throw error;
        const status = Number.isInteger(error?.status) ? ` (HTTP ${error.status})` : "";
        const detail = error?.message || "Unable to reach the server.";
        throw new Error(`${endpoint} failed${status}: ${detail}`, { cause: error });
    }
}

export async function listFunds() {
    const endpoint = "GET /api/funds";
    return getRows(endpoint, () => api.get("/api/funds"));
}

export async function listAvailableFunds() {
    const endpoint = "GET /api/funds/available";
    return getRows(endpoint, () => api.get("/api/funds/available"));
}

export async function getMyAllocations() {
    const endpoint = "GET /api/funds/my-allocations";
    return getRows(endpoint, () => api.get("/api/funds/my-allocations"));
}

export async function replaceMyAllocations(allocations) {
    const response = await api.put("/api/funds/my-allocations", { allocations });
    return response.data.data;
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
    const endpoint = "GET /api/funds/:fundId/allocations";
    return getRows(endpoint, () => api.get(`/api/funds/${fundId}/allocations`));
}
