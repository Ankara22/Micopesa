import api from "./api";

export async function listReports() {
    const res = await api.get("/api/compliance-reports");
    return res.data.data;
}

export async function getReport(reportId) {
    const res = await api.get(`/api/compliance-reports/${reportId}`);
    return res.data.data.report;
}

export async function createReport(payload) {
    const res = await api.post("/api/compliance-reports", payload);
    return res.data.data.report;
}
