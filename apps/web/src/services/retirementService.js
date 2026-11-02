import api from "./api";

export async function getMyPlan() {
    try {
        const res = await api.get("/api/retirement/my-plan");
        return res.data.data;
    } catch (error) {
        if (error.status === 404 && error.data?.code === "RETIREMENT_PLAN_NOT_FOUND") {
            return error.data.data;
        }
        throw error;
    }
}

export async function saveMyPlan(payload) {
    const res = await api.post("/api/retirement/my-plan", payload);
    return res.data.data;
}
