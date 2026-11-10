const { exportReport } = require("./reportService");

const STATEMENT_COLUMNS = [
    "record_type",
    "record_source",
    "payment_provider",
    "transaction_reference",
    "contribution_date",
    "amount_kes",
    "contribution_status",
    "payment_status",
    "channel",
];
const MAX_STATEMENT_ROWS = 5000;
const ALLOWED_FORMATS = new Set(["CSV", "XLSX", "PDF"]);
const ALLOWED_STATUSES = new Set(["PENDING", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function statementError(message, code, statusCode) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function createWorkerStatementService(pool) {
    if (!pool || typeof pool.query !== "function") {
        throw new TypeError("A PostgreSQL pool is required.");
    }

    function validateFilters(filters) {
        if (!filters || typeof filters !== "object" || Array.isArray(filters) ||
            Object.keys(filters).some((key) =>
                !["start_date", "end_date", "contribution_status"].includes(key))) {
            throw statementError("Statement filters are invalid.", "STATEMENT_INVALID_FILTERS", 400);
        }
        for (const key of ["start_date", "end_date"]) {
            const value = filters[key];
            const parsed = typeof value === "string" && DATE_PATTERN.test(value)
                ? new Date(`${value}T00:00:00Z`)
                : null;
            if (value !== undefined &&
                (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)) {
                throw statementError("Statement dates must use YYYY-MM-DD.", "STATEMENT_INVALID_FILTERS", 400);
            }
        }
        if (filters.start_date && filters.end_date && filters.start_date > filters.end_date) {
            throw statementError("The statement start date must not be after its end date.", "STATEMENT_INVALID_FILTERS", 400);
        }
        if (filters.contribution_status !== undefined &&
            !ALLOWED_STATUSES.has(filters.contribution_status)) {
            throw statementError("The contribution status filter is invalid.", "STATEMENT_INVALID_FILTERS", 400);
        }
    }

    async function recordAudit(userId, format, filters, outcome, resultCount, totalCount, truncated, errorCode) {
        await pool.query(
            `INSERT INTO audit_logs (user_id, action_type, entity_name, entity_id, details)
             VALUES ($1, 'CREATE', 'WORKER_FINANCIAL_STATEMENT', $1, $2::jsonb)`,
            [
                userId,
                JSON.stringify({
                    format,
                    filters,
                    outcome,
                    result_count: resultCount,
                    total_count: totalCount,
                    truncated,
                    ...(errorCode ? { error_code: errorCode } : {}),
                }),
            ]
        );
    }

    async function generate({ userId, role, format, filters = {} }) {
        if (role !== "WORKER") {
            throw statementError(
                "Only workers can download a personal financial statement.",
                "STATEMENT_FORBIDDEN",
                403
            );
        }
        if (!ALLOWED_FORMATS.has(format)) {
            throw statementError("Choose CSV, XLSX, or PDF.", "STATEMENT_INVALID_FORMAT", 400);
        }
        validateFilters(filters);

        try {
            const accountResult = await pool.query(
                `SELECT pa.account_id, pa.current_balance, pa.account_status
                 FROM users u
                 JOIN pension_accounts pa ON pa.user_id = u.user_id
                 WHERE u.user_id = $1 AND u.role = 'WORKER'`,
                [userId]
            );
            const account = accountResult.rows[0];
            if (!account) {
                throw statementError(
                    "No pension account is available for this worker.",
                    "STATEMENT_ACCOUNT_NOT_FOUND",
                    404
                );
            }
            const result = await pool.query(
                `WITH statement_rows AS (
                    SELECT m.movement_type AS record_type,
                           'LEDGER'::text AS record_source,
                           CASE m.provider_mode
                               WHEN 'SIMULATOR' THEN 'SIMULATED'
                               WHEN 'DARAJA' THEN 'DARAJA'
                               ELSE 'NOT_APPLICABLE'
                           END AS payment_provider,
                           CASE
                               WHEN m.provider_mode = 'SIMULATOR' THEN sim.synthetic_reference
                               WHEN m.provider_mode = 'DARAJA' THEN t.mpesa_receipt
                               ELSE NULL
                           END AS transaction_reference,
                           m.effective_at AS contribution_date,
                           m.amount,
                           c.contribution_status,
                           CASE WHEN m.movement_type = 'CONTRIBUTION_SETTLEMENT'
                                THEN t.transaction_status::text
                                ELSE 'POSTED' END AS payment_status,
                           CASE WHEN m.provider_mode = 'SIMULATOR' THEN 'SIMULATED'
                                WHEN m.provider_mode = 'DARAJA' THEN 'MPESA'
                                ELSE m.movement_type END AS channel,
                           m.movement_id::text AS sort_id
                    FROM pension_account_movements m
                    LEFT JOIN contributions c
                      ON c.contribution_id = m.contribution_id
                    LEFT JOIN transactions t
                      ON t.transaction_id = m.transaction_id
                    LEFT JOIN simulator_payment_confirmations sim
                      ON sim.confirmation_id = m.simulator_confirmation_id
                    WHERE m.account_id = $1

                    UNION ALL

                    SELECT 'CONTRIBUTION'::text AS record_type,
                           CASE WHEN l.activated_at IS NULL OR c.created_at < l.activated_at
                                THEN 'LEGACY_HISTORY_INCLUDED_IN_OPENING'
                                ELSE 'SOURCE_RECORD' END AS record_source,
                           CASE latest_attempt.provider_mode
                               WHEN 'SIMULATOR' THEN 'SIMULATED'
                               WHEN 'DARAJA' THEN 'DARAJA'
                               ELSE 'UNRESOLVED'
                           END AS payment_provider,
                           CASE WHEN latest_attempt.provider_mode = 'SIMULATOR'
                                THEN sim.synthetic_reference
                                WHEN latest_attempt.provider_mode = 'DARAJA'
                                THEN t.mpesa_receipt
                                ELSE NULL
                           END AS transaction_reference,
                           c.created_at AS contribution_date,
                           c.amount,
                           c.contribution_status,
                           t.transaction_status::text AS payment_status,
                           CASE WHEN latest_attempt.provider_mode = 'SIMULATOR' THEN 'SIMULATED'
                                ELSE c.channel END AS channel,
                           c.contribution_id::text AS sort_id
                    FROM contributions c
                    LEFT JOIN transactions t ON t.transaction_id = c.transaction_id
                    LEFT JOIN pension_ledger l ON l.singleton_key IS TRUE
                    LEFT JOIN LATERAL (
                        SELECT a.attempt_id, a.provider_mode
                        FROM mpesa_payment_attempts a
                        WHERE a.transaction_id = c.transaction_id
                        ORDER BY a.created_at DESC, a.attempt_id DESC
                        LIMIT 1
                    ) latest_attempt ON TRUE
                    LEFT JOIN LATERAL (
                        SELECT s.synthetic_reference
                        FROM simulator_payment_confirmations s
                        WHERE s.attempt_id = latest_attempt.attempt_id
                        ORDER BY s.confirmed_at DESC, s.confirmation_id DESC
                        LIMIT 1
                    ) sim ON TRUE
                    WHERE c.account_id = $1
                      AND NOT EXISTS (
                          SELECT 1 FROM pension_account_movements m
                          WHERE m.contribution_id = c.contribution_id
                            AND m.movement_type = 'CONTRIBUTION_SETTLEMENT'
                      )
                )
                 SELECT record_type, record_source, payment_provider,
                        transaction_reference, contribution_date, amount,
                        contribution_status, payment_status, channel
                 FROM statement_rows
                 WHERE ($2::date IS NULL OR contribution_date >= $2::date)
                   AND ($3::date IS NULL OR contribution_date < ($3::date + INTERVAL '1 day'))
                   AND ($4::varchar IS NULL OR contribution_status::text = $4)
                 ORDER BY contribution_date DESC, sort_id
                 LIMIT $5`,
                [
                    account.account_id,
                    filters.start_date || null,
                    filters.end_date || null,
                    filters.contribution_status || null,
                    MAX_STATEMENT_ROWS + 1,
                ]
            );
            const contributionRows = result.rows.filter((row) => row.contribution_id !== null);
            const truncated = contributionRows.length > MAX_STATEMENT_ROWS;
            const rows = (truncated
                ? contributionRows.slice(0, MAX_STATEMENT_ROWS)
                : contributionRows)
                .map((row) => ({
                    record_type: row.record_type || "CONTRIBUTION",
                    record_source: row.record_source || "LEGACY_SOURCE",
                    payment_provider: row.payment_provider || "UNRESOLVED",
                    transaction_reference: row.transaction_reference || "",
                    contribution_date: row.contribution_date,
                    amount_kes: row.amount,
                    contribution_status: row.contribution_status,
                    payment_status: row.payment_status,
                    channel: row.channel,
                }));
            const generatedAt = new Date().toISOString();
            const totalCount = contributionRows.length;
            const auditFilters = {
                start_date: filters.start_date || null,
                end_date: filters.end_date || null,
                contribution_status: filters.contribution_status || null,
            };
            const exported = await exportReport(
                "my-financial-statement",
                rows,
                format,
                {
                    title: "MicoPesa personal financial statement",
                    summary: [
                        ["Account status", account.account_status],
                        ["Current balance (KES)", account.current_balance],
                        ["Historical contributions", "LEGACY_HISTORY_INCLUDED_IN_OPENING rows are informational and already included in the opening balance; do not add them again."],
                        ["Simulated payments", "SIMULATED entries are demonstrations; no real money was transferred."],
                        ["Generated at (UTC)", generatedAt],
                        ["Start date", auditFilters.start_date || "All"],
                        ["End date", auditFilters.end_date || "All"],
                        ["Contribution status", auditFilters.contribution_status || "All"],
                        ["Exported rows", rows.length],
                        ["Matching rows", truncated ? `At least ${totalCount}` : totalCount],
                        ["Truncated", truncated ? "Yes" : "No"],
                    ],
                    columns: STATEMENT_COLUMNS,
                }
            );
            await recordAudit(
                userId,
                format,
                auditFilters,
                "SUCCEEDED",
                rows.length,
                totalCount,
                truncated
            );
            return { ...exported, rows: rows.length, totalCount, truncated };
        } catch (error) {
            try {
                await recordAudit(
                    userId,
                    format,
                    {
                        start_date: filters.start_date || null,
                        end_date: filters.end_date || null,
                        contribution_status: filters.contribution_status || null,
                    },
                    "FAILED",
                    0,
                    0,
                    false,
                    error.code || "STATEMENT_GENERATION_FAILED"
                );
            } catch (auditError) {
                console.error("Could not record worker statement audit event.", {
                    code: auditError?.code || "AUDIT_LOG_WRITE_FAILED",
                });
            }
            throw error;
        }
    }

    return { generate };
}

module.exports = { createWorkerStatementService };
