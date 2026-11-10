const pool = require("../db/database");
const {
    distributeContributionAmount,
    parseAmountCents,
} = require("../services/contributionAllocationService");

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
                    a.checkout_request_id,
                    CASE a.provider_mode
                         WHEN 'SIMULATOR' THEN 'SIMULATED'
                         WHEN 'DARAJA' THEN 'DARAJA'
                         ELSE 'UNRESOLVED'
                    END AS payment_provider,
                    COALESCE(fund_shares.fund_allocations, '[]'::jsonb) AS fund_allocations
                 FROM contributions c
                 JOIN transactions t ON t.transaction_id = c.transaction_id
                 LEFT JOIN LATERAL (
                     SELECT checkout_request_id, provider_mode
                     FROM mpesa_payment_attempts
                     WHERE transaction_id = c.transaction_id
                     ORDER BY created_at DESC, attempt_id DESC
                     LIMIT 1
                 ) a ON TRUE
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
        console.error("Failed to fetch contributions:", {
            code: typeof error?.code === "string" ? error.code : "CONTRIBUTIONS_LOOKUP_ERROR",
            message: typeof error?.message === "string" ? error.message : "Unknown contributions lookup error",
        });
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
        const accountResult = await client.query(
            `SELECT account_id
             FROM pension_accounts
             WHERE user_id = $1 AND account_status = 'ACTIVE'
             FOR UPDATE`,
            [userId]
        );

        if (accountResult.rows.length === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;
            return res.status(409).json({
                status: "error",
                message: "No active pension account is available for contributions",
            });
        }

        const accountId = accountResult.rows[0].account_id;
        const allocationsResult = await client.query(
            `SELECT fa.allocation_id, fa.fund_id, fa.percentage, f.fund_name
             FROM fund_allocations fa
             JOIN funds f ON f.fund_id = fa.fund_id
             WHERE fa.account_id = $1
               AND fa.fund_id = ANY($2::varchar[])
               AND fa.effective_from <= CURRENT_DATE
               AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)
               AND f.fund_status = 'ACTIVE'
             ORDER BY fa.fund_id, fa.allocation_id
             FOR SHARE OF fa, f`,
            [accountId, fundIds]
        );
        const allocationsByFund = new Map();
        for (const allocation of allocationsResult.rows) {
            const existing = allocationsByFund.get(allocation.fund_id) || [];
            existing.push(allocation);
            allocationsByFund.set(allocation.fund_id, existing);
        }
        const invalidFundId = fundIds.find((fundId) => allocationsByFund.get(fundId)?.length !== 1);
        if (invalidFundId) {
            await client.query("ROLLBACK");
            transactionStarted = false;
            return res.status(409).json({
                status: "error",
                message: "Each selected fund must be active and have exactly one current allocation for your pension account.",
            });
        }

        const selectedAllocations = fundIds.map((fundId) => allocationsByFund.get(fundId)[0]);
        const fundShares = distributeContributionAmount(parsedAmount.cents, selectedAllocations);
        const transactionResult = await client.query(
            `INSERT INTO transactions (transaction_type, amount, transaction_status)
             VALUES ('CONTRIBUTION', $1, 'PENDING')
             RETURNING transaction_id, amount, transaction_status, initiated_at`,
            [parsedAmount.text]
        );
        const transaction = transactionResult.rows[0];
        const contributionResult = await client.query(
            `INSERT INTO contributions
                (account_id, transaction_id, amount, channel, contribution_status)
             VALUES ($1, $2, $3, $4, 'PENDING')
             RETURNING contribution_id, account_id, transaction_id, amount, channel,
                       contribution_status, created_at`,
            [accountId, transaction.transaction_id, parsedAmount.text, channel]
        );
        for (const fundShare of fundShares) {
            await client.query(
                `INSERT INTO contribution_fund_allocations
                    (contribution_id, account_id, fund_id, fund_name,
                     allocation_percentage, allocated_amount)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    contributionResult.rows[0].contribution_id,
                    accountId,
                    fundShare.fund_id,
                    fundShare.fund_name,
                    fundShare.allocation_percentage,
                    fundShare.allocated_amount,
                ]
            );
        }

        await client.query("COMMIT");
        transactionStarted = false;
        return res.status(202).json({
            status: "success",
            message: "Contribution initiated and awaiting payment confirmation. No payment has been confirmed.",
            data: {
                contribution: contributionResult.rows[0],
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
