const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createReportService } = require("../src/services/reportService");
const { createReportController } = require("../src/controllers/reportController");

function response() {
    return {
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
}

test("manager analytics return scoped contribution trends, fund totals, and settled fund performance", async () => {
    const calls = [];
    const service = createReportService({
        async query(sql, params) {
            calls.push({ sql, params });
            return {
                rows: [{
                    period: "2026-10-01",
                    status: "COMPLETED",
                    contribution_count: 3,
                    allocated_amount: "125.00",
                }],
            };
        },
    });

    const data = await service.getAnalytics({
        userId: "manager-1",
        role: "FUND_MANAGER",
        filters: { start_date: "2026-10-01", end_date: "2026-10-31" },
    });

    assert.equal(calls.length, 3);
    const trends = calls.find(({ sql }) => sql.includes("GROUP BY date_trunc('month', c.created_at)"));
    const summary = calls.find(({ sql }) => sql.includes("AS managed_funds"));
    const performance = calls.find(({ sql }) => sql.includes("AS settled_contributions"));
    assert.deepEqual(trends.params, ["2026-10-01", "2026-10-31", "manager-1"]);
    assert.match(trends.sql, /f\.managed_by = \$3/);
    assert.match(trends.sql, /f\.fund_status = 'ACTIVE'/);
    assert.match(trends.sql, /fa\.effective_from <= c\.created_at::date/);
    assert.match(trends.sql, /fa\.effective_to IS NULL OR fa\.effective_to >= c\.created_at::date/);
    assert.match(trends.sql, /c\.created_at >= \$1::date/);
    assert.match(trends.sql, /c\.created_at < \(\$2::date \+ INTERVAL '1 day'\)/);
    assert.match(trends.sql, /c\.contribution_status/);
    assert.match(trends.sql, /t\.transaction_status = 'COMPLETED'/);
    assert.match(summary.sql, /AS managed_funds/);
    assert.match(summary.sql, /AS allocated_workers/);
    assert.match(performance.sql, /t\.transaction_status = 'COMPLETED'/);
    assert.match(performance.sql, /t\.transaction_type = 'CONTRIBUTION'/);
    assert.doesNotMatch(trends.sql + summary.sql + performance.sql, /full_name|phone|email/);
    assert.deepEqual(data.contribution_trends, [{
        period: "2026-10-01",
        status: "COMPLETED",
        contribution_count: 3,
        allocated_amount: "125.00",
    }]);
    assert.ok(data.fund_summary);
    assert.ok(Array.isArray(data.fund_performance));
});

test("regulator analytics scope comparison, compliance trends, and evidence to active assigned funds", async () => {
    const calls = [];
    const service = createReportService({
        async query(sql, params) {
            calls.push({ sql, params });
            return { rows: [] };
        },
    });

    const data = await service.getAnalytics({
        userId: "regulator-1",
        role: "REGULATOR",
        filters: { start_date: "2026-01-01" },
    });

    assert.equal(calls.length, 5);
    for (const [index, { sql, params }] of calls.entries()) {
        assert.deepEqual(
            params,
            index === 4 ? ["regulator-1"] : ["2026-01-01", null, "regulator-1"]
        );
        assert.match(sql, /regulator_fund_assignments/);
        assert.match(sql, index === 4 ? /rfa\.regulator_user_id = \$1/ : /rfa\.regulator_user_id = \$3/);
        assert.match(sql, /rfa\.active = TRUE/);
        assert.match(sql, /f\.fund_status = 'ACTIVE'/);
        assert.doesNotMatch(sql, /full_name|phone|email/);
    }
    assert.match(calls[0].sql, /assigned_funds/);
    assert.match(calls[0].sql, /c\.contribution_status = 'COMPLETED'/);
    assert.match(calls[0].sql, /t\.transaction_status = 'COMPLETED'/);
    assert.match(calls[0].sql, /t\.transaction_type = 'CONTRIBUTION'/);
    for (const index of [1, 2, 3]) {
        assert.match(calls[index].sql, /\(cr\.is_legacy = TRUE OR cr\.rba_status <> 'DRAFT'\)/);
    }
    assert.match(calls[1].sql, /compliance_reports/);
    assert.match(calls[2].sql, /compliance_report_submissions/);
    assert.match(calls[2].sql, /evidence\.section/);
    assert.match(calls[3].sql, /COMPLIANCE_REPORTS/);
    assert.deepEqual(data, {
        fund_comparison: [],
        compliance_trends: [],
        compliance_evidence: [],
        compliance_activity: [],
        risk_summary: [],
    });
    assert.match(calls[4].sql, /f\.risk_level/);
});

test("admin analytics preserve notification outcomes and distinguish payment attempt, verification, and settlement statuses", async () => {
    const calls = [];
    const service = createReportService({
        async query(sql, params) {
            calls.push({ sql, params });
            return { rows: [] };
        },
    });

    const data = await service.getAnalytics({
        userId: "admin-1",
        role: "ADMIN",
        filters: { end_date: "2026-11-05" },
    });

    assert.equal(calls.length, 4);
    for (const { params } of calls) assert.deepEqual(params, [null, "2026-11-05"]);
    const notifications = calls.find(({ sql }) => sql.includes("FROM notifications"));
    assert.match(notifications.sql, /notification_type AS channel/);
    assert.match(notifications.sql, /delivery_status AS status/);
    assert.match(notifications.sql, /GROUP BY notification_type, delivery_status/);
    assert.match(notifications.sql, /notification_type AS channel/);
    assert.doesNotMatch(notifications.sql, /CASE.*delivery_status/s);

    const payments = calls.find(({ sql }) => sql.includes("mpesa_payment_attempts"));
    assert.match(payments.sql, /'ATTEMPT'/);
    assert.match(payments.sql, /'VERIFICATION'/);
    assert.match(payments.sql, /'SETTLEMENT'/);
    assert.match(payments.sql, /latest\.verification_status = 'VERIFIED_SUCCESS'/);
    assert.match(payments.sql, /c\.contribution_status = 'COMPLETED'/);
    assert.match(payments.sql, /t\.transaction_status = 'COMPLETED'/);
    assert.match(payments.sql, /t\.transaction_type = 'CONTRIBUTION'/);
    assert.doesNotMatch(payments.sql, /mpesa_receipt|mpesa_phone|full_name|email/);
    assert.match(calls.find(({ sql }) => sql.includes("FROM audit_logs")).sql, /action_type, entity_name/);
    assert.deepEqual(Object.keys(data), ["notification_outcomes", "mpesa_statuses", "activity", "user_trends"]);
});

test("analytics reject unauthorized roles and invalid filters before querying aggregate data", async () => {
    let queryCount = 0;
    const service = createReportService({
        async query() {
            queryCount += 1;
            return { rows: [] };
        },
    });

    await assert.rejects(() => service.getAnalytics({
        userId: "worker-1",
        role: "WORKER",
    }), { code: "REPORT_FORBIDDEN", statusCode: 403 });
    await assert.rejects(() => service.getAnalytics({
        userId: "admin-1",
        role: "ADMIN",
        filters: { start_date: "2026-11-31" },
    }), { code: "REPORT_INVALID_FILTERS", statusCode: 400 });
    assert.equal(queryCount, 0);
});

test("analytics controller passes only the authenticated identity and date filters to the service", async () => {
    let input;
    const controller = createReportController({
        service: {
            async getAnalytics(options) {
                input = options;
                return { activity: [{ action_type: "LOGIN", event_count: 2 }] };
            },
        },
    });
    const res = response();

    await controller.analytics({
        user: { userId: "admin-1", role: "ADMIN" },
        query: { start_date: "2026-11-01" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(input, {
        userId: "admin-1",
        role: "ADMIN",
        filters: { start_date: "2026-11-01" },
    });
    assert.deepEqual(res.body.data, { activity: [{ action_type: "LOGIN", event_count: 2 }] });
});
