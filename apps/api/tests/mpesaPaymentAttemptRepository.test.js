const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createMpesaPaymentAttemptRepository,
} = require("../src/services/mpesaPaymentAttemptRepository");

const workerId = "worker_001";
const contributionId = "contribution_001";
const phoneNumber = "254712345678";

function createContribution(overrides = {}) {
    return {
        contribution_id: contributionId,
        account_id: "account_001",
        transaction_id: "transaction_001",
        contribution_amount: "250.00",
        channel: "MPESA",
        contribution_status: "PENDING",
        transaction_type: "CONTRIBUTION",
        transaction_amount: "250.00",
        transaction_status: "PENDING",
        user_id: workerId,
        account_status: "ACTIVE",
        user_status: "ACTIVE",
        role: "WORKER",
        ...overrides,
    };
}

function copy(value) {
    return JSON.parse(JSON.stringify(value));
}

function createMockPool({
    contributions = [createContribution()],
    simulateConcurrentConflict = false,
    concurrentWinner = {},
    simulateActiveAttemptConstraintConflict = false,
    account = { account_id: "account_001", user_id: workerId },
    allocations = [
        { allocation_id: "allocation_001", fund_id: "fund_001", percentage: "70.00", fund_name: "Balanced", fund_status: "ACTIVE" },
        { allocation_id: "allocation_002", fund_id: "fund_002", percentage: "30.00", fund_name: "Growth", fund_status: "ACTIVE" },
    ],
} = {}) {
    const state = {
        contributions: copy(contributions),
        createdContributions: [],
        createdTransactions: [],
        fundSnapshots: [],
        attempts: [],
        verifications: [],
        nextId: 1,
        nextVerificationId: 1,
        balances: { account_001: 1000 },
        rollbackCount: 0,
        failInsert: false,
        simulateConcurrentConflict,
        simulateActiveAttemptConstraintConflict,
        concurrentWinner,
        concurrentWinnerRecord: null,
        account: copy(account),
        allocations: copy(allocations),
        queries: [],
        snapshot: null,
    };

    const client = {
        async query(sql, params = []) {
            const normalizedSql = sql.trim();
            state.queries.push(normalizedSql);

            if (normalizedSql.startsWith("BEGIN")) {
                state.snapshot = {
                    attempts: copy(state.attempts),
                    verifications: copy(state.verifications),
                    createdContributions: copy(state.createdContributions),
                    createdTransactions: copy(state.createdTransactions),
                    fundSnapshots: copy(state.fundSnapshots),
                    nextId: state.nextId,
                    nextVerificationId: state.nextVerificationId,
                    balances: copy(state.balances),
                };
                return { rows: [] };
            }
            if (normalizedSql === "COMMIT") {
                state.snapshot = null;
                return { rows: [] };
            }
            if (normalizedSql === "ROLLBACK") {
                state.rollbackCount += 1;
                if (state.snapshot) {
                    state.attempts = state.snapshot.attempts;
                    state.verifications = state.snapshot.verifications;
                    state.createdContributions = state.snapshot.createdContributions;
                    state.createdTransactions = state.snapshot.createdTransactions;
                    state.fundSnapshots = state.snapshot.fundSnapshots;
                    state.nextId = state.snapshot.nextId;
                    state.nextVerificationId = state.snapshot.nextVerificationId;
                    state.balances = state.snapshot.balances;
                }
                state.snapshot = null;
                return { rows: [] };
            }
            if (
                normalizedSql.startsWith("UPDATE mpesa_payment_verifications") &&
                normalizedSql.includes("SET verification_status = CASE")
            ) {
                const [status, providerCode, description, simulatorOutcome, verificationId] = params;
                const verification = state.verifications.find(
                    (item) => item.verification_id === verificationId
                );
                if (!verification || verification.verification_status !== "PROCESSING") return { rows: [] };
                Object.assign(verification, {
                    verification_status: status,
                    provider_result_code: providerCode,
                    provider_result_description: description,
                    simulator_outcome: simulatorOutcome,
                    completed_at: new Date().toISOString(),
                });
                return { rows: [copy(verification)] };
            }
            if (normalizedSql.includes("SELECT c.contribution_id")) {
                const contribution = state.contributions.find((item) =>
                    item.contribution_id === params[0] &&
                    item.user_id === params[1] &&
                    item.account_status === "ACTIVE" &&
                    item.user_status === "ACTIVE" &&
                    item.role === "WORKER"
                );
                return { rows: contribution ? [copy(contribution)] : [] };
            }
            if (
                normalizedSql.includes("FROM mpesa_payment_attempts") &&
                normalizedSql.includes("WHERE contribution_id = $1") &&
                normalizedSql.includes("'PENDING', 'OUTCOME_UNKNOWN', 'PROMPT_ACCEPTED'")
            ) {
                const attempt = state.attempts.find((item) =>
                    item.contribution_id === params[0] &&
                    ["PENDING", "OUTCOME_UNKNOWN", "PROMPT_ACCEPTED"].includes(item.attempt_status)
                );
                return { rows: attempt ? [{ attempt_id: attempt.attempt_id, attempt_status: attempt.attempt_status }] : [] };
            }
            if (normalizedSql.includes("FROM pension_accounts p") && normalizedSql.includes("JOIN users u")) {
                return {
                    rows: state.account && state.account.user_id === params[0]
                        ? [copy(state.account)]
                        : [],
                };
            }
            if (normalizedSql.includes("FROM fund_allocations fa")) {
                return { rows: copy(state.allocations) };
            }
            if (
                normalizedSql.includes("FROM mpesa_payment_attempts") &&
                normalizedSql.includes("WHERE attempt_id = $1")
            ) {
                const attempt = state.attempts.find((item) => item.attempt_id === params[0]);
                return { rows: attempt ? [copy(attempt)] : [] };
            }
            if (
                normalizedSql.includes("FROM mpesa_payment_verifications") &&
                normalizedSql.includes("WHERE callback_fingerprint = $1")
            ) {
                const verification = state.verifications.find(
                    (item) => item.callback_fingerprint === params[0]
                );
                return { rows: verification ? [copy(verification)] : [] };
            }
            if (
                normalizedSql.includes("FROM mpesa_payment_verifications") &&
                normalizedSql.includes("verification_status IN ('VERIFIED_SUCCESS', 'VERIFIED_FAILURE')")
            ) {
                const verification = state.verifications.find((item) =>
                    item.attempt_id === params[0] &&
                    ["VERIFIED_SUCCESS", "VERIFIED_FAILURE"].includes(item.verification_status)
                );
                return { rows: verification ? [copy(verification)] : [] };
            }
            if (
                normalizedSql.includes("FROM mpesa_payment_verifications") &&
                normalizedSql.includes("verification_status = 'PROCESSING'")
            ) {
                const verification = state.verifications.find((item) =>
                    item.attempt_id === params[0] &&
                    item.verification_status === "PROCESSING"
                );
                return { rows: verification ? [copy(verification)] : [] };
            }
            if (normalizedSql.startsWith("INSERT INTO mpesa_payment_verifications")) {
                const source = normalizedSql.includes("'CALLBACK'") ? "CALLBACK" : "RECONCILIATION";
                const verification = {
                    verification_id: state.nextVerificationId++,
                    attempt_id: params[0],
                    provider_mode: state.attempts.find((item) => item.attempt_id === params[0])?.provider_mode ?? null,
                    verification_source: source,
                    checkout_request_id: params[1],
                    merchant_request_id: params[2],
                    callback_fingerprint: source === "CALLBACK" ? params[3] : null,
                    callback_result_code: source === "CALLBACK" ? params[4] : null,
                    callback_amount_matches: source === "CALLBACK" ? params[5] : null,
                    callback_phone_matches: source === "CALLBACK" ? params[6] : null,
                    callback_receipt: source === "CALLBACK" ? params[7] : null,
                    verification_status: "PROCESSING",
                    provider_result_code: null,
                    provider_result_description: null,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    completed_at: null,
                };
                state.verifications.push(verification);
                return { rows: [copy(verification)] };
            }
            if (normalizedSql.startsWith("INSERT INTO transactions")) {
                const transaction = {
                    transaction_id: `transaction_created_${String(state.nextId++).padStart(3, "0")}`,
                    amount: params[0],
                    transaction_status: "PENDING",
                };
                state.createdTransactions.push(transaction);
                return { rows: [copy(transaction)] };
            }
            if (normalizedSql.startsWith("INSERT INTO contributions")) {
                const contribution = {
                    contribution_id: `contribution_created_${String(state.nextId++).padStart(3, "0")}`,
                    account_id: params[0],
                    transaction_id: params[1],
                    amount: params[2],
                    channel: "MPESA",
                    contribution_status: "PENDING",
                };
                state.createdContributions.push(contribution);
                return { rows: [copy(contribution)] };
            }
            if (normalizedSql.startsWith("INSERT INTO contribution_fund_allocations")) {
                state.fundSnapshots.push({
                    contribution_id: params[0],
                    account_id: params[1],
                    fund_id: params[2],
                    fund_name: params[3],
                    allocation_percentage: params[4],
                    allocated_amount: params[5],
                });
                return { rows: [] };
            }
            if (normalizedSql.includes("WHERE a.idempotency_key = $1")) {
                const attempt = state.attempts.find((item) => item.idempotency_key === params[0]) ||
                    (state.concurrentWinnerRecord?.idempotency_key === params[0]
                        ? state.concurrentWinnerRecord
                        : null);
                return { rows: attempt ? [{ ...copy(attempt), user_id: workerId }] : [] };
            }
            if (normalizedSql.startsWith("INSERT INTO mpesa_payment_attempts")) {
                if (state.failInsert) throw new Error("Mock insert failure");
                if (state.simulateActiveAttemptConstraintConflict) {
                    state.simulateActiveAttemptConstraintConflict = false;
                    const error = new Error("Active attempt unique constraint");
                    error.code = "23505";
                    error.constraint = "uq_mpesa_payment_attempts_one_active_per_contribution";
                    throw error;
                }
                if (state.simulateConcurrentConflict) {
                    const winner = {
                        attempt_id: "attempt_concurrent_winner",
                        account_id: params[0],
                        contribution_id: params[1],
                        transaction_id: params[2],
                        idempotency_key: params[3],
                        expected_amount: Number(params[4]).toFixed(2),
                        mpesa_phone: params[5],
                        attempt_status: "PENDING",
                        provider_mode: params[6],
                        checkout_request_id: null,
                        merchant_request_id: null,
                        provider_result_code: null,
                        provider_result_description: null,
                        created_at: "2026-01-01T00:00:00.000Z",
                        updated_at: "2026-01-01T00:00:00.000Z",
                        provider_accepted_at: null,
                        user_id: workerId,
                        ...copy(state.concurrentWinner),
                    };
                    state.concurrentWinnerRecord = winner;
                    state.simulateConcurrentConflict = false;
                    return { rows: [] };
                }
                if (state.attempts.some((item) => item.idempotency_key === params[3])) {
                    return { rows: [] };
                }
                if (state.attempts.some((item) =>
                    item.contribution_id === params[1] &&
                    ["PENDING", "OUTCOME_UNKNOWN", "PROMPT_ACCEPTED"].includes(item.attempt_status)
                )) {
                    const error = new Error("Active attempt unique constraint");
                    error.code = "23505";
                    error.constraint = "uq_mpesa_payment_attempts_one_active_per_contribution";
                    throw error;
                }
                const attempt = {
                    attempt_id: `attempt_${String(state.nextId++).padStart(3, "0")}`,
                    account_id: params[0],
                    contribution_id: params[1],
                    transaction_id: params[2],
                    idempotency_key: params[3],
                    expected_amount: Number(params[4]).toFixed(2),
                    mpesa_phone: params[5],
                    attempt_status: "PENDING",
                    provider_mode: params[6],
                    checkout_request_id: null,
                    merchant_request_id: null,
                    provider_result_code: null,
                    provider_result_description: null,
                    created_at: "2026-01-01T00:00:00.000Z",
                    updated_at: "2026-01-01T00:00:00.000Z",
                    provider_accepted_at: null,
                };
                state.attempts.push(attempt);
                return { rows: [copy(attempt)] };
            }
            if (normalizedSql.startsWith("UPDATE mpesa_payment_attempts") &&
                normalizedSql.includes("SET attempt_status = 'OUTCOME_UNKNOWN'")) {
                const attempt = state.attempts.find((item) => item.attempt_id === params[0]);
                if (!attempt || attempt.attempt_status !== "PENDING") return { rows: [] };
                attempt.attempt_status = "OUTCOME_UNKNOWN";
                return { rows: [{ attempt_id: attempt.attempt_id, attempt_status: attempt.attempt_status }] };
            }
            if (normalizedSql.startsWith("UPDATE mpesa_payment_verifications") &&
                normalizedSql.includes("SET verification_status = 'UNVERIFIED'")) {
                for (const verification of state.verifications) {
                    if (verification.attempt_id === params[0] && verification.verification_status === "PROCESSING") {
                        Object.assign(verification, {
                            verification_status: "UNVERIFIED",
                            completed_at: new Date().toISOString(),
                        });
                    }
                }
                return { rows: [] };
            }
            if (normalizedSql.startsWith("UPDATE mpesa_payment_verifications") &&
                normalizedSql.includes("SET verification_status = 'PROCESSING'")) {
                const [
                    verificationId,
                    checkoutRequestId,
                    merchantRequestId,
                    callbackCode,
                    amountMatches,
                    phoneMatches,
                    receipt,
                ] = params;
                const verification = state.verifications.find(
                    (item) => item.verification_id === verificationId
                );
                if (!verification) return { rows: [] };
                Object.assign(verification, {
                    verification_status: "PROCESSING",
                    checkout_request_id: checkoutRequestId,
                    merchant_request_id: merchantRequestId,
                    callback_result_code: callbackCode,
                    callback_amount_matches: amountMatches,
                    callback_phone_matches: phoneMatches,
                    callback_receipt: receipt,
                    provider_result_code: null,
                    provider_result_description: null,
                    completed_at: null,
                });
                return { rows: [copy(verification)] };
            }
            if (normalizedSql.startsWith("UPDATE mpesa_payment_attempts") &&
                normalizedSql.includes("SET attempt_status = 'FAILED'")) {
                const [resultCode, description, attemptId] = params;
                const attempt = state.attempts.find((item) => item.attempt_id === attemptId);
                if (!attempt || attempt.attempt_status !== "OUTCOME_UNKNOWN") return { rows: [] };
                Object.assign(attempt, {
                    attempt_status: "FAILED",
                    provider_result_code: resultCode,
                    provider_result_description: description,
                });
                return { rows: [copy(attempt)] };
            }
            if (normalizedSql.startsWith("UPDATE mpesa_payment_attempts")) {
                const [checkoutId, merchantId, resultCode, description, attemptId, expectedStatus] = params;
                const attempt = state.attempts.find((item) => item.attempt_id === attemptId);
                if (!attempt || attempt.attempt_status !== expectedStatus) return { rows: [] };
                if (state.attempts.some((item) =>
                    item.attempt_id !== attemptId &&
                    (item.checkout_request_id === checkoutId || item.merchant_request_id === merchantId)
                )) {
                    const error = new Error("Unique identifier conflict");
                    error.code = "23505";
                    throw error;
                }
                Object.assign(attempt, {
                    checkout_request_id: checkoutId,
                    merchant_request_id: merchantId,
                    provider_result_code: resultCode,
                    provider_result_description: description,
                    attempt_status: "PROMPT_ACCEPTED",
                    provider_accepted_at: "2026-01-01T00:00:01.000Z",
                });
                return { rows: [copy(attempt)] };
            }
            if (normalizedSql.includes("WHERE a.attempt_id = $1")) {
                const attempt = state.attempts.find((item) => item.attempt_id === params[0]);
                return { rows: attempt ? [{ ...copy(attempt), user_id: workerId }] : [] };
            }
            if (normalizedSql.includes("WHERE a.checkout_request_id = $1")) {
                const attempt = state.attempts.find((item) => item.checkout_request_id === params[0]);
                return { rows: attempt ? [{ ...copy(attempt), user_id: workerId }] : [] };
            }
            throw new Error(`Unexpected mock query: ${normalizedSql}`);
        },
        release() {},
    };

    return {
        state,
        pool: { connect: async () => client, query: client.query },
    };
}

function createRepository(options) {
    const mock = createMockPool(options);
    return {
        ...mock,
        repository: createMpesaPaymentAttemptRepository(mock.pool),
    };
}

function request(overrides = {}) {
    return {
        workerId,
        contributionId,
        idempotencyKey: "demo-attempt-key-001",
        phoneNumber,
        ...overrides,
    };
}

test("creates a pending attempt tied to an existing pending contribution", async () => {
    const { repository, state } = createRepository();
    const result = await repository.createPendingPaymentAttempt(request());

    assert.equal(result.created, true);
    assert.equal(result.attempt.attempt_status, "PENDING");
    assert.equal(result.attempt.expected_amount, "250.00");
    assert.equal(result.attempt.account_id, "account_001");
    assert.equal(result.attempt.transaction_id, "transaction_001");
    assert.equal(state.attempts.length, 1);
    assert.equal(state.balances.account_001, 1000);
    assert.equal(state.queries.some((sql) => sql.startsWith("UPDATE contributions")), false);
    assert.equal(state.queries.some((sql) => sql.startsWith("UPDATE pension_accounts")), false);
});

test("attempt provider is assigned from server configuration, not client input", async () => {
    const mock = createMockPool();
    const repository = createMpesaPaymentAttemptRepository(mock.pool, {
        providerModeProvider: () => ({ provider: "SIMULATOR", simulatorEnabled: true }),
    });
    const result = await repository.createPendingPaymentAttempt(
        request({ providerMode: "DARAJA" })
    );
    const repeated = await repository.createPendingPaymentAttempt(
        request({ providerMode: "DARAJA" })
    );

    assert.equal(result.attempt.provider_mode, "SIMULATOR");
    assert.equal(mock.state.attempts[0].provider_mode, "SIMULATOR");
    assert.equal(repeated.created, false);
    assert.equal(repeated.attempt.provider_mode, "SIMULATOR");
});

test("attempt creation rejects a simulator not explicitly enabled by server configuration", async () => {
    const mock = createMockPool();
    const repository = createMpesaPaymentAttemptRepository(mock.pool, {
        providerModeProvider: () => ({ provider: "SIMULATOR", simulatorEnabled: false }),
    });

    await assert.rejects(
        repository.createPendingPaymentAttempt(request()),
        { code: "PAYMENT_PROVIDER_CONFIGURATION_ERROR", statusCode: 503 }
    );
    assert.equal(mock.state.attempts.length, 0);
    assert.equal(mock.state.queries.some((sql) =>
        sql.startsWith("INSERT INTO mpesa_payment_attempts")
    ), false);
});

test("creates a retry against the existing contribution without duplicating obligation or allocations", async () => {
    const { repository, state } = createRepository();
    const result = await repository.createPaymentAttemptForContribution({
        ...request(),
        amount: 250,
    });

    assert.equal(result.created, true);
    assert.equal(result.attempt.contribution_id, contributionId);
    assert.equal(result.attempt.transaction_id, "transaction_001");
    assert.equal(state.createdTransactions.length, 0);
    assert.equal(state.createdContributions.length, 0);
    assert.equal(state.fundSnapshots.length, 0);
});

test("same retry idempotency key returns its attempt and rejects changed request fields", async () => {
    const { repository, state } = createRepository();
    const retry = { ...request(), amount: 250 };
    const first = await repository.createPaymentAttemptForContribution(retry);
    const repeated = await repository.createPaymentAttemptForContribution(retry);

    assert.equal(repeated.created, false);
    assert.equal(repeated.attempt.attempt_id, first.attempt.attempt_id);
    for (const changed of [
        { phoneNumber: "254712345679" },
        { workerId: "worker_002" },
        { amount: 251 },
        { contributionId: "contribution_002" },
    ]) {
        await assert.rejects(
            repository.createPaymentAttemptForContribution({ ...retry, ...changed }),
            { code: "IDEMPOTENCY_KEY_CONFLICT", statusCode: 409 }
        );
    }
    assert.equal(state.attempts.length, 1);
});

test("a definitive failed attempt permits a new attempt on the same pending obligation", async () => {
    const { repository, state } = createRepository();
    const first = await repository.createPaymentAttemptForContribution({
        ...request(),
        amount: 250,
    });
    state.attempts[0].attempt_status = "FAILED";

    const retry = await repository.createPaymentAttemptForContribution({
        ...request({ idempotencyKey: "demo-attempt-key-002" }),
        amount: 250,
    });

    assert.equal(retry.created, true);
    assert.notEqual(retry.attempt.attempt_id, first.attempt.attempt_id);
    assert.equal(retry.attempt.contribution_id, first.attempt.contribution_id);
    assert.equal(retry.attempt.transaction_id, first.attempt.transaction_id);
    assert.equal(state.createdContributions.length, 0);
    assert.equal(state.createdTransactions.length, 0);
    assert.equal(state.fundSnapshots.length, 0);
});

test("unknown outcomes block retry attempts", async () => {
    const { repository, state } = createRepository();
    await repository.createPaymentAttemptForContribution({ ...request(), amount: 250 });
    state.attempts[0].attempt_status = "OUTCOME_UNKNOWN";

    await assert.rejects(
        repository.createPaymentAttemptForContribution({
            ...request({ idempotencyKey: "demo-attempt-key-002" }),
            amount: 250,
        }),
        { code: "PAYMENT_ATTEMPT_ACTIVE", statusCode: 409 }
    );
});

test("database active-attempt uniqueness conflicts map to a safe retry conflict", async () => {
    const { repository, state } = createRepository({
        simulateActiveAttemptConstraintConflict: true,
    });

    await assert.rejects(
        repository.createPaymentAttemptForContribution({ ...request(), amount: 250 }),
        { code: "PAYMENT_ATTEMPT_ACTIVE", statusCode: 409 }
    );
    assert.equal(state.attempts.length, 0);
    assert.equal(state.rollbackCount, 1);
});

test("overlapping retry calls produce at most one active mocked attempt", async () => {
    const { repository, state } = createRepository();
    const results = await Promise.allSettled([
        repository.createPaymentAttemptForContribution({ ...request(), amount: 250 }),
        repository.createPaymentAttemptForContribution({
            ...request({ idempotencyKey: "demo-attempt-key-002" }),
            amount: 250,
        }),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "PAYMENT_ATTEMPT_ACTIVE");
    assert.equal(state.attempts.length, 1);
    assert.equal(state.attempts.filter((item) =>
        ["PENDING", "OUTCOME_UNKNOWN", "PROMPT_ACCEPTED"].includes(item.attempt_status)
    ).length, 1);
});

test("returns the existing attempt for an identical idempotency key and rejects key reuse", async () => {
    const { repository, state } = createRepository({
        contributions: [
            createContribution(),
            createContribution({
                contribution_id: "contribution_002",
                transaction_id: "transaction_002",
            }),
        ],
    });
    const first = await repository.createPendingPaymentAttempt(request());
    const duplicate = await repository.createPendingPaymentAttempt(request());

    assert.equal(duplicate.created, false);
    assert.equal(duplicate.attempt.attempt_id, first.attempt.attempt_id);
    assert.equal(state.attempts.length, 1);
    await assert.rejects(
        repository.createPendingPaymentAttempt(request({ contributionId: "contribution_002" })),
        { code: "IDEMPOTENCY_KEY_CONFLICT", statusCode: 409 }
    );
    assert.equal(state.attempts.length, 1);
});

test("recovers a concurrent idempotent insert under explicit READ COMMITTED isolation", async () => {
    const { repository, state } = createRepository({ simulateConcurrentConflict: true });

    const result = await repository.createPendingPaymentAttempt(request());

    assert.equal(result.created, false);
    assert.equal(result.attempt.attempt_id, "attempt_concurrent_winner");
    assert.equal(state.attempts.length, 0);
    assert.match(state.queries[0], /^BEGIN ISOLATION LEVEL READ COMMITTED$/);
});

test("does not return a concurrent winner belonging to a conflicting request", async () => {
    const { repository, state } = createRepository({
        contributions: [
            createContribution(),
            createContribution({
                contribution_id: "contribution_002",
                transaction_id: "transaction_002",
            }),
        ],
        simulateConcurrentConflict: true,
        concurrentWinner: {
            contribution_id: "contribution_002",
            transaction_id: "transaction_002",
        },
    });

    await assert.rejects(
        repository.createPendingPaymentAttempt(request()),
        { code: "IDEMPOTENCY_KEY_CONFLICT", statusCode: 409 }
    );
    assert.equal(state.attempts.length, 0);
    assert.equal(state.concurrentWinnerRecord.contribution_id, "contribution_002");
});

test("prevents a second active attempt for the same contribution", async () => {
    const { repository, state } = createRepository();
    await repository.createPendingPaymentAttempt(request());
    await assert.rejects(
        repository.createPendingPaymentAttempt(
            request({ idempotencyKey: "demo-attempt-key-002" })
        ),
        { code: "PAYMENT_ATTEMPT_ACTIVE", statusCode: 409 }
    );

    assert.equal(state.attempts.length, 1);
});

test("rejects missing, non-worker, non-pending, and non-whole-KES associations", async () => {
    const { repository } = createRepository({
        contributions: [
            createContribution(),
            createContribution({
                contribution_id: "contribution_inactive",
                user_id: "other_worker",
            }),
            createContribution({
                contribution_id: "contribution_completed",
                contribution_status: "COMPLETED",
            }),
            createContribution({
                contribution_id: "contribution_fractional",
                contribution_amount: "250.50",
            }),
        ],
    });

    await assert.rejects(
        repository.createPendingPaymentAttempt(request({ contributionId: "missing_contribution" })),
        { code: "PAYMENT_CONTRIBUTION_NOT_FOUND" }
    );
    await assert.rejects(
        repository.createPendingPaymentAttempt(request({ contributionId: "contribution_inactive" })),
        { code: "PAYMENT_CONTRIBUTION_NOT_FOUND" }
    );
    await assert.rejects(
        repository.createPendingPaymentAttempt(request({ contributionId: "contribution_completed" })),
        { code: "PAYMENT_CONTRIBUTION_NOT_ELIGIBLE" }
    );
    await assert.rejects(
        repository.createPendingPaymentAttempt(request({ contributionId: "contribution_fractional" })),
        { code: "PAYMENT_CONTRIBUTION_NOT_ELIGIBLE" }
    );
});

test("rolls back a failed attempt insert", async () => {
    const { repository, state } = createRepository();
    state.failInsert = true;

    await assert.rejects(repository.createPendingPaymentAttempt(request()), /Mock insert failure/);
    assert.equal(state.attempts.length, 0);
    assert.equal(state.rollbackCount, 1);
    assert.equal(state.balances.account_001, 1000);
});

test("enforces unique provider request identifiers and rolls back duplicates", async () => {
    const { repository, state } = createRepository({
        contributions: [
            createContribution(),
            createContribution({
                contribution_id: "contribution_002",
                transaction_id: "transaction_002",
            }),
        ],
    });
    const first = await repository.createPendingPaymentAttempt(request());
    const second = await repository.createPendingPaymentAttempt(
        request({ contributionId: "contribution_002", idempotencyKey: "demo-attempt-key-002" })
    );
    await repository.markProviderRequestStarted(first.attempt.attempt_id);
    await repository.markProviderRequestStarted(second.attempt.attempt_id);
    await repository.recordDispatchedProviderRequestAccepted({
        attemptId: first.attempt.attempt_id,
        checkoutRequestId: "checkout_demo_001",
        merchantRequestId: "merchant_demo_001",
    });

    await assert.rejects(
        repository.recordDispatchedProviderRequestAccepted({
            attemptId: second.attempt.attempt_id,
            checkoutRequestId: "checkout_demo_001",
            merchantRequestId: "merchant_demo_002",
        }),
        { code: "23505" }
    );
    assert.equal(state.rollbackCount, 1);
    assert.equal(state.attempts[1].attempt_status, "OUTCOME_UNKNOWN");
    assert.equal(state.attempts[1].checkout_request_id, null);
});

test("records provider acceptance from the original pending-attempt sequence", async () => {
    const { repository, state } = createRepository();
    const created = await repository.createPendingPaymentAttempt(request());

    const accepted = await repository.recordProviderRequestAccepted({
        attemptId: created.attempt.attempt_id,
        checkoutRequestId: "checkout_legacy_001",
        merchantRequestId: "merchant_legacy_001",
    });

    assert.equal(accepted.attempt_status, "PROMPT_ACCEPTED");
    assert.equal(state.contributions[0].contribution_status, "PENDING");
    assert.equal(state.balances.account_001, 1000);
});

test("strict acceptance rejects attempts that have not entered the dispatched state", async () => {
    const { repository, state } = createRepository();
    const created = await repository.createPendingPaymentAttempt(request());

    await assert.rejects(
        repository.recordDispatchedProviderRequestAccepted({
            attemptId: created.attempt.attempt_id,
            checkoutRequestId: "checkout_demo_001",
            merchantRequestId: "merchant_demo_001",
        }),
        { code: "PAYMENT_ATTEMPT_NOT_PENDING", statusCode: 409 }
    );
    assert.equal(state.attempts[0].attempt_status, "PENDING");
});

test("rejects provider acceptance after an attempt is failed", async () => {
    const { repository, state } = createRepository();
    const created = await repository.createPendingPaymentAttempt(request());
    await repository.markProviderRequestStarted(created.attempt.attempt_id);
    await repository.markProviderRequestRejected({
        attemptId: created.attempt.attempt_id,
        providerResultCode: "1032",
        providerResultDescription: "Provider rejected the request",
    });

    await assert.rejects(
        repository.recordDispatchedProviderRequestAccepted({
            attemptId: created.attempt.attempt_id,
            checkoutRequestId: "checkout_demo_001",
            merchantRequestId: "merchant_demo_001",
        }),
        { code: "PAYMENT_ATTEMPT_NOT_PENDING", statusCode: 409 }
    );
    assert.equal(state.attempts[0].attempt_status, "FAILED");
});

test("repeated acceptance is idempotent and conflicting provider identifiers are rejected", async () => {
    const { repository, state } = createRepository();
    const created = await repository.createPendingPaymentAttempt(request());
    const acceptance = {
        attemptId: created.attempt.attempt_id,
        checkoutRequestId: "checkout_demo_001",
        merchantRequestId: "merchant_demo_001",
    };

    const first = await repository.recordProviderRequestAccepted(acceptance);
    const duplicate = await repository.recordProviderRequestAccepted(acceptance);

    assert.equal(duplicate.attempt_status, "PROMPT_ACCEPTED");
    assert.equal(duplicate.checkout_request_id, first.checkout_request_id);
    assert.equal(duplicate.merchant_request_id, first.merchant_request_id);
    await assert.rejects(
        repository.recordProviderRequestAccepted({
            ...acceptance,
            checkoutRequestId: "checkout_conflicting_001",
        }),
        { code: "PAYMENT_PROVIDER_ID_CONFLICT", statusCode: 409 }
    );
    assert.equal(state.attempts[0].checkout_request_id, "checkout_demo_001");
});

test("records provider acceptance without settling the contribution or crediting balance", async () => {
    const { repository, state } = createRepository();
    const created = await repository.createPendingPaymentAttempt(request());
    await repository.markProviderRequestStarted(created.attempt.attempt_id);
    const accepted = await repository.recordDispatchedProviderRequestAccepted({
        attemptId: created.attempt.attempt_id,
        checkoutRequestId: "checkout_demo_001",
        merchantRequestId: "merchant_demo_001",
        providerResultCode: "0",
        providerResultDescription: "Prompt accepted",
    });

    assert.equal(accepted.attempt_status, "PROMPT_ACCEPTED");
    assert.equal(state.contributions[0].contribution_status, "PENDING");
    assert.equal(state.balances.account_001, 1000);
    assert.equal(state.queries.some((sql) => sql.startsWith("UPDATE contributions")), false);
    assert.equal(state.queries.some((sql) => sql.startsWith("UPDATE pension_accounts")), false);
});

test("retrieves attempts by internal ID and checkout request ID with qualified columns", async () => {
    const { repository, state } = createRepository();
    const created = await repository.createPendingPaymentAttempt(request());
    await repository.markProviderRequestStarted(created.attempt.attempt_id);
    await repository.recordDispatchedProviderRequestAccepted({
        attemptId: created.attempt.attempt_id,
        checkoutRequestId: "checkout_demo_001",
        merchantRequestId: "merchant_demo_001",
    });
    assert.equal(
        (await repository.findById(created.attempt.attempt_id)).attempt_id,
        created.attempt.attempt_id
    );
    assert.equal(
        (await repository.findByCheckoutRequestId("checkout_demo_001")).attempt_id,
        created.attempt.attempt_id
    );
    const lookupQueries = state.queries.filter((sql) =>
        sql.includes("FROM mpesa_payment_attempts a") &&
        (sql.includes("WHERE a.attempt_id = $1") || sql.includes("WHERE a.checkout_request_id = $1"))
    );
    assert.equal(lookupQueries.length, 2);
    for (const sql of lookupQueries) {
        assert.match(sql, /SELECT a\.attempt_id, a\.account_id, a\.contribution_id, a\.transaction_id/);
        assert.doesNotMatch(sql, /SELECT attempt_id, account_id, contribution_id, transaction_id/);
    }
});

test("atomically creates a pending MPESA transaction, contribution, allocation snapshot, and attempt", async () => {
    const { repository, state } = createRepository();
    const result = await repository.createPendingMpesaPayment({
        workerId,
        idempotencyKey: "atomic-payment-key-1",
        amount: 2500,
        phoneNumber,
    });

    assert.equal(result.created, true);
    assert.equal(result.transaction.transaction_status, "PENDING");
    assert.equal(result.contribution.contribution_status, "PENDING");
    assert.equal(result.contribution.channel, "MPESA");
    assert.equal(result.attempt.attempt_status, "PENDING");
    assert.equal(result.attempt.account_id, "account_001");
    assert.equal(result.attempt.contribution_id, result.contribution.contribution_id);
    assert.equal(result.attempt.transaction_id, result.transaction.transaction_id);
    assert.equal(state.createdTransactions.length, 1);
    assert.equal(state.createdContributions.length, 1);
    assert.equal(state.fundSnapshots.length, 2);
    assert.equal(state.fundSnapshots.reduce((sum, item) => sum + Number(item.allocated_amount), 0), 2500);
    assert.equal(state.balances.account_001, 1000);
    assert.equal(state.queries.some((sql) => sql.startsWith("UPDATE pension_accounts")), false);
    assert.ok(state.queries.some((sql) => sql.includes("WHERE p.user_id = $1")));
});

test("rejects a missing worker account and invalid fund allocation state", async () => {
    const missingAccount = createRepository({ account: null });
    await assert.rejects(
        missingAccount.repository.createPendingMpesaPayment({
            workerId,
            idempotencyKey: "missing-account-key",
            amount: 2500,
            phoneNumber,
        }),
        { code: "PAYMENT_ACCOUNT_NOT_FOUND" }
    );
    const invalidAllocations = createRepository({
        allocations: [
            { allocation_id: "allocation_001", fund_id: "fund_001", percentage: "70.00", fund_name: "Balanced", fund_status: "ACTIVE" },
            { allocation_id: "allocation_002", fund_id: "fund_002", percentage: "20.00", fund_name: "Growth", fund_status: "ACTIVE" },
        ],
    });
    await assert.rejects(
        invalidAllocations.repository.createPendingMpesaPayment({
            workerId,
            idempotencyKey: "bad-allocation-key",
            amount: 2500,
            phoneNumber,
        }),
        { code: "PAYMENT_ALLOCATION_INVALID" }
    );
    assert.equal(invalidAllocations.state.createdTransactions.length, 0);

    const anotherWorkersAccount = createRepository({
        account: { account_id: "account_001", user_id: "worker_002" },
    });
    await assert.rejects(
        anotherWorkersAccount.repository.createPendingMpesaPayment({
            workerId,
            idempotencyKey: "other-workers-account-key",
            amount: 2500,
            phoneNumber,
        }),
        { code: "PAYMENT_ACCOUNT_NOT_FOUND" }
    );
    assert.equal(anotherWorkersAccount.state.createdTransactions.length, 0);
});

test("validates amount and normalized Kenyan phone before connecting to the database", async () => {
    const { repository, state } = createRepository();
    await assert.rejects(
        repository.createPendingMpesaPayment({
            workerId,
            idempotencyKey: "invalid-amount-key",
            amount: 2500.5,
            phoneNumber,
        }),
        { code: "INVALID_PAYMENT_ATTEMPT_INPUT" }
    );
    await assert.rejects(
        repository.createPendingMpesaPayment({
            workerId,
            idempotencyKey: "invalid-phone-key",
            amount: 2500,
            phoneNumber: "0712345678",
        }),
        { code: "INVALID_PAYMENT_ATTEMPT_INPUT" }
    );
    assert.equal(state.queries.length, 0);
});

test("rolls back every related write after a partial database failure", async () => {
    const dbPool = createMockPool();
    dbPool.state.failInsert = true;
    const failingRepository = createMpesaPaymentAttemptRepository(dbPool.pool);

    await assert.rejects(
        failingRepository.createPendingMpesaPayment({
            workerId,
            idempotencyKey: "rollback-payment-key",
            amount: 2500,
            phoneNumber,
        }),
        /Mock insert failure/
    );
    assert.equal(dbPool.state.createdTransactions.length, 0);
    assert.equal(dbPool.state.createdContributions.length, 0);
    assert.equal(dbPool.state.fundSnapshots.length, 0);
    assert.equal(dbPool.state.attempts.length, 0);
    assert.equal(dbPool.state.rollbackCount, 1);
});

test("reuses a matching atomic idempotency key and rejects conflicting request data", async () => {
    const { repository, state } = createRepository();
    const paymentRequest = {
        workerId,
        idempotencyKey: "atomic-idempotency-key",
        amount: 2500,
        phoneNumber,
    };
    const first = await repository.createPendingMpesaPayment(paymentRequest);
    const duplicate = await repository.createPendingMpesaPayment(paymentRequest);

    assert.equal(duplicate.created, false);
    assert.equal(duplicate.attempt.attempt_id, first.attempt.attempt_id);
    assert.equal(state.createdTransactions.length, 1);
    await assert.rejects(
        repository.createPendingMpesaPayment({ ...paymentRequest, amount: 3000 }),
        { code: "IDEMPOTENCY_KEY_CONFLICT", statusCode: 409 }
    );
    await assert.rejects(
        repository.createPendingMpesaPayment({ ...paymentRequest, phoneNumber: "254712345679" }),
        { code: "IDEMPOTENCY_KEY_CONFLICT", statusCode: 409 }
    );
    await assert.rejects(
        repository.createPendingMpesaPayment({ ...paymentRequest, workerId: "worker_002" }),
        { code: "IDEMPOTENCY_KEY_CONFLICT", statusCode: 409 }
    );
});

test("rolls back newly created records when a concurrent atomic retry wins the idempotency key", async () => {
    const { repository, state } = createRepository({
        simulateConcurrentConflict: true,
        concurrentWinner: {
            expected_amount: "2500",
            mpesa_phone: phoneNumber,
        },
    });
    const result = await repository.createPendingMpesaPayment({
        workerId,
        idempotencyKey: "atomic-concurrent-key",
        amount: 2500,
        phoneNumber,
    });

    assert.equal(result.created, false);
    assert.equal(result.attempt.attempt_id, "attempt_concurrent_winner");
    assert.equal(state.createdTransactions.length, 0);
    assert.equal(state.createdContributions.length, 0);
    assert.equal(state.fundSnapshots.length, 0);
    assert.equal(state.rollbackCount, 1);
    assert.match(state.queries[0], /^BEGIN ISOLATION LEVEL READ COMMITTED$/);
});

test("claims callback verification once and retains evidence without changing payment records", async () => {
    const { repository, state } = createRepository();
    const created = await repository.createPendingPaymentAttempt(request());
    await repository.markProviderRequestStarted(created.attempt.attempt_id);
    await repository.recordDispatchedProviderRequestAccepted({
        attemptId: created.attempt.attempt_id,
        checkoutRequestId: "checkout_verify_001",
        merchantRequestId: "merchant_verify_001",
    });

    const input = {
        attemptId: created.attempt.attempt_id,
        source: "CALLBACK",
        callbackFingerprint: "a".repeat(64),
        callbackResultCode: "0",
        callbackAmountMatches: true,
        callbackPhoneMatches: true,
        checkoutRequestId: "checkout_verify_001",
        merchantRequestId: "merchant_verify_001",
    };
    const claim = await repository.claimVerification(input);
    assert.equal(claim.claimed, true);
    assert.equal(claim.verification.verification_status, "PROCESSING");

    const duplicate = await repository.claimVerification(input);
    assert.equal(duplicate.claimed, false);
    assert.equal(duplicate.duplicate, true);

    const result = await repository.completeVerification({
        verificationId: claim.verification.verification_id,
        verificationStatus: "VERIFIED_SUCCESS",
        providerResultCode: "0",
        providerResultDescription: "Provider-confirmed success",
    });
    assert.equal(result.verification_status, "VERIFIED_SUCCESS");
    assert.equal(state.verifications.length, 1);
    assert.equal(state.verifications[0].callback_amount_matches, true);
    assert.equal(state.verifications[0].callback_phone_matches, true);
    assert.equal(Object.hasOwn(state.verifications[0], "callback_phone"), false);
    assert.equal(state.attempts[0].attempt_status, "PROMPT_ACCEPTED");
    assert.equal(state.contributions[0].contribution_status, "PENDING");
    assert.equal(state.balances.account_001, 1000);
    assert.equal(state.queries.some((sql) =>
        /UPDATE (transactions|contributions|pension_accounts)/.test(sql)
    ), false);
});

test("refuses reconciliation after confirmed evidence and rejects mismatched provider IDs", async () => {
    const { repository } = createRepository();
    const created = await repository.createPendingPaymentAttempt(request());
    await repository.markProviderRequestStarted(created.attempt.attempt_id);
    await repository.recordDispatchedProviderRequestAccepted({
        attemptId: created.attempt.attempt_id,
        checkoutRequestId: "checkout_verify_002",
        merchantRequestId: "merchant_verify_002",
    });
    const claim = await repository.claimVerification({
        attemptId: created.attempt.attempt_id,
        source: "RECONCILIATION",
        checkoutRequestId: "checkout_verify_002",
        merchantRequestId: "merchant_verify_002",
    });
    await repository.completeVerification({
        verificationId: claim.verification.verification_id,
        verificationStatus: "VERIFIED_FAILURE",
        providerResultCode: "1032",
    });

    const repeated = await repository.claimVerification({
        attemptId: created.attempt.attempt_id,
        source: "RECONCILIATION",
        checkoutRequestId: "checkout_verify_002",
        merchantRequestId: "merchant_verify_002",
    });
    assert.equal(repeated.claimed, false);
    assert.equal(repeated.verification.verification_status, "VERIFIED_FAILURE");
    await assert.rejects(repository.claimVerification({
        attemptId: created.attempt.attempt_id,
        source: "RECONCILIATION",
        checkoutRequestId: "checkout_verify_002",
        merchantRequestId: "merchant_forged",
    }), { code: "PAYMENT_ATTEMPT_NOT_VERIFIABLE" });
});

test("validates request identifiers and bounded provider metadata", async () => {
    const { repository } = createRepository();
    await assert.rejects(
        repository.createPendingPaymentAttempt(request({ phoneNumber: "0712345678" })),
        { code: "INVALID_PAYMENT_ATTEMPT_INPUT" }
    );
    await assert.rejects(
        repository.createPendingPaymentAttempt(request({ idempotencyKey: "bad key" })),
        { code: "INVALID_PAYMENT_ATTEMPT_INPUT" }
    );
});
