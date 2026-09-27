const pool = require("../db/database");
const { calculateProjection, ANNUAL_RATE } = require("../services/projectionService");

const ASSUMED_RETURN_PERCENT = ANNUAL_RATE * 100; // e.g. 0.08 -> 8.00, stored in expected_return/assumed_return (NUMERIC(6,2), percentage)

/**
 * Looks up the pension account belonging to req.user.userId.
 * Returns the account row, or null if none exists yet.
 */
async function findAccountForUser(userId, client = pool) {
    const result = await client.query(
        "SELECT account_id, current_balance FROM pension_accounts WHERE user_id = $1",
        [userId]
    );
    return result.rows[0] || null;
}

/**
 * GET /api/retirement/my-plan
 * Returns the authenticated worker's active retirement plan together with
 * its most recent projection. Identity is derived strictly from
 * req.user.userId - no account_id/user_id is ever read from the request.
 */
async function getPlan(req, res) {
    const { userId } = req.user;

    try {
        const account = await findAccountForUser(userId);

        if (!account) {
            return res.status(404).json({
                status: "error",
                message: "No pension account found for this user yet",
            });
        }

        const planResult = await pool.query(
            `SELECT plan_id, account_id, target_amount, target_age, expected_return,
                    contribution_frequency, plan_status, created_at, updated_at
             FROM retirement_plans
             WHERE account_id = $1 AND plan_status = 'ACTIVE'
             ORDER BY created_at DESC
             LIMIT 1`,
            [account.account_id]
        );

        if (planResult.rows.length === 0) {
            return res.status(404).json({
                status: "error",
                message: "No retirement plan found for this account yet",
            });
        }

        const plan = planResult.rows[0];

        const projectionResult = await pool.query(
            `SELECT projection_id, plan_id, assumed_contribution, assumed_return,
                    projected_amount, projection_years, projected_at
             FROM retirement_projections
             WHERE plan_id = $1
             ORDER BY projected_at DESC
             LIMIT 1`,
            [plan.plan_id]
        );

        return res.status(200).json({
            status: "success",
            data: {
                plan,
                projection: projectionResult.rows[0] || null,
            },
        });
    } catch (error) {
        console.error("Failed to fetch retirement plan:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch retirement plan due to a server error",
        });
    }
}

/**
 * POST /api/retirement/my-plan
 * Body: { target_amount, target_retirement_age, monthly_contribution_target, current_age }
 *
 * Inserts or updates the authenticated worker's active retirement_plans row,
 * runs projectionService.calculateProjection, and writes the result as a
 * new retirement_projections row.
 *
 * Field-mapping notes (schema.sql does not have an exact 1:1 match for the
 * requested body fields):
 *   - target_retirement_age -> retirement_plans.target_age
 *   - monthly_contribution_target -> retirement_projections.assumed_contribution
 *     (retirement_plans has no numeric contribution-amount column; only the
 *     existing `contribution_frequency` enum, which is set to 'MONTHLY').
 *   - current_age is required in the body because calculateProjection needs
 *     it and none of pension_accounts/retirement_plans/retirement_projections
 *     store a birthdate or age (kyc_records.date_of_birth exists in a
 *     different table not referenced by this module).
 */
async function upsertPlan(req, res) {
    const { userId } = req.user;
    const { target_amount, target_retirement_age, monthly_contribution_target, current_age } = req.body;

    const targetAmount = Number(target_amount);
    const targetAge = Number(target_retirement_age);
    const monthlyContribution = Number(monthly_contribution_target);
    const currentAge = Number(current_age);

    if (
        target_amount === undefined ||
        target_retirement_age === undefined ||
        monthly_contribution_target === undefined ||
        current_age === undefined
    ) {
        return res.status(400).json({
            status: "error",
            message:
                "target_amount, target_retirement_age, monthly_contribution_target, and current_age are required",
        });
    }

    if (!Number.isFinite(targetAmount) || targetAmount <= 0) {
        return res.status(400).json({
            status: "error",
            message: "target_amount must be a positive number",
        });
    }

    if (!Number.isInteger(targetAge) || targetAge <= 0) {
        return res.status(400).json({
            status: "error",
            message: "target_retirement_age must be a positive whole number",
        });
    }

    if (!Number.isFinite(monthlyContribution) || monthlyContribution < 0) {
        return res.status(400).json({
            status: "error",
            message: "monthly_contribution_target must be a non-negative number",
        });
    }

    if (!Number.isInteger(currentAge) || currentAge <= 0) {
        return res.status(400).json({
            status: "error",
            message: "current_age must be a positive whole number",
        });
    }

    if (currentAge >= targetAge) {
        return res.status(400).json({
            status: "error",
            message: "target_retirement_age must be greater than current_age",
        });
    }

    const client = await pool.connect();

    try {
        const account = await findAccountForUser(userId, client);

        if (!account) {
            return res.status(404).json({
                status: "error",
                message: "No pension account found for this user yet",
            });
        }

        const currentBalance = Number(account.current_balance);

        const calculation = calculateProjection({
            currentBalance,
            monthlyContribution,
            targetAmount,
            targetAge,
            currentAge,
        });

        await client.query("BEGIN");

        const existingPlanResult = await client.query(
            `SELECT plan_id FROM retirement_plans
             WHERE account_id = $1 AND plan_status = 'ACTIVE'
             ORDER BY created_at DESC
             LIMIT 1`,
            [account.account_id]
        );

        let plan;

        if (existingPlanResult.rows.length > 0) {
            const { plan_id } = existingPlanResult.rows[0];
            const updateResult = await client.query(
                `UPDATE retirement_plans
                 SET target_amount = $1,
                     target_age = $2,
                     expected_return = $3,
                     contribution_frequency = 'MONTHLY',
                     plan_status = 'ACTIVE',
                     updated_at = now()
                 WHERE plan_id = $4
                 RETURNING plan_id, account_id, target_amount, target_age, expected_return,
                           contribution_frequency, plan_status, created_at, updated_at`,
                [targetAmount, targetAge, ASSUMED_RETURN_PERCENT, plan_id]
            );
            plan = updateResult.rows[0];
        } else {
            const insertResult = await client.query(
                `INSERT INTO retirement_plans
                    (account_id, target_amount, target_age, expected_return, contribution_frequency, plan_status)
                 VALUES ($1, $2, $3, $4, 'MONTHLY', 'ACTIVE')
                 RETURNING plan_id, account_id, target_amount, target_age, expected_return,
                           contribution_frequency, plan_status, created_at, updated_at`,
                [account.account_id, targetAmount, targetAge, ASSUMED_RETURN_PERCENT]
            );
            plan = insertResult.rows[0];
        }

        const projectionYears = targetAge - currentAge;

        const projectionResult = await client.query(
            `INSERT INTO retirement_projections
                (plan_id, assumed_contribution, assumed_return, projected_amount, projection_years)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING projection_id, plan_id, assumed_contribution, assumed_return,
                       projected_amount, projection_years, projected_at`,
            [plan.plan_id, monthlyContribution, ASSUMED_RETURN_PERCENT, calculation.projectedBalance, projectionYears]
        );

        await client.query("COMMIT");

        return res.status(200).json({
            status: "success",
            message: "Retirement plan saved successfully",
            data: {
                plan,
                projection: projectionResult.rows[0],
                calculation,
            },
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Failed to save retirement plan:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to save retirement plan due to a server error",
        });
    } finally {
        client.release();
    }
}

module.exports = { getPlan, upsertPlan };
