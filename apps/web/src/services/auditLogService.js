import api from "./api";

export async function getOperationalLogs() {
    const res = await api.get("/api/audit-logs/operational");
    return res.data.data;
}

export async function getSystemLogs() {
    const res = await api.get("/api/audit-logs/system");
    return res.data.data;
}
