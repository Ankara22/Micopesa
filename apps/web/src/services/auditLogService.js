import api from "./api";

export async function getOperationalLogs(filters = {}) {
    const res = await api.get("/api/audit-logs/operational", { params: filters });
    return {
        rows: res.data.data,
        pagination: res.data.pagination,
    };
}

export async function getSystemLogs() {
    const res = await api.get("/api/audit-logs/system");
    return res.data.data;
}
