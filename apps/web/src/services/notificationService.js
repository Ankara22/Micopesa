import api from "./api";

export async function getMyNotifications() {
    const res = await api.get("/api/notifications/my");
    return res.data.data;
}
