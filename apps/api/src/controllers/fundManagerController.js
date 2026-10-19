const pool = require("../db/database");
const { writeAuditLog } = require("../utils/auditLog");

async function getPerformance(req, res) {
    const { userId } = req.user;

    try {
        const result = await pool.query(
            `SELECT
                (SELECT COALESCE(SUM(current_balance), 0) FROM pension_accounts) AS total_assets,
                (SELECT count(*)::int FROM pension_accounts WHERE account_status = 'ACTIVE') AS active_accounts,
                (SELECT count(*)::int FROM funds WHERE managed_by = $1) AS funds_managed,
                (SELECT AVG(expected_return) FROM funds WHERE managed_by = $1 AND fund_status = 'ACTIVE') AS average_yield`,
            [userId]
        );

        return res.status(200).json({ status: "success", data: result.rows[0] });
    } catch (error) {
        console.error("Failed to fetch fund performance:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch fund performance due to a server error",
        });
    }
}

async function listWithdrawals(req, res) {
    try {
        const result = await pool.query(
            `SELECT wc.claim_id, wc.account_id, pa.user_id, u.full_name, u.phone,
                    wc.amount_requested, wc.destination_phone, wc.withdrawal_reason, wc.claim_status,
                    wc.requested_at, wc.reviewed_at, wc.reviewed_by, wc.transaction_id,
                    reviewer.full_name AS reviewer_name
             FROM withdrawal_claims wc
             JOIN pension_accounts pa ON pa.account_id = wc.account_id
             JOIN users u ON u.user_id = pa.user_id
             LEFT JOIN users reviewer ON reviewer.user_id = wc.reviewed_by
             ORDER BY CASE WHEN wc.claim_status = 'PENDING' THEN 0 ELSE 1 END,
                      wc.requested_at ASC
             LIMIT 500`
        );

        return res.status(200).json({ status: "success", data: result.rows });
    } catch (error) {
        console.error("Failed to fetch withdrawal claims for review:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch withdrawal claims due to a server error",
        });
    }
}

async function reviewWithdrawal(req, res) {
    const { userId } = req.user;
    const { id } = req.params;
    const { decision } = req.body;

    if (!["APPROVED", "REJECTED"].includes(decision)) {
        return res.status(400).json({
            status: "error",
            message: "decision must be APPROVED or REJECTED",
        });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const existing = await client.query(
            "SELECT claim_status FROM withdrawal_claims WHERE claim_id = $1 FOR UPDATE",
            [id]
        );
        if (existing.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ status: "error", message: "Withdrawal claim not found" });
        }
        if (existing.rows[0].claim_status !== "PENDING") {
            await client.query("ROLLBACK");
            return res.status(409).json({
                status: "error",
                message: `Claim has already been ${existing.rows[0].claim_status.toLowerCase()}`,
            });
        }

        const result = await client.query(
            `UPDATE withdrawal_claims
             SET claim_status = $1, reviewed_by = $2, reviewed_at = now()
             WHERE claim_id = $3
             RETURNING claim_id, account_id, reviewed_by, amount_requested,
                       destination_phone, withdrawal_reason, claim_status, requested_at, reviewed_at`,
            [decision, userId, id]
        );

        await writeAuditLog(client, {
            userId,
            actionType: decision === "APPROVED" ? "APPROVE" : "REJECT",
            entityName: "WITHDRAWAL_CLAIMS",
            entityId: id,
        });
        await client.query("COMMIT");

        return res.status(200).json({
            status: "success",
            message: `Claim ${decision.toLowerCase()} successfully`,
            data: { claim: result.rows[0] },
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Failed to review withdrawal claim:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to review withdrawal claim due to a server error",
        });
    } finally {
        client.release();
    }
}

module.exports = { getPerformance, listWithdrawals, reviewWithdrawal };
