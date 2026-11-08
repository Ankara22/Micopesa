const { test } = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const { createWorkerStatementController } = require("../src/controllers/workerStatementController");
const { createWorkerStatementService } = require("../src/services/workerStatementService");

const WORKER_ID = "worker-own";
const OTHER_WORKER_ID = "worker-other";
const STATEMENT_ROWS = [
    {
        account_id: "account-own",
        current_balance: "125.50",
        account_status: "ACTIVE",
        contribution_id: "contribution-own",
        contribution_date: "2026-10-12T10:00:00.000Z",
        amount: "25.50",
        contribution_status: "COMPLETED",
        channel: "MPESA",
        payment_status: "COMPLETED",
    },
];

function createMockApi({
    rows = STATEMENT_ROWS,
    queryError,
    account = { account_id: "account-own", current_balance: "125.50", account_status: "ACTIVE" },
} = {}) {
    const calls = [];
    const pool = {
        async query(sql, params = []) {
            calls.push([sql, params]);
            if (sql.includes("INSERT INTO audit_logs")) return { rows: [] };
            if (queryError) throw queryError;
            if (sql.includes("FROM users u")) {
                return { rows: [account] };
            }
            if (sql.includes("FROM contributions c")) return { rows };
            throw new Error(`Unexpected statement SQL: ${sql}`);
        },
    };
    const service = createWorkerStatementService(pool);
    const controller = createWorkerStatementController({ service });
    const response = {
        statusCode: null,
        headers: {},
        body: null,
        setHeader(key, value) { this.headers[key] = value; return this; },
        status(code) { this.statusCode = code; return this; },
        send(body) { this.body = body; return this; },
        json(body) { this.body = body; return this; },
    };
    return { calls, controller, response };
}

for (const [format, extension, signature] of [
    ["CSV", "csv", Buffer.from([0xef, 0xbb, 0xbf])],
    ["XLSX", "xlsx", Buffer.from("PK")],
    ["PDF", "pdf", Buffer.from("%PDF")],
]) {
    test(`personal statement API downloads ${format} for only the authenticated worker`, async () => {
        const { calls, controller, response } = createMockApi();
        await controller.download({
            user: { userId: WORKER_ID, role: "WORKER" },
            query: {
                format,
                userId: OTHER_WORKER_ID,
                start_date: "2026-10-01",
                end_date: "2026-10-31",
                contribution_status: "COMPLETED",
            },
        }, response);

        assert.equal(response.statusCode, 200);
        assert.equal(response.headers["Cache-Control"], "private, no-store");
        assert.match(response.headers["Content-Disposition"], new RegExp(`\\.${extension}"$`));
        assert.equal(response.headers["X-Statement-Row-Count"], "1");
        assert.equal(response.headers["X-Statement-Total-Count"], "1");
        assert.equal(response.headers["X-Statement-Truncated"], "false");
        const dataQuery = calls.find(([sql]) => sql.includes("FROM users u"));
        assert.ok(dataQuery);
        assert.match(dataQuery[0], /WHERE u\.user_id = \$1 AND u\.role = 'WORKER'/);
        assert.equal(dataQuery[1][0], WORKER_ID);
        assert.notEqual(dataQuery[1][0], OTHER_WORKER_ID);
        assert.deepEqual(response.body.subarray(0, signature.length), signature);
        const contributionsQuery = calls.find(([sql]) => sql.includes("FROM contributions c"));
        assert.match(contributionsQuery[0], /FROM pension_account_movements m/);
        assert.match(contributionsQuery[0], /NOT EXISTS/);
        assert.match(contributionsQuery[0], /latest_attempt\.provider_mode/);
        assert.doesNotMatch(contributionsQuery[0], /checkout_request_id LIKE 'SIM%'/);
        assert.deepEqual(contributionsQuery[1], [
            "account-own",
            "2026-10-01",
            "2026-10-31",
            "COMPLETED",
            5001,
        ]);
        if (format === "CSV") {
            const csv = response.body.toString("utf8");
            assert.match(csv, /"Current balance \(KES\)","125\.50"/);
            assert.match(csv, /2026-10-12T10:00:00\.000Z/);
            assert.match(csv, /COMPLETED/);
        } else if (format === "XLSX") {
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(response.body);
            const sheet = workbook.getWorksheet("my-financial-statement");
            assert.equal(sheet.getCell("A1").value, "MicoPesa personal financial statement");
            assert.equal(sheet.getCell("B3").value, "125.50");
            assert.equal(sheet.getCell("B3").value, "125.50");
            assert.match(sheet.getCell("B4").value, /already included in the opening balance/);
            assert.equal(sheet.getCell("A14").value, "record_type");
            assert.equal(sheet.getCell("F15").value, "25.50");
        }

        const audit = calls.find(([sql]) => sql.includes("INSERT INTO audit_logs"));
        assert.ok(audit);
        assert.equal(audit[1][0], WORKER_ID);
        assert.equal(JSON.parse(audit[1][1]).format, format);
        assert.equal(JSON.parse(audit[1][1]).result_count, 1);
        assert.deepEqual(JSON.parse(audit[1][1]).filters, {
            start_date: "2026-10-01",
            end_date: "2026-10-31",
            contribution_status: "COMPLETED",
        });
    });
}

test("empty personal statement keeps headers and reports the current balance", async () => {
    const { controller, response } = createMockApi({
        account: { account_id: "account-own", current_balance: "0.00", account_status: "ACTIVE" },
        rows: [{
            account_id: "account-own",
            current_balance: "0.00",
            account_status: "ACTIVE",
            contribution_id: null,
            contribution_date: null,
            amount: null,
            contribution_status: null,
            channel: null,
            payment_status: null,
        }],
    });
    await controller.download({
        user: { userId: WORKER_ID, role: "WORKER" },
        query: { format: "CSV" },
    }, response);

    assert.equal(response.statusCode, 200);
    const csv = response.body.toString("utf8");
    assert.match(csv, /"Current balance \(KES\)","0\.00"/);
    assert.match(csv, /"record_type","record_source","payment_provider","transaction_reference"/);
    assert.match(csv, /"SIMULATED entries are demonstrations; no real money was transferred\."/);
    assert.equal(response.headers["X-Statement-Row-Count"], "0");
});

test("statement marks ledger-backed simulator entries and explains no money moved", async () => {
    const { controller, response } = createMockApi({
        rows: [{
            record_type: "CONTRIBUTION_SETTLEMENT",
            record_source: "LEDGER",
            payment_provider: "SIMULATED",
            transaction_reference: "SIM0123456789ABCDEF012345",
            contribution_date: "2026-10-12T10:00:00.000Z",
            amount: "25.50",
            contribution_status: "COMPLETED",
            payment_status: "COMPLETED",
            channel: "SIMULATED",
        }],
    });
    await controller.download({
        user: { userId: WORKER_ID, role: "WORKER" },
        query: { format: "CSV" },
    }, response);

    const csv = response.body.toString("utf8");
    assert.match(csv, /SIMULATED/);
    assert.match(csv, /SIM0123456789ABCDEF012345/);
    assert.match(csv, /no real money was transferred/);
});

test("statement filters are validated and over-limit results are explicitly truncated", async () => {
    const tooManyRows = Array.from({ length: 5001 }, (_, index) => ({
        ...STATEMENT_ROWS[0],
        contribution_id: `contribution-${index}`,
    }));
    const { calls, controller, response } = createMockApi({ rows: tooManyRows });
    await controller.download({
        user: { userId: WORKER_ID, role: "WORKER" },
        query: { format: "CSV", start_date: "2026-10-01", contribution_status: "PENDING" },
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["X-Statement-Row-Count"], "5000");
    assert.equal(response.headers["X-Statement-Total-Count"], "5001");
    assert.equal(response.headers["X-Statement-Truncated"], "true");
    assert.match(response.body.toString("utf8"), /"Truncated","Yes"/);
    assert.equal(JSON.parse(calls.find(([sql]) => sql.includes("INSERT INTO audit_logs"))[1][1]).truncated, true);

    const invalid = createMockApi();
    await invalid.controller.download({
        user: { userId: WORKER_ID, role: "WORKER" },
        query: { format: "CSV", start_date: "2026-02-30" },
    }, invalid.response);
    assert.equal(invalid.response.statusCode, 400);
    assert.equal(invalid.response.body.code, "STATEMENT_INVALID_FILTERS");
});

test("personal statement API rejects unsupported formats, non-workers, and database failures", async () => {
    const invalid = createMockApi();
    await invalid.controller.download({
        user: { userId: WORKER_ID, role: "WORKER" },
        query: { format: "HTML" },
    }, invalid.response);
    assert.equal(invalid.response.statusCode, 400);
    assert.equal(invalid.response.body.code, "STATEMENT_INVALID_FORMAT");

    const unauthorized = createMockApi();
    await unauthorized.controller.download({
        user: { userId: WORKER_ID, role: "ADMIN" },
        query: { format: "CSV" },
    }, unauthorized.response);
    assert.equal(unauthorized.response.statusCode, 403);
    assert.equal(unauthorized.calls.length, 0);

    const failed = createMockApi({ queryError: new Error("database detail") });
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        await failed.controller.download({
            user: { userId: WORKER_ID, role: "WORKER" },
            query: { format: "PDF" },
        }, failed.response);
    } finally {
        console.error = originalConsoleError;
    }
    assert.equal(failed.response.statusCode, 500);
    assert.equal(failed.response.body.message, "Could not generate the statement.");
    assert.equal(failed.calls.filter(([sql]) => sql.includes("INSERT INTO audit_logs")).length, 1);
});
