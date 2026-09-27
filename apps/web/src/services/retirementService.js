import api from "./api";

export async function getMyPlan() {
    const res = await api.get("/api/retirement/my-plan");
    return res.data.data;
}

export async function saveMyPlan(payload) {
    const res = await api.post("/api/retirement/my-plan", payload);
    return res.data.data;
}
