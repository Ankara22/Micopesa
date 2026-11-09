const { writeAuditLog } = require("../utils/auditLog");

// Shared contribution helpers: amount parsing, fund-split arithmetic and the
// creation of a pending contribution + transaction pair inside a caller-owned
// database transaction.

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
 * Creates a PENDING transaction, PENDING contribution and the per-fund split
 * for the worker's active pension account. The caller owns BEGIN/COMMIT.
 *
 * Returns { ok: true, accountId, contribution, transaction, fundShares } or
 * { ok: false, statusCode, message } (the caller should ROLLBACK).
 */
async function createPendingContribution(client, { userId, parsedAmount, channel, fundIds, mpesaPhone = null }) {
    const accountResult = await client.query(
        `SELECT account_id
         FROM pension_accounts
         WHERE user_id = $1 AND account_status = 'ACTIVE'
         FOR UPDATE`,
        [userId]
    );
    if (accountResult.rows.length === 0) {
        return { ok: false, statusCode: 409, message: "No active pension account is available for contributions" };
    }

    const accountId = accountResult.rows[0].account_id;
    if (fundIds === null || fundIds === undefined) {
        const currentFunds = await client.query(
            `SELECT DISTINCT fa.fund_id
             FROM fund_allocations fa
             JOIN funds f ON f.fund_id = fa.fund_id
             WHERE fa.account_id = $1
               AND fa.effective_from <= CURRENT_DATE
               AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)
               AND f.fund_status = 'ACTIVE'
             ORDER BY fa.fund_id`,
            [accountId]
        );
        if (currentFunds.rows.length === 0) {
            return { ok: false, statusCode: 409, message: "Choose a fund allocation before making a contribution." };
        }
        fundIds = currentFunds.rows.map((row) => row.fund_id);
    }
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
        return {
            ok: false,
            statusCode: 409,
            message: "Each selected fund must be active and have exactly one current allocation for your pension account.",
        };
    }

    const selectedAllocations = fundIds.map((fundId) => allocationsByFund.get(fundId)[0]);
    const fundShares = distributeContributionAmount(parsedAmount.cents, selectedAllocations);
    const transactionResult = await client.query(
        `INSERT INTO transactions (transaction_type, amount, transaction_status, mpesa_phone)
         VALUES ('CONTRIBUTION', $1, 'PENDING', $2)
         RETURNING transaction_id, amount, transaction_status, initiated_at`,
        [parsedAmount.text, mpesaPhone]
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
    const contribution = contributionResult.rows[0];
    for (const fundShare of fundShares) {
        await client.query(
            `INSERT INTO contribution_fund_allocations
                (contribution_id, account_id, fund_id, fund_name,
                 allocation_percentage, allocated_amount)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                contribution.contribution_id,
                accountId,
                fundShare.fund_id,
                fundShare.fund_name,
                fundShare.allocation_percentage,
                fundShare.allocated_amount,
            ]
        );
    }
    await writeAuditLog(client, {
        userId,
        actionType: "CREATE",
        entityName: "CONTRIBUTIONS",
        entityId: contribution.contribution_id,
        details: { channel, amount: parsedAmount.text, status: "PENDING" },
    });

    return { ok: true, accountId, contribution, transaction, fundShares };
}

module.exports = {
    createPendingContribution,
    distributeContributionAmount,
    parseAmountCents,
};
