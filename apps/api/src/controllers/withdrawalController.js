const pool = require("../db/database");
const { parseAmountCents } = require("../services/contributionAllocationService");
const {
    calculateAvailableBalance,
    getWithdrawalAvailability,
    reviewWithdrawalClaim: reviewClaimTransaction,
} = require("../services/withdrawalService");
const { createWithdrawalPayoutOtpService } = require("../services/withdrawalPayoutOtpService");
const { enqueueBusinessNotification } = require("../services/notificationEventService");
const payoutOtpService = createWithdrawalPayoutOtpService();

const ELIGIBLE_ACCOUNT_STATUSES = ["ACTIVE"];
const CLAIM_ID_PATTERN = /^[A-Za-z0-9_-]{1,25}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function findAccountForUser(userId) {
    const result = await pool.query(
        "SELECT account_id, current_balance, account_status FROM pension_accounts WHERE user_id = $1",
        [userId]
    );
    return result.rows[0] || null;
}

async function hasPendingClaim(accountId) {
    const result = await pool.query(
        "SELECT count(*)::int AS pending_count FROM withdrawal_claims WHERE account_id = $1 AND claim_status = 'PENDING'",
        [accountId]
    );
    return result.rows[0].pending_count > 0;
}

/**
 * GET /api/withdrawals/eligibility
 * WORKER only.
 *
 * A lightweight, schema-derivable eligibility check:
 *   - the worker must have a pension account,
 *   - the account must be ACTIVE,
 *   - the account balance must be greater than zero,
 *   - there must be no existing PENDING claim already.
 * (pension_accounts has no birthdate/age column, so the age-based
 * eligibility rules implied by the design docs cannot be enforced here.)
 */
async function checkEligibility(req, res) {
    const { userId } = req.user;

    try {
        const account = await findAccountForUser(userId);

        if (!account) {
            return res.status(404).json({
                status: "error",
                message: "No pension account found for this user yet",
            });
        }

        const balance = Number(account.current_balance);
        const pendingExists = await hasPendingClaim(account.account_id);
        const reservedAmount = Number(await getWithdrawalAvailability(pool, account.account_id));
        const availableBalance = calculateAvailableBalance(balance, reservedAmount);

        const reasons = [];
        if (!ELIGIBLE_ACCOUNT_STATUSES.includes(account.account_status)) {
            reasons.push(`Account status is ${account.account_status}, must be ACTIVE`);
        }
        if (availableBalance <= 0) {
            reasons.push("Available balance must be greater than zero");
        }
        if (pendingExists) {
            reasons.push("An existing withdrawal claim is already pending review");
        }

        return res.status(200).json({
            status: "success",
            data: {
                eligible: reasons.length === 0,
                reasons,
                current_balance: account.current_balance,
                reserved_withdrawal_amount: reservedAmount,
                available_balance: availableBalance,
                account_status: account.account_status,
            },
        });
    } catch (error) {
        console.error("Failed to check withdrawal eligibility:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to check eligibility due to a server error",
        });
    }
}

/**
 * POST /api/withdrawals
 * WORKER only. Body: { amount_requested, destination_phone, withdrawal_reason }
 * Identity/account is derived strictly from req.user.userId.
 */
async function submitClaim(req, res) {
    const { userId } = req.user;
    const { amount_requested, destination_phone, withdrawal_reason } = req.body || {};
    const parsedAmount = parseAmountCents(amount_requested);
    const amount = parsedAmount ? Number(parsedAmount.text) : null;

    if (amount_requested === undefined || !withdrawal_reason) {
        return res.status(400).json({
            status: "error",
            message: "amount_requested and withdrawal_reason are required",
        });
    }

    if (destination_phone !== undefined &&
        (typeof destination_phone !== "string" || destination_phone.trim().length === 0 ||
         destination_phone.trim().length > 15)) {
        return res.status(400).json({ status: "error", message: "destination_phone must be a valid phone number" });
    }

    if (typeof withdrawal_reason !== "string" || withdrawal_reason.trim().length < 3 || withdrawal_reason.trim().length > 255) {
        return res.status(400).json({ status: "error", message: "withdrawal_reason must be between 3 and 255 characters" });
    }

    if (amount === null) {
        return res.status(400).json({
            status: "error",
            message: "amount_requested must be a positive amount with no more than two decimal places",
        });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const accountResult = await client.query(
            "SELECT account_id, current_balance, account_status FROM pension_accounts WHERE user_id = $1 FOR UPDATE",
            [userId]
        );
        const account = accountResult.rows[0] || null;

        if (!account) {
            await client.query("ROLLBACK");
            return res.status(404).json({
                status: "error",
                message: "No pension account found for this user yet",
            });
        }

        if (account.account_status !== "ACTIVE") {
            await client.query("ROLLBACK");
            return res.status(403).json({
                status: "error",
                message: `Cannot submit a withdrawal claim: account status is ${account.account_status}`,
            });
        }

        const profileResult = await client.query(
            `SELECT phone, phone_verified_at
             FROM users
             WHERE user_id = $1 AND role = 'WORKER'
             FOR SHARE`,
            [userId]
        );
        const profile = profileResult.rows[0];
        if (!profile || !profile.phone || !profile.phone_verified_at) {
            await client.query("ROLLBACK");
            return res.status(403).json({
                status: "error",
                message: "A verified profile phone is required to submit a withdrawal claim",
            });
        }
        if (destination_phone !== undefined && destination_phone.trim() !== profile.phone) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                status: "error",
                message: "destination_phone must match your verified profile phone",
            });
        }

        const reservedAmount = Number(await getWithdrawalAvailability(client, account.account_id));
        const availableBalance = calculateAvailableBalance(account.current_balance, reservedAmount);
        if (amount > availableBalance) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                status: "error",
                message: "amount_requested cannot exceed the available balance after approved withdrawals",
            });
        }

        const pending = await client.query(
            "SELECT 1 FROM withdrawal_claims WHERE account_id = $1 AND claim_status = 'PENDING' LIMIT 1",
            [account.account_id]
        );
        if (pending.rows.length > 0) {
            await client.query("ROLLBACK");
            return res.status(409).json({
                status: "error",
                message: "A withdrawal claim is already pending review for this account",
            });
        }

        const result = await client.query(
            `INSERT INTO withdrawal_claims
                (account_id, amount_requested, destination_phone, withdrawal_reason)
             VALUES ($1, $2, $3, $4)
             RETURNING claim_id, account_id, amount_requested, destination_phone,
                       withdrawal_reason, claim_status, requested_at`,
            [account.account_id, parsedAmount.text, profile.phone, withdrawal_reason.trim()]
        );

        await client.query("COMMIT");
        void enqueueBusinessNotification({
            userId,
            eventType: "WITHDRAWAL_SUBMITTED",
            referenceId: result.rows[0].claim_id,
        });
        return res.status(201).json({
            status: "success",
            message: "Withdrawal claim submitted successfully",
            data: { claim: result.rows[0], available_balance: availableBalance },
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Failed to submit withdrawal claim:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to submit withdrawal claim due to a server error",
        });
    } finally {
        client.release();
    }
}

/**
 * GET /api/withdrawals/my-claims
 * WORKER only. Own claims, newest first.
 */
async function getMyClaims(req, res) {
    const { userId } = req.user;

    try {
        const account = await findAccountForUser(userId);

        if (!account) {
            return res.status(404).json({
                status: "error",
                message: "No pension account found for this user yet",
            });
        }

        const result = await pool.query(
            `SELECT wc.claim_id, wc.account_id, wc.reviewed_by, wc.transaction_id,
                    wc.amount_requested, wc.destination_phone, wc.withdrawal_reason,
                    wc.claim_status, wc.requested_at, wc.reviewed_at, wc.processed_at,
                    otp.status AS payout_otp_status, otp.expires_at AS payout_otp_expires_at,
                    otp.verified_at AS payout_otp_verified_at
             FROM withdrawal_claims wc
             LEFT JOIN LATERAL (
                 SELECT status, expires_at, verified_at
                 FROM withdrawal_payout_otp_authorizations
                 WHERE claim_id = wc.claim_id
                 ORDER BY created_at DESC
                 LIMIT 1
             ) otp ON true
             WHERE wc.account_id = $1
             ORDER BY wc.requested_at DESC`,
            [account.account_id]
        );

        return res.status(200).json({ status: "success", data: result.rows });
    } catch (error) {
        console.error("Failed to fetch withdrawal claims:", {
            code: typeof error?.code === "string" ? error.code : "WITHDRAWAL_CLAIMS_LOOKUP_ERROR",
            message: typeof error?.message === "string"
                ? error.message
                : "Unknown withdrawal claims lookup error",
            position: typeof error?.position === "string" ? error.position : null,
            routine: typeof error?.routine === "string" ? error.routine : null,
        });
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch withdrawal claims due to a server error",
        });
    }
}

/**
 * GET /api/withdrawals/pending
 * FUND_MANAGER only. Pending claims and approved unpaid reservations, oldest first.
 */
async function getPendingClaims(req, res) {
    try {
        const result = await pool.query(
            `SELECT wc.claim_id, wc.account_id, pa.user_id, u.full_name, u.phone,
                    wc.amount_requested, wc.destination_phone, wc.withdrawal_reason,
                    wc.claim_status, wc.requested_at
             FROM withdrawal_claims wc
             JOIN pension_accounts pa ON pa.account_id = wc.account_id
             JOIN users u ON u.user_id = pa.user_id
             WHERE wc.claim_status IN ('PENDING', 'APPROVED')
               AND EXISTS (
                   SELECT 1
                   FROM fund_allocations fa
                   JOIN funds f ON f.fund_id = fa.fund_id
                   WHERE fa.account_id = wc.account_id
                     AND f.managed_by = $1
                     AND fa.effective_from <= CURRENT_DATE
                     AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)
               )
             ORDER BY wc.requested_at ASC`,
            [req.user.userId]
        );

        return res.status(200).json({ status: "success", data: result.rows });
    } catch (error) {
        console.error("Failed to fetch pending claims:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch pending claims due to a server error",
        });
    }
}

/**
 * PATCH /api/withdrawals/:claimId/approve
 * PATCH /api/withdrawals/:claimId/reject
 * FUND_MANAGER only. reviewed_by is always the acting FUND_MANAGER's own
 * userId - never trusted from the request body, satisfying the
 * enforce_withdrawal_claim_reviewer_role trigger by construction.
 */
async function reviewClaim(req, res, decision) {
    const { userId } = req.user;
    const { claimId } = req.params;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const newStatus = decision === "approve" ? "APPROVED" : "REJECTED";
        const claim = await reviewClaimTransaction(client, { userId, claimId, decision: newStatus });
        await client.query("COMMIT");
        void enqueueBusinessNotification({
            userId: claim.user_id,
            eventType: newStatus === "APPROVED"
                ? "WITHDRAWAL_APPROVED"
                : "WITHDRAWAL_REJECTED",
            referenceId: claim.claim_id,
        });
        return res.status(200).json({
            status: "success",
            message: `Claim ${newStatus.toLowerCase()} successfully`,
            data: { claim },
        });
    } catch (error) {
        await client.query("ROLLBACK");
        if (error.statusCode) {
            return res.status(error.statusCode).json({ status: "error", message: error.message });
        }
        console.error("Failed to review withdrawal claim:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to review withdrawal claim due to a server error",
        });
    } finally {
        client.release();
    }
}

async function approveClaim(req, res) {
    return reviewClaim(req, res, "approve");
}

async function rejectClaim(req, res) {
    return reviewClaim(req, res, "reject");
}

function sendPayoutOtpError(res, error, operation) {
    if (error?.statusCode && error?.code) {
        return res.status(error.statusCode).json({
            status: "error",
            code: error.code,
            message: error.message,
            ...(Number.isInteger(error.retryAfterSeconds)
                ? { retryAfterSeconds: error.retryAfterSeconds }
                : {}),
        });
    }
    console.error(`Failed to ${operation} withdrawal OTP:`, {
        code: typeof error?.code === "string" ? error.code : "WITHDRAWAL_OTP_INTERNAL_ERROR",
    });
    return res.status(500).json({
        status: "error",
        code: "WITHDRAWAL_OTP_INTERNAL_ERROR",
        message: "Withdrawal OTP processing failed. The withdrawal remains unpaid; contact support if the problem persists.",
    });
}

async function getPayoutAuthorizationQueue(req, res) {
    try {
        const claims = await payoutOtpService.getAuthorizationQueue();
        return res.status(200).json({ status: "success", data: claims });
    } catch (error) {
        return sendPayoutOtpError(res, error, "load");
    }
}

async function createPayoutOtp(req, res) {
    const { claimId } = req.params;
    const idempotencyKey = req.get("Idempotency-Key");
    if (!CLAIM_ID_PATTERN.test(claimId)) {
        return res.status(400).json({ status: "error", message: "claimId is invalid" });
    }
    if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        return res.status(400).json({
            status: "error",
            message: "A UUID Idempotency-Key header is required.",
        });
    }
    try {
        const result = await payoutOtpService.issueOtp({
            claimId,
            payoutOfficerUserId: req.user.userId,
            idempotencyKey,
        });
        return res.status(200).json({
            status: "success",
            message: result.replayed
                ? "This authorization request was already processed."
                : "OTP accepted by the configured SMS provider. The withdrawal is still unpaid.",
            data: result,
        });
    } catch (error) {
        return sendPayoutOtpError(res, error, "issue");
    }
}

async function resendPayoutOtp(req, res) {
    const { claimId } = req.params;
    const idempotencyKey = req.get("Idempotency-Key");
    if (!CLAIM_ID_PATTERN.test(claimId)) {
        return res.status(400).json({ status: "error", message: "claimId is invalid" });
    }
    if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        return res.status(400).json({
            status: "error",
            message: "A UUID Idempotency-Key header is required.",
        });
    }
    try {
        const result = await payoutOtpService.issueOtp({
            claimId,
            payoutOfficerUserId: req.user.userId,
            idempotencyKey,
            resend: true,
        });
        return res.status(200).json({
            status: "success",
            message: result.replayed
                ? "This resend request was already processed."
                : "A new OTP was accepted by the configured SMS provider. The withdrawal is still unpaid.",
            data: result,
        });
    } catch (error) {
        return sendPayoutOtpError(res, error, "resend");
    }
}

async function verifyPayoutOtp(req, res) {
    const { claimId } = req.params;
    if (!CLAIM_ID_PATTERN.test(claimId)) {
        return res.status(400).json({ status: "error", message: "claimId is invalid" });
    }
    try {
        const result = await payoutOtpService.verifyOtp({
            claimId,
            workerUserId: req.user.userId,
            code: req.body?.code,
        });
        if (result?.status === "VERIFIED" &&
            typeof result.authorizationAttemptId === "string") {
            void enqueueBusinessNotification({
                userId: req.user.userId,
                eventType: "WITHDRAWAL_OTP_AUTHORIZED",
                referenceId: result.authorizationAttemptId,
            });
        }
        return res.status(200).json({
            status: "success",
            message: "OTP verified. This authorizes the withdrawal only; payout processing remains disabled.",
            data: result,
        });
    } catch (error) {
        return sendPayoutOtpError(res, error, "verify");
    }
}

module.exports = {
    checkEligibility,
    submitClaim,
    getMyClaims,
    getPendingClaims,
    approveClaim,
    rejectClaim,
    getPayoutAuthorizationQueue,
    createPayoutOtp,
    resendPayoutOtp,
    verifyPayoutOtp,
};
