const { writeAuditLog } = require("../utils/auditLog");

function toMinorUnits(amount) {
    return Math.round(Number(amount) * 100);
}

function calculateAvailableBalance(balance, reservedAmount) {
    return Math.max(toMinorUnits(balance) - toMinorUnits(reservedAmount), 0) / 100;
}

async function getWithdrawalAvailability(client, accountId) {
    const result = await client.query(
        `SELECT COALESCE(SUM(amount_requested), 0)::numeric AS reserved_amount
         FROM withdrawal_claims
         WHERE account_id = $1 AND claim_status = 'APPROVED'`,
        [accountId]
    );
    return result.rows[0].reserved_amount;
}

async function reviewWithdrawalClaim(client, { userId, claimId, decision }) {
    const claimReference = await client.query(
        "SELECT account_id FROM withdrawal_claims WHERE claim_id = $1",
        [claimId]
    );
    if (claimReference.rows.length === 0) {
        throw Object.assign(new Error("Withdrawal claim not found"), { statusCode: 404 });
    }

    const accountResult = await client.query(
        "SELECT account_id, current_balance, account_status FROM pension_accounts WHERE account_id = $1 FOR UPDATE",
        [claimReference.rows[0].account_id]
    );
    const account = accountResult.rows[0];
    if (!account) {
        throw Object.assign(new Error("Pension account not found"), { statusCode: 404 });
    }

    const claimResult = await client.query(
        `SELECT claim_id, account_id, claim_status, amount_requested, transaction_id, processed_at
         FROM withdrawal_claims WHERE claim_id = $1 FOR UPDATE`,
        [claimId]
    );
    if (claimResult.rows.length === 0) {
        throw Object.assign(new Error("Withdrawal claim not found"), { statusCode: 404 });
    }

    const claim = claimResult.rows[0];
    const managedFundResult = await client.query(
        `SELECT f.fund_id
         FROM fund_allocations fa
         JOIN funds f ON f.fund_id = fa.fund_id
         WHERE fa.account_id = $1
           AND f.managed_by = $2
           AND fa.effective_from <= CURRENT_DATE
           AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)
         ORDER BY f.fund_id
         LIMIT 1
         FOR SHARE OF fa, f`,
        [claim.account_id, userId]
    );
    if (!managedFundResult.rows[0]) {
        throw Object.assign(new Error("Withdrawal claim not found"), { statusCode: 404 });
    }

    const reviewableStatus = decision === "APPROVED"
        ? claim.claim_status === "PENDING"
        : ["PENDING", "APPROVED"].includes(claim.claim_status);
    if (!reviewableStatus) {
        throw Object.assign(
            new Error(`Claim has already been ${claim.claim_status.toLowerCase()}`),
            { statusCode: 409 }
        );
    }

    if (decision === "REJECTED" && claim.claim_status === "APPROVED" &&
        (claim.transaction_id !== null || claim.processed_at !== null)) {
        throw Object.assign(
            new Error("Cannot cancel an approved claim with settlement metadata; reconcile it first"),
            { statusCode: 409 }
        );
    }

    if (decision === "APPROVED") {
        if (account.account_status !== "ACTIVE") {
            throw Object.assign(
                new Error(`Cannot approve a withdrawal: account status is ${account.account_status}`),
                { statusCode: 403 }
            );
        }

        const reservedAmount = await getWithdrawalAvailability(client, account.account_id);
        const availableAmount = calculateAvailableBalance(account.current_balance, reservedAmount);
        if (toMinorUnits(claim.amount_requested) > toMinorUnits(availableAmount)) {
            throw Object.assign(
                new Error("Claim exceeds the available balance after approved withdrawal reservations"),
                { statusCode: 409 }
            );
        }
    }

    const result = await client.query(
        `UPDATE withdrawal_claims
         SET reviewed_by = $1, claim_status = $2, reviewed_at = now()
         WHERE claim_id = $3
         RETURNING claim_id, account_id, reviewed_by, amount_requested, destination_phone,
                   withdrawal_reason, claim_status, requested_at, reviewed_at`,
        [userId, decision, claimId]
    );

    await writeAuditLog(client, {
        userId,
        actionType: decision === "APPROVED" ? "APPROVE" : "REJECT",
        entityName: "WITHDRAWAL_CLAIMS",
        entityId: claimId,
    });

    return result.rows[0];
}

module.exports = {
    calculateAvailableBalance,
    getWithdrawalAvailability,
    reviewWithdrawalClaim,
};
