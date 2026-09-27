const pool = require("../db/database");

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
                    t.transaction_status, t.mpesa_receipt, t.completed_at
                 FROM contributions c
                 JOIN transactions t ON t.transaction_id = c.transaction_id
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
    const { amount, channel = "MPESA" } = req.body;
    const amountText = String(amount ?? "");
    const validChannels = ["MPESA", "BANK", "USSD"];

    if (!/^\d+(\.\d{1,2})?$/.test(amountText)) {
        return res.status(400).json({
            status: "error",
            message: "amount must be a positive number with no more than 2 decimal places",
        });
    }

    const parsedAmount = Number(amountText);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || parsedAmount > 9999999999.99) {
        return res.status(400).json({
            status: "error",
            message: "amount must be greater than 0 and within the supported limit",
        });
    }

    if (!validChannels.includes(channel)) {
        return res.status(400).json({
            status: "error",
            message: `channel must be one of: ${validChannels.join(", ")}`,
        });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const accountResult = await client.query(
            `SELECT account_id
             FROM pension_accounts
             WHERE user_id = $1 AND account_status = 'ACTIVE'
             FOR UPDATE`,
            [userId]
        );

        if (accountResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(409).json({
                status: "error",
                message: "No active pension account is available for contributions",
            });
        }

        const accountId = accountResult.rows[0].account_id;
        const transactionResult = await client.query(
            `INSERT INTO transactions (transaction_type, amount, transaction_status)
             VALUES ('CONTRIBUTION', $1, 'PENDING')
             RETURNING transaction_id, amount, transaction_status, initiated_at`,
            [amountText]
        );
        const transaction = transactionResult.rows[0];
        const contributionResult = await client.query(
            `INSERT INTO contributions
                (account_id, transaction_id, amount, channel, contribution_status)
             VALUES ($1, $2, $3, $4, 'PENDING')
             RETURNING contribution_id, account_id, transaction_id, amount, channel,
                       contribution_status, created_at`,
            [accountId, transaction.transaction_id, amountText, channel]
        );

        await client.query("COMMIT");
        return res.status(202).json({
            status: "success",
            message: "Contribution initiated and awaiting payment confirmation. No payment has been confirmed.",
            data: {
                contribution: contributionResult.rows[0],
                transaction,
                payment_status: "PENDING",
            },
        });
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("Failed to initiate contribution:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to initiate contribution due to a server error",
        });
    } finally {
        client.release();
    }
}

module.exports = { getMyBalance, getMyContributions, initiateMyContribution };
