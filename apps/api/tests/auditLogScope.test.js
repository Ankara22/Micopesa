const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadController(pool) {
    const controllerPath = require.resolve("../src/controllers/auditLogController");
    delete require.cache[controllerPath];
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === "../db/database" && parent?.filename === controllerPath) return pool;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        return require(controllerPath);
    } finally {
        Module._load = originalLoad;
    }
}

test("operational audit history is filtered to the authenticated user's actions", async () => {
    const calls = [];
    const controller = loadController({
        async query(sql, params) {
            calls.push({ sql, params });
            return { rows: [] };
        },
    });
    const response = {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };

    await controller.listOperationalLogs(
        { user: { userId: "manager-1", role: "FUND_MANAGER" } },
        response
    );

    assert.equal(response.statusCode, 200);
    assert.match(calls[0].sql, /WHERE al\.user_id = \$1/);
    assert.match(calls[0].sql, /al\.entity_name = 'COMPLIANCE_REPORTS'/);
    assert.match(calls[0].sql, /al\.entity_name = 'ROLE_NOTIFICATION'/);
    assert.match(calls[0].sql, /al\.entity_name = 'WITHDRAWAL_CLAIMS'/);
    assert.deepEqual(calls[0].params, ["manager-1", "FUND_MANAGER"]);
});

test("regulator audit includes only compliance and notification events in active assigned funds", async () => {
    const calls = [];
    const controller = loadController({
        async query(sql, params) {
            calls.push({ sql, params });
            return { rows: [{ entity_name: "COMPLIANCE_REPORTS", entity_id: "report-1" }] };
        },
    });
    const response = {
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };

    await controller.listOperationalLogs(
        { user: { userId: "regulator-1", role: "REGULATOR" } },
        response
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data[0].entity_id, "report-1");
    assert.deepEqual(calls[0].params, ["regulator-1", "REGULATOR"]);
    assert.match(calls[0].sql, /cr\.report_id = al\.entity_id/);
    assert.match(calls[0].sql, /rfa\.regulator_user_id = \$1/);
    assert.match(calls[0].sql, /rfa\.active = TRUE/);
    assert.match(calls[0].sql, /f\.fund_status = 'ACTIVE'/);
});

test("regulator audit query rejects revoked assignments and malformed or unknown scope metadata", async () => {
    const calls = [];
    const controller = loadController({
        async query(sql, params) {
            calls.push({ sql, params });
            return { rows: [] };
        },
    });
    const response = {
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };

    await controller.listOperationalLogs(
        { user: { userId: "regulator-1", role: "REGULATOR" } },
        response
    );

    assert.deepEqual(response.body.data, []);
    assert.match(calls[0].sql, /rfa\.fund_id = f\.fund_id[\s\S]*rfa\.active = TRUE/);
    assert.match(calls[0].sql, /jsonb_typeof\(al\.details->'scopeFundId'\) = 'string'/);
    assert.match(calls[0].sql, /al\.details->'scopeFundId' = 'null'::jsonb/);
    assert.match(calls[0].sql, /al\.entity_name = 'COMPLIANCE_REPORTS'[\s\S]*OR \(al\.entity_name = 'ROLE_NOTIFICATION'/);
});

test("explicitly global role-notification audit entries remain visible without granting unknown event access", async () => {
    const controller = loadController({
        async query(sql, params) {
            assert.deepEqual(params, ["manager-1", "FUND_MANAGER"]);
            assert.match(sql, /al\.details \? 'scopeFundId'/);
            return {
                rows: [{
                    entity_name: "ROLE_NOTIFICATION",
                    entity_id: "notification-1",
                    details: { scopeFundId: null },
                }],
            };
        },
    });
    const response = {
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };

    await controller.listOperationalLogs(
        { user: { userId: "manager-1", role: "FUND_MANAGER" } },
        response
    );

    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].details.scopeFundId, null);
});

test("fund-manager audit events require current ownership and current allocation for withdrawal claims", async () => {
    const queries = [];
    const controller = loadController({
        async query(sql, params) {
            queries.push({ sql, params });
            return { rows: [] };
        },
    });
    const response = {
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };

    await controller.listOperationalLogs(
        { user: { userId: "manager-1", role: "FUND_MANAGER" } },
        response
    );

    assert.deepEqual(response.body.data, []);
    assert.deepEqual(queries[0].params, ["manager-1", "FUND_MANAGER"]);
    assert.match(queries[0].sql, /f\.managed_by = \$1/);
    assert.match(queries[0].sql, /fa\.effective_from <= CURRENT_DATE/);
    assert.match(queries[0].sql, /fa\.effective_to IS NULL OR fa\.effective_to >= CURRENT_DATE/);
});
