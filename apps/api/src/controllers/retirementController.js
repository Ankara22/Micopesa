const pool = require("../db/database");
const { enqueueBusinessNotification } = require("../services/notificationEventService");
const { calculateProjection, validateProjectionInputs } = require("../services/projectionService");
const { loadAdminSettings } = require("../services/adminSettingsService");

async function findAccountForUser(userId, client = pool, { lock = false } = {}) {
    const result = await client.query(
        `SELECT account_id, current_balance
         FROM pension_accounts
         WHERE user_id = $1${lock ? " FOR SHARE" : ""}`,
        [userId]
    );
    return result.rows[0] || null;
}

async function getPlan(req, res) {
    try {
        const account = await findAccountForUser(req.user.userId);
        if (!account) {
            return res.status(404).json({
                status: "error",
                message: "No pension account found for this user yet",
            });
        }

        const settings = await loadAdminSettings();
        const planResult = await pool.query(
            `SELECT plan_id, account_id, target_amount, target_age, expected_return,
                    contribution_frequency, plan_status, created_at, updated_at
             FROM retirement_plans
             WHERE account_id = $1 AND plan_status = 'ACTIVE'
             ORDER BY created_at DESC
             LIMIT 1`,
            [account.account_id]
        );
        const plan = planResult.rows[0] || null;
        if (!plan) {
            return res.status(404).json({
                status: "error",
                code: "RETIREMENT_PLAN_NOT_FOUND",
                message: "No active retirement plan found",
                data: {
                    plan: null,
                    projection: null,
                    account: { current_balance: account.current_balance },
                    assumed_yearly_growth: settings.assumed_yearly_growth,
                },
            });
        }

        const projectionResult = await pool.query(
            `SELECT projection_id, plan_id, assumed_contribution, assumed_return,
                    projected_amount, projection_years, current_age, starting_balance,
                    yearly_projection, projected_at
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
                account: { current_balance: account.current_balance },
                assumed_yearly_growth: settings.assumed_yearly_growth,
            },
        });
    } catch (error) {
        console.error("Failed to fetch retirement plan:", error?.code || error?.name || "RETIREMENT_READ_ERROR");
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch retirement plan due to a server error",
        });
    }
}

async function upsertPlan(req, res) {
    const {
        target_amount: targetAmountInput,
        target_retirement_age: targetAgeInput,
        monthly_contribution_target: monthlyContributionInput,
        current_age: currentAgeInput,
    } = req.body || {};
    const validationError = validateProjectionInputs({
        currentBalance: 0,
        monthlyContribution: monthlyContributionInput,
        targetAmount: targetAmountInput,
        targetAge: targetAgeInput,
        currentAge: currentAgeInput,
    });

    if (validationError) {
        return res.status(400).json({ status: "error", message: validationError });
    }

    const targetAmount = Number(targetAmountInput);
    const targetAge = Number(targetAgeInput);
    const monthlyContribution = Number(monthlyContributionInput);
    const currentAge = Number(currentAgeInput);
    let client;
    let transactionStarted = false;

    try {
        client = await pool.connect();
        await client.query("BEGIN");
        transactionStarted = true;

        const account = await findAccountForUser(req.user.userId, client, { lock: true });
        if (!account) {
            await client.query("ROLLBACK");
            transactionStarted = false;
            return res.status(404).json({
                status: "error",
                message: "No pension account found for this user yet",
            });
        }

        const settings = await loadAdminSettings(client);
        const annualRate = settings.assumed_yearly_growth / 100;
        const calculation = calculateProjection({
            currentBalance: account.current_balance,
            monthlyContribution,
            targetAmount,
            targetAge,
            currentAge,
            annualRate,
        });

        const existingPlanResult = await client.query(
            `SELECT plan_id FROM retirement_plans
             WHERE account_id = $1 AND plan_status = 'ACTIVE'
             ORDER BY created_at DESC
             LIMIT 1
             FOR UPDATE`,
            [account.account_id]
        );

        let plan;
        if (existingPlanResult.rows.length > 0) {
            const { plan_id: planId } = existingPlanResult.rows[0];
            const updateResult = await client.query(
                `UPDATE retirement_plans
                 SET target_amount = $1,
                     target_age = $2,
                     expected_return = $3,
                     contribution_frequency = 'MONTHLY',
                     plan_status = 'ACTIVE',
                     updated_at = now()
                 WHERE plan_id = $4 AND account_id = $5
                 RETURNING plan_id, account_id, target_amount, target_age, expected_return,
                           contribution_frequency, plan_status, created_at, updated_at`,
                [targetAmount, targetAge, settings.assumed_yearly_growth, planId, account.account_id]
            );
            plan = updateResult.rows[0];
        } else {
            const insertResult = await client.query(
                `INSERT INTO retirement_plans
                    (account_id, target_amount, target_age, expected_return, contribution_frequency, plan_status)
                 VALUES ($1, $2, $3, $4, 'MONTHLY', 'ACTIVE')
                 RETURNING plan_id, account_id, target_amount, target_age, expected_return,
                           contribution_frequency, plan_status, created_at, updated_at`,
                [account.account_id, targetAmount, targetAge, settings.assumed_yearly_growth]
            );
            plan = insertResult.rows[0];
        }

        const projectionResult = await client.query(
            `INSERT INTO retirement_projections
                (plan_id, assumed_contribution, assumed_return, projected_amount, projection_years,
                 current_age, starting_balance, yearly_projection)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
             RETURNING projection_id, plan_id, assumed_contribution, assumed_return,
                       projected_amount, projection_years, current_age, starting_balance,
                       yearly_projection, projected_at`,
            [
                plan.plan_id,
                monthlyContribution,
                settings.assumed_yearly_growth,
                calculation.projectedBalance,
                calculation.projectionYears,
                currentAge,
                account.current_balance,
                JSON.stringify(calculation.yearByYear),
            ]
        );

        await client.query("COMMIT");
        transactionStarted = false;
        void enqueueBusinessNotification({
            userId: req.user.userId,
            eventType: "RETIREMENT_PLAN_SAVED",
            referenceId: projectionResult.rows[0].projection_id,
        });

        return res.status(200).json({
            status: "success",
            message: "Retirement projection calculated and saved",
            data: {
                plan,
                projection: projectionResult.rows[0],
                account: { current_balance: account.current_balance },
                assumed_yearly_growth: settings.assumed_yearly_growth,
                calculation,
            },
        });
    } catch (error) {
        if (transactionStarted && client) {
            await client.query("ROLLBACK").catch(() => {});
        }
        if (error.code === "PROJECTION_INVALID") {
            return res.status(400).json({ status: "error", message: error.message });
        }
        console.error("Failed to save retirement projection:", error?.code || error?.name || "RETIREMENT_WRITE_ERROR");
        return res.status(500).json({
            status: "error",
            message: "Failed to save retirement projection due to a server error",
        });
    } finally {
        client?.release();
    }
}

module.exports = { getPlan, upsertPlan };
