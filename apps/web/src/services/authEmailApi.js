import api from "./api";

export async function requestPasswordReset(email) {
    const response = await api.post("/api/auth/password-reset/request", { email });
    return response.data;
}

export async function resetPassword(token, password) {
    const response = await api.post("/api/auth/password-reset", { token, password });
    return response.data;
}

export async function verifyEmail(token, password) {
    const response = await api.post("/api/auth/email/verify", {
        token,
        ...(password === undefined ? {} : { password }),
    });
    return response.data;
}

export async function requestEmailVerification() {
    const response = await api.post("/api/auth/email/verification-request");
    return response.data;
}

export async function requestEmailVerificationForAddress(email) {
    const response = await api.post("/api/auth/email/verification-request/public", { email });
    return response.data;
}
