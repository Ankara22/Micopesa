const pool = require("../db/database");
const { writeAuditLog } = require("../utils/auditLog");
const {
    getActiveWorkerAccount,
    getEligibleFundsByIds,
    listEligibleFunds,
} = require("../services/fundEligibilityService");

const VALID_RISK_LEVELS = ["LOW", "MEDIUM", "HIGH"];
const VALID_FUND_STATUSES = ["ACTIVE", "SUSPENDED", "CLOSED"];

function validateAllocationRequest(body) {
    if (!Array.isArray(body?.allocations) || body.allocations.length === 0) {
        return { error: "allocations must be a non-empty array" };
    }

    const seenFundIds = new Set();
    const allocations = [];
    let totalCents = 0;

    for (const [index, item] of body.allocations.entries()) {
        if (typeof item?.fund_id !== "string" || item.fund_id.trim() === "") {
            return { error: `allocations[${index}].fund_id must be a non-empty fund ID` };
        }
        const fundId = item.fund_id.trim();
        if (seenFundIds.has(fundId)) {
            return { error: `Fund ${fundId} appears more than once in allocations` };
        }
        seenFundIds.add(fundId);

        const rawPercentage = item.allocation_percentage;
        if (typeof rawPercentage !== "string" && typeof rawPercentage !== "number") {
            return { error: `Allocation percentage for fund ${fundId} must be a positive number with up to two decimal places` };
        }

        const percentageText = String(rawPercentage).trim();
        if (!/^\d+(?:\.\d{1,2})?$/.test(percentageText)) {
            return { error: `Allocation percentage for fund ${fundId} must be a positive number with up to two decimal places` };
        }
        const [wholePart, fractionalPart = ""] = percentageText.split(".");
        const percentageCents = Number(wholePart) * 100 + Number(fractionalPart.padEnd(2, "0"));
        if (!Number.isSafeInteger(percentageCents) || percentageCents <= 0 || percentageCents > 10000) {
            return { error: `Allocation percentage for fund ${fundId} must be greater than 0 and no greater than 100` };
        }

        totalCents += percentageCents;
        allocations.push({
            fund_id: fundId,
            percentage: (percentageCents / 100).toFixed(2),
        });
    }

    if (totalCents !== 10000) {
        return {
            error: `Allocation percentages must total exactly 100.00% (received ${(totalCents / 100).toFixed(2)}%)`,
        };
    }

    return { allocations };
}

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
 * REGULATOR: sees only funds with an active regulator assignment.
 */
async function listFunds(req, res) {
    const { userId, role } = req.user;

    try {
        const result =
            role === "REGULATOR"
                ? await pool.query(
                      `SELECT f.fund_id, f.managed_by, f.fund_name, f.administrator_name, f.risk_level,
                              f.expected_return, f.fund_status, f.created_at, f.updated_at
                       FROM funds f
                       WHERE EXISTS (
                           SELECT 1
                           FROM regulator_fund_assignments rfa
                           WHERE rfa.fund_id = f.fund_id
                             AND rfa.regulator_user_id = $1
                             AND rfa.active = TRUE
                       )
                       ORDER BY f.created_at DESC`,
                      [userId]
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
 * GET /api/funds/available
 * WORKER only. Returns selectable fund records without allocation/account data.
 */
async function listAvailableFunds(req, res) {
    try {
        const account = await getActiveWorkerAccount(req.user.userId);
        if (!account) {
            return res.status(403).json({
                status: "error",
                message: "An active pension account is required to browse eligible funds",
            });
        }
        const funds = await listEligibleFunds(req.user.userId);

        return res.status(200).json({ status: "success", data: funds });
    } catch (error) {
        console.error("Failed to list available funds:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch available funds due to a server error",
        });
    }
}

async function getMyAllocations(req, res) {
    const { userId } = req.user;
    try {
        const account = await getActiveWorkerAccount(userId);
        if (!account) {
            return res.status(403).json({
                status: "error",
                message: "An active pension account is required to view allocation preferences",
            });
        }
        const result = await pool.query(
            `SELECT fa.allocation_id, fa.fund_id, f.fund_name, f.administrator_name,
                    f.risk_level, f.expected_return, f.fund_status,
                    fa.percentage AS allocation_percentage, fa.effective_from, fa.effective_to
             FROM pension_accounts pa
             JOIN fund_allocations fa ON fa.account_id = pa.account_id
             JOIN funds f ON f.fund_id = fa.fund_id
             WHERE pa.user_id = $1 AND pa.account_status = 'ACTIVE'
               AND fa.effective_from <= CURRENT_DATE
               AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)
             ORDER BY f.fund_name ASC`,
            [userId]
        );

        return res.status(200).json({ status: "success", data: result.rows });
    } catch (error) {
        console.error("Failed to fetch worker fund allocations:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch your fund allocation due to a server error",
        });
    }
}

async function replaceMyAllocations(req, res) {
    const { userId } = req.user;
    const validation = validateAllocationRequest(req.body);
    if (validation.error) {
        return res.status(400).json({ status: "error", message: validation.error });
    }

    let client;
    let transactionStarted = false;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        transactionStarted = true;

        const account = await getActiveWorkerAccount(userId, client, { lock: true });
        if (!account) {
            await client.query("ROLLBACK");
            transactionStarted = false;
            return res.status(404).json({
                status: "error",
                message: "A pension account is required before setting a fund allocation",
            });
        }
        const accountId = account.account_id;

        const fundIds = validation.allocations.map(({ fund_id }) => fund_id);
        const eligibleFunds = await getEligibleFundsByIds(fundIds, client, { lock: true });
        const eligibleFundIds = new Set(eligibleFunds.map(({ fund_id }) => fund_id));
        const unavailableFund = fundIds.find((fundId) => !eligibleFundIds.has(fundId));
        if (unavailableFund) {
            await client.query("ROLLBACK");
            transactionStarted = false;
            return res.status(409).json({
                status: "error",
                message: `Fund ${unavailableFund} does not exist or is not currently active`,
            });
        }

        const sameDayAllocations = await client.query(
            `SELECT allocation_id FROM fund_allocations
             WHERE account_id = $1 AND effective_from = CURRENT_DATE
             FOR UPDATE`,
            [accountId]
        );
        if (sameDayAllocations.rows.length > 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;
            return res.status(409).json({
                status: "error",
                message: "This allocation distribution was already changed today. Allocation history supports calendar dates only, so try again tomorrow.",
            });
        }

        const futureAllocations = await client.query(
            `SELECT allocation_id FROM fund_allocations
             WHERE account_id = $1 AND effective_from > CURRENT_DATE
             FOR UPDATE`,
            [accountId]
        );
        if (futureAllocations.rows.length > 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;
            return res.status(409).json({
                status: "error",
                message: "A future-effective allocation distribution already exists. It must be resolved before saving a current distribution.",
            });
        }

        await client.query(
            `UPDATE fund_allocations
             SET effective_to = CURRENT_DATE - 1
             WHERE account_id = $1
               AND effective_from < CURRENT_DATE
               AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)`,
            [accountId]
        );

        const savedAllocations = [];
        for (const allocation of validation.allocations) {
            const result = await client.query(
                `INSERT INTO fund_allocations
                    (account_id, fund_id, percentage, effective_from, effective_to)
                 VALUES ($1, $2, $3, CURRENT_DATE, NULL)
                 RETURNING allocation_id, fund_id, percentage AS allocation_percentage,
                           effective_from, effective_to`,
                [accountId, allocation.fund_id, allocation.percentage]
            );
            savedAllocations.push(result.rows[0]);
        }

        await writeAuditLog(client, {
            userId,
            actionType: "UPDATE",
            entityName: "FUND_ALLOCATIONS",
            entityId: accountId,
        });
        await client.query("COMMIT");
        transactionStarted = false;

        return res.status(200).json({ status: "success", data: savedAllocations });
    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK");
        }
        console.error("Failed to save worker fund allocation:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to save your fund allocation due to a server error",
        });
    } finally {
        client?.release();
    }
}

/**
 * GET /api/funds/:fundId
 * FUND_MANAGER: only a fund they manage. REGULATOR: only an actively assigned fund.
 */
async function getFund(req, res) {
    const { userId, role } = req.user;
    const { fundId } = req.params;

    try {
        const result = await pool.query(
            `SELECT f.fund_id, f.managed_by, f.fund_name, f.administrator_name, f.risk_level,
                    f.expected_return, f.fund_status, f.created_at, f.updated_at
             FROM funds f
             WHERE f.fund_id = $1
               AND ($2 <> 'REGULATOR' OR EXISTS (
                   SELECT 1
                   FROM regulator_fund_assignments rfa
                   WHERE rfa.fund_id = f.fund_id
                     AND rfa.regulator_user_id = $3
                     AND rfa.active = TRUE
               ))`,
            [fundId, role, userId]
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
 * FUND_MANAGER (own fund) or REGULATOR (actively assigned fund).
 */
async function getFundAllocations(req, res) {
    const { userId, role } = req.user;
    const { fundId } = req.params;

    try {
        const result = await pool.query(
            `SELECT f.managed_by, allocation.allocation_id, allocation.account_id, allocation.fund_id,
                    allocation.percentage, allocation.effective_from, allocation.effective_to
             FROM funds f
             LEFT JOIN LATERAL (
                 SELECT allocation_id, account_id, fund_id, percentage, effective_from, effective_to
                 FROM fund_allocations
                 WHERE fund_id = f.fund_id
                   AND ($2 <> 'FUND_MANAGER' OR f.managed_by = $3)
                 ORDER BY effective_from DESC
             ) allocation ON TRUE
             WHERE f.fund_id = $1
               AND ($2 <> 'REGULATOR' OR EXISTS (
                   SELECT 1
                   FROM regulator_fund_assignments rfa
                   WHERE rfa.fund_id = f.fund_id
                     AND rfa.regulator_user_id = $3
                     AND rfa.active = TRUE
               ))
             ORDER BY allocation.effective_from DESC`,
            [fundId, role, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ status: "error", message: "Fund not found" });
        }

        if (role === "FUND_MANAGER" && result.rows[0].managed_by !== userId) {
            return res.status(403).json({ status: "error", message: "You do not manage this fund" });
        }

        const allocations = result.rows
            .filter((row) => row.allocation_id !== null)
            .map(({ managed_by, ...allocation }) => allocation);
        return res.status(200).json({ status: "success", data: allocations });
    } catch (error) {
        console.error("Failed to fetch fund allocations:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch fund allocations due to a server error",
        });
    }
}

module.exports = {
    createFund,
    listFunds,
    listAvailableFunds,
    getMyAllocations,
    replaceMyAllocations,
    getFund,
    updateFund,
    getFundAllocations,
};
