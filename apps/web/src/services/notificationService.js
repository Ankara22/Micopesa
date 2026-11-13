import api from "./api";

function validatePreferences(data) {
    if (
        !data ||
        typeof data !== "object" ||
        typeof data.sms_enabled !== "boolean" ||
        typeof data.email_enabled !== "boolean"
    ) {
        const error = new Error("Unexpected notification preferences response.");
        error.code = "INVALID_NOTIFICATION_PREFERENCES";
        throw error;
    }
    return {
        sms_enabled: data.sms_enabled,
        email_enabled: data.email_enabled,
    };
}

export async function getMyNotificationPreferences() {
    const res = await api.get("/api/notifications/preferences");
    return validatePreferences(res.data.data);
}

export async function updateMyNotificationPreferences(preferences) {
    if (
        !preferences ||
        typeof preferences !== "object" ||
        Array.isArray(preferences) ||
        Object.keys(preferences).some((key) => !["sms_enabled", "email_enabled"].includes(key)) ||
        Object.keys(preferences).length === 0 ||
        Object.entries(preferences).some(([, value]) => typeof value !== "boolean")
    ) {
        throw new TypeError("Only boolean SMS and email preferences may be updated.");
    }
    const res = await api.patch("/api/notifications/preferences", {
        ...preferences,
    });
    return validatePreferences(res.data.data);
}

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
