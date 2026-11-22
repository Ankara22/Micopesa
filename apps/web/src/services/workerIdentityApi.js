import api from "./api";

export async function resendWorkerRegistrationCode(challengeId) {
    const response = await api.post("/api/auth/register/resend", {
        challenge_id: challengeId,
    });
    return response.data;
}

export async function completeWorkerRegistration({ challengeId, code, password }) {
    const response = await api.post("/api/auth/register/complete", {
        challenge_id: challengeId,
        code,
        password,
    });
    return response.data;
}

export async function requestPhonePasswordReset(phone) {
    const response = await api.post("/api/auth/password-reset/phone/request", { phone });
    return response.data;
}

export async function completePhonePasswordReset({ challengeId, phone, code, password }) {
    const response = await api.post("/api/auth/password-reset/phone/complete", {
        challenge_id: challengeId,
        phone,
        code,
        password,
    });
    return response.data;
}
