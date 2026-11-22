const pool = require("../db/database");
const defaultSmsService = require("./smsService");
const { loadAdminSettings } = require("./adminSettingsService");
const { normalizeKenyanPhone } = require("./phoneChangeService");
const { writeAuditLog } = require("../utils/auditLog");
const {
    generateSixDigitCode,
    hashOneTimeCode,
    verifyOneTimeCode,
} = require("../utils/oneTimeCode");

const OTP_TTL_MS = 5 * 60 * 1000;
const SEND_COOLDOWN_MS = 60 * 1000;
const SEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 3;
const MAX_VERIFY_ATTEMPTS = 5;

function createPayoutOtpError(message, code, statusCode) {
    return Object.assign(new Error(message), { code, statusCode });
}

function safeProviderErrorCode(error) {
    return typeof error?.code === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(error.code)
        ? error.code
        : null;
}

function hasCurrentVerifiedPhone(claim) {
    if (!claim.phone_verified_at) return false;
    const currentPhone = normalizeKenyanPhone(claim.phone);
    const claimPhone = normalizeKenyanPhone(claim.destination_phone);
    return Boolean(currentPhone && claimPhone && currentPhone === claimPhone);
}

async function loadClaimForUpdate(client, claimId, workerUserId = null) {
    const referenceResult = await client.query(
        "SELECT account_id FROM withdrawal_claims WHERE claim_id = $1",
        [claimId]
    );
    const accountId = referenceResult.rows[0]?.account_id;
    if (!accountId) return null;

    const accountValues = workerUserId ? [accountId, workerUserId] : [accountId];
    const accountResult = await client.query(
        `SELECT account_id, user_id, account_status
         FROM pension_accounts
         WHERE account_id = $1${workerUserId ? " AND user_id = $2" : ""}
         FOR UPDATE`,
        accountValues
    );
    const account = accountResult.rows[0];
    if (!account) return null;

    const claimResult = await client.query(
        `SELECT claim_id, account_id, claim_status, amount_requested,
                destination_phone, transaction_id, processed_at
         FROM withdrawal_claims
         WHERE claim_id = $1 AND account_id = $2
         FOR UPDATE`,
        [claimId, accountId]
    );
    const withdrawal = claimResult.rows[0];
    if (!withdrawal) return null;

    const userResult = await client.query(
        `SELECT user_id, full_name, phone, phone_verified_at,
                account_status AS user_status, role AS user_role
         FROM users
         WHERE user_id = $1
         FOR UPDATE`,
        [account.user_id]
    );
    const user = userResult.rows[0];
    if (!user) return null;

    return { ...withdrawal, ...account, ...user, worker_user_id: account.user_id };
}

function createWithdrawalPayoutOtpService({
    database = pool,
    smsService = defaultSmsService,
    settingsLoader = loadAdminSettings,
    generateCode = generateSixDigitCode,
    hashCode = hashOneTimeCode,
    verifyCode = verifyOneTimeCode,
    now = () => new Date(),
    environment = process.env,
} = {}) {
    function getSmsProviderConfiguration() {
        const providerConfiguration =
            typeof smsService.getPhoneVerificationSmsConfiguration === "function"
                ? smsService.getPhoneVerificationSmsConfiguration(environment)
                : null;
        if (!providerConfiguration?.available) {
            throw createPayoutOtpError(
                "Withdrawal OTP SMS is not configured. Configure the verified transactional SMS provider before retrying.",
                "WITHDRAWAL_OTP_SMS_CONFIGURATION",
                503
            );
        }
        return providerConfiguration;
    }

    async function assertOtpPolicy(client) {
        let settings;
        try {
            settings = await settingsLoader(client, { lock: true });
        } catch {
            throw createPayoutOtpError(
                "Withdrawal OTP policy settings are unavailable or invalid. Contact support before authorizing a payout.",
                "WITHDRAWAL_OTP_SETTINGS_UNAVAILABLE",
                503
            );
        }
        if (settings.require_otp_on_withdrawal !== true) {
            throw createPayoutOtpError(
                "Withdrawal OTP is required but is disabled in system settings. Contact an administrator.",
                "WITHDRAWAL_OTP_REQUIRED",
                503
            );
        }
    }

    async function getAuthorizationQueue() {
        const result = await database.query(
            `SELECT wc.claim_id, wc.amount_requested, wc.withdrawal_reason,
                    wc.claim_status, wc.requested_at, wc.reviewed_at,
                    pa.account_status, u.account_status AS worker_status,
                    u.phone_verified_at,
                    (
                        u.phone_verified_at IS NOT NULL
                        AND RIGHT(REGEXP_REPLACE(u.phone, '[^0-9]', '', 'g'), 9)
                            = RIGHT(REGEXP_REPLACE(wc.destination_phone, '[^0-9]', '', 'g'), 9)
                    ) AS verified_destination_matches,
                    u.full_name AS worker_name,
                    RIGHT(REGEXP_REPLACE(wc.destination_phone, '[^0-9]', '', 'g'), 4)
                        AS destination_phone_last_four,
                    otp.status AS otp_status, otp.expires_at AS otp_expires_at,
                    otp.verified_at AS otp_verified_at
             FROM withdrawal_claims wc
             JOIN pension_accounts pa ON pa.account_id = wc.account_id
             JOIN users u ON u.user_id = pa.user_id
             LEFT JOIN LATERAL (
                 SELECT status, expires_at, verified_at
                 FROM withdrawal_payout_otp_authorizations
                 WHERE claim_id = wc.claim_id
                 ORDER BY created_at DESC
                 LIMIT 1
             ) otp ON true
             WHERE wc.claim_status = 'APPROVED'
               AND wc.transaction_id IS NULL
               AND wc.processed_at IS NULL
             ORDER BY wc.reviewed_at ASC NULLS LAST, wc.requested_at ASC`
        );
        return result.rows;
    }

    async function readExistingIdempotentAttempt(client, idempotencyKey) {
        const result = await client.query(
            `SELECT authorization_attempt_id, claim_id, worker_user_id,
                    status, expires_at, verified_at, last_delivery_error_code
             FROM withdrawal_payout_otp_authorizations
             WHERE idempotency_key = $1
             FOR UPDATE`,
            [idempotencyKey]
        );
        return result.rows[0] || null;
    }

    async function issueOtp({
        claimId,
        payoutOfficerUserId,
        idempotencyKey,
        resend = false,
    }) {
        const providerConfiguration = getSmsProviderConfiguration();
        const client = await database.connect();
        let currentTime;
        let expiresAt;
        let otp;
        let hash;
        let salt;
        let transactionOpen = false;
        let deliveryFinalizationStarted = false;
        let deliveryFinalizationComplete = false;
        let stalePendingExpired = false;
        let dispatchError = null;
        let response;

        try {
            await client.query("BEGIN");
            transactionOpen = true;
            await assertOtpPolicy(client);
            currentTime = now();
            expiresAt = new Date(currentTime.getTime() + OTP_TTL_MS);

            const existing = await readExistingIdempotentAttempt(client, idempotencyKey);
            if (existing) {
                if (existing.claim_id !== claimId) {
                    throw createPayoutOtpError(
                        "This idempotency key was already used for a different withdrawal.",
                        "WITHDRAWAL_OTP_IDEMPOTENCY_CONFLICT",
                        409
                    );
                }
                await client.query("COMMIT");
                transactionOpen = false;
                if (existing.status === "DELIVERY_FAILED" || existing.status === "DELIVERY_UNKNOWN") {
                    throw createPayoutOtpError(
                        "The SMS delivery outcome was not confirmed. Wait before retrying with a new request.",
                        "WITHDRAWAL_OTP_DELIVERY_UNCONFIRMED",
                        503
                    );
                }
                if (existing.status === "DELIVERY_PENDING") {
                    throw createPayoutOtpError(
                        "OTP delivery is still being reconciled. The pending code cannot authorize this withdrawal.",
                        "WITHDRAWAL_OTP_DELIVERY_UNCONFIRMED",
                        503
                    );
                }
                if (existing.status === "EXPIRED" || existing.status === "INVALIDATED" ||
                    existing.status === "LOCKED") {
                    throw createPayoutOtpError(
                        "This authorization request is no longer active. Start a new authorization request.",
                        "WITHDRAWAL_OTP_REQUEST_INACTIVE",
                        409
                    );
                }
                return {
                    authorizationAttemptId: existing.authorization_attempt_id,
                    claimId: existing.claim_id,
                    status: existing.status,
                    expiresAt: existing.expires_at,
                    verifiedAt: existing.verified_at,
                    replayed: true,
                };
            }

            const claim = await loadClaimForUpdate(client, claimId);
            if (!claim) {
                throw createPayoutOtpError("Withdrawal claim not found.", "WITHDRAWAL_NOT_FOUND", 404);
            }
            if (claim.claim_status !== "APPROVED" ||
                claim.transaction_id !== null || claim.processed_at !== null) {
                throw createPayoutOtpError(
                    "Only an approved, unpaid withdrawal can be authorized for payout.",
                    "WITHDRAWAL_NOT_APPROVED",
                    409
                );
            }
            if (claim.account_status !== "ACTIVE" || claim.user_status !== "ACTIVE" ||
                claim.user_role !== "WORKER") {
                throw createPayoutOtpError(
                    "The worker or pension account is inactive. Resolve the account status before authorizing payout.",
                    "WITHDRAWAL_ACCOUNT_INACTIVE",
                    409
                );
            }
            if (!hasCurrentVerifiedPhone(claim)) {
                throw createPayoutOtpError(
                    "The worker's verified phone no longer matches the withdrawal destination. Review the claim before retrying.",
                    "WITHDRAWAL_PHONE_NOT_VERIFIED",
                    409
                );
            }

            const concurrentReplay = await readExistingIdempotentAttempt(client, idempotencyKey);
            if (concurrentReplay) {
                if (concurrentReplay.claim_id !== claimId) {
                    throw createPayoutOtpError(
                        "This idempotency key was already used for a different withdrawal.",
                        "WITHDRAWAL_OTP_IDEMPOTENCY_CONFLICT",
                        409
                    );
                }
                await client.query("COMMIT");
                transactionOpen = false;
                if (concurrentReplay.status === "DELIVERY_FAILED" ||
                    concurrentReplay.status === "DELIVERY_UNKNOWN") {
                    throw createPayoutOtpError(
                        "The SMS delivery outcome was not confirmed. Wait before retrying with a new request.",
                        "WITHDRAWAL_OTP_DELIVERY_UNCONFIRMED",
                        503
                    );
                }
                if (concurrentReplay.status === "EXPIRED" ||
                    concurrentReplay.status === "INVALIDATED" ||
                    concurrentReplay.status === "LOCKED") {
                    throw createPayoutOtpError(
                        "This authorization request is no longer active. Start a new authorization request.",
                        "WITHDRAWAL_OTP_REQUEST_INACTIVE",
                        409
                    );
                }
                return {
                    authorizationAttemptId: concurrentReplay.authorization_attempt_id,
                    claimId: concurrentReplay.claim_id,
                    status: concurrentReplay.status,
                    expiresAt: concurrentReplay.expires_at,
                    verifiedAt: concurrentReplay.verified_at,
                    replayed: true,
                };
            }

            const activeResult = await client.query(
                `SELECT authorization_attempt_id, status, created_at
                 FROM withdrawal_payout_otp_authorizations
                 WHERE claim_id = $1
                   AND status IN ('DELIVERY_PENDING', 'ISSUED', 'VERIFIED')
                 FOR UPDATE`,
                [claimId]
            );
            let activeAttempt = activeResult.rows[0] || null;
            if (activeAttempt?.status === "DELIVERY_PENDING" &&
                new Date(activeAttempt.created_at).getTime() <= currentTime.getTime() - OTP_TTL_MS) {
                await client.query(
                    `UPDATE withdrawal_payout_otp_authorizations
                     SET status = 'INVALIDATED', otp_hash = NULL, otp_salt = NULL,
                         invalidated_at = $2, invalidation_reason = 'DELIVERY_PENDING_EXPIRED',
                         updated_at = $2
                     WHERE authorization_attempt_id = $1
                       AND status = 'DELIVERY_PENDING'`,
                    [activeAttempt.authorization_attempt_id, currentTime]
                );
                await writeAuditLog(client, {
                    userId: payoutOfficerUserId,
                    actionType: "UPDATE",
                    entityName: "WITHDRAWAL_PAYOUT_OTP",
                    entityId: claimId,
                    details: {
                        event: "OTP_DELIVERY_PENDING_EXPIRED",
                        authorizationAttemptId: activeAttempt.authorization_attempt_id,
                    },
                });
                activeAttempt = null;
                stalePendingExpired = true;
            }
            if (resend) {
                if (!activeAttempt || activeAttempt.status !== "ISSUED") {
                    if (stalePendingExpired) {
                        await client.query("COMMIT");
                        transactionOpen = false;
                    }
                    throw createPayoutOtpError(
                        "There is no active code to resend. Start a new authorization request.",
                        "WITHDRAWAL_OTP_NOT_RESENDABLE",
                        409
                    );
                }
            } else if (activeAttempt) {
                throw createPayoutOtpError(
                    activeAttempt.status === "VERIFIED"
                        ? "This withdrawal has already been authorized. Payout processing is not enabled."
                        : "An OTP is already active. Use the resend action after the cooldown.",
                    activeAttempt.status === "VERIFIED"
                        ? "WITHDRAWAL_OTP_ALREADY_VERIFIED"
                        : "WITHDRAWAL_OTP_ALREADY_ACTIVE",
                    409
                );
            }

            const rateResult = await client.query(
                `SELECT COUNT(*)::int AS send_count, MAX(requested_at) AS last_requested_at
                 FROM withdrawal_payout_otp_delivery_events
                 WHERE worker_user_id = $1 AND claim_id = $2
                   AND requested_at >= $3`,
                [
                    claim.worker_user_id,
                    claimId,
                    new Date(currentTime.getTime() - SEND_WINDOW_MS),
                ]
            );
            const rate = rateResult.rows[0];
            if (Number(rate.send_count) >= MAX_SENDS_PER_WINDOW) {
                await writeAuditLog(client, {
                    userId: payoutOfficerUserId,
                    actionType: "UPDATE",
                    entityName: "WITHDRAWAL_PAYOUT_OTP",
                    entityId: claimId,
                    details: { event: "OTP_SEND_RATE_LIMITED", window: "1_hour" },
                });
                await client.query("COMMIT");
                transactionOpen = false;
                throw createPayoutOtpError(
                    "The maximum of three OTP messages for this withdrawal in one hour has been reached.",
                    "WITHDRAWAL_OTP_SEND_LIMIT",
                    429
                );
            }
            const lastSentAt = rate.last_requested_at ? new Date(rate.last_requested_at).getTime() : null;
            if (lastSentAt !== null && currentTime.getTime() - lastSentAt < SEND_COOLDOWN_MS) {
                const retryAfterSeconds = Math.ceil(
                    (SEND_COOLDOWN_MS - (currentTime.getTime() - lastSentAt)) / 1000
                );
                await writeAuditLog(client, {
                    userId: payoutOfficerUserId,
                    actionType: "UPDATE",
                    entityName: "WITHDRAWAL_PAYOUT_OTP",
                    entityId: claimId,
                    details: { event: "OTP_SEND_COOLDOWN", retryAfterSeconds },
                });
                await client.query("COMMIT");
                transactionOpen = false;
                throw Object.assign(
                    createPayoutOtpError(
                        `Wait ${retryAfterSeconds} seconds before sending another OTP.`,
                        "WITHDRAWAL_OTP_COOLDOWN",
                        429
                    ),
                    { retryAfterSeconds }
                );
            }

            if (activeAttempt) {
                await client.query(
                    `UPDATE withdrawal_payout_otp_authorizations
                     SET status = 'INVALIDATED', otp_hash = NULL, otp_salt = NULL,
                         verified_at = NULL,
                         invalidated_at = $2, invalidation_reason = 'OTP_RESENT',
                         updated_at = $2
                     WHERE authorization_attempt_id = $1`,
                    [activeAttempt.authorization_attempt_id, currentTime]
                );
                await writeAuditLog(client, {
                    userId: payoutOfficerUserId,
                    actionType: "UPDATE",
                    entityName: "WITHDRAWAL_PAYOUT_OTP",
                    entityId: claimId,
                    details: {
                        event: "OTP_INVALIDATED_FOR_RESEND",
                        authorizationAttemptId: activeAttempt.authorization_attempt_id,
                    },
                });
            }

            otp = generateCode();
            ({ hash, salt } = await hashCode(otp));
            const attemptResult = await client.query(
                `INSERT INTO withdrawal_payout_otp_authorizations
                    (idempotency_key, claim_id, account_id, worker_user_id,
                     initiated_by_user_id, destination_phone_snapshot,
                     destination_verified_at, otp_hash, otp_salt, status, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'DELIVERY_PENDING', $10)
                 RETURNING authorization_attempt_id`,
                [
                    idempotencyKey,
                    claimId,
                    claim.account_id,
                    claim.worker_user_id,
                    payoutOfficerUserId,
                    normalizeKenyanPhone(claim.phone),
                    claim.phone_verified_at,
                    hash,
                    salt,
                    currentTime,
                ]
            );
            const authorizationAttemptId = attemptResult.rows[0].authorization_attempt_id;
            await client.query(
                `INSERT INTO withdrawal_payout_otp_delivery_events
                    (authorization_attempt_id, claim_id, worker_user_id,
                     idempotency_key, requested_at, outcome)
                 VALUES ($1, $2, $3, $4, $5, 'PENDING')`,
                [
                    authorizationAttemptId,
                    claimId,
                    claim.worker_user_id,
                    idempotencyKey,
                    currentTime,
                ]
            );

            await writeAuditLog(client, {
                userId: payoutOfficerUserId,
                actionType: "UPDATE",
                entityName: "WITHDRAWAL_PAYOUT_OTP",
                entityId: claimId,
                details: {
                    event: "OTP_DELIVERY_PENDING",
                    authorizationAttemptId,
                },
            });
            await client.query("COMMIT");
            transactionOpen = false;

            try {
                const delivery = await smsService.sendPhoneVerificationSms({
                    to: normalizeKenyanPhone(claim.phone),
                    message: `Your withdrawal payout authorization code is ${otp}. It expires in 5 minutes. Never share it.`,
                    trackingId: `withdrawal-otp-${authorizationAttemptId}`,
                }, {
                    environment,
                    providerConfiguration,
                });
                if (delivery?.accepted !== true || delivery.status !== "PROVIDER_ACCEPTED") {
                    dispatchError = Object.assign(
                        new Error("The SMS provider did not confirm delivery."),
                        { code: "SMS_OUTCOME_UNKNOWN", deliveryOutcomeUnknown: true }
                    );
                }
            } catch (error) {
                dispatchError = error;
            }

            const issuedAt = now();
            expiresAt = new Date(issuedAt.getTime() + OTP_TTL_MS);
            deliveryFinalizationStarted = true;
            await client.query("BEGIN");
            transactionOpen = true;

            if (dispatchError) {
                const unknown = dispatchError.deliveryOutcomeUnknown === true ||
                    dispatchError.diagnostics?.deliveryOutcomeUnknown === true;
                const status = unknown ? "DELIVERY_UNKNOWN" : "DELIVERY_FAILED";
                const outcome = unknown ? "UNKNOWN" : "FAILED";
                const providerErrorCode = safeProviderErrorCode(dispatchError);
                await client.query(
                    `UPDATE withdrawal_payout_otp_authorizations
                     SET status = $2, otp_hash = NULL, otp_salt = NULL,
                         last_delivery_error_code = $3, updated_at = $4
                     WHERE authorization_attempt_id = $1`,
                    [authorizationAttemptId, status, providerErrorCode, issuedAt]
                );
                await client.query(
                    `UPDATE withdrawal_payout_otp_delivery_events
                     SET outcome = $2, provider_error_code = $3
                     WHERE idempotency_key = $1`,
                    [idempotencyKey, outcome, providerErrorCode]
                );
                await writeAuditLog(client, {
                    userId: payoutOfficerUserId,
                    actionType: "UPDATE",
                    entityName: "WITHDRAWAL_PAYOUT_OTP",
                    entityId: claimId,
                    details: {
                        event: "OTP_DELIVERY_FAILED",
                        authorizationAttemptId,
                        status,
                        providerErrorCode,
                    },
                });
                await client.query("COMMIT");
                transactionOpen = false;
                deliveryFinalizationComplete = true;
                throw createPayoutOtpError(
                    unknown
                        ? "The SMS provider did not confirm whether the OTP was delivered. The code cannot authorize this withdrawal; wait before retrying."
                        : "The OTP could not be sent. The withdrawal remains unpaid; check SMS configuration and retry after the cooldown.",
                    unknown
                        ? "WITHDRAWAL_OTP_DELIVERY_UNKNOWN"
                        : "WITHDRAWAL_OTP_DELIVERY_FAILED",
                    503
                );
            }

            const issued = await client.query(
                `UPDATE withdrawal_payout_otp_authorizations
                 SET status = 'ISSUED', issued_at = $2, expires_at = $3,
                     updated_at = $2
                 WHERE authorization_attempt_id = $1
                   AND status = 'DELIVERY_PENDING'
                 RETURNING authorization_attempt_id`,
                [authorizationAttemptId, issuedAt, expiresAt]
            );
            if (!issued.rows[0]) {
                await client.query(
                    `UPDATE withdrawal_payout_otp_delivery_events
                     SET outcome = 'PROVIDER_ACCEPTED'
                     WHERE idempotency_key = $1`,
                    [idempotencyKey]
                );
                await writeAuditLog(client, {
                    userId: payoutOfficerUserId,
                    actionType: "UPDATE",
                    entityName: "WITHDRAWAL_PAYOUT_OTP",
                    entityId: claimId,
                    details: {
                        event: "OTP_DELIVERY_ACCEPTED_AFTER_INVALIDATION",
                        authorizationAttemptId,
                    },
                });
                await client.query("COMMIT");
                transactionOpen = false;
                deliveryFinalizationComplete = true;
                throw createPayoutOtpError(
                    "The authorization changed while the SMS was being delivered. The code cannot authorize this withdrawal.",
                    "WITHDRAWAL_OTP_INVALIDATED_DURING_DELIVERY",
                    409
                );
            }
            await client.query(
                `UPDATE withdrawal_payout_otp_delivery_events
                 SET outcome = 'PROVIDER_ACCEPTED'
                 WHERE idempotency_key = $1`,
                [idempotencyKey]
            );
            await writeAuditLog(client, {
                userId: payoutOfficerUserId,
                actionType: "UPDATE",
                entityName: "WITHDRAWAL_PAYOUT_OTP",
                entityId: claimId,
                details: {
                    event: resend ? "OTP_RESENT" : "OTP_ISSUED",
                    authorizationAttemptId,
                    status: "ISSUED",
                },
            });
            response = {
                authorizationAttemptId,
                claimId,
                status: "ISSUED",
                expiresAt,
                replayed: false,
            };
            await client.query("COMMIT");
            transactionOpen = false;
            deliveryFinalizationComplete = true;
            return response;
        } catch (error) {
            if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
            if (deliveryFinalizationStarted && !deliveryFinalizationComplete) {
                const persistenceError = createPayoutOtpError(
                    "The SMS outcome could not be recorded. This OTP cannot authorize the withdrawal; wait before requesting another code.",
                    "WITHDRAWAL_OTP_DELIVERY_STATUS_UNAVAILABLE",
                    503
                );
                persistenceError.cause = error;
                throw persistenceError;
            }
            if (error?.code === "23505") {
                throw createPayoutOtpError(
                    "This authorization request conflicts with an existing request. Refresh the withdrawal queue and retry.",
                    "WITHDRAWAL_OTP_IDEMPOTENCY_CONFLICT",
                    409
                );
            }
            throw error;
        } finally {
            client.release();
        }
    }

    async function verifyOtp({ claimId, workerUserId, code }) {
        if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
            throw createPayoutOtpError(
                "Enter the six-digit withdrawal authorization code.",
                "WITHDRAWAL_OTP_INVALID_FORMAT",
                400
            );
        }
        getSmsProviderConfiguration();
        const client = await database.connect();
        let currentTime;
        let transactionOpen = false;
        try {
            await client.query("BEGIN");
            transactionOpen = true;
            await assertOtpPolicy(client);
            currentTime = now();

            const claim = await loadClaimForUpdate(client, claimId, workerUserId);
            if (!claim) {
                throw createPayoutOtpError(
                    "Withdrawal claim not found.",
                    "WITHDRAWAL_NOT_FOUND",
                    404
                );
            }
            if (claim.claim_status !== "APPROVED" ||
                claim.transaction_id !== null || claim.processed_at !== null) {
                throw createPayoutOtpError(
                    "Only an approved, unpaid withdrawal can be authorized.",
                    "WITHDRAWAL_NOT_APPROVED",
                    409
                );
            }
            if (claim.account_status !== "ACTIVE" || claim.user_status !== "ACTIVE" ||
                claim.user_role !== "WORKER" || !hasCurrentVerifiedPhone(claim)) {
                throw createPayoutOtpError(
                    "Your account or verified phone changed. Ask the payout officer to review this withdrawal.",
                    "WITHDRAWAL_OTP_ACCOUNT_CHANGED",
                    409
                );
            }

            const attemptResult = await client.query(
                `SELECT authorization_attempt_id, status, otp_hash, otp_salt,
                        attempt_count, expires_at, destination_phone_snapshot,
                        destination_verified_at
                 FROM withdrawal_payout_otp_authorizations
                 WHERE claim_id = $1 AND worker_user_id = $2
                   AND status IN (
                       'DELIVERY_PENDING', 'ISSUED', 'VERIFIED', 'EXPIRED', 'LOCKED',
                       'DELIVERY_FAILED', 'DELIVERY_UNKNOWN'
                   )
                 ORDER BY created_at DESC
                 LIMIT 1
                 FOR UPDATE`,
                [claimId, workerUserId]
            );
            const attempt = attemptResult.rows[0];
            if (!attempt) {
                throw createPayoutOtpError(
                    "No active OTP authorization exists for this withdrawal. Contact the payout officer.",
                    "WITHDRAWAL_OTP_NOT_FOUND",
                    409
                );
            }
            if (normalizeKenyanPhone(attempt.destination_phone_snapshot) !==
                    normalizeKenyanPhone(claim.phone) ||
                new Date(attempt.destination_verified_at).getTime() !==
                    new Date(claim.phone_verified_at).getTime()) {
                await client.query(
                    `UPDATE withdrawal_payout_otp_authorizations
                     SET status = 'INVALIDATED', otp_hash = NULL, otp_salt = NULL,
                         verified_at = NULL, invalidated_at = $2,
                         invalidation_reason = 'WORKER_PHONE_CHANGED', updated_at = $2
                     WHERE authorization_attempt_id = $1`,
                    [attempt.authorization_attempt_id, currentTime]
                );
                await writeAuditLog(client, {
                    userId: workerUserId,
                    actionType: "UPDATE",
                    entityName: "WITHDRAWAL_PAYOUT_OTP",
                    entityId: claimId,
                    details: {
                        event: "OTP_INVALIDATED",
                        authorizationAttemptId: attempt.authorization_attempt_id,
                        reason: "WORKER_PHONE_CHANGED",
                    },
                });
                await client.query("COMMIT");
                transactionOpen = false;
                throw createPayoutOtpError(
                    "The worker's verified phone changed after the OTP was sent. Ask the payout officer to restart authorization.",
                    "WITHDRAWAL_OTP_ACCOUNT_CHANGED",
                    409
                );
            }
            if (attempt.status === "VERIFIED") {
                throw createPayoutOtpError(
                    "This withdrawal OTP has already been used. Payout processing is not enabled.",
                    "WITHDRAWAL_OTP_ALREADY_USED",
                    409
                );
            }
            if (attempt.status === "LOCKED") {
                throw createPayoutOtpError(
                    "The OTP attempt limit has been reached. Ask the payout officer to restart authorization.",
                    "WITHDRAWAL_OTP_ATTEMPTS_EXHAUSTED",
                    429
                );
            }
            if (attempt.status === "EXPIRED") {
                throw createPayoutOtpError(
                    "The OTP has expired. Ask the payout officer to send a new code.",
                    "WITHDRAWAL_OTP_EXPIRED",
                    410
                );
            }
            if (attempt.status !== "ISSUED" || !attempt.otp_hash || !attempt.otp_salt) {
                throw createPayoutOtpError(
                    "The OTP is not available for verification. Contact the payout officer.",
                    "WITHDRAWAL_OTP_NOT_ACTIVE",
                    409
                );
            }
            if (new Date(attempt.expires_at).getTime() <= currentTime.getTime()) {
                await client.query(
                    `UPDATE withdrawal_payout_otp_authorizations
                     SET status = 'EXPIRED', otp_hash = NULL, otp_salt = NULL,
                         updated_at = $2
                     WHERE authorization_attempt_id = $1`,
                    [attempt.authorization_attempt_id, currentTime]
                );
                await writeAuditLog(client, {
                    userId: workerUserId,
                    actionType: "UPDATE",
                    entityName: "WITHDRAWAL_PAYOUT_OTP",
                    entityId: claimId,
                    details: {
                        event: "OTP_EXPIRED",
                        authorizationAttemptId: attempt.authorization_attempt_id,
                    },
                });
                await client.query("COMMIT");
                transactionOpen = false;
                throw createPayoutOtpError(
                    "The OTP has expired. Ask the payout officer to send a new code.",
                    "WITHDRAWAL_OTP_EXPIRED",
                    410
                );
            }

            if (Number(attempt.attempt_count) >= MAX_VERIFY_ATTEMPTS) {
                throw createPayoutOtpError(
                    "The OTP attempt limit has been reached. Ask the payout officer to restart authorization.",
                    "WITHDRAWAL_OTP_ATTEMPTS_EXHAUSTED",
                    429
                );
            }
            const matches = await verifyCode(code, attempt.otp_salt, attempt.otp_hash);
            if (!matches) {
                const nextAttemptCount = Number(attempt.attempt_count) + 1;
                const locked = nextAttemptCount >= MAX_VERIFY_ATTEMPTS;
                await client.query(
                    `UPDATE withdrawal_payout_otp_authorizations
                     SET attempt_count = $2,
                         status = CASE WHEN $3 THEN 'LOCKED' ELSE status END,
                         otp_hash = CASE WHEN $3 THEN NULL ELSE otp_hash END,
                         otp_salt = CASE WHEN $3 THEN NULL ELSE otp_salt END,
                         updated_at = $4
                     WHERE authorization_attempt_id = $1`,
                    [attempt.authorization_attempt_id, nextAttemptCount, locked, currentTime]
                );
                await writeAuditLog(client, {
                    userId: workerUserId,
                    actionType: "UPDATE",
                    entityName: "WITHDRAWAL_PAYOUT_OTP",
                    entityId: claimId,
                    details: {
                        event: locked ? "OTP_LOCKED" : "OTP_VERIFICATION_FAILED",
                        authorizationAttemptId: attempt.authorization_attempt_id,
                        attemptCount: nextAttemptCount,
                    },
                });
                await client.query("COMMIT");
                transactionOpen = false;
                throw createPayoutOtpError(
                    locked
                        ? "The OTP attempt limit has been reached. Ask the payout officer to restart authorization."
                        : "The OTP is incorrect. Check the code and try again.",
                    locked ? "WITHDRAWAL_OTP_ATTEMPTS_EXHAUSTED" : "WITHDRAWAL_OTP_INCORRECT",
                    locked ? 429 : 400
                );
            }

            await client.query(
                `UPDATE withdrawal_payout_otp_authorizations
                 SET status = 'VERIFIED', otp_hash = NULL, otp_salt = NULL,
                     verified_at = $2, updated_at = $2
                 WHERE authorization_attempt_id = $1`,
                [attempt.authorization_attempt_id, currentTime]
            );
            await writeAuditLog(client, {
                userId: workerUserId,
                actionType: "UPDATE",
                entityName: "WITHDRAWAL_PAYOUT_OTP",
                entityId: claimId,
                details: {
                    event: "OTP_VERIFIED",
                    authorizationAttemptId: attempt.authorization_attempt_id,
                    payoutStatus: "NOT_PROCESSED",
                },
            });
            await client.query("COMMIT");
            transactionOpen = false;
            return {
                claimId,
                authorizationAttemptId: attempt.authorization_attempt_id,
                status: "VERIFIED",
                claimStatus: "APPROVED",
                payoutStatus: "NOT_PROCESSED",
            };
        } catch (error) {
            if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    return { getAuthorizationQueue, issueOtp, verifyOtp };
}

module.exports = {
    MAX_SENDS_PER_WINDOW,
    MAX_VERIFY_ATTEMPTS,
    OTP_TTL_MS,
    SEND_COOLDOWN_MS,
    SEND_WINDOW_MS,
    createPayoutOtpError,
    createWithdrawalPayoutOtpService,
};
