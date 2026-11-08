const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createReportService } = require("../src/services/reportService");

const REPORT_ID = "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5";

function historyRow(overrides = {}) {
    return {
        report_id: REPORT_ID,
        generated_by: "regulator-1",
        generated_by_name: "Regulator One",
        generator_role: "REGULATOR",
        report_key: "fund-performance",
        export_format: "CSV",
        applied_filters: {},
        scope_fund_ids: ["fund-1"],
        generation_status: "SUCCEEDED",
        result_count: 3,
        generated_at: "2026-11-04T00:00:00Z",
        download_count: 0,
        ...overrides,
    };
}

function createHistoryService({ fundIds = ["fund-1"], rows = [] } = {}) {
    const calls = [];
    return {
        calls,
        service: createReportService({
            async query(sql, params = []) {
                calls.push({ sql, params });
                if (sql.includes("FROM regulator_fund_assignments")) {
                    return { rows: fundIds.map((fund_id) => ({ fund_id })) };
                }
                if (sql.includes("FROM report_generation_history h")) {
                    return params.length === 2
                        ? { rows: rows.filter((row) =>
                            row.generated_by === params[0] && row.generator_role === params[1]) }
                        : { rows };
                }
                throw new Error(`Unexpected report SQL: ${sql}`);
            },
        }),
    };
}

function createDownloadService({ currentFundIds, history }) {
    const calls = [];
    const service = createReportService({
        async query(sql, params = []) {
            calls.push({ sql, params });
            if (sql.includes("FROM report_generation_history WHERE")) return { rows: [history] };
            if (sql.includes("FROM regulator_fund_assignments") ||
                sql.includes("FROM funds WHERE managed_by")) {
                return { rows: currentFundIds.map((fund_id) => ({ fund_id })) };
            }
            if (sql.includes("WITH report_data AS")) return { rows: [] };
            if (sql.includes("INSERT INTO report_download_events")) return { rows: [] };
            throw new Error(`Unexpected report SQL: ${sql}`);
        },
    });
    return { calls, service };
}

test("regulator report history retains active scopes and explicit empty results, but excludes revoked and malformed scopes", async () => {
    const rows = [
        historyRow(),
        historyRow({ report_id: "revoked", scope_fund_ids: ["fund-2"], result_count: 5 }),
        historyRow({ report_id: "mixed", scope_fund_ids: ["fund-1", "fund-2"], result_count: 5 }),
        historyRow({ report_id: "empty", scope_fund_ids: [], result_count: 0 }),
        historyRow({ report_id: "invalid-empty", scope_fund_ids: [], result_count: 2 }),
        historyRow({ report_id: "missing", scope_fund_ids: undefined }),
        historyRow({ report_id: "malformed", scope_fund_ids: { fund_id: "fund-1" } }),
        historyRow({ report_id: "foreign-filter", applied_filters: { fund_id: "fund-2" } }),
        historyRow({ report_id: "foreign-owner", generated_by: "regulator-2" }),
    ];
    const { calls, service } = createHistoryService({ rows });

    const result = await service.listHistory({ userId: "regulator-1", role: "REGULATOR" });

    assert.deepEqual(result.map((entry) => entry.report_id), [REPORT_ID, "empty"]);
    assert.deepEqual(calls[0].params, ["regulator-1"]);
    assert.match(calls[1].sql, /h\.generated_by = \$1 AND h\.generator_role = \$2/);
});

test("admin report history preserves intentionally unscoped history", async () => {
    const globalEntry = historyRow({
        generated_by: "admin-1",
        generator_role: "ADMIN",
        scope_fund_ids: [],
        result_count: 17,
    });
    const { calls, service } = createHistoryService({ rows: [globalEntry] });

    const result = await service.listHistory({ userId: "admin-1", role: "ADMIN" });

    assert.deepEqual(result, [globalEntry]);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0].sql, /WHERE h\.generated_by =/);
});

test("regulator downloads only reports owned by them and within their current active fund scope", async (t) => {
    const baseHistory = {
        report_id: REPORT_ID,
        generated_by: "regulator-1",
        generator_role: "REGULATOR",
        report_key: "fund-performance",
        export_format: "CSV",
        applied_filters: {},
        scope_fund_ids: ["fund-1"],
    };

    const active = createDownloadService({
        currentFundIds: ["fund-1"],
        history: baseHistory,
    });
    const downloaded = await active.service.download({
        userId: "regulator-1",
        role: "REGULATOR",
        reportId: REPORT_ID,
    });
    assert.equal(downloaded.reportId, REPORT_ID);
    assert.ok(active.calls.some(({ sql }) => sql.includes("WITH report_data AS")));

    const deniedCases = [
        ["another user's report", ["fund-1"], { ...baseHistory, generated_by: "regulator-2" }],
        ["an unassigned fund", ["fund-2"], baseHistory],
        ["a revoked assignment", [], baseHistory],
        ["an inactive assignment", [], baseHistory],
    ];
    for (const [label, currentFundIds, history] of deniedCases) {
        await t.test(label, async () => {
            const attempt = createDownloadService({ currentFundIds, history });
            await assert.rejects(() => attempt.service.download({
                userId: "regulator-1",
                role: "REGULATOR",
                reportId: REPORT_ID,
            }), { code: "REPORT_FORBIDDEN", statusCode: 403 });
            assert.equal(
                attempt.calls.some(({ sql }) => sql.includes("WITH report_data AS")),
                false,
                "denied download must not query or regenerate report contents"
            );
        });
    }
});

test("Admin and Fund Manager retain their existing report download permissions", async (t) => {
    const cases = [
        {
            role: "ADMIN",
            userId: "admin-1",
            currentFundIds: [],
            history: {
                report_id: REPORT_ID,
                generated_by: "regulator-1",
                generator_role: "REGULATOR",
                report_key: "fund-performance",
                export_format: "CSV",
                applied_filters: {},
                scope_fund_ids: ["fund-1"],
            },
        },
        {
            role: "FUND_MANAGER",
            userId: "manager-1",
            currentFundIds: ["fund-1"],
            history: {
                report_id: REPORT_ID,
                generated_by: "manager-1",
                generator_role: "FUND_MANAGER",
                report_key: "fund-performance",
                export_format: "CSV",
                applied_filters: {},
                scope_fund_ids: ["fund-1"],
            },
        },
    ];
    for (const input of cases) {
        await t.test(`${input.role} authorized download`, async () => {
            const { calls, service } = createDownloadService(input);
            const result = await service.download({
                userId: input.userId,
                role: input.role,
                reportId: REPORT_ID,
            });
            assert.equal(result.reportId, REPORT_ID);
            assert.ok(calls.some(({ sql }) => sql.includes("WITH report_data AS")));
        });
    }
});
