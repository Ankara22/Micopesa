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
            `SELECT contribution_id, transaction_id, amount, channel,
                    contribution_status, created_at
             FROM contributions
             WHERE account_id = $1
             ORDER BY created_at DESC`,
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

module.exports = { getMyBalance, getMyContributions };
