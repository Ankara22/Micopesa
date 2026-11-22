const bcrypt = require("bcrypt");
const crypto = require("node:crypto");
const pool = require("../db/database");
const authEmailService = require("./authEmailService");
const defaultSmsService = require("./smsService");
const { writeAuditLog } = require("../utils/auditLog");
const { lockUserIdentities } = require("../utils/userIdentityLock");
const { NORMALIZED_PHONE_SQL, normalizeKenyanPhone } = require("../utils/kenyanPhone");
const {
    generateSixDigitCode,
    hashOneTimeCode,
    verifyOneTimeCode,
} = require("../utils/oneTimeCode");
const { enqueueBusinessNotification } = require("./notificationEventService");

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_INTERVAL_MS = 60 * 1000;
const SEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 3;
const MAX_ATTEMPTS_PER_WINDOW = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72;
const GENERIC_MESSAGE =
    "If the phone number belongs to an active, verified account, a recovery code can be sent.";
const CHALLENGE_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function recoveryError(message, code, statusCode) {
    return Object.assign(new Error(message), { code, statusCode });
}

function timestamp(value) {
    if (!value) return null;
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function getSmsConfiguration(smsService, environment) {
    if (typeof smsService.getPhoneVerificationSmsConfiguration !== "function") {
        return { available: false, errorCode: "SMS_CONFIGURATION_MISSING" };
    }
    return smsService.getPhoneVerificationSmsConfiguration(environment);
}

function ensureSmsAvailable(configuration) {
    if (configuration?.available) return;
    const error = recoveryError(
        "Phone recovery SMS configuration is incomplete or invalid.",
        "PHONE_RECOVERY_SMS_UNAVAILABLE",
        503
    );
    error.diagnostics = {
        missingVariables: configuration?.missingVariables || [],
        invalidVariables: configuration?.invalidVariables || [],
    };
    throw error;
}

async function dispatchCode(smsService, environment, configuration, phone, code, trackingId) {
    const result = await smsService.sendPhoneVerificationSms({
        to: phone,
        message: `Your MicoPesa password recovery code is ${code}. It expires in 10 minutes. Do not share this code.`,
        trackingId,
    }, { environment, providerConfiguration: configuration });
    if (result?.accepted !== true || result.status !== "PROVIDER_ACCEPTED") {
        throw Object.assign(new Error("The SMS provider outcome could not be confirmed."), {
            code: "SMS_UNKNOWN_OUTCOME",
        });
    }
}

function createPhonePasswordRecoveryService({
    database = pool,
    smsService = defaultSmsService,
    emailService = authEmailService,
    notificationEnqueuer = enqueueBusinessNotification,
    environment = process.env,
    now = () => new Date(),
} = {}) {
    async function requestCode(input, req) {
        const phone = normalizeKenyanPhone(input?.phone);
        await emailService.enforceRequestLimits({
            req,
            action: "PHONE_PASSWORD_RESET",
            phone: phone || undefined,
        });
        const challengeId = crypto.randomUUID();
        if (!phone) return { accepted: true, challengeId, message: GENERIC_MESSAGE };
        const eligible = await database.query(
            `SELECT user_id
             FROM users
             WHERE ${NORMALIZED_PHONE_SQL} = $1
               AND phone_verified_at IS NOT NULL
               AND account_status = 'ACTIVE'
             LIMIT 1`,
            [phone]
        );
        if (!eligible.rows[0]) return { accepted: true, challengeId, message: GENERIC_MESSAGE };

        const configuration = getSmsConfiguration(smsService, environment);
        ensureSmsAvailable(configuration);
        const requestTime = now();
        const code = generateSixDigitCode();
        const { hash, salt } = await hashOneTimeCode(code);
        const client = await database.connect();
        let transactionStarted = false;
        try {
            await client.query("BEGIN");
            transactionStarted = true;
            await lockUserIdentities(client, { phones: [phone] });
            const user = await client.query(
                `SELECT user_id, phone
                 FROM users
                 WHERE ${NORMALIZED_PHONE_SQL} = $1
                   AND phone_verified_at IS NOT NULL
                   AND account_status = 'ACTIVE'
                 FOR UPDATE`,
                [phone]
            );
            if (!user.rows[0]) {
                await client.query("ROLLBACK");
                transactionStarted = false;
                return { accepted: true, challengeId, message: GENERIC_MESSAGE };
            }
            await client.query(
                `UPDATE worker_password_reset_challenges
                 SET challenge_status = 'CANCELLED'
                 WHERE user_id = $1 AND challenge_status = 'PENDING'`,
                [user.rows[0].user_id]
            );
            await client.query(
                `INSERT INTO worker_password_reset_challenges (
                    challenge_id, user_id, code_hash, code_salt, expires_at,
                    send_count, window_started_at, last_sent_at, attempt_count,
                    attempt_window_started_at, challenge_status
                 )
                 VALUES ($1, $2, $3, $4, $5, 1, $6, $6, 0, $6, 'PENDING')`,
                [
                    challengeId,
                    user.rows[0].user_id,
                    hash,
                    salt,
                    new Date(requestTime.getTime() + CODE_TTL_MS),
                    requestTime,
                ]
            );
            await client.query("COMMIT");
            transactionStarted = false;
        } catch (error) {
            if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }

        try {
            await dispatchCode(
                smsService,
                environment,
                configuration,
                phone,
                code,
                `phone-password-reset-${challengeId}`
            );
        } catch {
            await database.query(
                `UPDATE worker_password_reset_challenges
                 SET challenge_status = 'CANCELLED'
                 WHERE challenge_id = $1 AND challenge_status = 'PENDING'`,
                [challengeId]
            );
            throw recoveryError(
                "The recovery message could not be confirmed. Please try again later.",
                "PHONE_RECOVERY_SMS_DELIVERY_FAILED",
                503
            );
        }
        return { accepted: true, challengeId, message: GENERIC_MESSAGE };
    }

    async function completeRecovery(input, req) {
        const challengeId = input?.challenge_id;
        const phone = normalizeKenyanPhone(input?.phone);
        const code = input?.code;
        const password = input?.password;
        await emailService.enforceRequestLimits({
            req,
            action: "PHONE_PASSWORD_RESET_VALIDATE",
            phone: phone || undefined,
        });
        if (!phone || typeof challengeId !== "string" ||
            !CHALLENGE_ID_PATTERN.test(challengeId) ||
            typeof code !== "string" || !/^\d{6}$/.test(code)) {
            throw recoveryError("The recovery code is invalid or expired.", "PHONE_RECOVERY_INVALID_CODE", 400);
        }
        if (typeof password !== "string" ||
            password.length < MIN_PASSWORD_LENGTH ||
            Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
            throw recoveryError(
                `Password must be at least ${MIN_PASSWORD_LENGTH} characters and no more than ${MAX_PASSWORD_BYTES} UTF-8 bytes.`,
                "PHONE_RECOVERY_INVALID_PASSWORD",
                400
            );
        }
        const initial = await database.query(
            `SELECT c.user_id
             FROM worker_password_reset_challenges c
             JOIN users u ON u.user_id = c.user_id
             WHERE c.challenge_id = $1
               AND ${NORMALIZED_PHONE_SQL.replace(/\bphone\b/g, "u.phone")} = $2
               AND u.phone_verified_at IS NOT NULL
               AND u.account_status = 'ACTIVE'
               AND c.challenge_status = 'PENDING'`,
            [challengeId, phone]
        );
        if (!initial.rows[0]) {
            throw recoveryError("The recovery code is invalid or expired.", "PHONE_RECOVERY_INVALID_CODE", 400);
        }
        const passwordHash = await bcrypt.hash(password, 10);
        const client = await database.connect();
        let transactionStarted = false;
        let userId;
        try {
            await client.query("BEGIN");
            transactionStarted = true;
            await lockUserIdentities(client, { phones: [phone] });
            const result = await client.query(
                `SELECT c.challenge_id, c.user_id, c.code_hash, c.code_salt,
                        c.expires_at, c.attempt_count, c.attempt_window_started_at,
                        c.locked_until, u.phone
                 FROM worker_password_reset_challenges c
                 JOIN users u ON u.user_id = c.user_id
                 WHERE c.challenge_id = $1
                   AND ${NORMALIZED_PHONE_SQL.replace(/\bphone\b/g, "u.phone")} = $2
                   AND u.phone_verified_at IS NOT NULL
                   AND u.account_status = 'ACTIVE'
                   AND c.challenge_status = 'PENDING'
                 FOR UPDATE OF c, u`,
                [challengeId, phone]
            );
            const challenge = result.rows[0];
            const currentTime = now();
            if (!challenge || timestamp(challenge.expires_at) <= currentTime.getTime()) {
                throw recoveryError("The recovery code is invalid or expired.", "PHONE_RECOVERY_INVALID_CODE", 400);
            }
            const lockedUntil = timestamp(challenge.locked_until);
            if (lockedUntil && lockedUntil > currentTime.getTime()) {
                throw recoveryError("Too many recovery attempts. Try again later.", "PHONE_RECOVERY_RATE_LIMITED", 429);
            }
            const oldWindow = timestamp(challenge.attempt_window_started_at);
            const resetWindow = !oldWindow ||
                currentTime.getTime() - oldWindow >= SEND_WINDOW_MS ||
                (lockedUntil !== null && lockedUntil <= currentTime.getTime());
            const attempts = resetWindow ? 0 : Number(challenge.attempt_count);
            if (attempts >= MAX_ATTEMPTS_PER_WINDOW) {
                await client.query(
                    `UPDATE worker_password_reset_challenges
                     SET locked_until = $2 WHERE challenge_id = $1`,
                    [challengeId, new Date(currentTime.getTime() + LOCKOUT_MS)]
                );
                await client.query("COMMIT");
                transactionStarted = false;
                throw recoveryError("Too many recovery attempts. Try again later.", "PHONE_RECOVERY_RATE_LIMITED", 429);
            }
            if (!await verifyOneTimeCode(code, challenge.code_salt, challenge.code_hash)) {
                const nextAttempts = attempts + 1;
                await client.query(
                    `UPDATE worker_password_reset_challenges
                     SET attempt_count = $2, attempt_window_started_at = $3,
                         locked_until = $4
                     WHERE challenge_id = $1`,
                    [
                        challengeId,
                        nextAttempts,
                        resetWindow ? currentTime : challenge.attempt_window_started_at,
                        nextAttempts >= MAX_ATTEMPTS_PER_WINDOW
                            ? new Date(currentTime.getTime() + LOCKOUT_MS)
                            : null,
                    ]
                );
                await client.query("COMMIT");
                transactionStarted = false;
                throw recoveryError("The recovery code is incorrect.", "PHONE_RECOVERY_INVALID_CODE", 400);
            }
            userId = challenge.user_id;
            await client.query(
                `UPDATE users
                 SET password_hash = $1, auth_version = auth_version + 1,
                     failed_login_attempts = 0, locked_until = NULL,
                     is_temp_password = FALSE, force_password_change = FALSE,
                     updated_at = now()
                 WHERE user_id = $2`,
                [passwordHash, userId]
            );
            await client.query(
                `UPDATE worker_password_reset_challenges
                 SET challenge_status = 'CONSUMED'
                 WHERE challenge_id = $1`,
                [challengeId]
            );
            await writeAuditLog(client, {
                userId,
                actionType: "UPDATE",
                entityName: "AUTHENTICATION",
                entityId: userId,
                details: { method: "PHONE_PASSWORD_RECOVERY" },
            });
            await client.query("COMMIT");
            transactionStarted = false;
        } catch (error) {
            if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }

        await notificationEnqueuer({
            userId,
            eventType: "PASSWORD_RESET_COMPLETED",
            referenceId: challengeId,
        });
        return {
            message: "Password reset successfully. Sign in with your new password.",
        };
    }

    return { requestCode, completeRecovery };
}

module.exports = {
    GENERIC_MESSAGE,
    createPhonePasswordRecoveryService,
};
