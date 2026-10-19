import api from "./api";

export async function getComplianceOverview() {
    const response = await api.get("/api/regulator/compliance");
    return response.data.data;
}

export async function getComplianceReports() {
    const response = await api.get("/api/regulator/reports");
    return response.data.data;
}
