import api from "./api";

export async function getRetirementPlan() {
    const response = await api.get("/api/retirement/my-plan");
    return response.data.data;
}

export async function updateRetirementPlan(planData) {
    const response = await api.post("/api/retirement/my-plan", planData);
    return response.data.data;
}
