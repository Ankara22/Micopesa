const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");

const REPORTS_BY_ROLE = {
    ADMIN: new Set([
        "users", "contributions", "mpesa-payments", "fund-performance",
        "notification-delivery", "administrative-activity", "compliance",
        "retirement-projections", "workers", "settled-contributions",
        "contribution-trends", "regulatory-notifications",
    ]),
    FUND_MANAGER: new Set([
        "workers", "contributions", "settled-contributions", "fund-performance",
        "retirement-projections", "notification-delivery", "compliance",
    ]),
    REGULATOR: new Set([
        "fund-performance", "contribution-trends", "regulatory-notifications", "compliance",
    ]),
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,25}$/;
const MAX_ROWS = 5000;
const EXPORT_COPY = {
    en: {
        reportTitle: (reportKey) => `MicoPesa report: ${reportKey}`,
        generatedAt: "Generated at (UTC)",
        appliedFilters: "Applied filters",
        authorizedFundScope: "Authorized fund scope",
        allFunds: "All funds",
        exportedRows: "Exported rows",
        matchingRows: "Matching rows",
        truncated: "Truncated",
        yes: "Yes",
        no: "No",
        atLeast: (count) => `At least ${count}`,
    },
    sw: {
        reportTitle: (reportKey) => `Ripoti ya MicoPesa: ${reportKey}`,
        generatedAt: "Imetengenezwa (UTC)",
        appliedFilters: "Vichujio vilivyotumika",
        authorizedFundScope: "Eneo la hazina lililoidhinishwa",
        allFunds: "Hazina zote",
        exportedRows: "Rekodi zilizotolewa",
        matchingRows: "Rekodi zinazolingana",
        truncated: "Imepunguzwa",
        yes: "Ndiyo",
        no: "Hapana",
        atLeast: (count) => `Angalau ${count}`,
    },
};

function validateExportLanguage(language) {
    if (language === undefined || language === null || language === "") return "en";
    if (!Object.hasOwn(EXPORT_COPY, language)) {
        throw serviceError("Export language must be English or Kiswahili.", "REPORT_INVALID_LANGUAGE", 400);
    }
    return language;
}

function serviceError(message, code, statusCode) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function validateFilters(filters) {
    if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
        throw serviceError("Report filters must be an object.", "REPORT_INVALID_FILTERS", 400);
    }
    const allowed = new Set([
        "start_date", "end_date", "fund_id", "user_id", "status",
        "channel", "delivery_status", "category", "transaction_status",
        "contribution_status",
    ]);
    if (Object.keys(filters).some((key) => !allowed.has(key))) {
        throw serviceError("One or more report filters are not supported.", "REPORT_INVALID_FILTERS", 400);
    }
    for (const key of ["start_date", "end_date"]) {
        const parsedDate = typeof filters[key] === "string"
            ? new Date(`${filters[key]}T00:00:00Z`)
            : null;
        if (filters[key] !== undefined &&
            (typeof filters[key] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(filters[key]) ||
             Number.isNaN(parsedDate?.getTime()) ||
             parsedDate.toISOString().slice(0, 10) !== filters[key])) {
            throw serviceError("Report dates must use YYYY-MM-DD.", "REPORT_INVALID_FILTERS", 400);
        }
    }
    if (filters.start_date && filters.end_date && filters.start_date > filters.end_date) {
        throw serviceError("The report start date must not be after its end date.", "REPORT_INVALID_FILTERS", 400);
    }
    if (filters.fund_id !== undefined &&
        (typeof filters.fund_id !== "string" || !USER_ID_PATTERN.test(filters.fund_id))) {
        throw serviceError("A valid fund filter is required.", "REPORT_INVALID_FILTERS", 400);
    }
    if (filters.user_id !== undefined &&
        (typeof filters.user_id !== "string" || !USER_ID_PATTERN.test(filters.user_id))) {
        throw serviceError("A valid user filter is required.", "REPORT_INVALID_FILTERS", 400);
    }
    for (const key of ["status", "channel", "delivery_status", "category"]) {
        if (filters[key] !== undefined &&
            (typeof filters[key] !== "string" || !/^[A-Z_]{1,40}$/.test(filters[key]))) {
            throw serviceError(`A valid ${key} filter is required.`, "REPORT_INVALID_FILTERS", 400);
        }
    }
    for (const key of ["transaction_status", "contribution_status"]) {
        if (filters[key] !== undefined &&
            (typeof filters[key] !== "string" || !/^[A-Z_]{1,40}$/.test(filters[key]))) {
            throw serviceError(`A valid ${key} filter is required.`, "REPORT_INVALID_FILTERS", 400);
        }
    }
}

function validateAnalyticsDates(filters) {
    if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
        throw serviceError("Analytics filters must be an object.", "REPORT_INVALID_FILTERS", 400);
    }
    if (Object.keys(filters).some((key) => !["start_date", "end_date"].includes(key))) {
        throw serviceError("Only start_date and end_date are supported.", "REPORT_INVALID_FILTERS", 400);
    }
    for (const key of ["start_date", "end_date"]) {
        const value = filters[key];
        const parsedDate = typeof value === "string" ? new Date(`${value}T00:00:00Z`) : null;
        if (value !== undefined &&
            (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
             Number.isNaN(parsedDate?.getTime()) ||
             parsedDate.toISOString().slice(0, 10) !== value)) {
            throw serviceError("Analytics dates must use YYYY-MM-DD.", "REPORT_INVALID_FILTERS", 400);
        }
    }
    if (filters.start_date && filters.end_date && filters.start_date > filters.end_date) {
        throw serviceError("The analytics start date must not be after its end date.", "REPORT_INVALID_FILTERS", 400);
    }
}

function csvSafe(value) {
    const shouldProtect = typeof value === "string";
    const text = value === null || value === undefined
        ? ""
        : typeof value === "object" ? JSON.stringify(value) : String(value);
    const safeText = shouldProtect && /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safeText.replace(/"/g, '""')}"`;
}

function csvBuffer(rows, configuredColumns) {
    if (!rows.length && !configuredColumns?.length) return Buffer.from("");
    const columns = configuredColumns || Object.keys(rows[0]);
    const lines = [
        columns.map(csvSafe).join(","),
        ...rows.map((row) => columns.map((column) => csvSafe(row[column])).join(",")),
    ];
    return Buffer.from(`\uFEFF${lines.join("\r\n")}`, "utf8");
}

async function xlsxBuffer(reportKey, rows, options = {}) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(reportKey.slice(0, 31));
    const columns = options.columns || (rows.length ? Object.keys(rows[0]) : []);
    let headerRow = 1;
    if (options.title) {
        sheet.getCell("A1").value = options.title;
        headerRow = 2;
        for (const [label, value] of options.summary || []) {
            sheet.addRow([label, value]);
            headerRow += 1;
        }
        if (columns.length) {
            sheet.addRow([]);
            headerRow += 1;
        }
    }
    if (columns.length) {
        sheet.getRow(headerRow).values = columns;
        columns.forEach((key, index) => {
            sheet.getColumn(index + 1).width = Math.min(Math.max(key.length + 4, 16), 40);
        });
        for (const row of rows) {
            sheet.addRow(columns.map((key) =>
                row[key] === null || row[key] === undefined || typeof row[key] !== "object"
                    ? row[key]
                    : JSON.stringify(row[key])
            ));
        }
        sheet.views = [{ state: "frozen", ySplit: headerRow }];
        sheet.autoFilter = {
            from: `A${headerRow}`,
            to: `${sheet.getColumn(columns.length).letter}${headerRow}`,
        };
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function pdfBuffer(reportKey, rows, options = {}) {
    return new Promise((resolve, reject) => {
        const document = new PDFDocument({ margin: 36, size: "A4", layout: "landscape" });
        const chunks = [];
        document.on("data", (chunk) => chunks.push(chunk));
        document.on("error", reject);
        document.on("end", () => resolve(Buffer.concat(chunks)));
        document.fontSize(16).text(options.title || `MicoPesa report: ${reportKey}`, { continued: false });
        document.moveDown(0.5).fontSize(8);
        for (const [label, value] of options.summary || []) {
            document.text(`${label}: ${value === null || value === undefined ? "" : value}`);
        }
        if (options.summary?.length) document.moveDown(0.5);
        if (!rows.length) {
            document.text("No records matched the selected filters.");
        } else {
            for (const row of rows) {
                const line = Object.entries(row)
                    .map(([key, value]) => `${key}: ${value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : value}`)
                    .join(" | ")
                    .replace(/[\u0000-\u001f\u007f]/g, " ");
                document.text(line.slice(0, 1500), { width: 760 });
                document.moveDown(0.2);
                if (document.y > 520) document.addPage();
            }
        }
        document.end();
    });
}

async function exportReport(reportKey, rows, format, options = {}) {
    if (format === "CSV") {
        let buffer = csvBuffer(rows, options.columns);
        if (options.title || options.summary?.length) {
            const metadata = [
                ...(options.title ? [csvSafe(options.title)] : []),
                ...(options.summary || []).map(([label, value]) => `${csvSafe(label)},${csvSafe(value)}`),
            ].join("\r\n");
            buffer = Buffer.concat([
                Buffer.from(`\uFEFF${metadata}\r\n\r\n`, "utf8"),
                buffer.length && buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
                    ? buffer.subarray(3)
                    : buffer,
            ]);
        }
        return { buffer, contentType: "text/csv; charset=utf-8", extension: "csv" };
    }
    if (format === "XLSX") {
        return {
            buffer: await xlsxBuffer(reportKey, rows, options),
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            extension: "xlsx",
        };
    }
    if (format === "PDF") {
        return {
            buffer: await pdfBuffer(reportKey, rows, options),
            contentType: "application/pdf",
            extension: "pdf",
        };
    }
    throw serviceError("Choose CSV, XLSX, or PDF.", "REPORT_INVALID_FORMAT", 400);
}

const REPORT_SQL = {
    users: `
        SELECT u.user_id, u.full_name, u.role, u.account_status AS status,
               u.created_at AS report_date, NULL::text AS fund_id,
               NULL::text AS channel, u.user_id AS filter_user_id,
               NULL::text AS category, NULL::text AS delivery_status
        FROM users u`,
    workers: `
        SELECT DISTINCT u.user_id, u.full_name, f.fund_id, f.fund_name,
               pa.account_status AS account_status, pa.current_balance,
               fa.effective_from AS report_date, 'ACTIVE'::text AS status,
               NULL::text AS channel, u.user_id AS filter_user_id,
               NULL::text AS category, NULL::text AS delivery_status
        FROM users u
        JOIN pension_accounts pa ON pa.user_id = u.user_id
        JOIN fund_allocations fa ON fa.account_id = pa.account_id
        JOIN funds f ON f.fund_id = fa.fund_id
        WHERE u.role = 'WORKER'
          AND fa.effective_from <= CURRENT_DATE
          AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)`,
    contributions: `
        SELECT c.contribution_id, u.user_id, u.full_name,
               COALESCE(cfa.allocated_amount, c.amount) AS amount,
               CASE WHEN attempt.provider_mode = 'SIMULATOR'
                    THEN 'SIMULATED' ELSE c.channel END AS channel,
               CASE attempt.provider_mode WHEN 'SIMULATOR' THEN 'SIMULATED'
                    WHEN 'DARAJA' THEN 'DARAJA' ELSE 'UNRESOLVED' END AS payment_provider,
               c.contribution_status AS status, c.contribution_status,
               c.created_at AS report_date,
               cfa.fund_id, cfa.fund_name, u.user_id AS filter_user_id,
               NULL::text AS category, NULL::text AS delivery_status
        FROM contributions c
        JOIN pension_accounts pa ON pa.account_id = c.account_id
        JOIN users u ON u.user_id = pa.user_id
        LEFT JOIN contribution_fund_allocations cfa
          ON cfa.contribution_id = c.contribution_id AND cfa.account_id = c.account_id
        LEFT JOIN LATERAL (
            SELECT a.provider_mode
            FROM mpesa_payment_attempts a
            WHERE a.transaction_id = c.transaction_id
            ORDER BY a.created_at DESC, a.attempt_id DESC
            LIMIT 1
        ) attempt ON TRUE`,
    "settled-contributions": `
        SELECT c.contribution_id, u.user_id, u.full_name,
               COALESCE(cfa.allocated_amount, m.amount, c.amount) AS amount,
               CASE WHEN m.provider_mode = 'SIMULATOR'
                    THEN 'SIMULATED' ELSE c.channel END AS channel,
               CASE m.provider_mode WHEN 'SIMULATOR' THEN 'SIMULATED'
                    WHEN 'DARAJA' THEN 'DARAJA'
                    WHEN m.movement_id IS NULL THEN 'UNRESOLVED_LEGACY'
                    ELSE 'UNRESOLVED' END AS payment_provider,
               c.contribution_status AS status, c.contribution_status,
               c.created_at AS report_date,
               cfa.fund_id, cfa.fund_name, u.user_id AS filter_user_id,
               NULL::text AS category, NULL::text AS delivery_status
        FROM contributions c
        JOIN transactions t ON t.transaction_id = c.transaction_id
        JOIN pension_accounts pa ON pa.account_id = c.account_id
        JOIN users u ON u.user_id = pa.user_id
        LEFT JOIN contribution_fund_allocations cfa
          ON cfa.contribution_id = c.contribution_id AND cfa.account_id = c.account_id
        LEFT JOIN pension_account_movements m
          ON m.contribution_id = c.contribution_id
         AND m.movement_type = 'CONTRIBUTION_SETTLEMENT'
        LEFT JOIN pension_ledger ledger ON ledger.singleton_key IS TRUE
        WHERE c.contribution_status = 'COMPLETED'
          AND t.transaction_status = 'COMPLETED'
          AND (m.movement_id IS NOT NULL
               OR ledger.activated_at IS NULL
               OR c.created_at < ledger.activated_at)`,
    "contribution-trends": `
        SELECT date_trunc('month', c.created_at)::date AS report_date,
               c.contribution_status AS status, cfa.fund_id,
               CASE WHEN attempt.provider_mode = 'SIMULATOR'
                    THEN 'SIMULATED' ELSE c.channel END AS channel,
               CASE attempt.provider_mode WHEN 'SIMULATOR' THEN 'SIMULATED'
                    WHEN 'DARAJA' THEN 'DARAJA' ELSE 'UNRESOLVED' END AS payment_provider,
               c.contribution_status, count(*)::integer AS contribution_count,
               sum(COALESCE(cfa.allocated_amount, c.amount)) AS amount_total, NULL::text AS category,
               NULL::text AS delivery_status, NULL::text AS filter_user_id
        FROM contributions c
        JOIN pension_accounts pa ON pa.account_id = c.account_id
        JOIN users u ON u.user_id = pa.user_id
        LEFT JOIN contribution_fund_allocations cfa
          ON cfa.contribution_id = c.contribution_id AND cfa.account_id = c.account_id
        LEFT JOIN LATERAL (
            SELECT a.provider_mode
            FROM mpesa_payment_attempts a
            WHERE a.transaction_id = c.transaction_id
            ORDER BY a.created_at DESC, a.attempt_id DESC
            LIMIT 1
        ) attempt ON TRUE
        GROUP BY date_trunc('month', c.created_at), c.contribution_status,
                 cfa.fund_id, c.channel, attempt.provider_mode`,
    "mpesa-payments": `
        SELECT a.attempt_id, a.attempt_status AS status, a.expected_amount,
               a.created_at AS report_date, c.contribution_status, t.transaction_status,
               v.latest_verification_status AS verification_status,
               (v.has_verified_success IS TRUE
                    AND c.contribution_status = 'COMPLETED'
                    AND t.transaction_status = 'COMPLETED'
                    AND (EXISTS (
                        SELECT 1 FROM pension_account_movements m
                        WHERE m.payment_attempt_id = a.attempt_id
                          AND m.movement_type = 'CONTRIBUTION_SETTLEMENT'
                    ) OR a.created_at < COALESCE(
                        (SELECT activated_at FROM pension_ledger WHERE singleton_key IS TRUE),
                        '-infinity'::timestamptz
                    ))) AS settlement_confirmed,
               t.mpesa_receipt, t.completed_at AS settled_at, u.user_id AS filter_user_id,
               NULL::text AS fund_id,
               CASE a.provider_mode WHEN 'SIMULATOR' THEN 'SIMULATED'
                    WHEN 'DARAJA' THEN 'MPESA' ELSE 'UNRESOLVED' END AS channel,
               CASE a.provider_mode WHEN 'SIMULATOR' THEN 'SIMULATED'
                    WHEN 'DARAJA' THEN 'DARAJA' ELSE 'UNRESOLVED' END AS payment_provider,
               NULL::text AS category, NULL::text AS delivery_status
        FROM mpesa_payment_attempts a
        JOIN contributions c ON c.contribution_id = a.contribution_id
        JOIN transactions t ON t.transaction_id = a.transaction_id
        JOIN pension_accounts pa ON pa.account_id = a.account_id
        JOIN users u ON u.user_id = pa.user_id
        LEFT JOIN LATERAL (
            SELECT (array_agg(verification_status
                        ORDER BY created_at DESC, verification_id DESC))[1]
                        AS latest_verification_status,
                   bool_or(verification_status = 'VERIFIED_SUCCESS') AS has_verified_success
            FROM mpesa_payment_verifications
            WHERE attempt_id = a.attempt_id
        ) v ON TRUE`,
    "fund-performance": `
        SELECT f.fund_id, f.fund_name, f.fund_status AS status, f.expected_return,
               f.risk_level, COALESCE(sum(CASE WHEN c.contribution_id IS NOT NULL AND t.transaction_id IS NOT NULL
                   THEN cfa.allocated_amount ELSE 0 END), 0)::numeric(12,2) AS settled_contributions,
               count(DISTINCT CASE WHEN c.contribution_id IS NOT NULL AND t.transaction_id IS NOT NULL
                   THEN cfa.contribution_id END)::integer AS settled_contribution_count,
               max(c.created_at) AS report_date, NULL::text AS channel,
               NULL::text AS category, NULL::text AS delivery_status,
               NULL::text AS filter_user_id
        FROM funds f
        LEFT JOIN contribution_fund_allocations cfa ON cfa.fund_id = f.fund_id
        LEFT JOIN contributions c ON c.contribution_id = cfa.contribution_id
            AND c.contribution_status = 'COMPLETED'
        LEFT JOIN transactions t ON t.transaction_id = c.transaction_id
            AND t.transaction_status = 'COMPLETED'
        GROUP BY f.fund_id, f.fund_name, f.fund_status, f.expected_return, f.risk_level`,
    "notification-delivery": `
        SELECT n.notification_id, n.user_id, u.full_name, n.notification_type AS channel,
               n.delivery_status AS status, n.created_at AS report_date, n.scope_fund_id AS fund_id,
               n.notification_category AS category, n.delivery_result,
               n.user_id AS filter_user_id, n.delivery_status`,
    "regulatory-notifications": `
        SELECT n.notification_id, n.user_id, u.full_name, n.notification_type AS channel,
               n.delivery_status AS status, n.created_at AS report_date, n.scope_fund_id AS fund_id,
               n.notification_category AS category, n.delivery_result,
               n.user_id AS filter_user_id, n.delivery_status`,
    "administrative-activity": `
        SELECT al.log_id, al.user_id, u.full_name, u.role, al.action_type AS status,
               al.entity_name, al.entity_id, al."timestamp" AS report_date,
               NULL::text AS fund_id, NULL::text AS channel,
               NULL::text AS category, NULL::text AS delivery_status,
               al.user_id AS filter_user_id
        FROM audit_logs al LEFT JOIN users u ON u.user_id = al.user_id`,
    compliance: `
        SELECT cr.report_id, cr.report_type, cr.rba_status AS status, cr.period_start,
               cr.period_end, cr.generated_at AS report_date, cr.fund_id,
               f.fund_name, cr.generated_by AS filter_user_id,
               NULL::text AS channel, NULL::text AS category, NULL::text AS delivery_status
        FROM compliance_reports cr
        LEFT JOIN funds f ON f.fund_id = cr.fund_id`,
    "retirement-projections": `
        SELECT rp.projection_id, rp.plan_id, u.user_id AS filter_user_id, u.full_name,
               rp.projected_amount, rp.projection_years, rp.created_at AS report_date,
               pa.account_status AS status, fa.fund_id, NULL::text AS channel,
               NULL::text AS category, NULL::text AS delivery_status
        FROM retirement_projections rp
        JOIN retirement_plans p ON p.plan_id = rp.plan_id
        JOIN pension_accounts pa ON pa.account_id = p.account_id
        JOIN users u ON u.user_id = pa.user_id
        JOIN LATERAL (
            SELECT fa.fund_id
            FROM fund_allocations fa
            WHERE fa.account_id = pa.account_id
              AND fa.effective_from <= CURRENT_DATE
              AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)
              AND ($4::text IS NULL OR fa.fund_id::text = $4)
              AND ($7::text[] IS NULL OR fa.fund_id::text = ANY($7))
            ORDER BY fa.fund_id
            LIMIT 1
        ) fa ON TRUE`,
};

function createReportService(pool) {
    if (!pool || typeof pool.query !== "function") throw new TypeError("A PostgreSQL pool is required.");

    async function getFundScope(userId, role) {
        if (role === "ADMIN") return null;
        const result = role === "FUND_MANAGER"
            ? await pool.query(
                "SELECT fund_id FROM funds WHERE managed_by = $1 AND fund_status = 'ACTIVE' ORDER BY fund_id",
                [userId]
            )
            : await pool.query(
                `SELECT f.fund_id FROM regulator_fund_assignments rfa
                 JOIN funds f ON f.fund_id = rfa.fund_id
                 WHERE rfa.regulator_user_id = $1 AND rfa.active = TRUE
                   AND f.fund_status = 'ACTIVE' ORDER BY f.fund_id`,
                [userId]
            );
        return result.rows.map((row) => row.fund_id);
    }

    async function getAnalytics({ userId, role, filters = {} }) {
        if (!Object.hasOwn(REPORTS_BY_ROLE, role)) {
            throw serviceError("This role cannot access analytics.", "REPORT_FORBIDDEN", 403);
        }
        validateAnalyticsDates(filters);
        const params = [filters.start_date || null, filters.end_date || null];
        const datePredicate = (column) =>
            `($1::date IS NULL OR ${column} >= $1::date)
             AND ($2::date IS NULL OR ${column} < ($2::date + INTERVAL '1 day'))`;

        if (role === "FUND_MANAGER") {
            const [trends, summary, performance] = await Promise.all([
                pool.query(
                `SELECT date_trunc('month', c.created_at)::date AS period,
                        c.contribution_status AS status,
                        count(DISTINCT c.contribution_id)::integer AS contribution_count,
                        COALESCE(sum(CASE
                            WHEN c.contribution_status = 'COMPLETED'
                             AND t.transaction_status = 'COMPLETED'
                             AND t.transaction_type = 'CONTRIBUTION'
                            THEN cfa.allocated_amount ELSE 0 END), 0)::numeric(14,2) AS allocated_amount
                 FROM contributions c
                 JOIN contribution_fund_allocations cfa
                   ON cfa.contribution_id = c.contribution_id
                  AND cfa.account_id = c.account_id
                 JOIN transactions t ON t.transaction_id = c.transaction_id
                 JOIN funds f ON f.fund_id = cfa.fund_id
                 WHERE f.managed_by = $3
                   AND f.fund_status = 'ACTIVE'
                   AND EXISTS (
                       SELECT 1 FROM fund_allocations fa
                       WHERE fa.account_id = cfa.account_id
                         AND fa.fund_id = cfa.fund_id
                         AND fa.effective_from <= c.created_at::date
                         AND (fa.effective_to IS NULL OR fa.effective_to >= c.created_at::date)
                   )
                   AND ${datePredicate("c.created_at")}
                 GROUP BY date_trunc('month', c.created_at), c.contribution_status
                 ORDER BY period, status`,
                [params[0], params[1], userId]
                ),
                pool.query(
                    `SELECT count(DISTINCT f.fund_id)::integer AS managed_funds,
                            count(DISTINCT CASE
                                WHEN u.role = 'WORKER' AND u.account_status = 'ACTIVE'
                                 AND pa.account_status = 'ACTIVE'
                                THEN pa.account_id END)::integer AS allocated_workers
                     FROM funds f
                     LEFT JOIN fund_allocations fa
                       ON fa.fund_id = f.fund_id
                      AND fa.effective_from <= CURRENT_DATE
                      AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)
                     LEFT JOIN pension_accounts pa ON pa.account_id = fa.account_id
                     LEFT JOIN users u ON u.user_id = pa.user_id
                     WHERE f.managed_by = $1 AND f.fund_status = 'ACTIVE'`,
                    [userId]
                ),
                pool.query(
                    `SELECT f.fund_id, f.fund_name, f.risk_level, f.expected_return,
                            COALESCE(sum(CASE
                                WHEN c.contribution_status = 'COMPLETED'
                                 AND t.transaction_status = 'COMPLETED'
                                 AND t.transaction_type = 'CONTRIBUTION'
                                THEN cfa.allocated_amount ELSE 0 END), 0)::numeric(14,2)
                                AS settled_contributions,
                            count(DISTINCT CASE
                                WHEN c.contribution_status = 'COMPLETED'
                                 AND t.transaction_status = 'COMPLETED'
                                 AND t.transaction_type = 'CONTRIBUTION'
                                THEN c.contribution_id END)::integer AS settled_contribution_count
                     FROM funds f
                     LEFT JOIN contribution_fund_allocations cfa ON cfa.fund_id = f.fund_id
                     LEFT JOIN contributions c
                       ON c.contribution_id = cfa.contribution_id
                      AND c.account_id = cfa.account_id
                      AND ${datePredicate("c.created_at")}
                     LEFT JOIN transactions t ON t.transaction_id = c.transaction_id
                     WHERE f.managed_by = $3 AND f.fund_status = 'ACTIVE'
                     GROUP BY f.fund_id, f.fund_name, f.risk_level, f.expected_return
                     ORDER BY f.fund_name, f.fund_id`,
                    [params[0], params[1], userId]
                ),
            ]);
            return {
                contribution_trends: trends.rows,
                fund_summary: summary.rows[0] || { managed_funds: 0, allocated_workers: 0 },
                fund_performance: performance.rows,
            };
        }

        if (role === "REGULATOR") {
            const [comparison, complianceTrends, evidence, complianceActivity, riskSummary] = await Promise.all([
                pool.query(
                    `WITH assigned_funds AS (
                         SELECT f.fund_id, f.fund_name
                         FROM regulator_fund_assignments rfa
                         JOIN funds f ON f.fund_id = rfa.fund_id
                         WHERE rfa.regulator_user_id = $3
                           AND rfa.active = TRUE
                           AND f.fund_status = 'ACTIVE'
                     )
                     SELECT af.fund_id, af.fund_name, c.contribution_status AS status,
                            count(DISTINCT c.contribution_id)::integer AS contribution_count,
                            COALESCE(sum(CASE
                                              WHEN c.contribution_status = 'COMPLETED'
                                               AND t.transaction_status = 'COMPLETED'
                                               AND t.transaction_type = 'CONTRIBUTION'
                                              THEN cfa.allocated_amount ELSE 0 END), 0)::numeric(14,2) AS allocated_amount
                     FROM assigned_funds af
                     LEFT JOIN contribution_fund_allocations cfa ON cfa.fund_id = af.fund_id
                     LEFT JOIN contributions c
                       ON c.contribution_id = cfa.contribution_id
                      AND c.account_id = cfa.account_id
                      AND EXISTS (
                          SELECT 1 FROM fund_allocations fa
                          WHERE fa.account_id = cfa.account_id
                            AND fa.fund_id = cfa.fund_id
                            AND fa.effective_from <= c.created_at::date
                            AND (fa.effective_to IS NULL OR fa.effective_to >= c.created_at::date)
                      )
                      AND ${datePredicate("c.created_at")}
                     LEFT JOIN transactions t
                       ON t.transaction_id = c.transaction_id
                      AND t.transaction_type = 'CONTRIBUTION'
                     GROUP BY af.fund_id, af.fund_name, c.contribution_status
                     ORDER BY af.fund_name, status`,
                    [params[0], params[1], userId]
                ),
                pool.query(
                    `SELECT date_trunc('month', COALESCE(cr.last_submitted_at,
                                cr.submitted_at, cr.generated_at))::date AS period,
                            cr.rba_status AS status, count(*)::integer AS report_count
                     FROM compliance_reports cr
                     JOIN regulator_fund_assignments rfa
                       ON rfa.fund_id = cr.fund_id
                      AND rfa.regulator_user_id = $3
                      AND rfa.active = TRUE
                     JOIN funds f ON f.fund_id = cr.fund_id AND f.fund_status = 'ACTIVE'
                     WHERE (cr.is_legacy = TRUE OR cr.rba_status <> 'DRAFT')
                       AND ${datePredicate("COALESCE(cr.last_submitted_at, cr.submitted_at, cr.generated_at)")}
                     GROUP BY date_trunc('month', COALESCE(cr.last_submitted_at,
                                  cr.submitted_at, cr.generated_at)), cr.rba_status
                     ORDER BY period, status`,
                    [params[0], params[1], userId]
                ),
                pool.query(
                    `WITH scoped_reports AS (
                         SELECT cr.report_id,
                                COALESCE(latest.report_content, cr.report_content) AS report_content
                         FROM compliance_reports cr
                         JOIN regulator_fund_assignments rfa
                           ON rfa.fund_id = cr.fund_id
                          AND rfa.regulator_user_id = $3
                          AND rfa.active = TRUE
                         JOIN funds f ON f.fund_id = cr.fund_id AND f.fund_status = 'ACTIVE'
                         LEFT JOIN LATERAL (
                             SELECT s.report_content
                             FROM compliance_report_submissions s
                             WHERE s.report_id = cr.report_id
                             ORDER BY s.version DESC
                             LIMIT 1
                         ) latest ON TRUE
                         WHERE (cr.is_legacy = TRUE OR cr.rba_status <> 'DRAFT')
                           AND ${datePredicate("COALESCE(cr.last_submitted_at, cr.submitted_at, cr.generated_at)")}
                     )
                     SELECT evidence.section, count(*) FILTER (WHERE evidence.provided)::integer AS report_count
                     FROM scoped_reports sr
                     CROSS JOIN LATERAL (VALUES
                         ('EXECUTIVE_SUMMARY', NULLIF(btrim(sr.report_content->>'executive_summary'), '') IS NOT NULL),
                         ('FINANCIAL_SUMMARY', NULLIF(btrim(sr.report_content->>'financial_summary'), '') IS NOT NULL),
                         ('RISK_AND_GOVERNANCE', NULLIF(btrim(sr.report_content->>'risk_and_governance'), '') IS NOT NULL),
                         ('INCIDENTS_AND_ACTIONS', NULLIF(btrim(sr.report_content->>'incidents_and_actions'), '') IS NOT NULL),
                         ('SUPPORTING_INFORMATION', NULLIF(btrim(sr.report_content->>'supporting_information'), '') IS NOT NULL)
                     ) AS evidence(section, provided)
                     GROUP BY evidence.section
                     ORDER BY evidence.section`,
                    [params[0], params[1], userId]
                ),
                pool.query(
                    `SELECT date_trunc('month', al."timestamp")::date AS period,
                            al.action_type, count(*)::integer AS event_count
                     FROM audit_logs al
                     JOIN compliance_reports cr ON cr.report_id = al.entity_id
                     JOIN regulator_fund_assignments rfa
                       ON rfa.fund_id = cr.fund_id
                      AND rfa.regulator_user_id = $3
                      AND rfa.active = TRUE
                     JOIN funds f ON f.fund_id = cr.fund_id AND f.fund_status = 'ACTIVE'
                     WHERE al.entity_name = 'COMPLIANCE_REPORTS'
                       AND (cr.is_legacy = TRUE OR cr.rba_status <> 'DRAFT')
                       AND ${datePredicate('al."timestamp"')}
                     GROUP BY date_trunc('month', al."timestamp"), al.action_type
                     ORDER BY period, al.action_type`,
                    [params[0], params[1], userId]
                ),
                pool.query(
                    `SELECT f.risk_level, count(*)::integer AS fund_count
                     FROM regulator_fund_assignments rfa
                     JOIN funds f ON f.fund_id = rfa.fund_id
                     WHERE rfa.regulator_user_id = $1
                       AND rfa.active = TRUE
                       AND f.fund_status = 'ACTIVE'
                       AND f.risk_level IS NOT NULL
                     GROUP BY f.risk_level
                     ORDER BY f.risk_level`,
                    [userId]
                ),
            ]);
            return {
                fund_comparison: comparison.rows,
                compliance_trends: complianceTrends.rows,
                compliance_evidence: evidence.rows,
                compliance_activity: complianceActivity.rows,
                risk_summary: riskSummary.rows,
            };
        }

        const [notifications, payments, activity, userTrends] = await Promise.all([
            pool.query(
                `SELECT notification_type AS channel, delivery_status AS status,
                        count(*)::integer AS notification_count
                 FROM notifications
                 WHERE ${datePredicate("created_at")}
                 GROUP BY notification_type, delivery_status
                 ORDER BY channel, status`,
                params
            ),
            pool.query(
                `WITH attempt_statuses AS (
                     SELECT a.attempt_status,
                            COALESCE(latest.verification_status, 'NOT_VERIFIED') AS verification_status,
                            CASE
                                WHEN latest.verification_status = 'VERIFIED_SUCCESS'
                                 AND c.contribution_status = 'COMPLETED'
                                 AND t.transaction_status = 'COMPLETED'
                                 AND t.transaction_type = 'CONTRIBUTION'
                                THEN 'SETTLED'
                                ELSE 'NOT_SETTLED'
                            END AS settlement_status
                     FROM mpesa_payment_attempts a
                     LEFT JOIN contributions c
                       ON c.contribution_id = a.contribution_id
                      AND c.account_id = a.account_id
                      AND c.transaction_id = a.transaction_id
                     LEFT JOIN transactions t
                       ON t.transaction_id = a.transaction_id
                      AND t.transaction_type = 'CONTRIBUTION'
                     LEFT JOIN LATERAL (
                         SELECT v.verification_status
                         FROM mpesa_payment_verifications v
                         WHERE v.attempt_id = a.attempt_id
                         ORDER BY v.created_at DESC, v.verification_id DESC
                         LIMIT 1
                     ) latest ON TRUE
                     WHERE ${datePredicate("a.created_at")}
                 )
                 SELECT 'ATTEMPT'::text AS category, attempt_status AS status,
                        count(*)::integer AS item_count
                 FROM attempt_statuses
                 GROUP BY attempt_status
                 UNION ALL
                 SELECT 'VERIFICATION', verification_status, count(*)::integer
                 FROM attempt_statuses
                 GROUP BY verification_status
                 UNION ALL
                 SELECT 'SETTLEMENT', settlement_status, count(*)::integer
                 FROM attempt_statuses
                 GROUP BY settlement_status
                 ORDER BY category, status`,
                params
            ),
            pool.query(
                `SELECT action_type, entity_name, count(*)::integer AS event_count
                 FROM audit_logs
                 WHERE ${datePredicate('"timestamp"')}
                 GROUP BY action_type, entity_name
                 ORDER BY entity_name, action_type`,
                params
            ),
            pool.query(
                `SELECT date_trunc('month', created_at)::date AS period,
                        account_status, count(*)::integer AS user_count
                 FROM users
                 WHERE ${datePredicate("created_at")}
                 GROUP BY date_trunc('month', created_at), account_status
                 ORDER BY period, account_status`,
                params
            ),
        ]);
        return {
            notification_outcomes: notifications.rows,
            mpesa_statuses: payments.rows,
            activity: activity.rows,
            user_trends: userTrends.rows,
        };
    }

    async function listFunds({ userId, role }) {
        if (role === "ADMIN") {
            const result = await pool.query(
                "SELECT fund_id, fund_name FROM funds ORDER BY fund_name, fund_id LIMIT 500"
            );
            return result.rows;
        }
        if (!["FUND_MANAGER", "REGULATOR"].includes(role)) {
            throw serviceError("This role cannot view report scopes.", "REPORT_FORBIDDEN", 403);
        }
        const result = role === "FUND_MANAGER"
            ? await pool.query(
                `SELECT fund_id, fund_name FROM funds
                 WHERE managed_by = $1 AND fund_status = 'ACTIVE'
                 ORDER BY fund_name, fund_id`,
                [userId]
            )
            : await pool.query(
                `SELECT f.fund_id, f.fund_name
                 FROM regulator_fund_assignments rfa
                 JOIN funds f ON f.fund_id = rfa.fund_id
                 WHERE rfa.regulator_user_id = $1 AND rfa.active = TRUE
                   AND f.fund_status = 'ACTIVE'
                 ORDER BY f.fund_name, f.fund_id`,
                [userId]
            );
        return result.rows;
    }

    function listCatalog(role) {
        if (!Object.hasOwn(REPORTS_BY_ROLE, role)) {
            throw serviceError("This role cannot access reports.", "REPORT_FORBIDDEN", 403);
        }
        return [...REPORTS_BY_ROLE[role]];
    }

    async function assertReportScope({ role, userId, reportKey, filters }) {
        if (!Object.hasOwn(REPORTS_BY_ROLE, role) || !REPORTS_BY_ROLE[role].has(reportKey)) {
            throw serviceError("This report is not available to your role.", "REPORT_FORBIDDEN", 403);
        }
        validateFilters(filters);
        const fundIds = await getFundScope(userId, role);
        if (role !== "ADMIN" && filters.fund_id && !fundIds.includes(filters.fund_id)) {
            throw serviceError("The requested fund is outside your authorized scope.", "REPORT_FORBIDDEN", 403);
        }
        if (role !== "ADMIN" && (!fundIds || fundIds.length === 0)) {
            return { fundIds: [], scoped: true };
        }
        return { fundIds, scoped: role !== "ADMIN" };
    }

    function buildQuery(reportKey, filters, fundIds, scoped, role) {
        const source = REPORT_SQL[reportKey];
        if (!source) throw serviceError("This report is not available.", "REPORT_NOT_FOUND", 404);
        let querySource = source;
        if (role === "REGULATOR" && reportKey === "compliance") {
            querySource = `${source}
                WHERE (cr.is_legacy = TRUE OR cr.rba_status <> 'DRAFT')`;
        }
        if (["notification-delivery", "regulatory-notifications"].includes(reportKey)) {
            querySource = `${source}
                FROM notifications n LEFT JOIN users u ON u.user_id = n.user_id`;
        }
        const params = [
            filters.start_date || null,
            filters.end_date || null,
            filters.status || null,
            filters.fund_id || null,
            filters.channel || null,
            filters.category || null,
            scoped ? fundIds : null,
            filters.user_id || null,
            filters.transaction_status || null,
            filters.contribution_status || null,
            filters.delivery_status || null,
        ];
        if (filters.transaction_status && reportKey !== "mpesa-payments") {
            throw serviceError("Transaction status applies only to M-Pesa payment reports.", "REPORT_INVALID_FILTERS", 400);
        }
        if (filters.contribution_status &&
            !["contributions", "settled-contributions", "contribution-trends"].includes(reportKey)) {
            throw serviceError("Contribution status applies only to contribution reports.", "REPORT_INVALID_FILTERS", 400);
        }
        if (filters.delivery_status &&
            !["notification-delivery", "regulatory-notifications"].includes(reportKey)) {
            throw serviceError("Delivery status applies only to notification reports.", "REPORT_INVALID_FILTERS", 400);
        }
        const transactionCondition = reportKey === "mpesa-payments"
            ? "AND ($9::text IS NULL OR transaction_status::text = $9)"
            : "";
        const contributionCondition = ["contributions", "settled-contributions", "contribution-trends"].includes(reportKey)
            ? "AND ($10::text IS NULL OR contribution_status::text = $10)"
            : "";
        const deliveryCondition = ["notification-delivery", "regulatory-notifications"].includes(reportKey)
            ? `AND ($11::text IS NULL OR delivery_status::text = $11
                   OR ($11::text IN ('SENT', 'PROVIDER_ACCEPTED')
                       AND delivery_status::text IN ('SENT', 'PROVIDER_ACCEPTED')))`
            : "";
        return {
            sql: `WITH report_data AS (${querySource})
                SELECT * FROM report_data
                WHERE ($1::date IS NULL OR report_date::date >= $1::date)
                  AND ($2::date IS NULL OR report_date::date <= $2::date)
                  AND ($3::text IS NULL OR status::text = $3 OR delivery_status::text = $3
                       OR ($3::text IN ('SENT', 'PROVIDER_ACCEPTED')
                           AND delivery_status::text IN ('SENT', 'PROVIDER_ACCEPTED')))
                  AND ($4::text IS NULL OR fund_id::text = $4)
                  AND ($5::text IS NULL OR channel::text = $5)
                  AND ($6::text IS NULL OR category::text = $6)
                  AND ($7::text[] IS NULL OR fund_id::text = ANY($7))
                  AND ($8::text IS NULL OR filter_user_id::text = $8)
                  AND ($9::text IS NULL OR $9::text IS NOT NULL)
                  AND ($10::text IS NULL OR $10::text IS NOT NULL)
                  AND ($11::text IS NULL OR $11::text IS NOT NULL)
                  ${transactionCondition}
                  ${contributionCondition}
                  ${deliveryCondition}
                ORDER BY report_date DESC NULLS LAST
                LIMIT ${MAX_ROWS + 1}`,
            params,
        };
    }

    async function queryRows(reportKey, filters, fundIds, scoped, role) {
        const { sql, params } = buildQuery(reportKey, filters, fundIds, scoped, role);
        const result = await pool.query(sql, params);
        return result.rows;
    }

    function summarizeRows(rows) {
        const truncated = rows.length > MAX_ROWS;
        const exportedRows = truncated ? rows.slice(0, MAX_ROWS) : rows;
        return {
            rows: exportedRows,
            truncated,
            totalCount: rows.length,
        };
    }

    function exportMetadata({ reportKey, filters, fundIds, rows, truncated, totalCount, language }) {
        const generatedAt = new Date().toISOString();
        const copy = EXPORT_COPY[language];
        return {
            generatedAt,
            options: {
                title: copy.reportTitle(reportKey),
                summary: [
                    [copy.generatedAt, generatedAt],
                    [copy.appliedFilters, JSON.stringify(filters || {})],
                    [copy.authorizedFundScope, fundIds === null ? copy.allFunds : JSON.stringify(fundIds || [])],
                    [copy.exportedRows, rows],
                    [copy.matchingRows, truncated ? copy.atLeast(totalCount) : totalCount],
                    [copy.truncated, truncated ? copy.yes : copy.no],
                ],
            },
        };
    }

    async function generate({ userId, role, reportKey, filters, format, language }) {
        if (!["CSV", "XLSX", "PDF"].includes(format)) {
            throw serviceError("Choose CSV, XLSX, or PDF.", "REPORT_INVALID_FORMAT", 400);
        }
        const exportLanguage = validateExportLanguage(language);
        const scope = await assertReportScope({ role, userId, reportKey, filters });
        let rows;
        let rowSummary;
        let exported;
        try {
            rows = scope.scoped && scope.fundIds.length === 0
                ? []
                : await queryRows(reportKey, filters, scope.fundIds, scope.scoped, role);
            rowSummary = summarizeRows(rows);
            const metadata = exportMetadata({
                reportKey,
                filters,
                fundIds: scope.fundIds,
                rows: rowSummary.rows.length,
                truncated: rowSummary.truncated,
                totalCount: rowSummary.totalCount,
                language: exportLanguage,
            });
            exported = await exportReport(reportKey, rowSummary.rows, format, metadata.options);
        } catch (error) {
            await pool.query(
                `INSERT INTO report_generation_history (
                    generated_by, generator_role, report_key, export_format,
                    applied_filters, scope_fund_ids, generation_status, result_count
                 ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'FAILED', 0)`,
                [
                    userId, role, reportKey, format, JSON.stringify(filters),
                    JSON.stringify(scope.fundIds || []),
                ]
            );
            throw error;
        }
        const history = await pool.query(
            `INSERT INTO report_generation_history (
                generated_by, generator_role, report_key, export_format,
                applied_filters, scope_fund_ids, generation_status, result_count
             ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'SUCCEEDED', $7)
             RETURNING report_id, generated_at`,
            [
                userId, role, reportKey, format, JSON.stringify(filters),
                JSON.stringify(scope.fundIds || []), rowSummary.rows.length,
            ]
        );
        const report = history.rows[0];
        await pool.query(
            `INSERT INTO report_download_events (report_id, downloaded_by, outcome)
             VALUES ($1, $2, 'SUCCEEDED')`,
            [report.report_id, userId]
        );
        return {
            ...exported,
            reportId: report.report_id,
            rows: rowSummary.rows.length,
            truncated: rowSummary.truncated,
            totalCount: rowSummary.totalCount,
            generatedAt: report.generated_at,
        };
    }

    async function listHistory({ userId, role }) {
        if (role === "ADMIN") {
            const result = await pool.query(
                `SELECT h.report_id, h.generated_by, u.full_name AS generated_by_name,
                        h.generator_role, h.report_key, h.export_format, h.applied_filters,
                        h.scope_fund_ids, h.generation_status, h.result_count, h.generated_at,
                        (SELECT count(*)::integer FROM report_download_events d
                         WHERE d.report_id = h.report_id AND d.outcome = 'SUCCEEDED') AS download_count
                 FROM report_generation_history h LEFT JOIN users u ON u.user_id = h.generated_by
                 ORDER BY h.generated_at DESC LIMIT 200`
            );
            return result.rows;
        }

        const fundIds = await getFundScope(userId, role);
        const result = await pool.query(
            `SELECT h.report_id, h.generated_by, u.full_name AS generated_by_name,
                    h.generator_role, h.report_key, h.export_format, h.applied_filters,
                    h.scope_fund_ids, h.generation_status, h.result_count, h.generated_at,
                    (SELECT count(*)::integer FROM report_download_events d
                     WHERE d.report_id = h.report_id AND d.outcome = 'SUCCEEDED') AS download_count
             FROM report_generation_history h LEFT JOIN users u ON u.user_id = h.generated_by
             WHERE h.generated_by = $1 AND h.generator_role = $2
             ORDER BY h.generated_at DESC LIMIT 100`,
            [userId, role]
        );
        return result.rows.filter((history) => {
            if (!Array.isArray(history.scope_fund_ids) ||
                !history.scope_fund_ids.every((fundId) =>
                    typeof fundId === "string" && fundIds.includes(fundId))) {
                return false;
            }
            if (!history.applied_filters || typeof history.applied_filters !== "object" ||
                Array.isArray(history.applied_filters)) {
                return false;
            }
            if (Object.hasOwn(history.applied_filters, "fund_id") &&
                (typeof history.applied_filters.fund_id !== "string" ||
                 !fundIds.includes(history.applied_filters.fund_id))) {
                return false;
            }
            return history.scope_fund_ids.length > 0 || history.result_count === 0;
        });
    }

    async function download({ userId, role, reportId, language }) {
        if (!UUID_PATTERN.test(reportId || "")) {
            throw serviceError("A valid report reference is required.", "REPORT_NOT_FOUND", 404);
        }
        const exportLanguage = validateExportLanguage(language);
        const historyResult = await pool.query(
            `SELECT report_id, generated_by, generator_role, report_key,
                    export_format, applied_filters, scope_fund_ids
             FROM report_generation_history WHERE report_id = $1`,
            [reportId]
        );
        const history = historyResult.rows[0];
        if (!history) throw serviceError("The report was not found.", "REPORT_NOT_FOUND", 404);
        if (role !== "ADMIN" && (history.generated_by !== userId || history.generator_role !== role)) {
            await pool.query(
                `INSERT INTO report_download_events (report_id, downloaded_by, outcome)
                 VALUES ($1, $2, 'DENIED')`,
                [reportId, userId]
            );
            throw serviceError("You cannot download this report.", "REPORT_FORBIDDEN", 403);
        }
        const scope = await assertReportScope({
            role,
            userId,
            reportKey: history.report_key,
            filters: history.applied_filters,
        });
        const priorScope = Array.isArray(history.scope_fund_ids) ? history.scope_fund_ids : [];
        if (scope.scoped && priorScope.some((fundId) => !scope.fundIds.includes(fundId))) {
            await pool.query(
                `INSERT INTO report_download_events (report_id, downloaded_by, outcome)
                 VALUES ($1, $2, 'DENIED')`,
                [reportId, userId]
            );
            throw serviceError("The report's original fund scope is no longer authorized.", "REPORT_FORBIDDEN", 403);
        }
        let rows;
        let rowSummary;
        let exported;
        try {
            rows = scope.scoped && scope.fundIds.length === 0
                ? []
                : await queryRows(history.report_key, history.applied_filters, scope.fundIds, scope.scoped, role);
            rowSummary = summarizeRows(rows);
            const metadata = exportMetadata({
                reportKey: history.report_key,
                filters: history.applied_filters,
                fundIds: scope.fundIds,
                rows: rowSummary.rows.length,
                truncated: rowSummary.truncated,
                totalCount: rowSummary.totalCount,
                language: exportLanguage,
            });
            exported = await exportReport(
                history.report_key,
                rowSummary.rows,
                history.export_format,
                metadata.options
            );
        } catch (error) {
            await pool.query(
                `INSERT INTO report_download_events (report_id, downloaded_by, outcome)
                 VALUES ($1, $2, 'FAILED')`,
                [reportId, userId]
            );
            throw error;
        }
        await pool.query(
            `INSERT INTO report_download_events (report_id, downloaded_by, outcome)
             VALUES ($1, $2, 'SUCCEEDED')`,
            [reportId, userId]
        );
        return {
            ...exported,
            reportId,
            rows: rowSummary.rows.length,
            truncated: rowSummary.truncated,
            totalCount: rowSummary.totalCount,
        };
    }

    return { download, generate, getAnalytics, listCatalog, listFunds, listHistory };
}

module.exports = {
    createReportService,
    csvSafe,
    exportReport,
    validateFilters,
};
