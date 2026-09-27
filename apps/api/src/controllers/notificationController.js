const pool = require("../db/database");

const VALID_TYPES = ["SMS", "EMAIL", "PUSH", "USSD"];

/**
 * POST /api/admin/notifications
 * ADMIN only. Body: { user_id, notification_type, message }
 * created_by is always the acting ADMIN's own userId - never trusted from
 * the request body.
 */
async function createNotification(req, res) {
    const { userId } = req.user;
    const { user_id, notification_type, message } = req.body;

    if (!user_id || !notification_type || !message) {
        return res.status(400).json({
            status: "error",
            message: "user_id, notification_type, and message are required",
        });
    }

    if (!VALID_TYPES.includes(notification_type)) {
        return res.status(400).json({
            status: "error",
            message: `notification_type must be one of: ${VALID_TYPES.join(", ")}`,
        });
    }

    try {
        const targetUser = await pool.query("SELECT user_id FROM users WHERE user_id = $1", [user_id]);

        if (targetUser.rows.length === 0) {
            return res.status(404).json({ status: "error", message: "Target user not found" });
        }

        const result = await pool.query(
            `INSERT INTO notifications (user_id, created_by, notification_type, message)
             VALUES ($1, $2, $3, $4)
             RETURNING notification_id, user_id, created_by, notification_type, message,
                       delivery_status, created_at, sent_at`,
            [user_id, userId, notification_type, message]
        );

        return res.status(201).json({
            status: "success",
            message: "Notification created successfully",
            data: { notification: result.rows[0] },
        });
    } catch (error) {
        console.error("Failed to create notification:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to create notification due to a server error",
        });
    }
}

/**
 * GET /api/admin/notifications
 * ADMIN only. Lists all notifications for monitoring/delivery tracking.
 */
async function listNotifications(req, res) {
    try {
        const result = await pool.query(
            `SELECT n.notification_id, n.user_id, u.full_name AS recipient_name,
                    n.created_by, cu.full_name AS created_by_name,
                    n.notification_type, n.message, n.delivery_status, n.created_at, n.sent_at
             FROM notifications n
             JOIN users u ON u.user_id = n.user_id
             LEFT JOIN users cu ON cu.user_id = n.created_by
             ORDER BY n.created_at DESC`
        );

        return res.status(200).json({ status: "success", data: result.rows });
    } catch (error) {
        console.error("Failed to list notifications:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to list notifications due to a server error",
        });
    }
}

module.exports = { createNotification, listNotifications };
