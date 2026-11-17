const { test } = require("node:test");
const assert = require("node:assert/strict");
process.env.NODE_ENV = "test";
const pool = require("../src/db/database");
const regulator = require("../src/controllers/regulatorController");
const fundController = require("../src/controllers/fundController");

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

test("regulator compliance overview and report list bind every aggregate and row query to assigned funds", async () => {
    const originalQuery = pool.query;
    const calls = [];
    pool.query = async (sql, values = []) => {
        calls.push({ sql, values });
        if (sql.includes("entity_name = 'KYC_RECORD'")) {
            return { rows: [{ action_type: "APPROVE", kyc_status: "VERIFIED", timestamp: "2026-03-01T00:00:00Z" }] };
        }
        if (sql.includes("FROM audit_logs al")) {
            return { rows: [{ events_last_24h: 1, last_event_at: "2026-03-01T00:00:00Z" }] };
        }
        if (sql.startsWith("SELECT rba_status, count(*)::int AS count")) {
            return { rows: [{ rba_status: "SUBMITTED", count: 1 }] };
        }
        if (sql.startsWith("SELECT report_id, rba_status, period_start")) {
            return { rows: [{ report_id: "assigned-report", rba_status: "SUBMITTED" }] };
        }
        if (sql.includes("FROM kyc_records")) {
            return { rows: [{ kyc_status: "VERIFIED", count: 1 }] };
        }
        if (sql.startsWith("SELECT cr.report_id, cr.generated_by AS manager_id")) {
            return {
                rows: values[0] === "regulator-1"
                    ? [{ report_id: "assigned-report", fund_id: "fund-1" }]
                    : [],
            };
        }
        throw new Error(`Unexpected regulator scope query: ${sql}`);
    };

    try {
        const overview = response();
        await regulator.getComplianceOverview({ user: { userId: "regulator-1" } }, overview);
        assert.equal(overview.statusCode, 200);
        assert.equal(overview.body.data.latest_rba_report.report_id, "assigned-report");
        assert.equal(calls.length, 5);
        assert.ok(calls.slice(0, 3).every(({ values }) => values[0] === "regulator-1"));
        assert.ok(calls.slice(0, 3).every(({ sql }) => sql.includes("regulator_fund_assignments")));
        assert.ok(calls.slice(0, 3).every(({ sql }) =>
            sql.includes("(cr.is_legacy = TRUE OR cr.rba_status <> 'DRAFT')")
        ));
        assert.match(calls[0].sql, /al\.entity_name = 'COMPLIANCE_REPORTS'/);
        assert.match(calls[0].sql, /cr\.report_id = al\.entity_id/);
        assert.deepEqual(overview.body.data.kyc_status_counts, [{ kyc_status: "VERIFIED", count: 1 }]);
        assert.deepEqual(overview.body.data.kyc_review_history, [{
            action_type: "APPROVE",
            kyc_status: "VERIFIED",
            timestamp: "2026-03-01T00:00:00Z",
        }]);
        assert.match(calls[3].sql, /GROUP BY kyc_status/);
        assert.match(calls[4].sql, /entity_name = 'KYC_RECORD'/);
        assert.doesNotMatch(JSON.stringify(overview.body.data.kyc_status_counts), /national_id|email|phone|user_id|kyc_id/i);
        assert.doesNotMatch(JSON.stringify(overview.body.data.kyc_review_history), /national_id|email|phone|user_id|kyc_id/i);
        assert.match(calls[3].sql, /rfa\.regulator_user_id = \$1/);
        assert.match(calls[4].sql, /JOIN kyc_records k ON k\.kyc_id = al\.entity_id/);
        assert.match(calls[4].sql, /rfa\.regulator_user_id = \$1/);

        calls.length = 0;
        const filteredList = response();
        await regulator.listReports({
            user: { userId: "regulator-1" },
            query: {
                fund_id: "fund-1",
                manager_id: "manager-1",
                report_type: "RBA",
                status: "SUBMITTED",
                period_start: "2026-01-01",
                period_end: "2026-03-31",
                search: "synthetic",
            },
        }, filteredList);
        assert.equal(filteredList.statusCode, 200);
        assert.deepEqual(calls[0].values, [
            "regulator-1",
            "fund-1",
            "manager-1",
            "RBA",
            "SUBMITTED",
            "2026-01-01",
            "2026-03-31",
            "%synthetic%",
            "%synthetic%",
        ]);
        assert.match(calls[0].sql, /cr\.period_end >= \$6/);
        assert.match(calls[0].sql, /cr\.period_start <= \$7/);
        assert.match(calls[0].sql, /rfa\.regulator_user_id = \$1/);
        assert.match(calls[0].sql, /rfa\.active = TRUE/);

        calls.length = 0;
        const invalidDateRange = response();
        await regulator.listReports({
            user: { userId: "regulator-1" },
            query: { period_start: "2026-04-01", period_end: "2026-03-31" },
        }, invalidDateRange);
        assert.equal(invalidDateRange.statusCode, 400);
        assert.equal(calls.length, 0);

        calls.length = 0;
        const list = response();
        await regulator.listReports({ user: { userId: "regulator-1" }, query: {} }, list);
        assert.equal(list.statusCode, 200);
        assert.deepEqual(list.body.data.map((report) => report.report_id), ["assigned-report"]);
        assert.equal(calls[0].values[0], "regulator-1");
        assert.match(calls[0].sql, /rfa\.fund_id = cr\.fund_id/);
        assert.match(calls[0].sql, /rfa\.active = TRUE/);
    } finally {
        pool.query = originalQuery;
    }
});

test("regulator report details return not found outside the active assigned-fund scope", async () => {
    const originalConnect = pool.connect;
    let visibleReportQuery;
    pool.connect = async () => ({
        async query(sql, values = []) {
            if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") return { rows: [] };
            if (sql === "ROLLBACK") return { rows: [] };
            visibleReportQuery = { sql, values };
            return { rows: [] };
        },
        release() {},
    });

    try {
        const result = response();
        await regulator.getComplianceReport({
            user: { userId: "regulator-1" },
            params: { reportId: "unassigned-report" },
        }, result);

        assert.equal(result.statusCode, 404);
        assert.equal(visibleReportQuery.values[1], "regulator-1");
        assert.match(visibleReportQuery.sql, /rfa\.regulator_user_id = \$2/);
        assert.match(visibleReportQuery.sql, /rfa\.fund_id = compliance_reports\.fund_id/);
        assert.match(visibleReportQuery.sql, /rfa\.active = TRUE/);
    } finally {
        pool.connect = originalConnect;
    }
});

test("regulator KYC oversight exposes only aggregate and redacted data in assigned active funds", async () => {
    const originalQuery = pool.query;
    const calls = [];
    pool.query = async (sql, values = []) => {
        calls.push({ sql, values });
        if (sql.startsWith("SELECT count(DISTINCT rfa.fund_id)")) {
            return { rows: [{ active_assigned_fund_count: 1 }] };
        }
        if (sql.startsWith("SELECT kyc_status")) {
            return { rows: [{ kyc_status: "VERIFIED", count: 2 }] };
        }
        if (sql.startsWith("SELECT count(*)::int AS total_count")) {
            return { rows: [{ total_count: 1 }] };
        }
        if (sql.startsWith("SELECT al.log_id")) {
            return {
                rows: [{
                    log_id: "log-1",
                    action_type: "APPROVE",
                    kyc_status: "VERIFIED",
                    reviewer_role: "ADMIN",
                    timestamp: "2026-03-01T00:00:00Z",
                }],
            };
        }
        throw new Error(`Unexpected KYC oversight query: ${sql}`);
    };

    try {
        const result = response();
        await regulator.getKycOversight({
            user: { userId: "regulator-1" },
            query: { page: "1", page_size: "25" },
        }, result);

        assert.equal(result.statusCode, 200);
        assert.deepEqual(result.body.data.kyc_status_counts, [{ kyc_status: "VERIFIED", count: 2 }]);
        assert.deepEqual(result.body.data.review_history, [{
            log_id: "log-1",
            action_type: "APPROVE",
            kyc_status: "VERIFIED",
            reviewer_role: "ADMIN",
            timestamp: "2026-03-01T00:00:00Z",
        }]);
        assert.equal(result.body.data.pagination.total_count, 1);
        assert.ok(calls.every(({ sql }) => /rfa\.regulator_user_id = \$1/.test(sql)));
        assert.ok(calls.filter(({ sql }) => sql.includes("JOIN kyc_records k")).every(({ sql }) =>
            /f\.fund_status = 'ACTIVE'/.test(sql)
        ));
        assert.match(calls.find(({ sql }) => sql.startsWith("SELECT kyc_status")).sql, /fa\.effective_from <= CURRENT_DATE/);
        assert.match(calls.find(({ sql }) => sql.startsWith("SELECT al.log_id")).sql, /JOIN kyc_records k ON k\.kyc_id = al\.entity_id/);
        assert.deepEqual(calls.map(({ values }) => values[0]), [
            "regulator-1", "regulator-1", "regulator-1", "regulator-1",
        ]);
        assert.doesNotMatch(JSON.stringify(result.body), /national_id|email|phone|account_id|user_id|kyc_id/i);
        const historyQuery = calls.find(({ sql }) => sql.startsWith("SELECT al.log_id"));
        assert.doesNotMatch(historyQuery.sql.slice(0, historyQuery.sql.indexOf("FROM audit_logs")), /user_id|kyc_id|email|phone/i);
    } finally {
        pool.query = originalQuery;
    }
});

test("regulator internal controls are read-only and explicitly distinguish system checks from statutory thresholds", async () => {
    const originalQuery = pool.query;
    const calls = [];
    pool.query = async (sql, values = []) => {
        calls.push({ sql, values });
        if (sql.includes("FROM pension_ledger WHERE singleton_key IS TRUE")) {
            return { rows: [{ status: "ACTIVE" }] };
        }
        if (sql.startsWith("SELECT f.fund_status")) {
            return { rows: [{ fund_status: "ACTIVE", fund_count: 1 }] };
        }
        if (sql.includes("WITH scoped_accounts AS")) {
            return { rows: [{ evaluated_accounts: 1, valid_accounts: 1, invalid_accounts: 0 }] };
        }
        if (sql.includes("FROM mpesa_payment_attempts a")) {
            return { rows: [{ evaluated_count: 1, unresolved_count: 0 }] };
        }
        if (sql.includes("FROM compliance_reports cr")) {
            return { rows: [{ incomplete_submissions: 0 }] };
        }
        throw new Error(`Unexpected internal control query: ${sql}`);
    };

    try {
        const result = response();
        await regulator.getInternalControlChecks({ user: { userId: "regulator-1" } }, result);

        assert.equal(result.statusCode, 200);
        assert.equal(result.body.data.formal_parameters.status, "NOT_CONFIGURED");
        assert.equal(result.body.data.checks.length, 5);
        assert.equal(result.body.data.checks.find(({ key }) => key === "ledger_readiness").status, "PASS");
        assert.equal(result.body.data.checks.find(({ key }) => key === "payment_reconciliation").status, "PASS");
        assert.equal(result.body.data.formal_parameters.observed_value,
            "No authoritative RBA parameter configuration is available.");
        assert.ok(calls.every(({ sql }) => !/^(?:UPDATE|INSERT|DELETE|ALTER|CREATE|DROP)/i.test(sql.trim())));
        assert.match(calls[1].sql, /rfa\.regulator_user_id = \$1/);
        assert.match(calls[2].sql, /rfa\.regulator_user_id = \$1/);
        assert.match(calls[3].sql, /f\.fund_status = 'ACTIVE'/);
        assert.doesNotMatch(JSON.stringify(result.body.data), /account_id|attempt_id|user_id|kyc_id/i);
    } finally {
        pool.query = originalQuery;
    }
});

test("regulator dashboard uses a read-only repeatable snapshot and returns assigned-scope summaries", async () => {
    const originalConnect = pool.connect;
    const statements = [];
    pool.connect = async () => ({
        async query(sql, values = []) {
            statements.push({ sql, values });
            if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" || sql === "COMMIT") {
                return { rows: [] };
            }
            if (sql.includes("AS assigned_fund_count")) {
                return { rows: [{ assigned_fund_count: 2, active_assigned_fund_count: 1 }] };
            }
            if (sql.includes("AS total_fund_count")) {
                return { rows: [{ total_fund_count: 2, active_fund_count: 1, inactive_fund_count: 1 }] };
            }
            if (sql.includes("AS account_count")) {
                return { rows: [{ account_count: 3, active_account_count: 2, worker_count: 3 }] };
            }
            if (sql.includes("AS workflow_awaiting_review_count")) {
                assert.match(sql, /rfa\.regulator_user_id = \$1/);
                return { rows: [{
                    workflow_total_count: 2,
                    workflow_draft_count: 1,
                    workflow_submitted_count: 1,
                    workflow_awaiting_review_count: 1,
                    workflow_incomplete_submission_count: 0,
                    workflow_approved_count: 0,
                    workflow_returned_count: 0,
                    workflow_rejected_count: 0,
                    synthetic_demo_total_count: 1,
                    synthetic_demo_draft_count: 1,
                    synthetic_demo_submitted_count: 0,
                    synthetic_demo_awaiting_review_count: 0,
                    synthetic_demo_incomplete_submission_count: 0,
                    synthetic_demo_approved_count: 0,
                    synthetic_demo_returned_count: 0,
                    synthetic_demo_rejected_count: 0,
                    legacy_history_count: 0,
                }] };
            }
            if (sql.startsWith("SELECT cr.report_id, cr.report_type")) {
                return { rows: [{
                    report_id: "assigned-report",
                    report_type: "RBA",
                    report_category: "GENERAL_COMPLIANCE",
                    is_synthetic_demo: false,
                    submitted_at: "2026-03-01T00:00:00Z",
                    rba_status: "SUBMITTED",
                }] };
            }
            if (sql.startsWith("SELECT al.log_id, cr.report_type")) {
                return { rows: [{
                    log_id: "report-event",
                    report_type: "RBA",
                    report_category: "GENERAL_COMPLIANCE",
                    is_synthetic_demo: false,
                    rba_status: "SUBMITTED",
                    action_type: "SUBMIT",
                    timestamp: "2026-03-01T00:00:00Z",
                }] };
            }
            if (sql.includes("AS events_last_24h")) {
                return { rows: [{ events_last_24h: 2, last_event_at: "2026-03-01T00:00:00Z" }] };
            }
            if (sql.startsWith("SELECT k.kyc_status, count(*)")) {
                return { rows: [{ kyc_status: "VERIFIED", count: 2 }] };
            }
            if (sql.startsWith("SELECT al.log_id, al.action_type")) {
                return { rows: [{
                    log_id: "kyc-event",
                    action_type: "APPROVE",
                    kyc_status: "VERIFIED",
                    reviewer_role: "ADMIN",
                    timestamp: "2026-03-01T00:00:00Z",
                }] };
            }
            if (sql.includes("FROM pension_ledger WHERE singleton_key IS TRUE")) {
                return { rows: [{ status: "ACTIVE" }] };
            }
            if (sql.startsWith("SELECT f.fund_status, count(*)")) {
                return { rows: [{ fund_status: "ACTIVE", fund_count: 1 }] };
            }
            if (sql.includes("AS evaluated_accounts")) {
                return { rows: [{ evaluated_accounts: 1, valid_accounts: 1, invalid_accounts: 0 }] };
            }
            if (sql.includes("AS evaluated_count")) {
                return { rows: [{ evaluated_count: 1, unresolved_count: 0 }] };
            }
            if (sql.includes("AS submitted_count")) {
                return { rows: [{ submitted_count: 1, incomplete_submissions: 0 }] };
            }
            if (sql === "ROLLBACK") return { rows: [] };
            throw new Error(`Unexpected dashboard query: ${sql}`);
        },
        release() {},
    });

    try {
        const result = response();
        await regulator.getDashboardOverview({ user: { userId: "regulator-1" } }, result);

        assert.equal(result.statusCode, 200);
        assert.equal(result.body.data.scope.has_active_fund_scope, true);
        assert.equal(result.body.data.fund_overview.active_fund_count, 1);
        assert.equal(result.body.data.account_overview.worker_count, 3);
        assert.equal(result.body.data.awaiting_review.count, 1);
        assert.equal(result.body.data.report_summary.workflow.draft_count, 1);
        assert.equal(result.body.data.report_summary.workflow.awaiting_review_count, 1);
        assert.equal(result.body.data.report_summary.synthetic_demo.draft_count, 1);
        assert.equal(result.body.data.awaiting_review.synthetic_demo_count, 0);
        assert.equal(result.body.data.kyc.status_counts[0].count, 2);
        assert.equal(result.body.data.control_checks.checks.find(({ key }) => key === "ledger_readiness").status, "PASS");
        assert.equal(statements[0].sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        assert.equal(statements.at(-1).sql, "COMMIT");
        assert.ok(statements.every(({ values }) => values.length === 0 || values[0] === "regulator-1"));
        assert.ok(statements.every(({ sql }) => !/^(?:UPDATE|INSERT|DELETE|ALTER|CREATE|DROP)/i.test(sql.trim())));
        assert.ok(statements.some(({ sql }) => sql.includes("rfa.regulator_user_id = $1")));
    } finally {
        pool.connect = originalConnect;
    }
});

test("regulator fund details and allocations are limited to active assignments", async () => {
    const originalQuery = pool.query;
    const assignments = [{ regulator_user_id: "regulator-1", fund_id: "fund-1", active: true }];
    const fund = {
        fund_id: "fund-1",
        managed_by: "manager-1",
        fund_name: "Assigned Growth",
        administrator_name: "Admin",
        risk_level: "LOW",
        expected_return: "5.00",
        fund_status: "ACTIVE",
    };
    const allocation = {
        distribution_key: "67.50|2026-01-01|ongoing",
        percentage: "100.00",
        effective_from: "2026-01-01",
        effective_to: null,
        allocation_count: 2,
    };
    const calls = [];
    pool.query = async (sql, values = []) => {
        calls.push({ sql, values });
        const [fundId] = values;
        const regulatorAllocationsQuery = sql.includes("rfa.regulator_user_id = $2");
        const role = regulatorAllocationsQuery ? "REGULATOR" : values[1];
        const userId = regulatorAllocationsQuery ? values[1] : values[2];
        const isAssigned = assignments.some((assignment) =>
            assignment.regulator_user_id === userId && assignment.fund_id === fundId && assignment.active
        );
        if (sql.includes("LEFT JOIN LATERAL")) {
            if (fundId !== fund.fund_id || (role === "REGULATOR" && !isAssigned)) return { rows: [] };
            return { rows: [{ managed_by: fund.managed_by, ...allocation }] };
        }
        if (sql.startsWith("SELECT f.fund_id")) {
            return fundId === fund.fund_id && (role !== "REGULATOR" || isAssigned)
                ? { rows: [fund] }
                : { rows: [] };
        }
        throw new Error(`Unexpected fund scope query: ${sql}`);
    };

    try {
        const assignedFund = response();
        await fundController.getFund({
            user: { userId: "regulator-1", role: "REGULATOR" },
            params: { fundId: "fund-1" },
        }, assignedFund);
        assert.equal(assignedFund.statusCode, 200);
        assert.equal(assignedFund.body.data.fund.fund_id, "fund-1");
        assert.match(calls[0].sql, /rfa\.active = TRUE/);
        assert.deepEqual(calls[0].values, ["fund-1", "REGULATOR", "regulator-1"]);

        calls.length = 0;
        const assignedAllocations = response();
        await fundController.getFundAllocations({
            user: { userId: "regulator-1", role: "REGULATOR" },
            params: { fundId: "fund-1" },
        }, assignedAllocations);
        assert.equal(assignedAllocations.statusCode, 200);
        assert.deepEqual(assignedAllocations.body.data, [allocation]);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].values, ["fund-1", "regulator-1"]);
        assert.match(calls[0].sql, /rfa\.active = TRUE/);
        assert.doesNotMatch(JSON.stringify(assignedAllocations.body.data), /account_id|allocation_id/);

        for (const [userId, fundId] of [["regulator-2", "fund-1"], ["regulator-1", "fund-2"]]) {
            const deniedFund = response();
            await fundController.getFund({
                user: { userId, role: "REGULATOR" },
                params: { fundId },
            }, deniedFund);
            assert.equal(deniedFund.statusCode, 404);
            assert.equal(deniedFund.body.message, "Fund not found");

            const deniedAllocations = response();
            await fundController.getFundAllocations({
                user: { userId, role: "REGULATOR" },
                params: { fundId },
            }, deniedAllocations);
            assert.equal(deniedAllocations.statusCode, 404);
            assert.equal(deniedAllocations.body.message, "Fund not found");
        }

        assignments[0].active = false;
        const inactiveFund = response();
        await fundController.getFund({
            user: { userId: "regulator-1", role: "REGULATOR" },
            params: { fundId: "fund-1" },
        }, inactiveFund);
        assert.equal(inactiveFund.statusCode, 404);
        const inactiveAllocations = response();
        await fundController.getFundAllocations({
            user: { userId: "regulator-1", role: "REGULATOR" },
            params: { fundId: "fund-1" },
        }, inactiveAllocations);
        assert.equal(inactiveAllocations.statusCode, 404);
    } finally {
        pool.query = originalQuery;
    }
});

test("fund manager access remains unchanged, and regulator fund listing still returns scoped results", async () => {
    const originalQuery = pool.query;
    const calls = [];
    pool.query = async (sql, values = []) => {
        calls.push({ sql, values });
        if (sql.startsWith("SELECT f.fund_id")) return { rows: [{
            fund_id: "fund-1",
            managed_by: "manager-1",
            fund_name: "Assigned Growth",
        }] };
        if (sql.includes("LEFT JOIN LATERAL")) {
            const [, role, userId] = values;
            const isManager = role === "FUND_MANAGER";
            return { rows: [{
                managed_by: "manager-1",
                allocation_id: isManager && userId !== "manager-1" ? null : "allocation-1",
                account_id: isManager && userId !== "manager-1" ? null : "account-1",
                fund_id: isManager && userId !== "manager-1" ? null : "fund-1",
                percentage: isManager && userId !== "manager-1" ? null : "100.00",
                effective_from: isManager && userId !== "manager-1" ? null : "2026-01-01",
                effective_to: null,
            }] };
        }
        if (sql.includes("FROM regulator_fund_assignments")) return { rows: [{
            fund_id: "fund-1",
            managed_by: "manager-1",
        }] };
        throw new Error(`Unexpected fund scope query: ${sql}`);
    };

    try {
        const managerFund = response();
        await fundController.getFund({
            user: { userId: "manager-1", role: "FUND_MANAGER" },
            params: { fundId: "fund-1" },
        }, managerFund);
        assert.equal(managerFund.statusCode, 200);

        const managerAllocations = response();
        await fundController.getFundAllocations({
            user: { userId: "manager-1", role: "FUND_MANAGER" },
            params: { fundId: "fund-1" },
        }, managerAllocations);
        assert.equal(managerAllocations.statusCode, 200);
        assert.equal(managerAllocations.body.data.length, 1);
        assert.match(calls.find(({ sql }) => sql.includes("LEFT JOIN LATERAL")).sql, /f\.managed_by = \$3/);

        const otherManagerFund = response();
        await fundController.getFund({
            user: { userId: "manager-2", role: "FUND_MANAGER" },
            params: { fundId: "fund-1" },
        }, otherManagerFund);
        assert.equal(otherManagerFund.statusCode, 403);

        const otherManagerAllocations = response();
        await fundController.getFundAllocations({
            user: { userId: "manager-2", role: "FUND_MANAGER" },
            params: { fundId: "fund-1" },
        }, otherManagerAllocations);
        assert.equal(otherManagerAllocations.statusCode, 403);

        const regulatorFunds = response();
        await fundController.listFunds({
            user: { userId: "regulator-1", role: "REGULATOR" },
        }, regulatorFunds);
        assert.equal(regulatorFunds.statusCode, 200);
        assert.equal(regulatorFunds.body.data[0].fund_id, "fund-1");
        assert.equal(calls.at(-1).values[0], "regulator-1");
        assert.match(calls.at(-1).sql, /rfa\.active = TRUE/);
    } finally {
        pool.query = originalQuery;
    }
});
