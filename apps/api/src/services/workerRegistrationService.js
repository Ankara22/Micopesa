const bcrypt = require("bcrypt");
const crypto = require("node:crypto");
const pool = require("../db/database");
const authEmailService = require("./authEmailService");
const defaultSmsService = require("./smsService");
const {
    decryptNationalId,
    encryptNationalId,
    getNationalIdKeys,
    normalizeNationalId,
} = require("./nationalIdCrypto");
const { writeAuditLog } = require("../utils/auditLog");
const { lockUserIdentities } = require("../utils/userIdentityLock");
const {
    NORMALIZED_PHONE_SQL,
    normalizedPhoneSql,
    normalizeKenyanPhone,
} = require("../utils/kenyanPhone");
const {
    generateSixDigitCode,
    hashOneTimeCode,
    verifyOneTimeCode,
} = require("../utils/oneTimeCode");

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_INTERVAL_MS = 60 * 1000;
const SEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 3;
const MAX_ATTEMPTS_PER_WINDOW = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const SALT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72;
const VALID_OCCUPATIONS = new Set([
    "BODA_BODA_OPERATOR",
    "MARKET_VENDOR",
    "JUA_KALI_ARTISAN",
    "DOMESTIC_WORKER",
    "CASUAL_LABOURER",
    "SMALL_SCALE_FARMER",
    "OTHER_INFORMAL_WORKER",
]);
const GENERIC_REGISTRATION_MESSAGE =
    "If the supplied details can be used, a verification code will be sent to the phone number.";

function serviceError(message, code, statusCode) {
    return Object.assign(new Error(message), { code, statusCode });
}

function timestamp(value) {
    if (!value) return null;
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function normalizeEmail(value) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") return undefined;
    const email = value.trim().toLowerCase();
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        ? email
        : undefined;
}

function validDateOfBirth(value, now) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day) return false;
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (date > today) return false;
    let age = today.getUTCFullYear() - year;
    if (today.getUTCMonth() < month - 1 ||
        (today.getUTCMonth() === month - 1 && today.getUTCDate() < day)) age -= 1;
    return age >= 18 && age <= 60;
}

function validateRegistration(input, now) {
    const fullName = typeof input?.full_name === "string" ? input.full_name.trim() : "";
    const phone = normalizeKenyanPhone(input?.phone);
    const email = normalizeEmail(input?.email);
    const nationalId = normalizeNationalId(input?.national_id);
    const occupation = input?.occupation;
    const dateOfBirth = typeof input?.date_of_birth === "string"
        ? input.date_of_birth.trim()
        : "";

    if (!fullName || fullName.length > 100 || !phone || email === undefined) {
        throw serviceError(
            "Provide a full name, a valid Kenyan phone number, and an optional valid email address.",
            "WORKER_REGISTRATION_INVALID_INPUT",
            400
        );
    }
    if (!nationalId) {
        throw serviceError(
            "National ID must contain 7 or 8 digits.",
            "INVALID_NATIONAL_ID",
            400
        );
    }
    if (!VALID_OCCUPATIONS.has(occupation)) {
        throw serviceError("Select a valid occupation.", "INVALID_OCCUPATION", 400);
    }
    if (!validDateOfBirth(dateOfBirth, now)) {
        throw serviceError(
            "Date of birth must be valid and the worker must be between 18 and 60 years old.",
            "INVALID_DATE_OF_BIRTH",
            400
        );
    }
    return { fullName, phone, email, nationalId, occupation, dateOfBirth };
}

function validatePassword(password) {
    if (typeof password !== "string" ||
        password.length < MIN_PASSWORD_LENGTH ||
        Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
        throw serviceError(
            `Password must be at least ${MIN_PASSWORD_LENGTH} characters and no more than ${MAX_PASSWORD_BYTES} UTF-8 bytes.`,
            "INVALID_PASSWORD",
            400
        );
    }
}

function getSmsConfiguration(smsService, environment) {
    if (typeof smsService.getPhoneVerificationSmsConfiguration !== "function") {
        return {
            available: false,
            errorCode: "SMS_CONFIGURATION_MISSING",
            provider: null,
            missingVariables: ["SMS_PROVIDER_CONFIGURATION"],
            invalidVariables: [],
        };
    }
    return smsService.getPhoneVerificationSmsConfiguration(environment);
}

function ensureSmsAvailable(configuration) {
    if (configuration?.available) return;
    const error = serviceError(
        "Phone verification SMS configuration is incomplete or invalid.",
        "WORKER_REGISTRATION_SMS_UNAVAILABLE",
        503
    );
    error.diagnostics = {
        provider: configuration?.provider || null,
        missingVariables: configuration?.missingVariables || [],
        invalidVariables: configuration?.invalidVariables || [],
        reasonCode: configuration?.errorCode || "SMS_CONFIGURATION_MISSING",
    };
    throw error;
}

function safeSmsError(error) {
    return typeof error?.code === "string" && /^SMS_[A-Z0-9_]{1,60}$/.test(error.code)
        ? error.code
        : "SMS_SEND_FAILED";
}

async function dispatchVerificationCode({
    smsService,
    environment,
    configuration,
    phone,
    code,
    trackingId,
}) {
    const result = await smsService.sendPhoneVerificationSms({
        to: phone,
        message: `Your MicoPesa registration code is ${code}. It expires in 10 minutes. Do not share this code.`,
        trackingId,
    }, { environment, providerConfiguration: configuration });
    if (result?.accepted !== true || result.status !== "PROVIDER_ACCEPTED") {
        throw Object.assign(new Error("The SMS provider outcome could not be confirmed."), {
            code: "SMS_UNKNOWN_OUTCOME",
        });
    }
}

function createWorkerRegistrationService({
    database = pool,
    smsService = defaultSmsService,
    emailService = authEmailService,
    environment = process.env,
    now = () => new Date(),
} = {}) {
    async function enforceRequestLimits(req, action, phone) {
        await emailService.enforceRequestLimits({ req, action, phone });
    }

    async function cancelChallenge(challengeId) {
        await database.query(
            "DELETE FROM worker_registration_challenges WHERE challenge_id = $1",
            [challengeId]
        );
    }

    async function startRegistration(input, req) {
        const requestTime = now();
        const details = validateRegistration(input, requestTime);
        const keys = getNationalIdKeys(environment);
        const encrypted = encryptNationalId(details.nationalId, keys);
        const challengeId = crypto.randomUUID();
        const code = generateSixDigitCode();
        const { hash, salt } = await hashOneTimeCode(code);
        const configuration = getSmsConfiguration(smsService, environment);
        ensureSmsAvailable(configuration);
        await enforceRequestLimits(req, "WORKER_REGISTRATION_OTP", details.phone);

        const client = await database.connect();
        let transactionStarted = false;
        let eligible = false;
        try {
            await client.query("BEGIN");
            transactionStarted = true;
            await lockUserIdentities(client, {
                emails: details.email ? [details.email] : [],
                phones: [details.phone],
                nationalIds: [encrypted.fingerprint],
            });
            await client.query(
                `DELETE FROM worker_registration_challenges
                 WHERE phone = $1
                   AND (challenge_status <> 'PENDING' OR expires_at <= $2)`,
                [details.phone, requestTime]
            );
            await client.query(
                `DELETE FROM worker_national_id_claims
                 WHERE claim_status = 'RESERVED' AND expires_at <= $1`,
                [requestTime]
            );
            const existing = await client.query(
                `SELECT 1
                 FROM users
                 WHERE (${NORMALIZED_PHONE_SQL}) = $1
                    OR ($2::varchar IS NOT NULL AND (
                        lower(email) = $2 OR lower(pending_email) = $2
                    ))
                 UNION ALL
                 SELECT 1 FROM pending_registrations
                 WHERE expires_at > $3
                   AND (${normalizedPhoneSql("phone")} = $1
                        OR ($2::varchar IS NOT NULL AND lower(email) = $2))
                 UNION ALL
                 SELECT 1
                 FROM worker_national_id_claims
                 WHERE national_id_fingerprint = $4
                   AND NOT (claim_status = 'RESERVED' AND expires_at <= $3)
                 LIMIT 1`,
                [details.phone, details.email, requestTime, encrypted.fingerprint]
            );
            if (existing.rows.length) {
                await client.query("COMMIT");
                transactionStarted = false;
            } else {
                await client.query(
                    `DELETE FROM worker_registration_challenges
                     WHERE phone = $1 AND challenge_status = 'PENDING'`,
                    [details.phone]
                );
                await client.query(
                    `INSERT INTO worker_registration_challenges (
                        challenge_id, full_name, phone, email, occupation, date_of_birth,
                        national_id_ciphertext, national_id_iv, national_id_tag,
                        national_id_key_version,
                        national_id_fingerprint, national_id_last_four,
                        code_hash, code_salt, expires_at, send_count,
                        window_started_at, last_sent_at, attempt_count,
                        attempt_window_started_at, challenge_status
                     )
                     VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                        $13, $14, $15, 1, $16, $16, 0, $16, 'PENDING'
                     )`,
                    [
                        challengeId,
                        details.fullName,
                        details.phone,
                        details.email,
                        details.occupation,
                        details.dateOfBirth,
                        encrypted.ciphertext,
                        encrypted.iv,
                        encrypted.tag,
                        encrypted.keyVersion,
                        encrypted.fingerprint,
                        encrypted.lastFour,
                        hash,
                        salt,
                        new Date(requestTime.getTime() + CODE_TTL_MS),
                        requestTime,
                    ]
                );
                await client.query(
                    `INSERT INTO worker_national_id_claims (
                        national_id_fingerprint, claim_status,
                        registration_challenge_id, expires_at
                     ) VALUES ($1, 'RESERVED', $2, $3)`,
                    [encrypted.fingerprint, challengeId, new Date(requestTime.getTime() + CODE_TTL_MS)]
                );
                await client.query("COMMIT");
                transactionStarted = false;
                eligible = true;
            }
        } catch (error) {
            if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
            if (error?.code === "23505") {
                return {
                    challengeId,
                    message: GENERIC_REGISTRATION_MESSAGE,
                    accepted: false,
                };
            }
            throw error;
        } finally {
            client.release();
        }

        if (eligible) {
            try {
                await dispatchVerificationCode({
                    smsService,
                    environment,
                    configuration,
                    phone: details.phone,
                    code,
                    trackingId: `worker-registration-${challengeId}`,
                });
            } catch (error) {
                await cancelChallenge(challengeId);
                throw serviceError(
                    "The verification message could not be confirmed. Please try again later.",
                    "WORKER_REGISTRATION_SMS_DELIVERY_FAILED",
                    503
                );
            }
        }
        return {
            challengeId,
            message: GENERIC_REGISTRATION_MESSAGE,
            accepted: true,
        };
    }

    async function resendRegistrationCode(challengeId, req) {
        if (typeof challengeId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(challengeId)) {
            return { accepted: true, message: GENERIC_REGISTRATION_MESSAGE };
        }
        const lookup = await database.query(
            `SELECT phone FROM worker_registration_challenges
             WHERE challenge_id = $1 AND challenge_status = 'PENDING'`,
            [challengeId]
        );
        const phone = lookup.rows[0]?.phone;
        if (!phone) return { accepted: true, message: GENERIC_REGISTRATION_MESSAGE };
        await enforceRequestLimits(req, "WORKER_REGISTRATION_OTP_RESEND", phone);
        const configuration = getSmsConfiguration(smsService, environment);
        ensureSmsAvailable(configuration);

        const requestTime = now();
        const client = await database.connect();
        let transactionStarted = false;
        let code;
        let sendCount;
        try {
            await client.query("BEGIN");
            transactionStarted = true;
            const result = await client.query(
                `SELECT phone, code_hash, code_salt, expires_at, send_count,
                        window_started_at, last_sent_at, attempt_count,
                        attempt_window_started_at, locked_until
                 FROM worker_registration_challenges
                 WHERE challenge_id = $1 AND challenge_status = 'PENDING'
                 FOR UPDATE`,
                [challengeId]
            );
            const challenge = result.rows[0];
            if (!challenge || timestamp(challenge.expires_at) <= requestTime.getTime()) {
                await client.query("ROLLBACK");
                transactionStarted = false;
                return { accepted: true, message: GENERIC_REGISTRATION_MESSAGE };
            }
            const lockedUntil = timestamp(challenge.locked_until);
            if (lockedUntil && lockedUntil > requestTime.getTime()) {
                throw serviceError("Too many verification attempts. Try again later.", "OTP_RATE_LIMITED", 429);
            }
            const oldWindow = timestamp(challenge.window_started_at);
            const resetWindow = !oldWindow || requestTime.getTime() - oldWindow >= SEND_WINDOW_MS;
            const currentSendCount = resetWindow ? 0 : Number(challenge.send_count);
            const lastSentAt = timestamp(challenge.last_sent_at);
            if (currentSendCount >= MAX_SENDS_PER_WINDOW ||
                (lastSentAt && requestTime.getTime() - lastSentAt < RESEND_INTERVAL_MS)) {
                throw serviceError("Wait before requesting another verification code.", "OTP_RATE_LIMITED", 429);
            }
            code = generateSixDigitCode();
            const { hash, salt } = await hashOneTimeCode(code);
            sendCount = currentSendCount + 1;
            await client.query(
                `UPDATE worker_registration_challenges
                 SET code_hash = $2, code_salt = $3, expires_at = $4,
                     send_count = $5, window_started_at = $6,
                     last_sent_at = $7, attempt_count = 0,
                     attempt_window_started_at = $7, locked_until = NULL
                 WHERE challenge_id = $1`,
                [
                    challengeId,
                    hash,
                    salt,
                    new Date(requestTime.getTime() + CODE_TTL_MS),
                    sendCount,
                    resetWindow ? requestTime : challenge.window_started_at,
                    requestTime,
                ]
            );
            await client.query(
                `UPDATE worker_national_id_claims
                 SET expires_at = $2
                 WHERE registration_challenge_id = $1 AND claim_status = 'RESERVED'`,
                [challengeId, new Date(requestTime.getTime() + CODE_TTL_MS)]
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
            await dispatchVerificationCode({
                smsService,
                environment,
                configuration,
                phone,
                code,
                trackingId: `worker-registration-${challengeId}-${sendCount}`,
            });
        } catch {
            await cancelChallenge(challengeId);
            throw serviceError(
                "The verification message could not be confirmed. Please restart registration.",
                "WORKER_REGISTRATION_SMS_DELIVERY_FAILED",
                503
            );
        }
        return { accepted: true, message: GENERIC_REGISTRATION_MESSAGE };
    }

    async function completeRegistration({ challengeId, code, password }, req) {
        if (typeof challengeId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(challengeId) ||
            typeof code !== "string" || !/^\d{6}$/.test(code)) {
            throw serviceError("The verification code is invalid or expired.", "OTP_INVALID", 400);
        }
        validatePassword(password);
        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
        const initial = await database.query(
            `SELECT phone, email, national_id_fingerprint
             FROM worker_registration_challenges
             WHERE challenge_id = $1 AND challenge_status = 'PENDING'`,
            [challengeId]
        );
        const identity = initial.rows[0];
        if (!identity) {
            throw serviceError("The verification code is invalid or expired.", "OTP_INVALID", 400);
        }
        await enforceRequestLimits(req, "WORKER_REGISTRATION_OTP_VALIDATE", identity.phone);
        const client = await database.connect();
        let transactionStarted = false;
        let createdUser;
        let pendingEmail;
        try {
            await client.query("BEGIN");
            transactionStarted = true;
            await lockUserIdentities(client, {
                emails: identity.email ? [identity.email] : [],
                phones: [identity.phone],
                nationalIds: [identity.national_id_fingerprint],
            });
            const result = await client.query(
                `SELECT challenge_id, full_name, phone, email, occupation, date_of_birth,
                        national_id_ciphertext, national_id_iv, national_id_tag,
                        national_id_key_version,
                        national_id_fingerprint, national_id_last_four, code_hash, code_salt,
                        expires_at, attempt_count, attempt_window_started_at, locked_until
                 FROM worker_registration_challenges
                 WHERE challenge_id = $1 AND challenge_status = 'PENDING'
                 FOR UPDATE`,
                [challengeId]
            );
            const challenge = result.rows[0];
            if (!challenge ||
                challenge.phone !== identity.phone ||
                challenge.email !== identity.email ||
                challenge.national_id_fingerprint !== identity.national_id_fingerprint ||
                timestamp(challenge.expires_at) <= now().getTime()) {
                throw serviceError("The verification code is invalid or expired.", "OTP_INVALID", 400);
            }

            const lockedUntil = timestamp(challenge.locked_until);
            if (lockedUntil && lockedUntil > now().getTime()) {
                throw serviceError("Too many verification attempts. Try again later.", "OTP_RATE_LIMITED", 429);
            }
            const attemptWindow = timestamp(challenge.attempt_window_started_at);
            const resetAttemptWindow = !attemptWindow ||
                now().getTime() - attemptWindow >= SEND_WINDOW_MS ||
                (lockedUntil !== null && lockedUntil <= now().getTime());
            const attempts = resetAttemptWindow ? 0 : Number(challenge.attempt_count);
            if (attempts >= MAX_ATTEMPTS_PER_WINDOW) {
                const retryAt = new Date(now().getTime() + LOCKOUT_MS);
                await client.query(
                    "UPDATE worker_registration_challenges SET locked_until = $2 WHERE challenge_id = $1",
                    [challengeId, retryAt]
                );
                await client.query("COMMIT");
                transactionStarted = false;
                throw serviceError("Too many verification attempts. Try again later.", "OTP_RATE_LIMITED", 429);
            }
            if (!await verifyOneTimeCode(code, challenge.code_salt, challenge.code_hash)) {
                const nextAttempts = attempts + 1;
                const nextLock = nextAttempts >= MAX_ATTEMPTS_PER_WINDOW
                    ? new Date(now().getTime() + LOCKOUT_MS)
                    : null;
                await client.query(
                    `UPDATE worker_registration_challenges
                     SET attempt_count = $2, attempt_window_started_at = $3,
                         locked_until = $4
                     WHERE challenge_id = $1`,
                    [
                        challengeId,
                        nextAttempts,
                        resetAttemptWindow ? now() : challenge.attempt_window_started_at,
                        nextLock,
                    ]
                );
                await client.query("COMMIT");
                transactionStarted = false;
                throw serviceError("The verification code is incorrect.", "OTP_INVALID", 400);
            }

            const claim = await client.query(
                `SELECT claim_status, registration_challenge_id, expires_at
                 FROM worker_national_id_claims
                 WHERE national_id_fingerprint = $1
                 FOR UPDATE`,
                [challenge.national_id_fingerprint]
            );
            if (claim.rows[0]?.claim_status !== "RESERVED" ||
                claim.rows[0]?.registration_challenge_id !== challengeId ||
                timestamp(claim.rows[0]?.expires_at) <= now().getTime()) {
                throw serviceError("The registration could not be completed. Restart registration.", "REGISTRATION_UNAVAILABLE", 409);
            }
            const existingIdentity = await client.query(
                `SELECT 1 FROM users
                 WHERE (${NORMALIZED_PHONE_SQL}) = $1 OR ($2::varchar IS NOT NULL AND (
                     lower(email) = $2 OR lower(pending_email) = $2
                 ))
                 UNION ALL
                 SELECT 1 FROM pending_registrations
                 WHERE ${normalizedPhoneSql("phone")} = $1
                    OR ($2::varchar IS NOT NULL AND lower(email) = $2)
                 LIMIT 1`,
                [challenge.phone, challenge.email]
            );
            if (existingIdentity.rows.length) {
                throw serviceError("The registration could not be completed. Restart registration.", "REGISTRATION_UNAVAILABLE", 409);
            }

            const nationalId = decryptNationalId({
                ciphertext: challenge.national_id_ciphertext,
                iv: challenge.national_id_iv,
                tag: challenge.national_id_tag,
                keyVersion: challenge.national_id_key_version,
                fingerprint: challenge.national_id_fingerprint,
                lastFour: typeof challenge.national_id_last_four === "string"
                    ? challenge.national_id_last_four.trim()
                    : challenge.national_id_last_four,
            }, { environment });
            const encryptedNationalId = encryptNationalId(nationalId, { environment });
            const userResult = await client.query(
                `INSERT INTO users (
                    full_name, phone, phone_verified_at, pending_email, email_verified,
                    password_hash, role, occupation, login_method, account_status
                 )
                 VALUES ($1, $2, now(), $3, FALSE, $4, 'WORKER', $5, 'PHONE', 'ACTIVE')
                 RETURNING user_id`,
                [
                    challenge.full_name,
                    challenge.phone,
                    challenge.email,
                    passwordHash,
                    challenge.occupation,
                ]
            );
            createdUser = userResult.rows[0];
            await client.query(
                `INSERT INTO pension_accounts (user_id, current_balance, retirement_age)
                 VALUES ($1, 0.00, 60)`,
                [createdUser.user_id]
            );
            await client.query(
                `INSERT INTO notification_preferences (user_id, sms_enabled, email_enabled)
                 VALUES ($1, FALSE, FALSE)`,
                [createdUser.user_id]
            );
            await client.query(
                `INSERT INTO kyc_records (
                    user_id, national_id, national_id_ciphertext, national_id_iv,
                    national_id_tag, national_id_key_version,
                    national_id_fingerprint, national_id_last_four,
                    date_of_birth, kyc_status
                 )
                 VALUES ($1, 'ENCRYPTED', $2, $3, $4, $5, $6, $7, $8, 'PENDING')`,
                [
                    createdUser.user_id,
                    encryptedNationalId.ciphertext,
                    encryptedNationalId.iv,
                    encryptedNationalId.tag,
                    encryptedNationalId.keyVersion,
                    encryptedNationalId.fingerprint,
                    encryptedNationalId.lastFour,
                    challenge.date_of_birth,
                ]
            );
            const claimUpdate = await client.query(
                `UPDATE worker_national_id_claims
                 SET claim_status = 'CLAIMED', user_id = $2,
                     registration_challenge_id = NULL, expires_at = NULL
                 WHERE national_id_fingerprint = $1
                   AND claim_status = 'RESERVED'
                   AND registration_challenge_id = $3
                 RETURNING national_id_fingerprint`,
                [challenge.national_id_fingerprint, createdUser.user_id, challengeId]
            );
            if (!claimUpdate.rows[0]) {
                throw serviceError("The registration could not be completed. Restart registration.", "REGISTRATION_UNAVAILABLE", 409);
            }
            await writeAuditLog(client, {
                userId: createdUser.user_id,
                actionType: "CREATE",
                entityName: "WORKER_REGISTRATION",
                entityId: createdUser.user_id,
                details: {
                    phone_verified: true,
                    email_provided: Boolean(challenge.email),
                    kyc_status: "PENDING",
                },
            });
            await client.query(
                "DELETE FROM worker_registration_challenges WHERE challenge_id = $1",
                [challengeId]
            );
            await client.query("COMMIT");
            transactionStarted = false;
            pendingEmail = challenge.email;
        } catch (error) {
            if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
            if (error?.code === "23505") {
                throw serviceError("The registration could not be completed. Restart registration.", "REGISTRATION_UNAVAILABLE", 409);
            }
            throw error;
        } finally {
            client.release();
        }

        if (pendingEmail) {
            try {
                await emailService.issueEmailToken({
                    userId: createdUser.user_id,
                    email: pendingEmail,
                    purpose: "EMAIL_VERIFICATION",
                });
            } catch (error) {
                emailService.logEmailDeliveryFailure("EMAIL_VERIFICATION", error);
            }
        }
        return {
            userId: createdUser.user_id,
            accountStatus: "ACTIVE",
            kycStatus: "PENDING",
            message: "Your phone number is verified and your account is ready. Sign in to continue.",
        };
    }

    return { startRegistration, resendRegistrationCode, completeRegistration };
}

module.exports = {
    CODE_TTL_MS,
    GENERIC_REGISTRATION_MESSAGE,
    createWorkerRegistrationService,
    normalizeEmail,
    validateRegistration,
};
