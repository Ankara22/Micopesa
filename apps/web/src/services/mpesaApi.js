import api from "./api";

export async function initiateStkPush({ amount, phoneNumber }) {
    const response = await api.post("/api/mpesa/stkpush", { amount, phoneNumber });
    return response.data.data;
}

export async function getStkPushStatus(statusReference) {
    const response = await api.get(`/api/mpesa/status/${encodeURIComponent(statusReference)}`);
    return response.data.data;
}
