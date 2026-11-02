const pool = require("../db/database");

const AVAILABLE_FUND_FIELDS = `fund_id, fund_name, administrator_name, risk_level,
                              expected_return, fund_status`;

async function getActiveWorkerAccount(userId, executor = pool, { lock = false } = {}) {
    const result = await executor.query(
        `SELECT account_id, account_status
         FROM pension_accounts
         WHERE user_id = $1 AND account_status = 'ACTIVE'
         ${lock ? "FOR UPDATE" : ""}`,
        [userId]
    );
    return result.rows[0] || null;
}

async function listEligibleFunds(userId, executor = pool) {
    const result = await executor.query(
        `SELECT ${AVAILABLE_FUND_FIELDS}
         FROM funds f
         WHERE f.fund_status = 'ACTIVE'
           AND EXISTS (
               SELECT 1
               FROM pension_accounts pa
               WHERE pa.user_id = $1 AND pa.account_status = 'ACTIVE'
           )
         ORDER BY f.fund_name ASC`,
        [userId]
    );
    return result.rows;
}

async function getEligibleFundsByIds(fundIds, executor = pool, { lock = false } = {}) {
    const result = await executor.query(
        `SELECT fund_id
         FROM funds
         WHERE fund_id = ANY($1::varchar[]) AND fund_status = 'ACTIVE'
         ${lock ? "FOR SHARE" : ""}`,
        [fundIds]
    );
    return result.rows;
}

module.exports = {
    getActiveWorkerAccount,
    getEligibleFundsByIds,
    listEligibleFunds,
};
