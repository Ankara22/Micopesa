import api from "./api";

export async function listManagerReports() {
    const response = await api.get("/api/compliance-reports");
    return response.data.data;
}

export async function getManagerReport(reportId) {
    const response = await api.get(`/api/compliance-reports/${reportId}`);
    return response.data.data;
}

export async function createDraft(payload) {
    const response = await api.post("/api/compliance-reports", payload);
    return response.data.data.report;
}

export async function updateDraft(reportId, payload) {
    const response = await api.put(`/api/compliance-reports/${reportId}`, payload);
    return response.data.data.report;
}

export async function submitReport(reportId) {
    const response = await api.post(`/api/compliance-reports/${reportId}/submit`);
    return response.data.data;
}

export async function listRegulatorReports(filters = {}) {
    const response = await api.get("/api/regulator/reports", { params: filters });
    return response.data.data;
}

export async function getRegulatorReport(reportId) {
    const response = await api.get(`/api/regulator/reports/${reportId}`);
    return response.data.data;
}

export async function reviewRegulatorReport(reportId, payload) {
    const response = await api.post(`/api/regulator/reports/${reportId}/review`, payload);
    return response.data.data;
}
