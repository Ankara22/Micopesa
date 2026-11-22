import api from "./api";
import i18n from "../i18n";

function exportLanguage() {
    return i18n.resolvedLanguage === "sw" ? "sw" : "en";
}

export async function getReportCatalog() {
    const response = await api.get("/api/reports/catalog");
    if (!Array.isArray(response.data?.data)) {
        throw new Error("The report catalog response was incomplete.");
    }
    return response.data.data;
}

export async function getReportFunds() {
    const response = await api.get("/api/reports/funds");
    if (!Array.isArray(response.data?.data)) {
        throw new Error("The report scope response was incomplete.");
    }
    return response.data.data;
}

export async function getReportAnalytics(filters = {}) {
    const params = Object.fromEntries(
        Object.entries(filters).filter(([, value]) => value)
    );
    const response = await api.get("/api/reports/analytics", { params });
    const data = response.data?.data;
    const managerAnalytics = data &&
        Array.isArray(data.contribution_trends) &&
        isAnalyticsCount(data.fund_summary?.managed_funds) &&
        isAnalyticsCount(data.fund_summary?.allocated_workers) &&
        Array.isArray(data.fund_performance);
    const regulatorAnalytics = data &&
        ["fund_comparison", "compliance_trends", "compliance_evidence", "compliance_activity", "risk_summary"]
            .every((key) => Array.isArray(data[key]));
    const adminAnalytics = data &&
        ["notification_outcomes", "mpesa_statuses", "activity", "user_trends"]
            .every((key) => Array.isArray(data[key]));
    if (!managerAnalytics && !regulatorAnalytics && !adminAnalytics) {
        throw new Error("The analytics response was incomplete.");
    }
    return data;
}

function isAnalyticsCount(value) {
    return (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) &&
        Number.isFinite(Number(value)) &&
        Number(value) >= 0;
}

export async function getReportHistory(params = {}) {
    const response = await api.get("/api/reports/history", { params });
    if (!Array.isArray(response.data?.data) || !response.data.pagination) {
        throw new Error("The report history response was incomplete.");
    }
    return {
        records: response.data.data,
        pagination: response.data.pagination,
    };
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
