const bcrypt = require("bcrypt");
const pool = require("../db/database");
const { generateToken } = require("../utils/token");
const { hashOpaque } = require("../services/authEmailService");
const authEmailService = require("../services/authEmailService");
const { loadAdminSettings } = require("../services/adminSettingsService");
const { normalizeKenyanPhone, NORMALIZED_PHONE_SQL } = require("../utils/kenyanPhone");

const SALT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 8;
const VALID_ROLES = ["WORKER", "FUND_MANAGER", "REGULATOR", "ADMIN"];
const VALID_OCCUPATIONS = [
    "BODA_BODA_OPERATOR",
    "MARKET_VENDOR",
    "JUA_KALI_ARTISAN",
    "DOMESTIC_WORKER",
    "CASUAL_LABOURER",
    "SMALL_SCALE_FARMER",
    "OTHER_INFORMAL_WORKER",
];

const PUBLIC_REGISTRATION_ROLE = "WORKER";

function normalizeEmail(value) {
    if (typeof value !== "string") return null;
    const email = value.trim().toLowerCase();
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * POST /api/auth/register
 * Body: { full_name, email, phone, password, occupation }
 *
 * Public registration always creates a WORKER. Privileged roles must be
 * assigned through a separately authorized administrative or provisioning
 * workflow.
 */
async function register(req, res) {
    const { full_name, phone, password, occupation } = req.body || {};
    const email = normalizeEmail(req.body?.email);

    if (!full_name || !phone || !password || !email) {
        return res.status(400).json({
            status: "error",
            message: "full_name, a valid email, phone, and password are required",
        });
    }

    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({
            status: "error",
            message: `password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
        });
    }

    const role = PUBLIC_REGISTRATION_ROLE;
    if (!VALID_OCCUPATIONS.includes(occupation)) {
        return res.status(400).json({
            status: "error",
            message: `occupation must be one of: ${VALID_OCCUPATIONS.join(", ")}`,
        });
    }

    let client;
    try {
        const existing = await pool.query(
            `SELECT user_id FROM users
             WHERE phone = $1 OR lower(email) = $2 OR lower(pending_email) = $2
             LIMIT 1`,
            [phone, email]
        );

        if (existing.rows.length > 0) {
            return res.status(409).json({
                status: "error",
                message: "An account already uses this phone number or email address",
            });
        }

        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

        client = await pool.connect();
        await client.query("BEGIN");

        const result = await client.query(
            `INSERT INTO users (full_name, phone, email, password_hash, role, occupation, login_method)
             VALUES ($1, $2, $3, $4, $5, $6, 'EMAIL')
             RETURNING user_id, full_name, phone, email, role, occupation, account_status,
                       email_verified, pending_email, auth_version, login_method,
                       created_at, updated_at, (profile_photo_ref IS NOT NULL) AS profile_photo_available`,
            [full_name, phone, email, passwordHash, role, occupation || null]
        );

        const user = result.rows[0];
        if (user.role === "WORKER") {
            await client.query(
                `INSERT INTO pension_accounts (user_id, current_balance, retirement_age)
                 VALUES ($1, 0.00, 60)
                 ON CONFLICT (user_id) DO NOTHING`,
                [user.user_id]
            );
        }
        await client.query("COMMIT");
        client.release();
        client = null;

        let verificationEmailSent = false;
        try {
            await authEmailService.issueEmailToken({
                userId: user.user_id,
                email,
                purpose: "EMAIL_VERIFICATION",
            });
            verificationEmailSent = true;
        } catch (error) {
            authEmailService.logEmailDeliveryFailure("EMAIL_VERIFICATION", error);
        }

        return res.status(201).json({
            status: "success",
            message: verificationEmailSent
                ? "Account created. Verify your email before signing in."
                : "Account created, but the verification email could not be sent. Retry from this page or the sign-in page.",
            data: { user, verificationEmailSent },
        });
    } catch (error) {
        if (client) {
            await client.query("ROLLBACK").catch(() => {});
        }
        if (error.code === "23505") {
            return res.status(409).json({
                status: "error",
                message: "An account already uses this phone number or email address",
            });
        }
        console.error("Registration failed:", error);
        return res.status(500).json({
            status: "error",
            message: "Registration failed due to a server error",
        });
    } finally {
        client?.release();
    }
}

/**
 * POST /api/auth/login
 * Body: { identifier, password } or legacy { phone, password }.
 * PHONE-policy accounts authenticate by phone; all verified accounts may
 * also authenticate by email. EMAIL-policy accounts never fall back to phone.
 * Verifies the password against `password_hash` and returns a signed JWT
 * containing { userId, role }.
 */
async function login(req, res) {
    const identifier = typeof req.body?.identifier === "string"
        ? req.body.identifier.trim()
        : typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
    const password = req.body?.password;

    if (!identifier || typeof password !== "string" || !password) {
        return res.status(400).json({
            status: "error",
            message: "identifier and password are required",
        });
    }
    const email = identifier.includes("@") ? identifier.toLowerCase() : null;
    const normalizedPhone = email ? null : normalizeKenyanPhone(identifier);

    try {
        const result = await pool.query(
            `SELECT user_id, full_name, phone, email, password_hash, role, occupation,
                    account_status, email_verified, auth_version, failed_login_attempts,
                    locked_until, is_temp_password, force_password_change, created_at, updated_at,
                    (profile_photo_ref IS NOT NULL) AS profile_photo_available
             FROM users
             WHERE (login_method = 'PHONE' AND (
                        phone = $1 OR
                        ($3::varchar IS NOT NULL AND (${NORMALIZED_PHONE_SQL}) = $3)
                    ))
                OR ($3::varchar IS NOT NULL AND phone_verified_at IS NOT NULL
                    AND (${NORMALIZED_PHONE_SQL}) = $3)
                OR ($2::varchar IS NOT NULL AND email_verified IS TRUE AND lower(email) = $2)
             ORDER BY CASE WHEN login_method = 'PHONE' AND (
                    phone = $1 OR
                    ($3::varchar IS NOT NULL AND (${NORMALIZED_PHONE_SQL}) = $3)
                ) THEN 0 ELSE 1 END
             LIMIT 1`,
            [identifier, email, normalizedPhone]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                status: "error",
                message: "Invalid phone number or password",
            });
        }

        const user = result.rows[0];

        if (user.account_status !== "ACTIVE") {
            return res.status(403).json({
                status: "error",
                message: "This account is not active",
            });
        }

        const settings = await loadAdminSettings();
        if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
            return res.status(401).json({
                status: "error",
                message: "Invalid phone number or password",
            });
        }

        const passwordMatches = await bcrypt.compare(password, user.password_hash);

        if (!passwordMatches) {
            await pool.query(
                `UPDATE users
                 SET failed_login_attempts = failed_login_attempts + 1,
                     locked_until = CASE
                         WHEN failed_login_attempts + 1 >= $2
                         THEN now() + ($3 * interval '1 minute')
                         ELSE NULL
                     END,
                     updated_at = now()
                 WHERE user_id = $1`,
                [user.user_id, settings.max_failed_login_attempts, settings.account_lockout_duration_minutes]
            );
            return res.status(401).json({
                status: "error",
                message: "Invalid phone number or password",
            });
        }

        await pool.query(
            `UPDATE users
             SET failed_login_attempts = 0, locked_until = NULL, updated_at = now()
             WHERE user_id = $1`,
            [user.user_id]
        );

        if (!VALID_ROLES.includes(user.role)) {
            return res.status(403).json({ status: "error", message: "This account role is not authorized" });
        }

        const token = generateToken({
            userId: user.user_id,
            role: user.role,
            authVersion: user.auth_version,
            forcePasswordChange: user.force_password_change,
        });

        return res.status(200).json({
            status: "success",
            message: "Login successful",
            data: {
                token,
                user: {
                    user_id: user.user_id,
                    full_name: user.full_name,
                    phone: user.phone,
                    email: user.email,
                    email_verified: user.email_verified,
                    pending_email: user.pending_email,
                    role: user.role,
                    occupation: user.occupation,
                    account_status: user.account_status,
                    created_at: user.created_at,
                    updated_at: user.updated_at,
                    profile_photo_available: user.profile_photo_available,
                    is_temp_password: user.is_temp_password,
                    force_password_change: user.force_password_change,
                },
            },
        });
    } catch (error) {
        const missingColumn = error?.code === "42703" && typeof error.message === "string"
            ? error.message.match(/^column "([A-Za-z_][A-Za-z0-9_]*)" does not exist$/)
            : null;
        const diagnostic = missingColumn
            ? `column "${missingColumn[1]}" does not exist`
            : error?.code || error?.name || "AUTH_LOGIN_ERROR";
        console.error("Login failed:", diagnostic);
        return res.status(500).json({
            status: "error",
            message: "Login failed due to a server error",
        });
    }
}

/**
 * POST /api/auth/logout
 * Requires authentication.
 *
 * NOTE: JWTs issued by this API are stateless and there is no session or
 * token-blacklist table in the database schema. This endpoint therefore
 * cannot revoke the presented token server-side; it simply confirms the
 * request was authenticated and instructs the client to discard its token.
 * True server-side revocation would require a new table (e.g. a token
 * denylist) which is out of scope here per the "do not modify schema.sql"
 * constraint - flagged in the final report as a known limitation.
 */
async function logout(req, res) {
    return res.status(200).json({
        status: "success",
        message: "Logged out successfully. Please discard your access token on the client.",
    });
}

/**
 * GET /api/auth/me
 * Requires authentication. Returns the authenticated user's safe profile
 * fields (never password_hash).
 */
async function getMe(req, res) {
    const { userId } = req.user;

    try {
        const result = await pool.query(
            `SELECT user_id, full_name, phone, email, email_verified, pending_email,
                    role, occupation, account_status, is_temp_password, force_password_change,
                    created_at, updated_at,
                    (profile_photo_ref IS NOT NULL) AS profile_photo_available
             FROM users
             WHERE user_id = $1`,
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                status: "error",
                message: "User not found",
            });
        }

        return res.status(200).json({
            status: "success",
            data: { user: result.rows[0] },
        });
    } catch (error) {
        console.error("Failed to fetch current user:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch current user due to a server error",
        });
    }
}

async function changeTemporaryPassword(req, res) {
    const newPassword = req.body?.new_password;
    if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({
            status: "error",
            message: `new_password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
        });
    }

    let client;
    try {
        const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
        client = await pool.connect();
        await client.query("BEGIN");
        const result = await client.query(
            `UPDATE users
             SET password_hash = $1, is_temp_password = FALSE, force_password_change = FALSE,
                 failed_login_attempts = 0, locked_until = NULL,
                 auth_version = auth_version + 1, updated_at = now()
             WHERE user_id = $2 AND force_password_change = TRUE
             RETURNING user_id, role, auth_version`,
            [passwordHash, req.user.userId]
        );
        if (!result.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(409).json({
                status: "error",
                message: "This account does not require a temporary password change.",
            });
        }
        await client.query("COMMIT");
        const token = generateToken({
            userId: result.rows[0].user_id,
            role: result.rows[0].role,
            authVersion: result.rows[0].auth_version,
        });
        return res.status(200).json({
            status: "success",
            message: "Password updated. Sign in again with your new password.",
            data: { token },
        });
    } catch (error) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        console.error("Temporary password update failed:", error.code || "PASSWORD_CHANGE_FAILED");
        return res.status(500).json({ status: "error", message: "Unable to update your password." });
    } finally {
        client?.release();
    }
}

async function requestPasswordReset(req, res) {
    const genericMessage = "If the address is associated with a verified account, a reset request has been processed. Email delivery is not confirmed by this response.";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    try {
        const { enforceRequestLimits, issueEmailToken } = require("../services/authEmailService");
        const validEmail = email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        await enforceRequestLimits({ req, action: "PASSWORD_RESET", email: validEmail ? email : undefined });
        if (!validEmail) {
            return res.status(200).json({ status: "success", message: genericMessage });
        }
        const result = await pool.query(
            `SELECT user_id, email
             FROM users
             WHERE email_verified IS TRUE AND lower(email) = $1 AND account_status = 'ACTIVE'`,
            [email]
        );
        if (result.rows[0]) {
            try {
                await issueEmailToken({
                    userId: result.rows[0].user_id,
                    email: result.rows[0].email,
                    purpose: "PASSWORD_RESET",
                });
            } catch (error) {
                authEmailService.logEmailDeliveryFailure("PASSWORD_RESET", error);
            }
        }
        return res.status(200).json({ status: "success", message: genericMessage });
    } catch (error) {
        if (error.status === 429) {
            return res.status(429).json({ status: "error", message: error.message });
        }
        console.error("Password-reset request failed:", error.code || "AUTH_RECOVERY_ERROR");
        return res.status(200).json({ status: "success", message: genericMessage });
    }
}

async function requestPublicEmailVerification(req, res) {
    const genericMessage = "If an unverified email-login account matches this address, verification instructions can be sent.";
    const email = normalizeEmail(req.body?.email);
    try {
        await authEmailService.enforceRequestLimits({
            req,
            action: "EMAIL_VERIFICATION",
            email: email || undefined,
        });
        if (email) {
            const result = await pool.query(
                `SELECT user_id, email
                 FROM users
                 WHERE login_method = 'EMAIL' AND email_verified IS FALSE
                   AND account_status = 'ACTIVE' AND lower(email) = $1`,
                [email]
            );
            if (result.rows[0]) {
                try {
                    await authEmailService.issueEmailToken({
                        userId: result.rows[0].user_id,
                        email: result.rows[0].email,
                        purpose: "EMAIL_VERIFICATION",
                    });
                } catch (error) {
                    authEmailService.logEmailDeliveryFailure("EMAIL_VERIFICATION", error);
                }
            }
        }
        return res.status(200).json({ status: "success", message: genericMessage });
    } catch (error) {
        if (error.status === 429) {
            return res.status(429).json({ status: "error", message: error.message });
        }
        console.error("Public email-verification request failed:", error.code || "EMAIL_VERIFICATION_ERROR");
        return res.status(200).json({ status: "success", message: genericMessage });
    }
}

async function resetPassword(req, res) {
    const { token, password } = req.body || {};
    if (typeof token !== "string" || token.length < 40 || token.length > 100) {
        return res.status(400).json({ status: "error", message: "This password-reset link is invalid or expired. Request a new link." });
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({
            status: "error",
            message: `password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
        });
    }

    const client = await pool.connect();
    try {
        const tokenHash = hashOpaque(token);
        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
        await client.query("BEGIN");
        const tokenResult = await client.query(
            `SELECT auth_token_id, user_id, email_address
             FROM auth_tokens
             WHERE token_hash = $1 AND purpose = 'PASSWORD_RESET'
               AND consumed_at IS NULL AND expires_at > now()
             FOR UPDATE`,
            [tokenHash]
        );
        if (!tokenResult.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                status: "error",
                message: "This password-reset link is invalid or expired. Request a new link.",
            });
        }
        const authToken = tokenResult.rows[0];
        const updated = await client.query(
            `UPDATE users
             SET password_hash = $1, auth_version = auth_version + 1
             WHERE user_id = $2 AND email = $3 AND email_verified IS TRUE
               AND account_status = 'ACTIVE'
             RETURNING user_id`,
            [passwordHash, authToken.user_id, authToken.email_address]
        );
        if (!updated.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                status: "error",
                message: "This password-reset link is invalid or expired. Request a new link.",
            });
        }
        await client.query(
            "UPDATE auth_tokens SET consumed_at = now() WHERE auth_token_id = $1",
            [authToken.auth_token_id]
        );
        await client.query("COMMIT");

        const { sendEmail } = require("../services/authEmailService");
        try {
            await sendEmail({
                to: authToken.email_address,
                subject: "Your MicoPesa password was changed",
                purpose: "PASSWORD_RESET_NOTIFICATION",
                text: "Your MicoPesa password was successfully changed. If you did not make this change, contact support.",
            });
        } catch (error) {
            authEmailService.logEmailDeliveryFailure("PASSWORD_RESET_NOTIFICATION", error);
        }
        return res.status(200).json({
            status: "success",
            message: "Password reset successfully. Sign in with your new password.",
        });
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("Password reset failed:", error.code || "AUTH_RECOVERY_ERROR");
        return res.status(500).json({ status: "error", message: "Unable to reset your password right now." });
    } finally {
        client.release();
    }
}

async function verifyEmail(req, res) {
    const { token } = req.body || {};
    if (typeof token !== "string" || token.length < 40 || token.length > 100) {
        return res.status(400).json({ status: "error", message: "This verification link is invalid or expired." });
    }
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query(
            `SELECT auth_token_id, user_id, email_address
             FROM auth_tokens
             WHERE token_hash = $1 AND purpose = 'EMAIL_VERIFICATION'
               AND consumed_at IS NULL AND expires_at > now()
             FOR UPDATE`,
            [hashOpaque(token)]
        );
        const authToken = result.rows[0];
        if (!authToken) {
            await client.query("ROLLBACK");
            return res.status(400).json({ status: "error", message: "This verification link is invalid or expired." });
        }
        const updated = await client.query(
            `UPDATE users
             SET email = CASE WHEN pending_email IS NOT NULL THEN pending_email ELSE email END,
                 pending_email = NULL, email_verified = TRUE
             WHERE user_id = $1
               AND (
                   lower(pending_email) = lower($2)
                   OR (login_method = 'EMAIL' AND email_verified IS FALSE AND lower(email) = lower($2))
               )
             RETURNING user_id`,
            [authToken.user_id, authToken.email_address]
        );
        if (!updated.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(400).json({ status: "error", message: "This verification link is invalid or expired." });
        }
        await client.query(
            "UPDATE auth_tokens SET consumed_at = now() WHERE auth_token_id = $1",
            [authToken.auth_token_id]
        );
        await client.query("COMMIT");
        return res.status(200).json({ status: "success", message: "Email address verified successfully." });
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if (error.code === "23505") {
            return res.status(400).json({
                status: "error",
                message: "This verification link is invalid or expired.",
            });
        }
        console.error("Email verification failed:", error.code || "EMAIL_VERIFICATION_ERROR");
        return res.status(500).json({ status: "error", message: "Unable to verify this email address right now." });
    } finally {
        client.release();
    }
}

async function resendEmailVerification(req, res) {
    try {
        const { enforceRequestLimits, issueEmailToken } = require("../services/authEmailService");
        const result = await pool.query(
            `SELECT user_id, pending_email, email_verified
             FROM users WHERE user_id = $1 AND account_status = 'ACTIVE'`,
            [req.user.userId]
        );
        const user = result.rows[0];
        if (!user || !user.pending_email || user.email_verified) {
            return res.status(200).json({
                status: "success",
                message: "If an email address is awaiting verification, a verification message can be sent.",
            });
        }
        await enforceRequestLimits({
            req,
            action: "EMAIL_VERIFICATION",
            email: user.pending_email,
            userId: user.user_id,
        });
        await issueEmailToken({
            userId: user.user_id,
            email: user.pending_email,
            purpose: "EMAIL_VERIFICATION",
        });
        return res.status(200).json({
            status: "success",
            message: "If an email address is awaiting verification, a verification message can be sent.",
        });
    } catch (error) {
        if (error.status === 429) {
            return res.status(429).json({ status: "error", message: error.message });
        }
        authEmailService.logEmailDeliveryFailure("EMAIL_VERIFICATION", error);
        return res.status(503).json({
            status: "error",
            message: "Unable to send a verification email right now. Please try again later.",
        });
    }
}

module.exports = {
    register,
    login,
    logout,
    getMe,
    requestPasswordReset,
    requestPublicEmailVerification,
    resetPassword,
    changeTemporaryPassword,
    verifyEmail,
    resendEmailVerification,
};