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
                if (sql.includes("FROM report_generation_history")) {
                    if (sql.includes("SELECT count(*)::int AS total_count")) {
                        const matching = params.length === 3
                            ? rows.filter((row) =>
                                row.generated_by === params[0] &&
                                row.generator_role === params[1] &&
                                Array.isArray(row.scope_fund_ids) &&
                                row.scope_fund_ids.every((id) => fundIds.includes(id)) &&
                                (row.scope_fund_ids.length > 0 || row.result_count === 0) &&
                                row.applied_filters &&
                                (!Object.hasOwn(row.applied_filters, "fund_id") ||
                                    fundIds.includes(row.applied_filters.fund_id)))
                            : rows;
                        return { rows: [{ total_count: matching.length }] };
                    }
                    const matching = params.length === 5
                        ? rows.filter((row) =>
                            row.generated_by === params[0] &&
                            row.generator_role === params[1] &&
                            Array.isArray(row.scope_fund_ids) &&
                            row.scope_fund_ids.every((id) => fundIds.includes(id)) &&
                            (row.scope_fund_ids.length > 0 || row.result_count === 0) &&
                            row.applied_filters &&
                            (!Object.hasOwn(row.applied_filters, "fund_id") ||
                                fundIds.includes(row.applied_filters.fund_id)))
                        : rows;
                    const pageSize = params.length === 5 ? params[3] : params[0];
                    const offset = params.length === 5 ? params[4] : params[1];
                    return { rows: matching.slice(offset, offset + pageSize) };
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

    assert.deepEqual(result.records.map((entry) => entry.report_id), [REPORT_ID, "empty"]);
    assert.deepEqual(result.pagination, { page: 1, page_size: 50, total_count: 2, total_pages: 1 });
    assert.deepEqual(calls[0].params, ["regulator-1"]);
    assert.match(calls[2].sql, /h\.generated_by = \$1 AND h\.generator_role = \$2/);
    assert.match(calls[2].sql, /LIMIT \$4 OFFSET \$5/);
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

    assert.deepEqual(result.records, [globalEntry]);
    assert.deepEqual(result.pagination, { page: 1, page_size: 50, total_count: 1, total_pages: 1 });
    assert.equal(calls.length, 2);
    assert.doesNotMatch(calls[1].sql, /WHERE h\.generated_by =/);
});

test("report history applies bounded pagination and rejects invalid page values", async () => {
    const { calls, service } = createHistoryService({
        rows: [
            historyRow(),
            historyRow({ report_id: "report-2" }),
        ],
    });

    const result = await service.listHistory({
        userId: "regulator-1",
        role: "REGULATOR",
        page: "2",
        page_size: "1",
    });
    assert.deepEqual(result.records.map((entry) => entry.report_id), ["report-2"]);
    assert.deepEqual(result.pagination, { page: 2, page_size: 1, total_count: 2, total_pages: 2 });
    assert.deepEqual(calls[2].params.slice(-2), [1, 1]);
    await assert.rejects(
        () => service.listHistory({ userId: "regulator-1", role: "REGULATOR", page: "0" }),
        { code: "REPORT_INVALID_PAGINATION", statusCode: 400 }
    );
});

test("regulator report catalog exposes scoped KYC, payment reconciliation and audit summaries", async () => {
    const dataQueries = [];
    const service = createReportService({
        async query(sql, params = []) {
            if (sql.includes("FROM regulator_fund_assignments")) {
                return { rows: [{ fund_id: "fund-1" }] };
            }
            if (sql.includes("WITH report_data AS")) {
                dataQueries.push({ sql, params });
                return { rows: [] };
            }
            if (sql.includes("INSERT INTO report_generation_history")) {
                return { rows: [{ report_id: REPORT_ID, generated_at: "2026-11-04T00:00:00Z" }] };
            }
            if (sql.includes("INSERT INTO report_download_events")) return { rows: [] };
            throw new Error(`Unexpected report SQL: ${sql}`);
        },
    });

    const catalog = service.listCatalog("REGULATOR");
    const reportKeys = [
        "kyc-status-summary",
        "payment-reconciliation-summary",
        "regulatory-audit-activity",
    ];
    assert.ok(reportKeys.every((key) => catalog.includes(key)));
    for (const reportKey of reportKeys) {
        await service.generate({
            userId: "regulator-1",
            role: "REGULATOR",
            reportKey,
            filters: {},
            format: "CSV",
            language: "en",
        });
    }

    assert.equal(dataQueries.length, 3);
    for (const { sql, params } of dataQueries) {
        assert.deepEqual(params[6], ["fund-1"]);
        assert.match(sql, /\$7::text\[\] IS NULL OR fund_id::text = ANY\(\$7\)/);
    }
    assert.match(dataQueries[0].sql, /count\(DISTINCT k\.user_id\)::integer AS worker_count/);
    assert.match(dataQueries[1].sql, /count\(DISTINCT a\.attempt_id\)::integer AS attempt_count/);
    assert.match(dataQueries[1].sql, /'PENDING', 'OUTCOME_UNKNOWN', 'PROMPT_ACCEPTED'/);
    assert.match(dataQueries[2].sql, /al\.entity_name = 'COMPLIANCE_REPORTS'/);
    assert.match(dataQueries[2].sql, /cr\.is_legacy = TRUE OR cr\.rba_status <> 'DRAFT'/);
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
