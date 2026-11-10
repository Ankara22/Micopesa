const { test } = require("node:test");
const assert = require("node:assert/strict");
process.env.NODE_ENV = "test";
const pool = require("../src/db/database");
const { getPerformance } = require("../src/controllers/fundManagerController");

test("fund manager performance aggregates include only their effective managed-fund allocations", async () => {
    const originalQuery = pool.query;
    let captured;
    pool.query = async (sql, values) => {
        captured = { sql, values };
        return {
            rows: [{
                total_assets: "750.00",
                active_accounts: 2,
                funds_managed: 1,
                average_yield: "4.5",
            }],
        };
    };

    try {
        const response = {
            statusCode: null,
            body: null,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(body) {
                this.body = body;
                return this;
            },
        };

        await getPerformance({ user: { userId: "manager-1" } }, response);

        assert.equal(response.statusCode, 200);
        assert.equal(response.body.data.total_assets, "750.00");
        assert.equal(response.body.data.active_accounts, 2);
        assert.equal(captured.values[0], "manager-1");
        assert.match(captured.sql, /JOIN funds managed_fund ON managed_fund\.fund_id = fa\.fund_id/);
        assert.match(captured.sql, /managed_fund\.managed_by = \$1/);
        assert.match(captured.sql, /fa\.effective_from <= CURRENT_DATE/);
        assert.match(captured.sql, /fa\.effective_to IS NULL OR fa\.effective_to >= CURRENT_DATE/);
        assert.match(captured.sql, /pa\.current_balance \* maa\.allocation_percentage \/ 100/);
    } finally {
        pool.query = originalQuery;
    }
});
