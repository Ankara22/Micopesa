import api from "./api";

// --- Users ---
export async function listUsers() {
    const res = await api.get("/api/admin/users");
    return res.data.data;
}

export async function getUser(userId) {
    const res = await api.get(`/api/admin/users/${userId}`);
    return res.data.data.user;
}

export async function updateUserRole(userId, role) {
    const res = await api.patch(`/api/admin/users/${userId}/role`, { role });
    return res.data.data.user;
}

export async function updateUserStatus(userId, account_status) {
    const res = await api.patch(`/api/admin/users/${userId}/status`, { account_status });
    return res.data.data.user;
}

export async function deleteUser(userId) {
    const res = await api.delete(`/api/admin/users/${userId}`);
    return res.data;
}

export async function createStaffAccount(payload) {
    const res = await api.post("/api/v1/admin/staff", payload);
    return res.data;
}

export async function resendStaffOnboarding(userId) {
    const res = await api.post(`/api/v1/admin/staff/${userId}/resend`);
    return res.data;
}

export async function getOperationalSettings() {
    const res = await api.get("/api/v1/admin/settings");
    return res.data.data.settings;
}

export async function updateOperationalSettings(settings) {
    const res = await api.put("/api/v1/admin/settings", { settings });
    return res.data.data.settings;
}

// --- System settings ---
export async function listSettings() {
    const res = await api.get("/api/admin/settings");
    return res.data.data;
}

export async function createSetting(payload) {
    const res = await api.post("/api/admin/settings", payload);
    return res.data.data.setting;
}

export async function updateSetting(key, payload) {
    const res = await api.put(`/api/admin/settings/${key}`, payload);
    return res.data.data.setting;
}

export async function deleteSetting(key) {
    await api.delete(`/api/admin/settings/${key}`);
}

// --- Notifications (admin compose/monitor - see notifications) ---
export async function listNotifications() {
    const res = await api.get("/api/admin/notifications");
    return res.data.data;
}

export async function createNotification(payload) {
    const res = await api.post("/api/admin/notifications", payload);
    return res.data.data.notifications;
}

export async function sendAdminTestSms(requestId) {
    const res = await api.post("/api/admin/notifications/test-sms", {
        request_id: requestId,
        confirmed: true,
    });
    return res.data.data.notifications;
}

export async function getExternalSmsAvailability() {
    const res = await api.get("/api/admin/notifications/external-sms/availability");
    return res.data.data;
}

export async function sendExternalRecipientSms(payload) {
    const res = await api.post("/api/admin/notifications/external-sms", payload);
    return res.data.data.notification;
}

export async function listNotificationRecipients(search = "") {
    const res = await api.get("/api/admin/notifications/recipients", {
        params: { search },
    });
    return res.data.data;
}

export async function listRegulatorFundAssignments() {
    const res = await api.get("/api/admin/regulator-fund-assignments");
    return res.data.data;
}

export async function getRegulatorFundAssignmentCandidates() {
    const res = await api.get("/api/admin/regulator-fund-assignments/candidates");
    return res.data.data;
}

export async function assignRegulatorFund(regulatorId, fundId) {
    const res = await api.post("/api/admin/regulator-fund-assignments", {
        regulator_id: regulatorId,
        fund_id: fundId,
    });
    return res.data.data;
}

export async function revokeRegulatorFund(regulatorId, fundId) {
    const res = await api.delete(
        `/api/admin/regulator-fund-assignments/${encodeURIComponent(regulatorId)}/${encodeURIComponent(fundId)}`
    );
    return res.data;
}

// --- Activity ---
export async function getActivitySummary() {
    const res = await api.get("/api/admin/activity/summary");
    return res.data.data;
}

export async function listSessions() {
    const res = await api.get("/api/admin/activity/sessions");
    return res.data.data;
}
