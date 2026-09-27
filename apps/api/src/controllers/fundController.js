const pool = require("../db/database");

const VALID_RISK_LEVELS = ["LOW", "MEDIUM", "HIGH"];
const VALID_FUND_STATUSES = ["ACTIVE", "SUSPENDED", "CLOSED"];

/**
 * POST /api/funds
 * FUND_MANAGER only. Body: { fund_name, administrator_name, risk_level, expected_return }
 * managed_by is always the acting FUND_MANAGER's own userId - never trusted
 * from the request body. Satisfies enforce_fund_manager_role by construction.
 */
async function createFund(req, res) {
    const { userId } = req.user;
    const { fund_name, administrator_name, risk_level, expected_return } = req.body;
    const expectedReturn = Number(expected_return);

    if (!fund_name || !administrator_name || !risk_level || expected_return === undefined) {
        return res.status(400).json({
            status: "error",
            message: "fund_name, administrator_name, risk_level, and expected_return are required",
        });
    }

    if (!VALID_RISK_LEVELS.includes(risk_level)) {
        return res.status(400).json({
            status: "error",
            message: `risk_level must be one of: ${VALID_RISK_LEVELS.join(", ")}`,
        });
    }

    if (!Number.isFinite(expectedReturn)) {
        return res.status(400).json({ status: "error", message: "expected_return must be a number" });
    }

    try {
        const result = await pool.query(
            `INSERT INTO funds (managed_by, fund_name, administrator_name, risk_level, expected_return)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING fund_id, managed_by, fund_name, administrator_name, risk_level,
                       expected_return, fund_status, created_at`,
            [userId, fund_name, administrator_name, risk_level, expectedReturn]
        );

        return res.status(201).json({
            status: "success",
            message: "Fund created successfully",
            data: { fund: result.rows[0] },
        });
    } catch (error) {
        console.error("Failed to create fund:", error);
        return res.status(500).json({ status: "error", message: "Failed to create fund due to a server error" });
    }
}

/**
 * GET /api/funds
 * FUND_MANAGER: sees only funds they manage.
 * REGULATOR: sees all funds (oversight/audit).
 */
async function listFunds(req, res) {
    const { userId, role } = req.user;

    try {
        const result =
            role === "REGULATOR"
                ? await pool.query(
                      `SELECT fund_id, managed_by, fund_name, administrator_name, risk_level,
                              expected_return, fund_status, created_at, updated_at
                       FROM funds ORDER BY created_at DESC`
                  )
                : await pool.query(
                      `SELECT fund_id, managed_by, fund_name, administrator_name, risk_level,
                              expected_return, fund_status, created_at, updated_at
                       FROM funds WHERE managed_by = $1 ORDER BY created_at DESC`,
                      [userId]
                  );

        return res.status(200).json({ status: "success", data: result.rows });
    } catch (error) {
        console.error("Failed to list funds:", error);
        return res.status(500).json({ status: "error", message: "Failed to list funds due to a server error" });
    }
}

/**
 * GET /api/funds/:fundId
 * FUND_MANAGER: only a fund they manage. REGULATOR: any fund.
 */
async function getFund(req, res) {
    const { userId, role } = req.user;
    const { fundId } = req.params;

    try {
        const result = await pool.query(
            `SELECT fund_id, managed_by, fund_name, administrator_name, risk_level,
                    expected_return, fund_status, created_at, updated_at
             FROM funds WHERE fund_id = $1`,
            [fundId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ status: "error", message: "Fund not found" });
        }

        const fund = result.rows[0];

        if (role === "FUND_MANAGER" && fund.managed_by !== userId) {
            return res.status(403).json({ status: "error", message: "You do not manage this fund" });
        }

        return res.status(200).json({ status: "success", data: { fund } });
    } catch (error) {
        console.error("Failed to fetch fund:", error);
        return res.status(500).json({ status: "error", message: "Failed to fetch fund due to a server error" });
    }
}

/**
 * PATCH /api/funds/:fundId
 * FUND_MANAGER only, and only for a fund they manage.
 * Body may include any of: fund_name, administrator_name, risk_level, expected_return, fund_status
 */
async function updateFund(req, res) {
    const { userId } = req.user;
    const { fundId } = req.params;
    const { fund_name, administrator_name, risk_level, expected_return, fund_status } = req.body;

    if (risk_level !== undefined && !VALID_RISK_LEVELS.includes(risk_level)) {
        return res.status(400).json({
            status: "error",
            message: `risk_level must be one of: ${VALID_RISK_LEVELS.join(", ")}`,
        });
    }

    if (fund_status !== undefined && !VALID_FUND_STATUSES.includes(fund_status)) {
        return res.status(400).json({
            status: "error",
            message: `fund_status must be one of: ${VALID_FUND_STATUSES.join(", ")}`,
        });
    }

    if (expected_return !== undefined && !Number.isFinite(Number(expected_return))) {
        return res.status(400).json({ status: "error", message: "expected_return must be a number" });
    }

    try {
        const existing = await pool.query("SELECT managed_by FROM funds WHERE fund_id = $1", [fundId]);

        if (existing.rows.length === 0) {
            return res.status(404).json({ status: "error", message: "Fund not found" });
        }

        if (existing.rows[0].managed_by !== userId) {
            return res.status(403).json({ status: "error", message: "You do not manage this fund" });
        }

        const result = await pool.query(
            `UPDATE funds SET
                fund_name = COALESCE($1, fund_name),
                administrator_name = COALESCE($2, administrator_name),
                risk_level = COALESCE($3, risk_level),
                expected_return = COALESCE($4, expected_return),
                fund_status = COALESCE($5, fund_status),
                updated_at = now()
             WHERE fund_id = $6
             RETURNING fund_id, managed_by, fund_name, administrator_name, risk_level,
                       expected_return, fund_status, created_at, updated_at`,
            [
                fund_name ?? null,
                administrator_name ?? null,
                risk_level ?? null,
                expected_return !== undefined ? Number(expected_return) : null,
                fund_status ?? null,
                fundId,
            ]
        );

        return res.status(200).json({
            status: "success",
            message: "Fund updated successfully",
            data: { fund: result.rows[0] },
        });
    } catch (error) {
        console.error("Failed to update fund:", error);
        return res.status(500).json({ status: "error", message: "Failed to update fund due to a server error" });
    }
}

/**
 * GET /api/funds/:fundId/allocations
 * FUND_MANAGER (own fund) or REGULATOR (any fund).
 */
async function getFundAllocations(req, res) {
    const { userId, role } = req.user;
    const { fundId } = req.params;

    try {
        const fundResult = await pool.query("SELECT managed_by FROM funds WHERE fund_id = $1", [fundId]);

        if (fundResult.rows.length === 0) {
            return res.status(404).json({ status: "error", message: "Fund not found" });
        }

        if (role === "FUND_MANAGER" && fundResult.rows[0].managed_by !== userId) {
            return res.status(403).json({ status: "error", message: "You do not manage this fund" });
        }

        const result = await pool.query(
            `SELECT allocation_id, account_id, fund_id, percentage, effective_from, effective_to
             FROM fund_allocations WHERE fund_id = $1 ORDER BY effective_from DESC`,
            [fundId]
        );

        return res.status(200).json({ status: "success", data: result.rows });
    } catch (error) {
        console.error("Failed to fetch fund allocations:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch fund allocations due to a server error",
        });
    }
}

module.exports = { createFund, listFunds, getFund, updateFund, getFundAllocations };
