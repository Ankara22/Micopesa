/*
 * Read-only schema diagnostic for the Regulator and Reports pages.
 *
 * Safety guard: this script will connect only to localhost:5433/Micopesa.
 * It loads the API's environment internally, but never prints credentials,
 * connection strings, personal records, fund names, or user identifiers.
 * No DDL/DML is executed. The read-only transaction is always rolled back.
 */
process.env.NODE_ENV = "development";
require("../src/config/loadEnvironment");

const { Client } = require("pg");

const EXPECTED_TARGET = Object.freeze({ host: "localhost", port: "5433", database: "Micopesa" });
const REQUIRED_TABLES = [
    "users",
    "funds",
    "regulator_fund_assignments",
    "notifications",
    "notification_audit_events",
    "report_generation_history",
    "report_download_events",
    "compliance_reports",
    "compliance_report_submissions",
    "compliance_report_reviews",
    "audit_logs",
];
const REQUIRED_COLUMNS = {
    notifications: ["notification_category", "scope_fund_id"],
    regulator_fund_assignments: ["regulator_user_id", "fund_id", "active"],
    report_generation_history: [
        "report_id", "generated_by", "generator_role", "report_key", "export_format",
        "applied_filters", "scope_fund_ids", "generation_status", "result_count", "generated_at",
    ],
    report_download_events: ["report_id", "downloaded_by", "downloaded_at", "outcome"],
    notification_audit_events: [
        "request_id", "sender_user_id", "sender_role", "recipient_user_id",
        "scope_fund_id", "notification_category", "channels", "authorization_outcome",
    ],
    compliance_reports: [
        "report_id", "generated_by", "fund_id", "report_type", "rba_status",
        "is_legacy", "submitted_at", "last_submitted_at",
    ],
    compliance_report_submissions: [
        "submission_id", "report_id", "submitted_by", "submitted_by_name",
        "submitted_by_role", "report_content", "report_type", "period_start",
        "period_end", "submitted_at",
    ],
    compliance_report_reviews: [
        "report_id", "submission_id", "reviewed_by", "reviewed_by_name",
        "reviewed_by_role", "decision", "reason", "created_at",
    ],
    audit_logs: ["log_id", "user_id", "action_type", "entity_name", "entity_id", "details"],
};

function stop(reason) {
    process.stdout.write(`${JSON.stringify({ result: "STOPPED_BEFORE_CONNECT", reason })}\n`);
    process.exitCode = 2;
}

function parseTarget(connectionString) {
    if (typeof connectionString !== "string" || connectionString.length === 0) return null;
    try {
        const parsed = new URL(connectionString);
        return {
            host: parsed.hostname.toLowerCase(),
            port: parsed.port || "5432",
            database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
        };
    } catch {
        return null;
    }
}

async function main() {
    const target = parseTarget(process.env.DATABASE_URL);
    if (!target) return stop("DATABASE_URL is unavailable or invalid; its value was not displayed.");
    if (
        target.host !== EXPECTED_TARGET.host ||
        target.port !== EXPECTED_TARGET.port ||
        target.database !== EXPECTED_TARGET.database
    ) {
        return stop("The loaded database target is not the authorized local Micopesa database; no connection was made.");
    }

    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 5000,
        statement_timeout: 15000,
        query_timeout: 15000,
    });
    let connected = false;
    let transactionStarted = false;
    let rollbackSucceeded = true;

    try {
        await client.connect();
        connected = true;
        await client.query("BEGIN TRANSACTION READ ONLY");
        transactionStarted = true;

        const verification = await client.query(`
            SELECT current_database() AS database_name,
                   inet_server_port()::text AS server_port,
                   current_setting('transaction_read_only') AS read_only
        `);
        const confirmed = verification.rows[0];
        const targetVerified = confirmed.database_name === EXPECTED_TARGET.database &&
            confirmed.server_port === EXPECTED_TARGET.port &&
            confirmed.read_only === "on";
        process.stdout.write(`${JSON.stringify({
            check: "connection_target",
            target_verified: targetVerified,
            database: confirmed.database_name,
            port: confirmed.server_port,
            transaction_read_only: confirmed.read_only,
        })}\n`);
        if (!targetVerified) {
            process.exitCode = 3;
            return;
        }

        await client.query("SET LOCAL statement_timeout = '15s'");
        const tableResult = await client.query(
            `SELECT table_name
             FROM information_schema.tables
             WHERE table_schema = 'public'
               AND table_type = 'BASE TABLE'
               AND table_name = ANY($1::text[])
             ORDER BY table_name`,
            [REQUIRED_TABLES]
        );
        const presentTables = new Set(tableResult.rows.map((row) => row.table_name));
        for (const table of REQUIRED_TABLES) {
            process.stdout.write(`${JSON.stringify({
                check: "table",
                table,
                status: presentTables.has(table) ? "PRESENT" : "MISSING",
            })}\n`);
        }

        const columnRequests = Object.entries(REQUIRED_COLUMNS)
            .filter(([table]) => presentTables.has(table))
            .flatMap(([table, columns]) => columns.map((column) => ({ table, column })));
        if (columnRequests.length) {
            const columnResult = await client.query(
                `SELECT table_name, column_name
                 FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND (table_name, column_name) IN (
                       SELECT requested.item->>'table', requested.item->>'column'
                       FROM jsonb_array_elements($1::jsonb) AS requested(item)
                   )
                 ORDER BY table_name, column_name`,
                [JSON.stringify(columnRequests)]
            );
            const presentColumns = new Set(columnResult.rows.map((row) => `${row.table_name}.${row.column_name}`));
            for (const { table, column } of columnRequests) {
                process.stdout.write(`${JSON.stringify({
                    check: "column",
                    column: `${table}.${column}`,
                    status: presentColumns.has(`${table}.${column}`) ? "PRESENT" : "MISSING",
                })}\n`);
            }
        }

        if (presentTables.has("regulator_fund_assignments") && presentTables.has("users") && presentTables.has("funds")) {
            const scopeSummary = await client.query(`
                SELECT
                    count(*) FILTER (WHERE rfa.active)::integer AS active_assignment_count,
                    count(DISTINCT rfa.regulator_user_id)
                        FILTER (WHERE rfa.active AND u.account_status = 'ACTIVE')::integer
                        AS active_regulators_with_scopes,
                    count(DISTINCT rfa.fund_id)
                        FILTER (WHERE rfa.active AND f.fund_status = 'ACTIVE')::integer
                        AS active_funds_assigned
                FROM public.regulator_fund_assignments rfa
                LEFT JOIN public.users u ON u.user_id = rfa.regulator_user_id
                LEFT JOIN public.funds f ON f.fund_id = rfa.fund_id
            `);
            process.stdout.write(`${JSON.stringify({
                check: "regulator_scope_counts_only",
                ...scopeSummary.rows[0],
                personal_records_displayed: false,
            })}\n`);
        } else {
            process.stdout.write(`${JSON.stringify({
                check: "regulator_scope_counts_only",
                status: "SKIPPED_REQUIRED_TABLE_MISSING",
            })}\n`);
        }

        process.stdout.write(`${JSON.stringify({
            result: "READ_ONLY_SCHEMA_INSPECTION_COMPLETE",
            migrations_applied: false,
            data_modified: false,
        })}\n`);
    } catch (error) {
        process.stdout.write(`${JSON.stringify({
            result: "READ_ONLY_SCHEMA_INSPECTION_FAILED",
            sqlstate: typeof error.code === "string" ? error.code : "UNKNOWN",
            message: "Database error details were withheld; do not share connection strings or credentials.",
        })}\n`);
        process.exitCode = 4;
    } finally {
        if (connected && transactionStarted) {
            try {
                await client.query("ROLLBACK");
                process.stdout.write(`${JSON.stringify({ result: "READ_ONLY_TRANSACTION_ROLLED_BACK" })}\n`);
            } catch (error) {
                rollbackSucceeded = false;
                process.stdout.write(`${JSON.stringify({
                    result: "ROLLBACK_FAILED",
                    sqlstate: typeof error.code === "string" ? error.code : "UNKNOWN",
                })}\n`);
                process.exitCode = 5;
            }
        }
        if (connected) {
            try {
                await client.end();
            } catch {
                process.exitCode = 6;
            }
        }
        if (!rollbackSucceeded) process.exitCode = 5;
    }
}

main().catch(() => {
    process.stderr.write("Schema diagnostic stopped unexpectedly; no credentials or raw connection details were printed.\n");
    process.exitCode = 7;
});
