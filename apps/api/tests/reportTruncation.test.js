const { test } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const ExcelJS = require("exceljs");
const { createReportController } = require("../src/controllers/reportController");
const { createReportService } = require("../src/services/reportService");

const REPORT_ID = "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5";

function createReportPool(rows) {
    const calls = [];
    return {
        calls,
        pool: {
            async query(sql, params = []) {
                calls.push([sql, params]);
                if (sql.includes("WITH report_data AS")) return { rows };
                if (sql.includes("INSERT INTO report_generation_history")) {
                    return { rows: [{ report_id: REPORT_ID, generated_at: "2026-11-05T00:00:00Z" }] };
                }
                if (sql.includes("INSERT INTO report_download_events")) return { rows: [] };
                throw new Error(`Unexpected report SQL: ${sql}`);
            },
        },
    };
}

test("report generation exports exactly 5,000 rows and reports an exact count at the limit", async () => {
    const sourceRows = Array.from({ length: 5000 }, (_, index) => ({ row_id: index + 1 }));
    const { pool, calls } = createReportPool(sourceRows);
    const report = await createReportService(pool).generate({
        userId: "admin-1",
        role: "ADMIN",
        reportKey: "users",
        filters: {},
        format: "CSV",
    });

    assert.equal(report.rows, 5000);
    assert.equal(report.totalCount, 5000);
    assert.equal(report.truncated, false);
    assert.match(calls.find(([sql]) => sql.includes("WITH report_data AS"))[0], /LIMIT 5001/);
    const csv = report.buffer.toString("utf8");
    assert.ok(csv.includes('"Applied filters","{}"'));
    assert.ok(csv.includes('"Exported rows","5000"'));
    assert.equal(csv.split("\r\n").length, 5009);
});

test("report generation detects more than 5,000 rows and caps the exported file", async () => {
    const sourceRows = Array.from({ length: 5001 }, (_, index) => ({ row_id: index + 1 }));
    const { pool, calls } = createReportPool(sourceRows);
    const report = await createReportService(pool).generate({
        userId: "admin-1",
        role: "ADMIN",
        reportKey: "users",
        filters: {},
        format: "CSV",
    });
    const content = report.buffer.toString("utf8");

    assert.equal(report.rows, 5000);
    assert.equal(report.totalCount, 5001);
    assert.equal(report.truncated, true);
    assert.match(calls.find(([sql]) => sql.includes("WITH report_data AS"))[0], /LIMIT 5001/);
    assert.ok(content.includes('"Truncated","Yes"'));
    assert.equal(content.split("\r\n").length, 5009);
    assert.ok(content.includes('"5000"'));
    assert.match(content, /"At least 5001"/);
    assert.ok(!content.includes('"row_id","5001"'));
});

test("Kiswahili export metadata preserves truncation counts and scope labels", async () => {
    const report = await createReportService(createReportPool(
        Array.from({ length: 5001 }, (_, index) => ({ row_id: index + 1 }))
    ).pool).generate({
        userId: "admin-1",
        role: "ADMIN",
        reportKey: "users",
        filters: {},
        format: "CSV",
        language: "sw",
    });
    const content = report.buffer.toString("utf8");

    assert.ok(content.includes('"Imetengenezwa (UTC)"'));
    assert.ok(content.includes('"Vichujio vilivyotumika"'));
    assert.ok(content.includes('"Eneo la hazina lililoidhinishwa","Hazina zote"'));
    assert.ok(content.includes('"Rekodi zilizotolewa","5000"'));
    assert.ok(content.includes('"Angalau 5001"'));
    assert.ok(content.includes('"Imepunguzwa","Ndiyo"'));
});

test("report generation rejects unsupported export languages before querying data", async () => {
    const { pool, calls } = createReportPool([]);
    await assert.rejects(() => createReportService(pool).generate({
        userId: "admin-1",
        role: "ADMIN",
        reportKey: "users",
        filters: {},
        format: "CSV",
        language: "fr",
    }), { code: "REPORT_INVALID_LANGUAGE", statusCode: 400 });
    assert.equal(calls.length, 0);
});

test("XLSX and PDF reports include applied filters, generation time, scope, and row-count metadata", async () => {
    const filters = { start_date: "2026-10-01", status: "ACTIVE" };
    const xlsx = await createReportService(createReportPool([{ row_id: 7 }]).pool).generate({
        userId: "admin-1",
        role: "ADMIN",
        reportKey: "users",
        filters,
        format: "XLSX",
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx.buffer);
    const sheet = workbook.getWorksheet("users");
    assert.equal(sheet.getCell("A1").value, "MicoPesa report: users");
    assert.equal(sheet.getCell("A2").value, "Generated at (UTC)");
    assert.match(sheet.getCell("B2").value, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(sheet.getCell("A3").value, "Applied filters");
    assert.equal(sheet.getCell("B3").value, JSON.stringify(filters));
    assert.equal(sheet.getCell("A4").value, "Authorized fund scope");
    assert.equal(sheet.getCell("B4").value, "All funds");
    assert.equal(sheet.getCell("A5").value, "Exported rows");
    assert.equal(sheet.getCell("B5").value, 1);
    assert.equal(sheet.getCell("A6").value, "Matching rows");

    const pdf = await createReportService(createReportPool([{ row_id: 7 }]).pool).generate({
        userId: "admin-1",
        role: "ADMIN",
        reportKey: "users",
        filters,
        format: "PDF",
    });
    const rawPdf = pdf.buffer.toString("latin1");
    const textStreams = [...rawPdf.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
        .map(([, stream]) => {
            try {
                return zlib.inflateSync(Buffer.from(stream, "latin1")).toString("latin1");
            } catch {
                return stream;
            }
        })
        .join("\n");
    const decodedPdfText = textStreams.replace(/<([0-9a-f]+)>/gi, (_, hex) =>
        Buffer.from(hex, "hex").toString("latin1")
    );
    const readablePdfText = decodedPdfText.replace(/\[([^\]]*)\] TJ/g, (_, text) =>
        text.replace(/\s+-?\d+(?:\.\d+)?\s+/g, "")
    );
    assert.ok(rawPdf.startsWith("%PDF"));
    assert.match(readablePdfText, /MicoPesa report:.*users/);
    assert.match(readablePdfText, /Generated at \(UTC\)/);
    assert.match(readablePdfText, /Applied filters/);
    assert.match(readablePdfText, /Authorized fund scope/);
    assert.match(readablePdfText, /Exported rows/);
    assert.match(readablePdfText, /Matching rows/);
});

test("report download responses expose truncation and lower-bound count headers", async () => {
    const report = {
        buffer: Buffer.from("report"),
        contentType: "text/csv; charset=utf-8",
        extension: "csv",
        reportId: REPORT_ID,
        rows: 5000,
        truncated: true,
        totalCount: 5001,
    };
    let generationInput;
    const controller = createReportController({
        service: {
            async generate(input) {
                generationInput = input;
                return report;
            },
        },
    });
    const headers = {};
    const response = {
        setHeader(name, value) { headers[name] = value; },
        status(statusCode) { this.statusCode = statusCode; return this; },
        send(buffer) { this.buffer = buffer; return this; },
    };

    await controller.generate({
        user: { userId: "admin-1", role: "ADMIN" },
        body: { report_key: "users", filters: {}, format: "CSV", language: "sw" },
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(generationInput.language, "sw");
    assert.equal(headers["X-Report-Truncated"], "true");
    assert.equal(headers["X-Report-Row-Count"], "5000");
    assert.equal(headers["X-Report-Total-Count"], "5001");
    assert.equal(headers["X-Report-Total-Count-Is-Lower-Bound"], "true");
});

test("history re-downloads recalculate and report truncation using the same capped export", async () => {
    const calls = [];
    const pool = {
        async query(sql) {
            calls.push(sql);
            if (sql.includes("FROM report_generation_history WHERE")) {
                return {
                    rows: [{
                        report_id: REPORT_ID,
                        generated_by: "admin-1",
                        generator_role: "ADMIN",
                        report_key: "users",
                        export_format: "CSV",
                        applied_filters: {},
                        scope_fund_ids: [],
                    }],
                };
            }
            if (sql.includes("WITH report_data AS")) {
                return { rows: Array.from({ length: 5001 }, (_, index) => ({ row_id: index + 1 })) };
            }
            if (sql.includes("INSERT INTO report_download_events")) return { rows: [] };
            throw new Error(`Unexpected report SQL: ${sql}`);
        },
    };

    const report = await createReportService(pool).download({
        userId: "admin-1",
        role: "ADMIN",
        reportId: REPORT_ID,
        language: "sw",
    });

    assert.equal(report.rows, 5000);
    assert.equal(report.totalCount, 5001);
    assert.equal(report.truncated, true);
    const content = report.buffer.toString("utf8");
    assert.equal(content.split("\r\n").length, 5009);
    assert.ok(content.includes('"Angalau 5001"'));
    assert.equal(calls.filter((sql) => sql.includes("INSERT INTO report_download_events")).length, 1);
});
