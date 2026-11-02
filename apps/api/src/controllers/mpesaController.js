const pool = require("../db/database");

function callbackResponse(res) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Notification received; payment outcome not verified" });
}

async function startStkPush(_req, res) {
    return res.status(503).json({
        status: "error",
        message: "M-Pesa deposits are temporarily unavailable while payment verification is being secured.",
    });
}

async function getStkPushStatus(req, res) {
    const { userId } = req.user;
    const { checkoutRequestId: statusReference } = req.params;
    try {
        const result = await pool.query(
            `SELECT t.transaction_id, t.amount, t.transaction_status, t.mpesa_receipt,
                    t.mpesa_result_code, t.mpesa_result_description, t.completed_at,
                    c.contribution_status, p.current_balance AS account_balance
             FROM transactions t
             JOIN contributions c ON c.transaction_id = t.transaction_id
             JOIN pension_accounts p ON p.account_id = c.account_id
             WHERE (t.checkout_request_id = $1 OR t.transaction_id = $1)
               AND t.transaction_type = 'CONTRIBUTION'
               AND p.user_id = $2`,
            [statusReference, userId]
        );
        if (!result.rowCount) {
            return res.status(404).json({ status: "error", message: "Payment was not found for this account" });
        }
        return res.status(200).json({ status: "success", data: result.rows[0] });
    } catch (error) {
        console.error("Failed to retrieve M-Pesa payment status:", error);
        return res.status(500).json({ status: "error", message: "Could not retrieve payment status" });
    }
}

async function handleStkCallback(_req, res) {
    return callbackResponse(res);
}

module.exports = { startStkPush, getStkPushStatus, handleStkCallback };
