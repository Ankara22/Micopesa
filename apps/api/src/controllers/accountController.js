const pool = require("../db/database");

function parseAmountCents(amount) {
    const text = typeof amount === "number" ? String(amount) : typeof amount === "string" ? amount.trim() : "";
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
    const [whole, fraction = ""] = text.split(".");
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    if (cents <= 0n || cents > 999999999999n) return null;
    return { text, cents };
}

function parsePercentageHundredths(value) {
    const text = String(value ?? "").trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
    const [whole, fraction = ""] = text.split(".");
    const hundredths = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    return Number.isSafeInteger(hundredths) && hundredths > 0 && hundredths <= 10000
        ? hundredths
        : null;
}

function distributeContributionAmount(amountCents, allocations) {
    const weighted = allocations.map((allocation) => {
        const weight = parsePercentageHundredths(allocation.percentage);
        if (weight === null) throw new Error("Stored fund allocation percentage is invalid");
        return { ...allocation, weight: BigInt(weight) };
    }).sort((left, right) => left.fund_id.localeCompare(right.fund_id));
    const totalWeight = weighted.reduce((sum, allocation) => sum + allocation.weight, 0n);
    if (totalWeight <= 0n) throw new Error("No positive fund allocation weights were found");

    let allocatedCents = 0n;
    const shares = weighted.map((allocation) => {
        const numerator = amountCents * allocation.weight;
        const shareCents = numerator / totalWeight;
        allocatedCents += shareCents;
        return {
            ...allocation,
            shareCents,
            remainder: numerator % totalWeight,
        };
    });

    let remainingCents = amountCents - allocatedCents;
    const byLargestRemainder = [...shares].sort((left, right) => {
        if (left.remainder > right.remainder) return -1;
        if (left.remainder < right.remainder) return 1;
        return left.fund_id.localeCompare(right.fund_id);
    });
    for (let index = 0; remainingCents > 0n; index += 1, remainingCents -= 1n) {
        byLargestRemainder[index % byLargestRemainder.length].shareCents += 1n;
    }

    let percentagesUsed = 0;
    return shares.map((allocation, index) => {
        const percentage = index === shares.length - 1
            ? Number((100 - percentagesUsed).toFixed(10))
            : Number(((Number(allocation.weight) / Number(totalWeight)) * 100).toFixed(10));
        percentagesUsed += percentage;
        const cents = allocation.shareCents.toString().padStart(3, "0");
        return {
            allocation_id: allocation.allocation_id,
            fund_id: allocation.fund_id,
            fund_name: allocation.fund_name,
            allocation_percentage: percentage.toFixed(10),
            allocated_amount: `${cents.slice(0, -2)}.${cents.slice(-2)}`,
        };
    });
}

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
