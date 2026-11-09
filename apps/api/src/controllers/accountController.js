const pool = require("../db/database");
const {
    createPendingContribution,
    distributeContributionAmount,
    parseAmountCents,
} = require("../services/contributionService");

/**
 * GET /api/accounts/my-balance
 * Returns the authenticated worker's pension account balance and status.
 * Scoped strictly to req.user.userId (from the verified JWT) — a worker can
 * never fetch another user's account by manipulating input, since no
 * account_id/user_id is ever accepted from the request itself.
 */
async function getMyBalance(req, res) {
    const { userId } = req.user;

    try {
        const result = await pool.query(
            `SELECT account_id, current_balance, account_status
             FROM pension_accounts
             WHERE user_id = $1`,
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                status: "error",
                message: "No pension account found for this user yet",
            });
        }

        const account = result.rows[0];

        return res.status(200).json({
            status: "success",
            data: {
                account_id: account.account_id,
                current_balance: account.current_balance,
                account_status: account.account_status,
            },
        });
    } catch (error) {
        console.error("Failed to fetch balance:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch balance due to a server error",
        });
    }
}

/**
 * GET /api/accounts/my-contributions
 * Returns the authenticated worker's contribution history, newest first.
 * Scoped strictly to the pension account owned by req.user.userId.
 */
async function getMyContributions(req, res) {
    const { userId } = req.user;

    try {
        const accountResult = await pool.query(
            "SELECT account_id FROM pension_accounts WHERE user_id = $1",
            [userId]
        );

        if (accountResult.rows.length === 0) {
            return res.status(404).json({
                status: "error",
                message: "No pension account found for this user yet",
            });
        }

        const { account_id } = accountResult.rows[0];

        const contributionsResult = await pool.query(
                `SELECT c.contribution_id, c.transaction_id, c.amount, c.channel,
                    c.contribution_status, c.created_at,
                    t.transaction_status, t.mpesa_receipt, t.mpesa_result_code,
                    t.mpesa_result_description, t.completed_at,
                    COALESCE(fund_shares.fund_allocations, '[]'::jsonb) AS fund_allocations
                 FROM contributions c
                 JOIN transactions t ON t.transaction_id = c.transaction_id
                 LEFT JOIN LATERAL (
                     SELECT jsonb_agg(
                         jsonb_build_object(
                             'fund_id', cfa.fund_id,
                             'fund_name', cfa.fund_name,
                             'allocation_percentage', cfa.allocation_percentage,
                             'allocated_amount', cfa.allocated_amount
                         ) ORDER BY cfa.fund_name, cfa.fund_id
                     ) AS fund_allocations
                     FROM contribution_fund_allocations cfa
                     WHERE cfa.contribution_id = c.contribution_id
                       AND cfa.account_id = c.account_id
                 ) fund_shares ON TRUE
                 WHERE c.account_id = $1
                 ORDER BY c.created_at DESC`,
            [account_id]
        );

        return res.status(200).json({
            status: "success",
            data: contributionsResult.rows,
        });
    } catch (error) {
        console.error("Failed to fetch contributions:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch contributions due to a server error",
        });
    }
}

/**
 * POST /api/accounts/my-contributions
 * Creates a pending contribution and transaction together. It does not claim
 * payment succeeded; a payment provider/confirmation workflow is not wired in.
 */
async function initiateMyContribution(req, res) {
    const { userId } = req.user;
    const { amount, channel = "MPESA", fund_ids: fundIds } = req.body || {};
    const parsedAmount = parseAmountCents(amount);
    const validChannels = ["MPESA", "BANK", "USSD"];

    if (!parsedAmount) {
        return res.status(400).json({
            status: "error",
            message: "amount must be greater than 0 and within the supported limit, with no more than 2 decimal places",
        });
    }

    if (!validChannels.includes(channel)) {
        return res.status(400).json({
            status: "error",
            message: `channel must be one of: ${validChannels.join(", ")}`,
        });
    }

    if (channel === "MPESA") {
        return res.status(409).json({
            status: "error",
            message: "Use the M-Pesa STK Push flow to initiate a payment",
        });
    }

    if (
        !Array.isArray(fundIds) ||
        fundIds.length === 0 ||
        fundIds.length > 100 ||
        fundIds.some((fundId) =>
            typeof fundId !== "string" ||
            fundId.length === 0 ||
            fundId.length > 25 ||
            fundId.trim() !== fundId
        )
    ) {
        return res.status(400).json({
            status: "error",
            message: "fund_ids must contain one or more valid fund IDs",
        });
    }
    if (new Set(fundIds).size !== fundIds.length) {
        return res.status(400).json({ status: "error", message: "fund_ids must not contain duplicates" });
    }

    const client = await pool.connect();
    let transactionStarted = false;
    try {
        await client.query("BEGIN");
        transactionStarted = true;
        const created = await createPendingContribution(client, {
            userId,
            parsedAmount,
            channel,
            fundIds,
        });
        if (!created.ok) {
            await client.query("ROLLBACK");
            transactionStarted = false;
            return res.status(created.statusCode).json({
                status: "error",
                message: created.message,
            });
        }
        const { contribution, transaction, fundShares } = created;

        await client.query("COMMIT");
        transactionStarted = false;
        return res.status(202).json({
            status: "success",
            message: "Contribution initiated and awaiting payment confirmation. No payment has been confirmed.",
            data: {
                contribution,
                transaction,
                fund_allocations: fundShares,
                payment_status: "PENDING",
            },
        });
    } catch (error) {
        if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
        console.error("Failed to initiate contribution:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to initiate contribution due to a server error",
        });
    } finally {
        client.release();
    }
}

module.exports = {
    distributeContributionAmount,
    getMyBalance,
    getMyContributions,
    initiateMyContribution,
    parseAmountCents,
};
