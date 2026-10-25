const { isIP } = require("node:net");
const { Pool } = require("pg");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const CHECKS = [
    {
        id: "contribution-transaction-mismatches",
        explanation: "Linked contribution and transaction records are missing, have an incompatible type, different amounts, or different statuses.",
        limitations: ["A status difference is a discrepancy to review; this report does not determine which record is correct."],
        sql: `/* reconcile:contribution-transaction-mismatches */
            SELECT c.contribution_id, c.transaction_id, t.transaction_id AS matched_transaction_id,
                   t.transaction_type, c.amount AS contribution_amount, t.amount AS transaction_amount,
                   c.contribution_status, t.transaction_status
            FROM contributions c
            LEFT JOIN transactions t ON t.transaction_id = c.transaction_id
            WHERE t.transaction_id IS NULL
               OR t.transaction_type IS DISTINCT FROM 'CONTRIBUTION'
               OR c.amount IS DISTINCT FROM t.amount
               OR c.contribution_status IS DISTINCT FROM t.transaction_status
            ORDER BY c.contribution_id`,
    },
    {
        id: "completed-contribution-payment-evidence",
        explanation: "Completed M-Pesa contributions without a linked transaction, CheckoutRequestID, or receipt identifier.",
        limitations: [
            "Identifiers and callback fields are evidence metadata only; they do not independently prove that a provider payment was received or credited.",
            "BANK and USSD evidence cannot be evaluated because the schema has no corresponding provider-reference fields.",
        ],
        sql: `/* reconcile:completed-contribution-payment-evidence */
            SELECT c.contribution_id, c.transaction_id, t.transaction_id AS matched_transaction_id,
                   t.checkout_request_id, t.mpesa_receipt
            FROM contributions c
            LEFT JOIN transactions t ON t.transaction_id = c.transaction_id
            WHERE c.contribution_status = 'COMPLETED'
              AND c.channel = 'MPESA'
              AND (t.transaction_id IS NULL
                   OR NULLIF(BTRIM(t.checkout_request_id, E' \\t\\n\\r\\f\\013'), '') IS NULL
                   OR NULLIF(BTRIM(t.mpesa_receipt, E' \\t\\n\\r\\f\\013'), '') IS NULL)
            ORDER BY c.contribution_id`,
    },
    {
        id: "completed-contributions-without-transaction",
        explanation: "Completed contributions without a matching transaction record.",
        limitations: ["The foreign key normally prevents this condition; it may indicate historical constraint bypass or corruption."],
        sql: `/* reconcile:completed-contributions-without-transaction */
            SELECT c.contribution_id, c.transaction_id, c.amount, c.channel
            FROM contributions c
            LEFT JOIN transactions t ON t.transaction_id = c.transaction_id
            WHERE c.contribution_status = 'COMPLETED' AND t.transaction_id IS NULL
            ORDER BY c.contribution_id`,
    },
    {
        id: "completed-contribution-transactions-without-contribution",
        explanation: "Completed contribution transactions without a linked contribution record.",
        limitations: ["The unique contribution-to-transaction relationship permits a transaction to have no contribution."],
        sql: `/* reconcile:completed-contribution-transactions-without-contribution */
            SELECT t.transaction_id, t.amount, t.transaction_status
            FROM transactions t
            LEFT JOIN contributions c ON c.transaction_id = t.transaction_id
            WHERE t.transaction_type = 'CONTRIBUTION'
              AND t.transaction_status = 'COMPLETED'
              AND c.contribution_id IS NULL
            ORDER BY t.transaction_id`,
    },
    {
        id: "duplicate-provider-identifiers",
        explanation: "Provider receipt or checkout identifiers used by more than one transaction.",
        limitations: ["Unique constraints currently protect non-null identifiers; this check is retained to detect constraint bypass or historical anomalies."],
        sql: `/* reconcile:duplicate-provider-identifiers */
            SELECT 'mpesa_receipt' AS identifier_type, mpesa_receipt AS identifier,
                   array_agg(transaction_id ORDER BY transaction_id) AS transaction_ids,
                   count(*)::int AS record_count
            FROM transactions
            WHERE NULLIF(BTRIM(mpesa_receipt, E' \\t\\n\\r\\f\\013'), '') IS NOT NULL
            GROUP BY mpesa_receipt
            HAVING count(*) > 1
            UNION ALL
            SELECT 'checkout_request_id', checkout_request_id,
                   array_agg(transaction_id ORDER BY transaction_id), count(*)::int
            FROM transactions
            WHERE NULLIF(BTRIM(checkout_request_id, E' \\t\\n\\r\\f\\013'), '') IS NOT NULL
            GROUP BY checkout_request_id
            HAVING count(*) > 1
            ORDER BY identifier_type, identifier`,
    },
    {
        id: "pending-mpesa-provider-state",
        explanation: "Lists all pending M-Pesa contributions with their identifier/result state; unresolved entries are shown for reconciliation and are not classified as failed.",
        limitations: [
            "A pending transaction is not classified as failed based on its age or missing provider identifier.",
            "A missing provider result is normal for an unresolved pending payment; it is reported as unresolved, not as a failure.",
            "The stored callback result is not independently verified and cannot establish payment completion.",
        ],
        sql: `/* reconcile:pending-mpesa-provider-state */
            SELECT c.contribution_id, c.transaction_id, t.checkout_request_id,
                   t.mpesa_result_code, t.transaction_status, c.contribution_status,
                   CASE
                      WHEN t.transaction_id IS NULL THEN 'missing_transaction'
                      WHEN t.transaction_status IS DISTINCT FROM 'PENDING' THEN 'transaction_status_disagrees_with_pending_contribution'
                      WHEN NULLIF(BTRIM(t.checkout_request_id, E' \\t\\n\\r\\f\\013'), '') IS NULL THEN 'missing_checkout_request_id'
                      WHEN t.mpesa_result_code IS NULL THEN 'awaiting_final_provider_result'
                      ELSE 'provider_result_present_while_pending'
                   END AS reason
            FROM contributions c
            LEFT JOIN transactions t ON t.transaction_id = c.transaction_id
            WHERE c.channel = 'MPESA'
              AND c.contribution_status = 'PENDING'
            ORDER BY c.contribution_id`,
    },
    {
        id: "withdrawal-settlement-inconsistencies",
        explanation: "Withdrawal claim status or processing metadata conflicts with its linked settlement transaction.",
        limitations: [
            "The current workflow reviews claims only; a paid claim and settlement record are not expected unless a separate payout process recorded them.",
            "The schema does not record payout provider identifiers or independently verified payout evidence.",
        ],
        sql: `/* reconcile:withdrawal-settlement-inconsistencies */
            SELECT wc.claim_id, wc.transaction_id, wc.amount_requested, wc.claim_status,
                   wc.reviewed_by, wc.reviewed_at, wc.processed_at,
                   t.transaction_id AS matched_transaction_id, t.transaction_type,
                   t.amount AS transaction_amount, t.transaction_status,
                   CASE
                       WHEN wc.claim_status = 'PENDING'
                            AND (wc.reviewed_by IS NOT NULL OR wc.reviewed_at IS NOT NULL OR wc.processed_at IS NOT NULL OR wc.transaction_id IS NOT NULL)
                           THEN 'pending_claim_has_processing_metadata'
                       WHEN wc.claim_status IN ('APPROVED', 'REJECTED', 'PAID')
                            AND (wc.reviewed_by IS NULL OR wc.reviewed_at IS NULL)
                           THEN 'review_decision_missing_metadata'
                       WHEN wc.claim_status = 'PAID'
                            AND (wc.processed_at IS NULL OR t.transaction_id IS NULL
                                 OR t.transaction_type IS DISTINCT FROM 'WITHDRAWAL'
                                 OR t.transaction_status IS DISTINCT FROM 'COMPLETED'
                                 OR t.amount IS DISTINCT FROM wc.amount_requested)
                           THEN 'paid_claim_missing_matching_completed_settlement'
                       WHEN wc.claim_status <> 'PAID' AND wc.transaction_id IS NOT NULL
                           THEN 'unpaid_claim_has_settlement_link'
                   END AS reason
            FROM withdrawal_claims wc
            LEFT JOIN transactions t ON t.transaction_id = wc.transaction_id
            WHERE (wc.claim_status = 'PENDING'
                   AND (wc.reviewed_by IS NOT NULL OR wc.reviewed_at IS NOT NULL OR wc.processed_at IS NOT NULL OR wc.transaction_id IS NOT NULL))
               OR (wc.claim_status IN ('APPROVED', 'REJECTED', 'PAID')
                   AND (wc.reviewed_by IS NULL OR wc.reviewed_at IS NULL))
               OR (wc.claim_status = 'PAID'
                   AND (wc.processed_at IS NULL OR t.transaction_id IS NULL
                        OR t.transaction_type IS DISTINCT FROM 'WITHDRAWAL'
                        OR t.transaction_status IS DISTINCT FROM 'COMPLETED'
                        OR t.amount IS DISTINCT FROM wc.amount_requested))
               OR (wc.claim_status <> 'PAID' AND wc.transaction_id IS NOT NULL)
            ORDER BY wc.claim_id`,
    },
    {
        id: "approved-review-only-claims",
        explanation: "Approved withdrawal claims that remain unpaid; these represent review approval, not completed payouts.",
        limitations: ["Approval does not itself show that funds were reserved, transferred, or paid."],
        sql: `/* reconcile:approved-review-only-claims */
            SELECT claim_id, account_id, amount_requested, claim_status, reviewed_at
            FROM withdrawal_claims
            WHERE claim_status = 'APPROVED'
            ORDER BY claim_id`,
    },
    {
        id: "balance-versus-completed-contributions-candidates",
        explanation: "Candidate comparison of each pension account balance with its completed contribution total.",
        limitations: [
            "A difference is not proof of an error: balances may include opening balances, manual adjustments, withdrawals, reversals, or other balance-changing operations.",
            "There is no independent financial posting ledger, so this comparison cannot establish a complete balance history.",
        ],
        sql: `/* reconcile:balance-versus-completed-contributions-candidates */
            WITH contribution_totals AS (
                SELECT c.account_id, sum(c.amount)::numeric(12,2) AS completed_contributions
                FROM contributions c
                WHERE c.contribution_status = 'COMPLETED'
                GROUP BY c.account_id
            )
            SELECT pa.account_id, pa.current_balance,
                   COALESCE(ct.completed_contributions, 0)::numeric(12,2) AS completed_contributions,
                   (pa.current_balance - COALESCE(ct.completed_contributions, 0))::numeric(12,2) AS difference
            FROM pension_accounts pa
            LEFT JOIN contribution_totals ct ON ct.account_id = pa.account_id
            WHERE pa.current_balance IS DISTINCT FROM COALESCE(ct.completed_contributions, 0)::numeric(12,2)
            ORDER BY pa.account_id`,
    },
];

function isLoopbackAddress(address) {
    if (typeof address !== "string") return false;
    const normalized = address.toLowerCase().split("%")[0].split("/")[0];
    if (normalized === "::1") return true;
    if (normalized.startsWith("::ffff:")) return isLoopbackAddress(normalized.slice(7));
    return isIP(normalized) === 4 && normalized.startsWith("127.");
}

function validateTestDatabaseUrl(connectionString) {
    let parsed;
    try {
        parsed = new URL(connectionString);
    } catch {
        throw new Error("Finance reconciliation requires a valid TEST_DATABASE_URL.");
    }

    const hostname = parsed.hostname.toLowerCase();
    const hasHostOverride = parsed.searchParams.has("host");
    const overriddenHost = parsed.searchParams.get("host");
    const hasHostAddress = parsed.searchParams.has("hostaddr");
    const hostAddress = parsed.searchParams.get("hostaddr");
    const validHost = LOCAL_HOSTS.has(hostname);
    const validOverrides =
        (!hasHostOverride || (overriddenHost && LOCAL_HOSTS.has(overriddenHost.toLowerCase()))) &&
        (!hasHostAddress || (hostAddress && isLoopbackAddress(hostAddress))) &&
        !parsed.searchParams.has("service");
    let databaseName;
    try {
        databaseName = decodeURIComponent(parsed.pathname.slice(1));
    } catch {
        databaseName = "";
    }

    if (!["postgres:", "postgresql:"].includes(parsed.protocol) ||
        !validHost || !validOverrides || databaseName !== "micopesa_test") {
        throw new Error("Finance reconciliation may connect only to local micopesa_test.");
    }
}

function isSafeServerAddress(address) {
    return address === null || isLoopbackAddress(address);
}

async function runReconciliation({ connectionString, PoolClass = Pool } = {}) {
    validateTestDatabaseUrl(connectionString);
    const pool = new PoolClass({ connectionString, max: 1 });
    let client;
    let transactionOpen = false;
    try {
        client = await pool.connect();
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        transactionOpen = true;

        const targetResult = await client.query(
            `SELECT current_database() AS database_name,
                    inet_server_addr()::text AS server_address,
                    current_setting('transaction_read_only') AS read_only`
        );
        const target = targetResult.rows[0];
        if (!target || target.database_name !== "micopesa_test" ||
            target.read_only !== "on" || !isSafeServerAddress(target.server_address)) {
            throw new Error("Connected database did not verify as a local, read-only micopesa_test target.");
        }

        const checks = [];
        for (const check of CHECKS) {
            const result = await client.query(check.sql);
            checks.push({
                id: check.id,
                status: "completed",
                flagged_count: result.rows.length,
                explanation: check.explanation,
                limitations: check.limitations,
                records: result.rows,
            });
        }

        await client.query("COMMIT");
        transactionOpen = false;
        return {
            database_target: {
                database: target.database_name,
                host: "local",
                read_only_transaction: true,
            },
            checks,
        };
    } catch (error) {
        if (client && transactionOpen) {
            await client.query("ROLLBACK").catch(() => {});
        }
        throw error;
    } finally {
        if (client) client.release();
        await pool.end();
    }
}

if (require.main === module) {
    runReconciliation({ connectionString: process.env.TEST_DATABASE_URL })
        .then((report) => console.log(JSON.stringify(report, null, 2)))
        .catch((error) => {
            console.error(`Finance reconciliation failed: ${error.message}`);
            process.exitCode = 1;
        });
}

module.exports = { CHECKS, runReconciliation, validateTestDatabaseUrl };
