const crypto = require("node:crypto");
const { promisify } = require("node:util");
const bcrypt = require("bcrypt");
const pool = require("../db/database");
const mobileSasaService = require("./mobileSasaService");
const {
    normalizeKenyanPhone,
    normalizedPhoneSql,
    NORMALIZED_PHONE_SQL,
} = require("../utils/kenyanPhone");

const scrypt = promisify(crypto.scrypt);
const PHONE_CODE_BYTES = 32;
const PHONE_CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_INTERVAL_MS = 60 * 1000;
const SEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 3;
const MAX_ATTEMPTS_PER_WINDOW = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const PHONE_CHANGE_MESSAGE = (code) =>
    `Your MicoPesa phone verification code is ${code}. It expires in 10 minutes. Do not share this code.`;

function createPhoneChangeError(message, code, statusCode) {
    return Object.assign(new Error(message), { code, statusCode });
}

async function hashCode(code, salt = crypto.randomBytes(16)) {
    return {
        salt,
        hash: await scrypt(code, salt, PHONE_CODE_BYTES, {
            N: 16384,
            r: 8,
            p: 1,
            maxmem: 32 * 1024 * 1024,
        }),
    };
}

async function codeMatches(code, salt, expectedHash) {
    const actualHash = await scrypt(code, salt, PHONE_CODE_BYTES, {
        N: 16384,
        r: 8,
        p: 1,
        maxmem: 32 * 1024 * 1024,
    });
    return expectedHash.length === actualHash.length &&
        crypto.timingSafeEqual(expectedHash, actualHash);
}

function timestamp(value) {
    if (!value) return null;
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

async function startPhoneChange({
    userId,
    currentPassword,
    newPhone,
    confirmed,
}, {
    database = pool,
    smsService = mobileSasaService,
    environment = process.env,
    fetchImpl = global.fetch,
    now = () => new Date(),
} = {}) {
    if (confirmed !== true) {
        throw createPhoneChangeError(
            "Confirm the phone-number change before requesting a code.",
            "PHONE_CHANGE_CONFIRMATION_REQUIRED",
            400
        );
    }
    if (typeof currentPassword !== "string" || !currentPassword) {
        throw createPhoneChangeError(
            "Your current password is required.",
            "PHONE_CHANGE_PASSWORD_REQUIRED",
            400
        );
    }
    const phone = normalizeKenyanPhone(newPhone);
    if (!phone) {
        throw createPhoneChangeError(
            "Enter a valid Kenyan mobile number.",
            "PHONE_CHANGE_INVALID_PHONE",
            400
        );
    }
    if (typeof smsService.isPhoneVerificationSmsConfigured !== "function" ||
        !smsService.isPhoneVerificationSmsConfigured(environment)) {
        throw createPhoneChangeError(
            "Phone verification by SMS is not configured.",
            "PHONE_CHANGE_SMS_UNAVAILABLE",
            503
        );
    }

    const client = await database.connect();
    const requestTime = now();
    let otp;
    try {
        await client.query("BEGIN");
        const accountResult = await client.query(
            `SELECT user_id, phone, phone_verified_at, password_hash
             FROM users
             WHERE user_id = $1
             FOR UPDATE`,
            [userId]
        );
        const account = accountResult.rows[0];
        if (!account) {
            throw createPhoneChangeError("Account not found.", "PHONE_CHANGE_ACCOUNT_NOT_FOUND", 404);
        }
        if (!await bcrypt.compare(currentPassword, account.password_hash)) {
            throw createPhoneChangeError(
                "The current password is incorrect.",
                "PHONE_CHANGE_PASSWORD_INVALID",
                401
            );
        }
        if (normalizeKenyanPhone(account.phone) === phone && account.phone_verified_at) {
            throw createPhoneChangeError(
                "That number is already registered to your account.",
                "PHONE_CHANGE_SAME_PHONE",
                409
            );
        }

        const currentNumberResult = await client.query(
            `SELECT user_id
             FROM users
             WHERE user_id <> $1 AND (${NORMALIZED_PHONE_SQL}) = $2
             LIMIT 1`,
            [userId, phone]
        );
        if (currentNumberResult.rows.length) {
            throw createPhoneChangeError(
                "That phone number is already in use.",
                "PHONE_CHANGE_PHONE_IN_USE",
                409
            );
        }
        const pendingNumberResult = await client.query(
            `SELECT user_id
             FROM phone_change_verifications
             WHERE user_id <> $1 AND pending_phone = $2
             LIMIT 1`,
            [userId, phone]
        );
        if (pendingNumberResult.rows.length) {
            throw createPhoneChangeError(
                "That phone number is already being verified for another account.",
                "PHONE_CHANGE_PHONE_IN_USE",
                409
            );
        }

        const challengeResult = await client.query(
            `SELECT send_count, window_started_at, last_sent_at,
                    attempt_count, attempt_window_started_at, locked_until
             FROM phone_change_verifications
             WHERE user_id = $1
             FOR UPDATE`,
            [userId]
        );
        const challenge = challengeResult.rows[0];
        const currentTime = requestTime.getTime();
        const oldSendWindow = timestamp(challenge?.window_started_at);
        const sendWindowExpired = !oldSendWindow || currentTime - oldSendWindow >= SEND_WINDOW_MS;
        const sendCount = sendWindowExpired ? 0 : Number(challenge.send_count);
        const windowStartedAt = sendWindowExpired
            ? requestTime
            : new Date(oldSendWindow);
        const lockedUntil = timestamp(challenge?.locked_until);
        if (lockedUntil && lockedUntil > currentTime) {
            throw createPhoneChangeError(
                "Too many verification attempts. Try again later.",
                "PHONE_CHANGE_RATE_LIMITED",
                429
            );
        }
        if (sendCount >= MAX_SENDS_PER_WINDOW) {
            throw createPhoneChangeError(
                "Too many verification codes were requested. Try again later.",
                "PHONE_CHANGE_RATE_LIMITED",
                429
            );
        }
        const lastSentAt = timestamp(challenge?.last_sent_at);
        if (lastSentAt && currentTime - lastSentAt < RESEND_INTERVAL_MS) {
            throw createPhoneChangeError(
                "Wait before requesting another verification code.",
                "PHONE_CHANGE_RATE_LIMITED",
                429
            );
        }

        const oldAttemptWindow = timestamp(challenge?.attempt_window_started_at);
        const attemptWindowExpired = !oldAttemptWindow ||
            currentTime - oldAttemptWindow >= SEND_WINDOW_MS ||
            (lockedUntil !== null && lockedUntil <= currentTime);
        const attemptCount = attemptWindowExpired
            ? 0
            : Number(challenge.attempt_count);
        const attemptWindowStartedAt = attemptWindowExpired
            ? requestTime
            : new Date(oldAttemptWindow);
        if (attemptCount >= MAX_ATTEMPTS_PER_WINDOW) {
            throw createPhoneChangeError(
                "Too many verification attempts. Try again later.",
                "PHONE_CHANGE_RATE_LIMITED",
                429
            );
        }

        otp = crypto.randomInt(0, 1000000).toString().padStart(6, "0");
        const { salt, hash } = await hashCode(otp);
        await client.query(
            `INSERT INTO phone_change_verifications
                (user_id, pending_phone, code_hash, code_salt, expires_at,
                 send_count, window_started_at, last_sent_at,
                 attempt_count, attempt_window_started_at, locked_until)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)
             ON CONFLICT (user_id) DO UPDATE SET
                pending_phone = EXCLUDED.pending_phone,
                code_hash = EXCLUDED.code_hash,
                code_salt = EXCLUDED.code_salt,
                expires_at = EXCLUDED.expires_at,
                send_count = EXCLUDED.send_count,
                window_started_at = EXCLUDED.window_started_at,
                last_sent_at = EXCLUDED.last_sent_at,
                attempt_count = EXCLUDED.attempt_count,
                attempt_window_started_at = EXCLUDED.attempt_window_started_at,
                locked_until = NULL`,
            [
                userId,
                phone,
                hash,
                salt,
                new Date(currentTime + PHONE_CODE_TTL_MS),
                sendCount + 1,
                windowStartedAt,
                requestTime,
                attemptCount,
                attemptWindowStartedAt,
            ]
        );
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if (error?.code === "23505") {
            throw createPhoneChangeError(
                "That phone number is already in use.",
                "PHONE_CHANGE_PHONE_IN_USE",
                409
            );
        }
        throw error;
    } finally {
        client.release();
    }

    try {
        const result = await smsService.sendPhoneVerificationSms({
            to: phone,
            message: PHONE_CHANGE_MESSAGE(otp),
            trackingId: `phone-change-${userId}-${crypto.randomUUID()}`,
        }, { environment, fetchImpl });
        if (result?.accepted !== true || result.status !== "PROVIDER_ACCEPTED") {
            throw createPhoneChangeError(
                "The SMS provider outcome could not be confirmed.",
                "PHONE_CHANGE_SMS_UNKNOWN",
                503
            );
        }
    } catch {
        throw createPhoneChangeError(
            "The verification message could not be confirmed. If it arrived, enter its code; otherwise wait before requesting another.",
            "PHONE_CHANGE_SMS_UNAVAILABLE",
            503
        );
    }

    return {
        phone,
        expiresAt: new Date(requestTime.getTime() + PHONE_CODE_TTL_MS).toISOString(),
        smsStatus: "PROVIDER_ACCEPTED",
    };
}

async function verifyPhoneChange({ userId, code }, {
    database = pool,
    now = () => new Date(),
} = {}) {
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
        throw createPhoneChangeError(
            "Enter the six-digit verification code.",
            "PHONE_CHANGE_INVALID_CODE",
            400
        );
    }
    const client = await database.connect();
    const currentTime = now();
    try {
        await client.query("BEGIN");
        const result = await client.query(
            `SELECT pending_phone, code_hash, code_salt, expires_at,
                    attempt_count, attempt_window_started_at, locked_until
             FROM phone_change_verifications
             WHERE user_id = $1
             FOR UPDATE`,
            [userId]
        );
        const challenge = result.rows[0];
        if (!challenge?.pending_phone || !challenge.code_hash || !challenge.code_salt) {
            await client.query("ROLLBACK");
            return { error: createPhoneChangeError(
                "Request a new verification code before continuing.",
                "PHONE_CHANGE_CHALLENGE_NOT_FOUND",
                400
            ) };
        }
        if (timestamp(challenge.expires_at) <= currentTime.getTime()) {
            await client.query(
                `UPDATE phone_change_verifications
                 SET pending_phone = NULL, code_hash = NULL, code_salt = NULL, expires_at = NULL
                 WHERE user_id = $1`,
                [userId]
            );
            await client.query("COMMIT");
            return { error: createPhoneChangeError(
                "The verification code has expired. Request a new code.",
                "PHONE_CHANGE_CODE_EXPIRED",
                410
            ) };
        }
        const lockedUntil = timestamp(challenge.locked_until);
        if (lockedUntil && lockedUntil > currentTime.getTime()) {
            await client.query("ROLLBACK");
            return { error: createPhoneChangeError(
                "Too many verification attempts. Try again later.",
                "PHONE_CHANGE_RATE_LIMITED",
                429
            ) };
        }

        const attemptWindow = timestamp(challenge.attempt_window_started_at);
        const attemptWindowExpired = !attemptWindow ||
            currentTime.getTime() - attemptWindow >= SEND_WINDOW_MS ||
            (lockedUntil !== null && lockedUntil <= currentTime.getTime());
        const attemptCount = attemptWindowExpired ? 0 : Number(challenge.attempt_count);
        if (attemptCount >= MAX_ATTEMPTS_PER_WINDOW) {
            const retryAt = new Date(currentTime.getTime() + LOCKOUT_MS);
            await client.query(
                `UPDATE phone_change_verifications
                 SET locked_until = $2
                 WHERE user_id = $1`,
                [userId, retryAt]
            );
            await client.query("COMMIT");
            return { error: createPhoneChangeError(
                "Too many verification attempts. Try again later.",
                "PHONE_CHANGE_RATE_LIMITED",
                429
            ) };
        }

        if (!await codeMatches(code, challenge.code_salt, challenge.code_hash)) {
            const nextAttemptCount = attemptCount + 1;
            const lockedUntilValue = nextAttemptCount >= MAX_ATTEMPTS_PER_WINDOW
                ? new Date(currentTime.getTime() + LOCKOUT_MS)
                : null;
            await client.query(
                `UPDATE phone_change_verifications
                 SET attempt_count = $2, attempt_window_started_at = $3,
                     locked_until = $4
                 WHERE user_id = $1`,
                [userId, nextAttemptCount, attemptWindowExpired ? currentTime : challenge.attempt_window_started_at, lockedUntilValue]
            );
            await client.query("COMMIT");
            return { error: createPhoneChangeError(
                "The verification code is incorrect.",
                "PHONE_CHANGE_INVALID_CODE",
                400
            ) };
        }

        const updateResult = await client.query(
            `UPDATE users
             SET phone = CASE
                     WHEN (${normalizedPhoneSql("phone")}) = $2 THEN phone
                     ELSE $2
                 END,
                 phone_verified_at = $3
             WHERE user_id = $1
               AND NOT EXISTS (
                   SELECT 1 FROM users other
                   WHERE other.user_id <> $1
                     AND (${normalizedPhoneSql("other.phone")}) = $2
               )
             RETURNING user_id, phone, phone_verified_at`,
            [userId, challenge.pending_phone, currentTime]
        );
        if (!updateResult.rows[0]) {
            await client.query("ROLLBACK");
            return { error: createPhoneChangeError(
                "That phone number is already in use.",
                "PHONE_CHANGE_PHONE_IN_USE",
                409
            ) };
        }
        await client.query(
            `UPDATE phone_change_verifications
             SET pending_phone = NULL, code_hash = NULL, code_salt = NULL,
                 expires_at = NULL, attempt_count = 0,
                 attempt_window_started_at = NULL, locked_until = NULL
             WHERE user_id = $1`,
            [userId]
        );
        await client.query("COMMIT");
        return { phone: updateResult.rows[0].phone, phoneVerified: true };
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if (error?.code === "23505") {
            throw createPhoneChangeError(
                "That phone number is already in use.",
                "PHONE_CHANGE_PHONE_IN_USE",
                409
            );
        }
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    normalizeKenyanPhone,
    startPhoneChange,
    verifyPhoneChange,
};
