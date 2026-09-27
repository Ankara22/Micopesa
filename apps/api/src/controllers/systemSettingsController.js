const pool = require("../db/database");

/**
 * GET /api/admin/settings
 * ADMIN only.
 */
async function listSettings(req, res) {
    try {
        const result = await pool.query(
            `SELECT setting_id, setting_key, setting_value, description, updated_by, updated_at
             FROM system_settings ORDER BY setting_key ASC`
        );
        return res.status(200).json({ status: "success", data: result.rows });
    } catch (error) {
        console.error("Failed to list system settings:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to list system settings due to a server error",
        });
    }
}

/**
 * GET /api/admin/settings/:key
 */
async function getSetting(req, res) {
    const { key } = req.params;

    try {
        const result = await pool.query(
            `SELECT setting_id, setting_key, setting_value, description, updated_by, updated_at
             FROM system_settings WHERE setting_key = $1`,
            [key]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ status: "error", message: "Setting not found" });
        }

        return res.status(200).json({ status: "success", data: { setting: result.rows[0] } });
    } catch (error) {
        console.error("Failed to fetch system setting:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch system setting due to a server error",
        });
    }
}

/**
 * POST /api/admin/settings
 * ADMIN only. Body: { setting_key, setting_value, description? }
 * updated_by is always the acting ADMIN's own userId.
 */
async function createSetting(req, res) {
    const { userId } = req.user;
    const { setting_key, setting_value, description } = req.body;

    if (!setting_key || setting_value === undefined) {
        return res.status(400).json({ status: "error", message: "setting_key and setting_value are required" });
    }

    try {
        const existing = await pool.query(
            "SELECT setting_id FROM system_settings WHERE setting_key = $1",
            [setting_key]
        );

        if (existing.rows.length > 0) {
            return res.status(409).json({ status: "error", message: "A setting with this key already exists" });
        }

        const result = await pool.query(
            `INSERT INTO system_settings (setting_key, setting_value, description, updated_by)
             VALUES ($1, $2, $3, $4)
             RETURNING setting_id, setting_key, setting_value, description, updated_by, updated_at`,
            [setting_key, String(setting_value), description || null, userId]
        );

        return res.status(201).json({
            status: "success",
            message: "Setting created successfully",
            data: { setting: result.rows[0] },
        });
    } catch (error) {
        console.error("Failed to create system setting:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to create system setting due to a server error",
        });
    }
}

/**
 * PUT /api/admin/settings/:key
 * ADMIN only. Body: { setting_value, description? }
 */
async function updateSetting(req, res) {
    const { userId } = req.user;
    const { key } = req.params;
    const { setting_value, description } = req.body;

    if (setting_value === undefined) {
        return res.status(400).json({ status: "error", message: "setting_value is required" });
    }

    try {
        const result = await pool.query(
            `UPDATE system_settings
             SET setting_value = $1, description = COALESCE($2, description), updated_by = $3, updated_at = now()
             WHERE setting_key = $4
             RETURNING setting_id, setting_key, setting_value, description, updated_by, updated_at`,
            [String(setting_value), description ?? null, userId, key]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ status: "error", message: "Setting not found" });
        }

        return res.status(200).json({
            status: "success",
            message: "Setting updated successfully",
            data: { setting: result.rows[0] },
        });
    } catch (error) {
        console.error("Failed to update system setting:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to update system setting due to a server error",
        });
    }
}

/**
 * DELETE /api/admin/settings/:key
 * ADMIN only.
 */
async function deleteSetting(req, res) {
    const { key } = req.params;

    try {
        const result = await pool.query(
            "DELETE FROM system_settings WHERE setting_key = $1 RETURNING setting_id",
            [key]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ status: "error", message: "Setting not found" });
        }

        return res.status(200).json({ status: "success", message: "Setting deleted successfully" });
    } catch (error) {
        console.error("Failed to delete system setting:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to delete system setting due to a server error",
        });
    }
}

module.exports = { listSettings, getSetting, createSetting, updateSetting, deleteSetting };
