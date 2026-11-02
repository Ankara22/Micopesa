import api from "./api";

export async function getMyProfile() {
    const response = await api.get("/api/profile/me");
    return response.data.data.user;
}

export async function updateMyProfile(profile) {
    const updates = {};
    if (Object.prototype.hasOwnProperty.call(profile, "full_name")) {
        updates.full_name = profile.full_name;
    }
    if (Object.prototype.hasOwnProperty.call(profile, "email")) {
        updates.email = profile.email;
    }
    const response = await api.patch("/api/profile/me", {
        ...updates,
    });
    return response.data.data.user;
}

export async function uploadMyProfilePhoto(file) {
    const response = await api.put("/api/profile/me/photo", file, {
        headers: { "Content-Type": file.type },
    });
    return response.data.data.user;
}

export async function getMyProfilePhoto() {
    const response = await api.get("/api/profile/me/photo", { responseType: "blob" });
    return response.data;
}

export async function requestEmailVerification() {
    const response = await api.post("/api/auth/email/verification-request");
    return response.data;
}
