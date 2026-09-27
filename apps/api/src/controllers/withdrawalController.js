const pool = require("../db/database");

const ELIGIBLE_ACCOUNT_STATUSES = ["ACTIVE"];

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

        const reasons = [];
        if (!ELIGIBLE_ACCOUNT_STATUSES.includes(account.account_status)) {
            reasons.push(`Account status is ${account.account_status}, must be ACTIVE`);
        }
        if (balance <= 0) {
            reasons.push("Account balance must be greater than zero");
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
 * WORKER only. Body: { amount_requested, destination_phone }
 * Identity/account is derived strictly from req.user.userId.
 */
async function submitClaim(req, res) {
    const { userId } = req.user;
    const { amount_requested, destination_phone } = req.body;
    const amount = Number(amount_requested);

    if (amount_requested === undefined || !destination_phone) {
        return res.status(400).json({
            status: "error",
            message: "amount_requested and destination_phone are required",
        });
    }

    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
            status: "error",
            message: "amount_requested must be a positive number",
        });
    }

    try {
        const account = await findAccountForUser(userId);

        if (!account) {
            return res.status(404).json({
                status: "error",
                message: "No pension account found for this user yet",
            });
        }

        if (account.account_status !== "ACTIVE") {
            return res.status(403).json({
                status: "error",
                message: `Cannot submit a withdrawal claim: account status is ${account.account_status}`,
            });
        }

        const balance = Number(account.current_balance);
        if (amount > balance) {
            return res.status(400).json({
                status: "error",
                message: "amount_requested cannot exceed the current account balance",
            });
        }

        if (await hasPendingClaim(account.account_id)) {
            return res.status(409).json({
                status: "error",
                message: "A withdrawal claim is already pending review for this account",
            });
        }

        const result = await pool.query(
            `INSERT INTO withdrawal_claims (account_id, amount_requested, destination_phone)
             VALUES ($1, $2, $3)
             RETURNING claim_id, account_id, amount_requested, destination_phone, claim_status, requested_at`,
            [account.account_id, amount, destination_phone]
        );

        return res.status(201).json({
            status: "success",
            message: "Withdrawal claim submitted successfully",
            data: { claim: result.rows[0] },
        });
    } catch (error) {
        console.error("Failed to submit withdrawal claim:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to submit withdrawal claim due to a server error",
        });
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
            `SELECT claim_id, account_id, reviewed_by, transaction_id, amount_requested,
                    destination_phone, claim_status, requested_at, reviewed_at, processed_at
             FROM withdrawal_claims
             WHERE account_id = $1
             ORDER BY requested_at DESC`,
            [account.account_id]
        );

        return res.status(200).json({ status: "success", data: result.rows });
    } catch (error) {
        console.error("Failed to fetch withdrawal claims:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch withdrawal claims due to a server error",
        });
    }
}

/**
 * GET /api/withdrawals/pending
 * FUND_MANAGER only. All claims awaiting review, oldest first (FIFO queue).
 */
async function getPendingClaims(req, res) {
    try {
        const result = await pool.query(
            `SELECT wc.claim_id, wc.account_id, pa.user_id, u.full_name, u.phone,
                    wc.amount_requested, wc.destination_phone, wc.claim_status, wc.requested_at
             FROM withdrawal_claims wc
             JOIN pension_accounts pa ON pa.account_id = wc.account_id
             JOIN users u ON u.user_id = pa.user_id
             WHERE wc.claim_status = 'PENDING'
             ORDER BY wc.requested_at ASC`
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

    try {
        const claimResult = await pool.query(
            "SELECT claim_id, claim_status FROM withdrawal_claims WHERE claim_id = $1",
            [claimId]
        );

        if (claimResult.rows.length === 0) {
            return res.status(404).json({ status: "error", message: "Withdrawal claim not found" });
        }

        if (claimResult.rows[0].claim_status !== "PENDING") {
            return res.status(409).json({
                status: "error",
                message: `Claim has already been ${claimResult.rows[0].claim_status.toLowerCase()}`,
            });
        }

        const newStatus = decision === "approve" ? "APPROVED" : "REJECTED";

        const result = await pool.query(
            `UPDATE withdrawal_claims
             SET reviewed_by = $1, claim_status = $2, reviewed_at = now()
             WHERE claim_id = $3
             RETURNING claim_id, account_id, reviewed_by, amount_requested, destination_phone,
                       claim_status, requested_at, reviewed_at`,
            [userId, newStatus, claimId]
        );

        return res.status(200).json({
            status: "success",
            message: `Claim ${newStatus.toLowerCase()} successfully`,
            data: { claim: result.rows[0] },
        });
    } catch (error) {
        console.error("Failed to review withdrawal claim:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to review withdrawal claim due to a server error",
        });
    }
}

async function approveClaim(req, res) {
    return reviewClaim(req, res, "approve");
}

async function rejectClaim(req, res) {
    return reviewClaim(req, res, "reject");
}

module.exports = {
    checkEligibility,
    submitClaim,
    getMyClaims,
    getPendingClaims,
    approveClaim,
    rejectClaim,
};
