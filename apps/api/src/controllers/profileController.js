const pool = require("../db/database");
const {
    MAX_PROFILE_PHOTO_BYTES,
    readProfilePhoto,
    removeProfilePhoto,
    saveProfilePhoto,
} = require("../services/profilePhotoStorage");
const authEmailService = require("../services/authEmailService");

const PROFILE_FIELDS = [
    "user_id",
    "full_name",
    "email",
    "pending_email",
    "email_verified",
    "phone",
    "role",
    "occupation",
    "account_status",
    "created_at",
    "updated_at",
    "(profile_photo_ref IS NOT NULL) AS profile_photo_available",
];

function normalizeFullName(value) {
    if (typeof value !== "string" || /\p{Cc}/u.test(value)) return null;
    const normalized = value.normalize("NFC").replace(/\p{Zs}+/gu, " ").trim();
    if (
        normalized.length < 2 ||
        normalized.length > 100 ||
        !/^\p{L}[\p{L}\p{M}]*(?:(?:[ '\u2019\u02BC\u2010\u2011-]+|\.\s*)\p{L}[\p{L}\p{M}]*)*$/u.test(normalized)
    ) return null;
    return normalized;
}

function normalizeEmail(value) {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (
        normalized.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    ) return undefined;
    return normalized;
}

function sendProfile(res, user) {
    return res.status(200).json({
        status: "success",
        data: { user },
    });
}

async function getMyProfile(req, res) {
    try {
        const result = await pool.query(
            `SELECT ${PROFILE_FIELDS.join(", ")}
             FROM users WHERE user_id = $1`,
            [req.user.userId]
        );
        if (!result.rows[0]) {
            return res.status(404).json({ status: "error", message: "User not found" });
        }
        return sendProfile(res, result.rows[0]);
    } catch (error) {
        console.error("Failed to fetch profile:", error);
        return res.status(500).json({ status: "error", message: "Failed to fetch profile" });
    }
}

async function updateMyProfile(req, res) {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        return res.status(400).json({ status: "error", message: "A profile object is required" });
    }
    const editableFields = ["full_name", "email"];
    const submittedFields = Object.keys(req.body);
    const unsupportedFields = submittedFields.filter((field) => !editableFields.includes(field));
    if (unsupportedFields.length) {
        return res.status(400).json({
            status: "error",
            message: "Only full_name and email may be changed through this endpoint",
        });
    }
    if (submittedFields.length === 0) {
        return res.status(400).json({
            status: "error",
            message: "At least one profile field must be provided",
        });
    }

    const updates = [];
    const values = [];
    let emailToVerify;
    if (Object.prototype.hasOwnProperty.call(req.body, "full_name")) {
        const fullName = normalizeFullName(req.body.full_name);
        if (fullName === null) {
            return res.status(400).json({
                status: "error",
                message: "Full name must be 2 to 100 characters and contain valid name characters",
            });
        }
        values.push(fullName);
        updates.push(`full_name = $${values.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, "email")) {
        const email = normalizeEmail(req.body.email);
        if (email === undefined) {
            return res.status(400).json({ status: "error", message: "Enter a valid email address" });
        }
        emailToVerify = email;
        values.push(email);
        updates.push(`pending_email = $${values.length}`);
    }

    try {
        if (emailToVerify) {
            const existing = await pool.query(
                `SELECT user_id FROM users
                 WHERE user_id <> $1
                   AND (lower(email) = $2 OR lower(pending_email) = $2)
                 LIMIT 1`,
                [req.user.userId, emailToVerify]
            );
            if (existing.rows.length) {
                return res.status(409).json({
                    status: "error",
                    message: "That email address is already in use",
                });
            }
        }
        values.push(req.user.userId);
        const result = await pool.query(
            `UPDATE users
             SET ${updates.join(", ")}
             WHERE user_id = $${values.length}
             RETURNING ${PROFILE_FIELDS.join(", ")}`,
            values
        );
        if (!result.rows[0]) {
            return res.status(404).json({ status: "error", message: "User not found" });
        }
        if (emailToVerify) {
            await authEmailService.enforceRequestLimits({
                req,
                action: "EMAIL_VERIFICATION",
                email: emailToVerify,
                userId: req.user.userId,
            });
            await authEmailService.issueEmailToken({
                userId: req.user.userId,
                email: emailToVerify,
                purpose: "EMAIL_VERIFICATION",
            });
        }
        return sendProfile(res, result.rows[0]);
    } catch (error) {
        if (error.status === 429) {
            return res.status(429).json({ status: "error", message: error.message });
        }
        if (error.code === "EMAIL_SMTP_CONFIGURATION_MISSING" ||
            error.code === "EMAIL_SMTP_CONFIGURATION_INVALID" ||
            error.code === "EMAIL_SMTP_DELIVERY_FAILED" ||
            error.code === "EMAIL_SMTP_RECIPIENT_REJECTED" ||
            error.code === "EMAIL_LINK_CONFIGURATION_MISSING" ||
            error.code === "EMAIL_LINK_CONFIGURATION_INVALID") {
            authEmailService.logEmailDeliveryFailure("EMAIL_VERIFICATION", error);
            return res.status(503).json({
                status: "error",
                message: "Email address saved as pending, but verification could not be sent. Please try again later.",
            });
        }
        if (error.code === "23505") {
            return res.status(409).json({
                status: "error",
                message: "That email address is already in use",
            });
        }
        console.error("Failed to update profile:", error);
        return res.status(500).json({ status: "error", message: "Failed to update profile" });
    }
}

async function uploadMyProfilePhoto(req, res) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(req.headers["content-type"])) {
        return res.status(415).json({ status: "error", message: "Upload a valid JPEG, PNG, or WebP image" });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ status: "error", message: "A profile photo is required" });
    }
    if (req.body.length > MAX_PROFILE_PHOTO_BYTES) {
        return res.status(413).json({ status: "error", message: "Profile photos must be 5 MB or smaller" });
    }

    let savedPhoto;
    let client;
    let transactionStarted = false;
    let commitAttempted = false;
    let previousPhotoRef = null;
    try {
        savedPhoto = await saveProfilePhoto(req.body, req.headers["content-type"]);
        client = await pool.connect();
        await client.query("BEGIN");
        transactionStarted = true;
        const existing = await client.query(
            "SELECT profile_photo_ref FROM users WHERE user_id = $1 FOR UPDATE",
            [req.user.userId]
        );
        if (!existing.rows[0]) {
            await client.query("ROLLBACK");
            transactionStarted = false;
            await removeProfilePhoto(savedPhoto.reference);
            return res.status(404).json({ status: "error", message: "User not found" });
        }
        previousPhotoRef = existing.rows[0].profile_photo_ref;
        const result = await client.query(
            `UPDATE users
             SET profile_photo_ref = $1
             WHERE user_id = $2
             RETURNING ${PROFILE_FIELDS.join(", ")}`,
            [savedPhoto.reference, req.user.userId]
        );
        commitAttempted = true;
        await client.query("COMMIT");
        transactionStarted = false;
        const user = result.rows[0];
        if (previousPhotoRef && previousPhotoRef !== savedPhoto.reference) {
            await removeProfilePhoto(previousPhotoRef).catch((error) => {
                console.error("Failed to remove replaced profile photo:", error);
            });
        }
        return sendProfile(res, user);
    } catch (error) {
        if (transactionStarted && client) {
            await client.query("ROLLBACK").catch((rollbackError) => {
                console.error("Failed to roll back profile-photo update:", rollbackError);
            });
        }
        if (savedPhoto && !commitAttempted) {
            await removeProfilePhoto(savedPhoto.reference).catch((cleanupError) => {
                console.error("Failed to clean up an unreferenced profile photo:", cleanupError);
            });
        }
        if (error.status) {
            return res.status(error.status).json({ status: "error", message: error.message });
        }
        if (error.code === "PROFILE_PHOTO_STORAGE_UNCONFIGURED") {
            return res.status(503).json({ status: "error", message: "Profile-photo storage is not configured" });
        }
        console.error("Failed to save profile photo:", error);
        return res.status(500).json({ status: "error", message: "Failed to save profile photo" });
    } finally {
        client?.release();
    }
}

async function getMyProfilePhoto(req, res) {
    try {
        const result = await pool.query(
            "SELECT profile_photo_ref FROM users WHERE user_id = $1",
            [req.user.userId]
        );
        const reference = result.rows[0]?.profile_photo_ref;
        if (!reference) {
            return res.status(404).json({ status: "error", message: "No profile photo has been uploaded" });
        }
        const photo = await readProfilePhoto(reference);
        if (!photo) {
            return res.status(404).json({ status: "error", message: "Profile photo not found" });
        }
        res.set({
            "Content-Type": photo.contentType,
            "Content-Length": photo.buffer.length,
            "Content-Disposition": "inline",
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        });
        return res.status(200).end(photo.buffer);
    } catch (error) {
        console.error("Failed to fetch profile photo:", error);
        return res.status(500).json({ status: "error", message: "Failed to fetch profile photo" });
    }
}

module.exports = { getMyProfile, getMyProfilePhoto, updateMyProfile, uploadMyProfilePhoto };
