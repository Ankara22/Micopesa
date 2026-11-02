import api from "./api";

export async function getMyBalance() {
    const res = await api.get("/api/accounts/my-balance");
    return res.data.data;
}

export async function getMyContributions() {
    const res = await api.get("/api/accounts/my-contributions");
    return res.data.data;
}

export async function initiateMyContribution({ amount, channel, fund_ids }) {
    const res = await api.post("/api/accounts/my-contributions", { amount, channel, fund_ids });
    return res.data;
}
