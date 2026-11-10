const { writeAuditLog } = require("../utils/auditLog");

const ID_PATTERN = /^[A-Za-z0-9_-]{1,25}$/;

function assignmentError(message, code, statusCode) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function createRegulatorFundAssignmentRepository(pool) {
    if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
        throw new TypeError("A PostgreSQL pool is required.");
    }

    async function list() {
        const result = await pool.query(
            `SELECT rfa.assignment_id, rfa.regulator_user_id, regulator.full_name AS regulator_name,
                    rfa.fund_id, f.fund_name, rfa.assigned_by, admin.full_name AS assigned_by_name,
                    rfa.active, rfa.created_at
             FROM regulator_fund_assignments rfa
             JOIN users regulator ON regulator.user_id = rfa.regulator_user_id
             JOIN funds f ON f.fund_id = rfa.fund_id
             LEFT JOIN users admin ON admin.user_id = rfa.assigned_by
             ORDER BY regulator.full_name, f.fund_name
             LIMIT 1000`
        );
        return result.rows;
    }

    async function listCandidates() {
        const [regulators, funds] = await Promise.all([
            pool.query(
                `SELECT user_id, full_name FROM users
                 WHERE role = 'REGULATOR' AND account_status = 'ACTIVE'
                 ORDER BY full_name, user_id LIMIT 500`
            ),
            pool.query(
                `SELECT fund_id, fund_name FROM funds
                 WHERE fund_status = 'ACTIVE' ORDER BY fund_name, fund_id LIMIT 500`
            ),
        ]);
        return { regulators: regulators.rows, funds: funds.rows };
    }

    async function assign({ adminId, regulatorId, fundId }) {
        if (!ID_PATTERN.test(regulatorId || "") || !ID_PATTERN.test(fundId || "")) {
            throw assignmentError("Choose a valid regulator and fund.", "ASSIGNMENT_INVALID_INPUT", 400);
        }
        const client = await pool.connect();
        let transactionStarted = false;
        try {
            await client.query("BEGIN");
            transactionStarted = true;
            const result = await client.query(
                `INSERT INTO regulator_fund_assignments (
                    regulator_user_id, fund_id, assigned_by, active
                 )
                 SELECT u.user_id, f.fund_id, $1, TRUE
                 FROM users u CROSS JOIN funds f
                 WHERE u.user_id = $2 AND u.role = 'REGULATOR'
                   AND u.account_status = 'ACTIVE' AND f.fund_id = $3
                   AND f.fund_status = 'ACTIVE'
                 ON CONFLICT (regulator_user_id, fund_id)
                 DO UPDATE SET active = TRUE, assigned_by = EXCLUDED.assigned_by
                 RETURNING assignment_id, regulator_user_id, fund_id, active, created_at`,
                [adminId, regulatorId, fundId]
            );
            const assignment = result.rows[0];
            if (!assignment) {
                throw assignmentError("The active regulator or fund was not found.", "ASSIGNMENT_TARGET_NOT_FOUND", 404);
            }
            await writeAuditLog(client, {
                userId: adminId,
                actionType: "UPDATE",
                entityName: "REGULATOR_FUND_ASSIGNMENT",
                entityId: fundId,
                details: { regulatorUserId: regulatorId, fundId, active: true },
            });
            await client.query("COMMIT");
            transactionStarted = false;
            return assignment;
        } catch (error) {
            if (transactionStarted) await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async function revoke({ adminId, regulatorId, fundId }) {
        if (!ID_PATTERN.test(regulatorId || "") || !ID_PATTERN.test(fundId || "")) {
            throw assignmentError("Choose a valid regulator and fund.", "ASSIGNMENT_INVALID_INPUT", 400);
        }
        const client = await pool.connect();
        let transactionStarted = false;
        try {
            await client.query("BEGIN");
            transactionStarted = true;
            const result = await client.query(
                `UPDATE regulator_fund_assignments
                 SET active = FALSE
                 WHERE regulator_user_id = $1 AND fund_id = $2 AND active = TRUE
                 RETURNING assignment_id`,
                [regulatorId, fundId]
            );
            if (!result.rows[0]) {
                throw assignmentError("The active assignment was not found.", "ASSIGNMENT_NOT_FOUND", 404);
            }
            await writeAuditLog(client, {
                userId: adminId,
                actionType: "UPDATE",
                entityName: "REGULATOR_FUND_ASSIGNMENT",
                entityId: fundId,
                details: { regulatorUserId: regulatorId, fundId, active: false },
            });
            await client.query("COMMIT");
            transactionStarted = false;
            return true;
        } catch (error) {
            if (transactionStarted) await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    return { assign, list, listCandidates, revoke };
}

module.exports = { createRegulatorFundAssignmentRepository };
