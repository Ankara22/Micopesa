import api from "./api";
import i18n from "../i18n";

function exportLanguage() {
    return i18n.resolvedLanguage === "sw" ? "sw" : "en";
}

export async function getReportCatalog() {
    const response = await api.get("/api/reports/catalog");
    return response.data.data;
}

export async function getReportFunds() {
    const response = await api.get("/api/reports/funds");
    return response.data.data;
}

export async function getReportAnalytics(filters = {}) {
    const params = Object.fromEntries(
        Object.entries(filters).filter(([, value]) => value)
    );
    const response = await api.get("/api/reports/analytics", { params });
    return response.data.data;
}

export async function getReportHistory() {
    const response = await api.get("/api/reports/history");
    return response.data.data;
}

export async function generateReport(payload) {
    return api.post("/api/reports", { ...payload, language: exportLanguage() }, { responseType: "blob" });
}

export async function downloadReport(reportId) {
    return api.get(`/api/reports/${encodeURIComponent(reportId)}/download`, {
        responseType: "blob",
        params: { language: exportLanguage() },
    });
}
