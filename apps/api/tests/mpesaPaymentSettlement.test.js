const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createMpesaPaymentAttemptRepository,
} = require("../src/services/mpesaPaymentAttemptRepository");

function copy(value) {
    return JSON.parse(JSON.stringify(value));
}

function createSettlementPool({
    attempt = {},
    verification = {},
    transaction = {},
    contribution = {},
    account = {},
    otherTransactions = [],
    failOn = null,
    forceReceiptConstraintViolation = false,
    ledgerStatus = "ACTIVE",
    ledgerReadinessError = null,
} = {}) {
    const state = {
        attempt: {
            attempt_id: "attempt_001",
            account_id: "account_001",
            contribution_id: "contribution_001",
            transaction_id: "transaction_001",
            expected_amount: "2500.00",
            mpesa_phone: "254712345678",
            attempt_status: "PROMPT_ACCEPTED",
            provider_mode: "DARAJA",
            checkout_request_id: "checkout_001",
            merchant_request_id: "merchant_001",
            ...attempt,
        },
        verification: {
            verification_id: 1,
            attempt_id: "attempt_001",
            verification_source: "CALLBACK",
            checkout_request_id: "checkout_001",
            merchant_request_id: "merchant_001",
            callback_result_code: "0",
            callback_amount_matches: true,
            callback_phone_matches: true,
            callback_receipt: "QAB123XYZ",
            provider_result_code: "0",
            provider_result_description: "Provider-confirmed success",
            verification_status: "VERIFIED_SUCCESS",
            provider_mode: "DARAJA",
            simulator_outcome: null,
            callback_fingerprint: "a".repeat(64),
            ...verification,
        },
        transaction: {
            transaction_id: "transaction_001",
            transaction_type: "CONTRIBUTION",
            transaction_amount: "2500.00",
            transaction_status: "PENDING",
            mpesa_receipt: null,
            transaction_checkout_request_id: null,
            transaction_phone: null,
            transaction_result_code: null,
            ...transaction,
        },
        contribution: {
            contribution_id: "contribution_001",
            account_id: "account_001",
            transaction_id: "transaction_001",
            contribution_amount: "2500.00",
            channel: "MPESA",
            contribution_status: "PENDING",
            ...contribution,
        },
        account: {
            account_id: "account_001",
            user_id: "worker_001",
            phone: "0712345678",
            current_balance: "1000.00",
            account_status: "ACTIVE",
            role: "WORKER",
            user_status: "ACTIVE",
            ...account,
        },
        otherTransactions: copy(otherTransactions),
        notifications: [],
        movements: [],
        simulatorConfirmation: null,
        callbackEvidence: {
            callback_id: 1,
            attempt_id: "attempt_001",
            verification_id: 1,
            callback_fingerprint: "a".repeat(64),
            callback_status: "VERIFIED",
            checkout_request_id: "checkout_001",
            merchant_request_id: "merchant_001",
            callback_result_code: "0",
            callback_amount: "2500.00",
            callback_phone: "254712345678",
            callback_receipt: "QAB123XYZ",
        },
        fundSnapshots: [
            { contribution_id: "contribution_001", fund_id: "fund_001", allocated_amount: "1750.00" },
            { contribution_id: "contribution_001", fund_id: "fund_002", allocated_amount: "750.00" },
        ],
        queries: [],
        rollbackCount: 0,
        failOn,
        ledgerStatus,
        ledgerReadinessError,
        snapshot: null,
    };

    function snapshot() {
        return {
            attempt: copy(state.attempt),
            transaction: copy(state.transaction),
            contribution: copy(state.contribution),
            account: copy(state.account),
            otherTransactions: copy(state.otherTransactions),
            notifications: copy(state.notifications),
            movements: copy(state.movements),
            fundSnapshots: copy(state.fundSnapshots),
        };
    }

    function restore(saved) {
        state.attempt = saved.attempt;
        state.transaction = saved.transaction;
        state.contribution = saved.contribution;
        state.account = saved.account;
        state.otherTransactions = saved.otherTransactions;
        state.notifications = saved.notifications;
        state.movements = saved.movements;
        state.fundSnapshots = saved.fundSnapshots;
    }

    async function query(sql, params = []) {
        const statement = sql.trim();
        state.queries.push(statement);
        if (state.failOn && statement.startsWith(state.failOn)) {
            throw new Error("Injected settlement write failure");
        }
        if (statement === "BEGIN") {
            state.snapshot = snapshot();
            return { rows: [] };
        }
        if (statement === "COMMIT") {
            state.snapshot = null;
            return { rows: [] };
        }
        if (statement === "ROLLBACK") {
            state.rollbackCount += 1;
            if (state.snapshot) restore(state.snapshot);
            state.snapshot = null;
            return { rows: [] };
        }
        if (statement === "SELECT pg_advisory_xact_lock_shared(1296917328, 1280265540)") {
            return { rows: [] };
        }
        if (statement === "SELECT status FROM pension_ledger WHERE singleton_key IS TRUE") {
            if (state.ledgerReadinessError) throw state.ledgerReadinessError;
            return {
                rows: state.ledgerStatus === null ? [] : [{ status: state.ledgerStatus }],
            };
        }
        if (statement === "SAVEPOINT contribution_sms_notification" ||
            statement === "RELEASE SAVEPOINT contribution_sms_notification" ||
            statement === "ROLLBACK TO SAVEPOINT contribution_sms_notification") {
            return { rows: [] };
        }
        if (statement.includes("FROM mpesa_payment_attempts") && statement.includes("WHERE attempt_id = $1")) {
            return { rows: params[0] === state.attempt.attempt_id ? [copy(state.attempt)] : [] };
        }
        if (statement.startsWith("SELECT account_id") && statement.includes("FROM pension_accounts")) {
            return { rows: params[0] === state.account.account_id ? [{ account_id: params[0] }] : [] };
        }
        if (statement.includes("FROM mpesa_payment_verifications") && statement.includes("WHERE verification_id = $1")) {
            const matches = params[0] === state.verification.verification_id &&
                params[1] === state.attempt.attempt_id
                ? [copy(state.verification)]
                : [];
            return { rows: matches };
        }
        if (statement.includes("FROM mpesa_callback_inbox") &&
            statement.includes("WHERE callback_fingerprint = $1")) {
            const callback = state.callbackEvidence;
            const matches = callback &&
                callback.callback_fingerprint === params[0] &&
                callback.attempt_id === params[1] &&
                String(callback.verification_id) === String(params[2]) &&
                callback.callback_status === "VERIFIED" &&
                callback.checkout_request_id === params[3] &&
                callback.merchant_request_id === params[4] &&
                callback.callback_result_code === "0" &&
                Number(callback.callback_amount) === Number(params[5]) &&
                callback.callback_phone === params[6] &&
                callback.callback_receipt === params[7];
            return {
                rows: matches
                    ? [{ callback_id: callback.callback_id, callback_receipt: callback.callback_receipt }]
                    : [],
            };
        }
        if (statement.includes("FROM simulator_payment_confirmations")) {
            const confirmation = state.simulatorConfirmation;
            const matches = confirmation &&
                confirmation.attempt_id === params[0] &&
                String(confirmation.verification_id) === String(params[1]) &&
                confirmation.synthetic_reference === params[2] &&
                confirmation.outcome === "SUCCESS";
            return { rows: matches ? [{ confirmation_id: confirmation.confirmation_id }] : [] };
        }
        if (statement.includes("FROM transactions t") && statement.includes("JOIN contributions c")) {
            const matches = params[0] === state.transaction.transaction_id &&
                params[1] === state.contribution.contribution_id &&
                params[2] === state.account.account_id &&
                state.contribution.transaction_id === state.transaction.transaction_id &&
                state.contribution.account_id === state.account.account_id;
            if (!matches) return { rows: [] };
            return {
                rows: [{
                    ...copy(state.transaction),
                    ...copy(state.contribution),
                    ...copy(state.account),
                    transaction_amount: state.transaction.transaction_amount,
                    contribution_amount: state.contribution.contribution_amount,
                    transaction_status: state.transaction.transaction_status,
                    contribution_status: state.contribution.contribution_status,
                    transaction_checkout_request_id: state.transaction.transaction_checkout_request_id,
                    transaction_phone: state.transaction.transaction_phone,
                    transaction_result_code: state.transaction.transaction_result_code,
                    pension_account_id: state.account.account_id,
                    worker_phone: state.account.phone,
                }],
            };
        }
        if (statement.startsWith("INSERT INTO notifications")) {
            const [userId, message, recipientPhone, deduplicationKey] = params;
            if (state.notifications.some((item) => item.deduplication_key === deduplicationKey)) {
                return { rows: [] };
            }
            const notification = {
                notification_id: "notification_001",
                user_id: userId,
                notification_type: "SMS",
                message,
                recipient_phone: recipientPhone,
                deduplication_key: deduplicationKey,
                delivery_status: "PENDING",
            };
            state.notifications.push(notification);
            return { rows: [] };
        }
        if (statement.startsWith("SELECT transaction_id") && statement.includes("WHERE mpesa_receipt = $1")) {
            const matches = state.otherTransactions.filter(
                (record) => record.mpesa_receipt === params[0] && record.transaction_id !== params[1]
            );
            return { rows: copy(matches) };
        }
        if (statement.startsWith("UPDATE transactions")) {
            if (
                statement.includes("mpesa_receipt IS NULL") &&
                state.transaction.transaction_status === "COMPLETED"
            ) {
                const [receipt, transactionId, checkoutId, phone] = params;
                if (
                    transactionId !== state.transaction.transaction_id ||
                    checkoutId !== state.transaction.transaction_checkout_request_id ||
                    phone !== state.transaction.transaction_phone ||
                    state.transaction.mpesa_receipt !== null
                ) return { rows: [] };
                state.transaction.mpesa_receipt = receipt;
                return { rows: [{ transaction_id: transactionId }] };
            }
            if (state.transaction.transaction_status !== "PENDING") return { rows: [] };
            if (statement.includes("transaction_status = 'COMPLETED'")) {
                const [receipt, checkoutId, phone, description, transactionId] = params;
                if (transactionId !== state.transaction.transaction_id) return { rows: [] };
                if (forceReceiptConstraintViolation && receipt !== null) {
                    const error = new Error("Unique constraint violation");
                    error.code = "23505";
                    error.constraint = "uq_transactions_mpesa_receipt";
                    throw error;
                }
                state.transaction = {
                    ...state.transaction,
                    transaction_status: "COMPLETED",
                    mpesa_receipt: receipt,
                    transaction_checkout_request_id: checkoutId,
                    transaction_phone: phone,
                    transaction_result_code: 0,
                    mpesa_result_description: description,
                    completed_at: "2026-11-03T00:00:00.000Z",
                };
                return { rows: [{ transaction_id: transactionId }] };
            }
            const [status, checkoutId, phone, code, description, transactionId] = params;
            if (transactionId !== state.transaction.transaction_id) return { rows: [] };
            state.transaction = {
                ...state.transaction,
                transaction_status: status,
                transaction_checkout_request_id: checkoutId,
                transaction_phone: phone,
                transaction_result_code: Number(code),
                mpesa_result_description: description,
            };
            return { rows: [{ transaction_id: transactionId }] };
        }
        if (statement.startsWith("UPDATE contributions")) {
            const isSuccess = statement.includes("contribution_status = 'COMPLETED'");
            const [statusOrContributionId, contributionIdOrAccountId, accountIdOrTransactionId, transactionId] = params;
            const status = isSuccess ? "COMPLETED" : statusOrContributionId;
            const contributionId = isSuccess ? statusOrContributionId : contributionIdOrAccountId;
            const accountId = isSuccess ? contributionIdOrAccountId : accountIdOrTransactionId;
            const transaction = isSuccess ? accountIdOrTransactionId : transactionId;
            if (
                contributionId !== state.contribution.contribution_id ||
                accountId !== state.contribution.account_id ||
                transaction !== state.contribution.transaction_id ||
                state.contribution.contribution_status !== "PENDING"
            ) return { rows: [] };
            state.contribution.contribution_status = status;
            return { rows: [{ contribution_id: contributionId }] };
        }
        if (statement.startsWith("INSERT INTO pension_account_movements")) {
            const [accountId, amount, idempotencyKey, transactionId, contributionId,
                attemptId, verificationId, callbackId, simulatorId, providerMode] = params;
            if (accountId !== state.account.account_id ||
                transactionId !== state.transaction.transaction_id ||
                contributionId !== state.contribution.contribution_id ||
                attemptId !== state.attempt.attempt_id ||
                Number(verificationId) !== Number(state.verification.verification_id)) {
                return { rows: [] };
            }
            if (state.movements.some((movement) => movement.contribution_id === contributionId)) {
                return { rows: [] };
            }
            state.movements.push({
                idempotency_key: idempotencyKey,
                account_id: accountId,
                movement_type: "CONTRIBUTION_SETTLEMENT",
                amount,
                transaction_id: transactionId,
                contribution_id: contributionId,
                payment_attempt_id: attemptId,
                payment_verification_id: verificationId,
                payment_callback_id: callbackId,
                simulator_confirmation_id: simulatorId,
                provider_mode: providerMode,
            });
            const [whole, fraction] = amount.split(".");
            const current = state.account.current_balance.split(".");
            const cents = BigInt(current[0]) * 100n + BigInt((current[1] || "").padEnd(2, "0")) +
                BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
            state.account.current_balance = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
            return { rows: [{ movement_id: "movement_001" }] };
        }
        if (statement.startsWith("SELECT current_balance") &&
            statement.includes("FROM pension_accounts")) {
            return { rows: params[0] === state.account.account_id
                ? [{ current_balance: state.account.current_balance }]
                : [] };
        }
        if (statement.startsWith("UPDATE mpesa_payment_attempts")) {
            if (statement.includes("SET attempt_status = 'SETTLED'")) {
                if (!["PROMPT_ACCEPTED", "OUTCOME_UNKNOWN"].includes(state.attempt.attempt_status) ||
                    params[0] !== state.attempt.attempt_id) {
                    return { rows: [] };
                }
                state.attempt.attempt_status = "SETTLED";
                return { rows: [{ attempt_id: state.attempt.attempt_id }] };
            }
            state.attempt.attempt_status = params[0];
            return { rows: [{ attempt_id: state.attempt.attempt_id }] };
        }
        throw new Error(`Unexpected mock settlement query: ${statement}`);
    }

    let connected = false;
    const waiters = [];
    const pool = {
        async connect() {
            if (connected) await new Promise((resolve) => waiters.push(resolve));
            connected = true;
            let released = false;
            return {
                query,
                release() {
                    if (released) return;
                    released = true;
                    connected = false;
                    waiters.shift()?.();
                },
            };
        },
        query,
    };
    return { pool, state };
}

function setup(options = {}) {
    const { ledgerEnforcementEnabled = false, ...poolOptions } = options;
    const database = createSettlementPool(poolOptions);
    return {
        ...database,
        repository: createMpesaPaymentAttemptRepository(database.pool, {
            environmentProvider: () => ({
                MPESA_LEDGER_ENFORCEMENT_ENABLED: ledgerEnforcementEnabled ? "true" : "false",
            }),
        }),
    };
}

function settlementRequest(overrides = {}) {
    return { attemptId: "attempt_001", verificationId: 1, ...overrides };
}

test("atomically settles callback-verified payment with its durable M-Pesa receipt", async () => {
    const { repository, state } = setup({ ledgerEnforcementEnabled: true });
    const result = await repository.settleVerifiedPayment(settlementRequest());

    assert.equal(result.alreadySettled, false);
    assert.equal(result.transaction_status, "COMPLETED");
    assert.equal(result.contribution_status, "COMPLETED");
    assert.equal(state.transaction.mpesa_receipt, "QAB123XYZ");
    assert.equal(state.transaction.transaction_checkout_request_id, "checkout_001");
    assert.equal(state.transaction.transaction_phone, "254712345678");
    assert.equal(state.account.current_balance, "3500.00");
    assert.equal(state.movements.length, 1);
    assert.equal(state.movements[0].movement_type, "CONTRIBUTION_SETTLEMENT");
    assert.equal(state.movements[0].provider_mode, "DARAJA");
    assert.equal(state.attempt.attempt_status, "SETTLED");
    assert.equal(state.notifications.length, 0);
    assert.deepEqual(state.fundSnapshots, [
        { contribution_id: "contribution_001", fund_id: "fund_001", allocated_amount: "1750.00" },
        { contribution_id: "contribution_001", fund_id: "fund_002", allocated_amount: "750.00" },
    ]);
    assert.ok(state.queries.some((sql) => sql.includes("FOR UPDATE OF t, c, u")));
    assert.equal(state.queries.filter((sql) => sql.startsWith("UPDATE pension_accounts")).length, 0);
    assert.equal(
        state.queries.some((sql) => sql.startsWith("INSERT INTO notifications")),
        false
    );
    assert.ok(state.queries.includes("SELECT status FROM pension_ledger WHERE singleton_key IS TRUE"));
});

test("ledger enforcement rolls back a verified settlement before financial writes", async () => {
    const { repository, state } = setup({
        ledgerEnforcementEnabled: true,
        ledgerStatus: "PREPARING",
    });

    await assert.rejects(repository.settleVerifiedPayment(settlementRequest()), {
        code: "PENSION_LEDGER_NOT_ACTIVE",
        statusCode: 503,
    });

    assert.equal(state.transaction.transaction_status, "PENDING");
    assert.equal(state.contribution.contribution_status, "PENDING");
    assert.equal(state.account.current_balance, "1000.00");
    assert.equal(state.movements.length, 0);
    assert.equal(state.rollbackCount, 1);
    assert.equal(
        state.queries.some((sql) => sql.startsWith("UPDATE transactions")),
        false
    );
});

test("query-only verified success settles without inventing a receipt", async () => {
    const { repository, state } = setup({
        verification: {
            verification_source: "RECONCILIATION",
            callback_result_code: null,
            callback_amount_matches: null,
            callback_phone_matches: null,
            callback_receipt: null,
        },
    });
    const result = await repository.settleVerifiedPayment(settlementRequest());

    assert.equal(result.alreadySettled, false);
    assert.equal(state.transaction.transaction_status, "COMPLETED");
    assert.equal(state.transaction.mpesa_receipt, null);
    assert.equal(state.transaction.transaction_checkout_request_id, "checkout_001");
    assert.equal(state.transaction.transaction_phone, "254712345678");
    assert.equal(state.account.current_balance, "3500.00");
    assert.equal(state.queries.filter((sql) => sql.startsWith("UPDATE pension_accounts")).length, 0);
    assert.equal(state.notifications.length, 0);
});

test("simulated query success uses its synthetic reference and never queues an SMS", async () => {
    const syntheticReference = `SIM${"A".repeat(22)}`;
    const { repository, state } = setup({
        attempt: {
            provider_mode: "SIMULATOR",
            checkout_request_id: syntheticReference,
            merchant_request_id: `SIMM${"A".repeat(21)}`,
        },
        verification: {
            provider_mode: "SIMULATOR",
            simulator_outcome: "SUCCESS",
            verification_source: "RECONCILIATION",
            checkout_request_id: syntheticReference,
            merchant_request_id: `SIMM${"A".repeat(21)}`,
            callback_result_code: null,
            callback_amount_matches: null,
            callback_phone_matches: null,
            callback_receipt: null,
            provider_result_description:
                "SIMULATED: Payment succeeded; no real money was transferred.",
        },
    });
    state.simulatorConfirmation = {
        confirmation_id: "confirmation-001",
        attempt_id: "attempt_001",
        verification_id: 1,
        synthetic_reference: syntheticReference,
        outcome: "SUCCESS",
    };

    await repository.settleVerifiedPayment(settlementRequest());
    const duplicate = await repository.settleVerifiedPayment(settlementRequest());

    assert.equal(duplicate.alreadySettled, true);
    assert.equal(state.transaction.mpesa_receipt, null);
    assert.equal(state.attempt.checkout_request_id, syntheticReference);
    assert.equal(state.transaction.transaction_status, "COMPLETED");
    assert.equal(state.contribution.contribution_status, "COMPLETED");
    assert.equal(state.account.current_balance, "3500.00");
    assert.equal(state.notifications.length, 0);
    assert.equal(state.queries.some((sql) => sql.startsWith("INSERT INTO notifications")), false);
    assert.equal(state.queries.filter((sql) => sql.startsWith("UPDATE pension_accounts")).length, 0);
    assert.equal(state.movements[0].simulator_confirmation_id, "confirmation-001");
    assert.equal(state.movements[0].payment_callback_id, null);
});

test("simulated verified failure does not complete the contribution or credit its balance", async () => {
    const syntheticReference = `SIM${"B".repeat(22)}`;
    const { repository, state } = setup({
        attempt: {
            provider_mode: "SIMULATOR",
            checkout_request_id: syntheticReference,
            merchant_request_id: `SIMM${"B".repeat(21)}`,
        },
        verification: {
            provider_mode: "SIMULATOR",
            simulator_outcome: "FAILED",
            verification_source: "RECONCILIATION",
            checkout_request_id: syntheticReference,
            merchant_request_id: `SIMM${"B".repeat(21)}`,
            callback_result_code: null,
            callback_amount_matches: null,
            callback_phone_matches: null,
            callback_receipt: null,
            provider_result_code: "1",
            provider_result_description:
                "SIMULATED: Payment failed; no real money was transferred.",
            verification_status: "VERIFIED_FAILURE",
        },
    });

    await repository.settleVerifiedPayment(settlementRequest());

    assert.equal(state.transaction.transaction_status, "PENDING");
    assert.equal(state.contribution.contribution_status, "PENDING");
    assert.equal(state.transaction.mpesa_receipt, null);
    assert.equal(state.account.current_balance, "1000.00");
    assert.equal(state.attempt.attempt_status, "FAILED");
    assert.equal(state.notifications.length, 0);
});

test("late callback receipt does not alter an already-settled query-only transaction", async () => {
    const { repository, state } = setup({
        verification: {
            verification_source: "RECONCILIATION",
            provider_mode: "DARAJA",
            callback_result_code: null,
            callback_amount_matches: null,
            callback_phone_matches: null,
            callback_receipt: null,
        },
    });
    await repository.settleVerifiedPayment(settlementRequest());
    state.verification = {
        ...state.verification,
        verification_id: 2,
        verification_source: "CALLBACK",
        callback_result_code: "0",
        callback_amount_matches: true,
        callback_phone_matches: true,
        callback_receipt: "LATE123RECEIPT",
    };
    state.callbackEvidence = {
        callback_id: 2,
        attempt_id: "attempt_001",
        verification_id: 2,
        callback_fingerprint: "a".repeat(64),
        callback_status: "VERIFIED",
        checkout_request_id: "checkout_001",
        merchant_request_id: "merchant_001",
        callback_result_code: "0",
        callback_amount: "2500.00",
        callback_phone: "254712345678",
        callback_receipt: "LATE123RECEIPT",
    };

    const result = await repository.settleVerifiedPayment(settlementRequest({ verificationId: 2 }));

    assert.equal(result.alreadySettled, true);
    assert.equal(state.transaction.mpesa_receipt, null);
    assert.equal(state.account.current_balance, "3500.00");
    assert.equal(state.queries.filter((sql) => sql.startsWith("UPDATE pension_accounts")).length, 0);
    assert.equal(state.notifications.length, 0);
    assert.equal(state.queries.some((sql) => /SET mpesa_receipt/.test(sql)), false);
});

test("conflicting late callback receipt cannot replace an already-settled receipt", async () => {
    const { repository, state } = setup({
        transaction: {
            transaction_status: "COMPLETED",
            mpesa_receipt: "ORIGINAL123",
            transaction_checkout_request_id: "checkout_001",
            transaction_phone: "254712345678",
            transaction_result_code: 0,
        },
        contribution: { contribution_status: "COMPLETED" },
    });
    await assert.rejects(
        repository.settleVerifiedPayment(settlementRequest()),
        { code: "PAYMENT_RECEIPT_CONFLICT" }
    );
    assert.equal(state.transaction.mpesa_receipt, "ORIGINAL123");
    assert.equal(state.account.current_balance, "1000.00");
});

test("ledger persistence failure rolls back settlement atomically", async () => {
    const { repository, state } = setup({ failOn: "INSERT INTO pension_account_movements" });
    await assert.rejects(repository.settleVerifiedPayment(settlementRequest()));

    assert.equal(state.transaction.transaction_status, "PENDING");
    assert.equal(state.contribution.contribution_status, "PENDING");
    assert.equal(state.account.current_balance, "1000.00");
    assert.equal(state.notifications.length, 0);
    assert.equal(state.rollbackCount, 1);
});

test("repeated callback settlement cannot create duplicate ledger movements", async () => {
    const { repository, state } = setup({ attempt: { attempt_status: "OUTCOME_UNKNOWN" } });
    await repository.settleVerifiedPayment(settlementRequest());
    const repeated = await repository.settleVerifiedPayment(settlementRequest());

    assert.equal(repeated.alreadySettled, true);
    assert.equal(state.transaction.mpesa_receipt, "QAB123XYZ");
    assert.equal(state.account.current_balance, "3500.00");
    assert.equal(state.attempt.attempt_status, "SETTLED");
    assert.equal(state.movements.length, 1);
    assert.equal(state.notifications.length, 0);
});

test("already-settled callback replay remains idempotent when readiness later becomes unavailable", async () => {
    const { repository, state } = setup({ ledgerEnforcementEnabled: true });
    await repository.settleVerifiedPayment(settlementRequest());
    state.ledgerStatus = null;
    const readinessChecksBeforeReplay = state.queries.filter(
        (sql) => sql === "SELECT status FROM pension_ledger WHERE singleton_key IS TRUE"
    ).length;

    const repeated = await repository.settleVerifiedPayment(settlementRequest());

    assert.equal(repeated.alreadySettled, true);
    assert.equal(state.movements.length, 1);
    assert.equal(
        state.queries.filter(
            (sql) => sql === "SELECT status FROM pension_ledger WHERE singleton_key IS TRUE"
        ).length,
        readinessChecksBeforeReplay
    );
});

test("payment settlement does not create its own SMS notification", async () => {
    const { repository, state } = setup();
    await repository.settleVerifiedPayment(settlementRequest());
    assert.equal(state.notifications.length, 0);
    assert.equal(state.transaction.transaction_status, "COMPLETED");
    assert.equal(state.contribution.contribution_status, "COMPLETED");
    assert.equal(state.account.current_balance, "3500.00");
});

test("concurrent identical settlements serialize and credit the balance once", async () => {
    const { repository, state } = setup();
    const results = await Promise.all([
        repository.settleVerifiedPayment(settlementRequest()),
        repository.settleVerifiedPayment(settlementRequest()),
    ]);

    assert.equal(results.filter((result) => result.alreadySettled).length, 1);
    assert.equal(state.account.current_balance, "3500.00");
    assert.equal(state.movements.length, 1);
    assert.equal(state.notifications.length, 0);
});

test("duplicate provider receipt is rejected without changing financial records", async () => {
    const { repository, state } = setup({
        otherTransactions: [{ transaction_id: "transaction_other", mpesa_receipt: "QAB123XYZ" }],
    });
    await assert.rejects(repository.settleVerifiedPayment(settlementRequest()), {
        code: "DUPLICATE_MPESA_RECEIPT",
        statusCode: 409,
    });
    assert.equal(state.transaction.transaction_status, "PENDING");
    assert.equal(state.contribution.contribution_status, "PENDING");
    assert.equal(state.account.current_balance, "1000.00");
    assert.equal(state.movements.length, 0);
    assert.equal(state.rollbackCount, 1);
});

test("database receipt uniqueness violation rolls back settlement safely", async () => {
    const { repository, state } = setup({ forceReceiptConstraintViolation: true });

    await assert.rejects(repository.settleVerifiedPayment(settlementRequest()), {
        code: "DUPLICATE_MPESA_RECEIPT",
        statusCode: 409,
    });

    assert.equal(state.transaction.transaction_status, "PENDING");
    assert.equal(state.contribution.contribution_status, "PENDING");
    assert.equal(state.transaction.mpesa_receipt, null);
    assert.equal(state.account.current_balance, "1000.00");
    assert.equal(state.movements.length, 0);
    assert.equal(state.rollbackCount, 1);
});

test("callback verification cannot settle unless the durable inbox receipt matches", async () => {
    const { repository, state } = setup();
    state.callbackEvidence.callback_receipt = "DIFFERENT123";

    await assert.rejects(repository.settleVerifiedPayment(settlementRequest()), {
        code: "PAYMENT_NOT_VERIFIED",
        statusCode: 409,
    });

    assert.equal(state.transaction.transaction_status, "PENDING");
    assert.equal(state.contribution.contribution_status, "PENDING");
    assert.equal(state.transaction.mpesa_receipt, null);
    assert.equal(state.account.current_balance, "1000.00");
    assert.equal(state.movements.length, 0);
    assert.equal(state.rollbackCount, 1);
});

test("mismatched transaction amount, account ownership, and worker role are rejected", async () => {
    for (const options of [
        { transaction: { transaction_amount: "2499.99" } },
        { account: { account_id: "account_other" } },
        { account: { role: "FUND_MANAGER" } },
    ]) {
        const { repository, state } = setup(options);
        await assert.rejects(repository.settleVerifiedPayment(settlementRequest()));
        assert.equal(state.account.current_balance, "1000.00");
    }
});

test("unverified evidence cannot settle and ambiguous evidence remains pending", async () => {
    for (const verification of [
        { verification_status: "UNVERIFIED" },
        { verification_status: "PROCESSING" },
        { verification_status: "VERIFIED_SUCCESS", callback_phone_matches: false },
        { verification_status: "VERIFIED_SUCCESS", callback_amount_matches: false },
        { verification_status: "VERIFIED_SUCCESS", provider_result_code: "1032" },
        { verification_status: "VERIFIED_SUCCESS", merchant_request_id: "merchant_forged" },
    ]) {
        const { repository, state } = setup({ verification });
        await assert.rejects(repository.settleVerifiedPayment(settlementRequest()));
        assert.equal(state.transaction.transaction_status, "PENDING");
        assert.equal(state.account.current_balance, "1000.00");
    }
});

test("verified failure terminalizes only the attempt and leaves the unpaid obligation pending", async () => {
    for (const [resultCode, expectedStatus] of [["1032", "CANCELLED"], ["1037", "TIMED_OUT"], ["1", "FAILED"]]) {
        const { repository, state } = setup({
            verification: {
                verification_source: "RECONCILIATION",
                callback_result_code: null,
                callback_amount_matches: null,
                callback_phone_matches: null,
                callback_receipt: null,
                provider_result_code: resultCode,
                verification_status: "VERIFIED_FAILURE",
            },
        });
        const result = await repository.settleVerifiedPayment(settlementRequest());

        assert.equal(result.attempt_status, expectedStatus);
        assert.equal(result.transaction_status, "PENDING");
        assert.equal(result.contribution_status, "PENDING");
        assert.equal(state.transaction.transaction_status, "PENDING");
        assert.equal(state.contribution.contribution_status, "PENDING");
        assert.equal(state.attempt.attempt_status, expectedStatus);
        assert.equal(state.transaction.mpesa_receipt, null);
        assert.equal(state.account.current_balance, "1000.00");
        assert.equal(state.queries.some((sql) => sql.startsWith("UPDATE pension_accounts")), false);
        assert.equal(state.queries.some((sql) =>
            sql.startsWith("UPDATE transactions") || sql.startsWith("UPDATE contributions")
        ), false);
    }
});

test("already terminal or conflicting records fail without changing a confirmed outcome", async () => {
    const { repository, state } = setup({
        transaction: {
            transaction_status: "FAILED",
            transaction_result_code: 1032,
        },
        contribution: { contribution_status: "FAILED" },
        attempt: { attempt_status: "FAILED" },
    });
    await assert.rejects(repository.settleVerifiedPayment(settlementRequest()), {
        code: "PAYMENT_ALREADY_TERMINAL",
    });
    assert.equal(state.transaction.transaction_status, "FAILED");
    assert.equal(state.account.current_balance, "1000.00");
});

test("partial settlement failure rolls back transaction, contribution, movement, and balance", async () => {
    const { repository, state } = setup({ failOn: "INSERT INTO pension_account_movements" });
    await assert.rejects(repository.settleVerifiedPayment(settlementRequest()), /Injected settlement write failure/);

    assert.equal(state.rollbackCount, 1);
    assert.equal(state.transaction.transaction_status, "PENDING");
    assert.equal(state.transaction.mpesa_receipt, null);
    assert.equal(state.contribution.contribution_status, "PENDING");
    assert.equal(state.movements.length, 0);
    assert.equal(state.account.current_balance, "1000.00");
});
