import api from "./api";

export async function getMyNotifications() {
    const res = await api.get("/api/notifications/my");
    return res.data.data;
}

export async function listRoleNotificationRecipients(search = "") {
    const res = await api.get("/api/notifications/recipients", { params: { search } });
    return res.data.data;
}

export async function createRoleNotification(payload) {
    const res = await api.post("/api/notifications/compose", payload);
    return res.data.data.notifications;
}

export async function listNotificationAudit() {
    const res = await api.get("/api/notifications/audit");
    return res.data.data;
}

export async function getPushPublicKey() {
    const res = await api.get("/api/notifications/push/public-key");
    return res.data.data.public_key;
}

export async function registerPushSubscription(subscription) {
    const res = await api.post("/api/notifications/push/subscriptions", { subscription });
    return res.data.data.subscription_id;
}

export async function removePushSubscription(subscriptionId) {
    const res = await api.delete(`/api/notifications/push/subscriptions/${encodeURIComponent(subscriptionId)}`);
    return res.data;
}
