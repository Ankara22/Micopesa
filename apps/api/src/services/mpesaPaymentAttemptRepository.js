const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const PROVIDER_RESULT_CODE_PATTERN = /^-?\d{1,30}$/;
const CALLBACK_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const { distributeContributionAmount, parsePercentageHundredths } = require("./contributionAllocationService");
const { getPaymentProviderConfiguration } = require("./mpesaPaymentProviderConfig");

function createRepositoryError(message, code, statusCode) {
    const error = new Error(message);
    error.code = code;
    if (statusCode) error.statusCode = statusCode;
    return error;
}

function requireIdentifier(value, label) {
    if (typeof value !== "string" || !ID_PATTERN.test(value)) {
        throw createRepositoryError(`${label} is invalid.`, "INVALID_PAYMENT_ATTEMPT_INPUT", 400);
    }
    return value;
}

function requireIdempotencyKey(value) {
    if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
        throw createRepositoryError(
            "Idempotency key must be 1 to 128 safe characters.",
            "INVALID_PAYMENT_ATTEMPT_INPUT",
            400
        );
    }
    return value;
}

function requirePhoneSnapshot(value) {
    if (typeof value !== "string" || !/^254[17]\d{8}$/.test(value)) {
        throw createRepositoryError(
            "Payment phone snapshot must be a normalized Kenyan mobile number.",
            "INVALID_PAYMENT_ATTEMPT_INPUT",
            400
        );
    }
    return value;
}

function requireProviderId(value, label) {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !ID_PATTERN.test(value)) {
        throw createRepositoryError(`${label} is invalid.`, "INVALID_PAYMENT_ATTEMPT_INPUT", 400);
    }
    return value;
}

function requireProviderResultCode(value) {
    if (value === undefined || value === null) return null;
    const normalized = String(value);
    if (!PROVIDER_RESULT_CODE_PATTERN.test(normalized)) {
        throw createRepositoryError(
            "Provider result code must be a bounded numeric code.",
            "INVALID_PAYMENT_ATTEMPT_INPUT",
            400
        );
    }
    return normalized;
}

function requireResultDescription(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.length > 255) {
        throw createRepositoryError(
            "Provider result description must be no longer than 255 characters.",
            "INVALID_PAYMENT_ATTEMPT_INPUT",
            400
        );
    }
    return value;
}

function sameAttemptRequest(attempt, { workerId, contributionId, phoneNumber, expectedAmount }) {
    return attempt.user_id === workerId &&
        (contributionId === undefined || attempt.contribution_id === contributionId) &&
        attempt.mpesa_phone === phoneNumber &&
        (expectedAmount === undefined || Number(attempt.expected_amount) === expectedAmount);
}

function isWholeKesAmount(value) {
    const amount = Number(value);
    return Number.isSafeInteger(amount) && amount > 0;
}

function requireWholeKesAmount(value) {
    const amount = typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : value;
    if (!isWholeKesAmount(amount) || amount > 9999999999) {
        throw createRepositoryError(
            "Payment amount must be a positive whole number of Kenyan shillings.",
            "INVALID_PAYMENT_ATTEMPT_INPUT",
            400
        );
    }
    return amount;
}

function decimalToCents(value, label) {
    const text = typeof value === "number" ? String(value) : String(value ?? "").trim();
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
    if (!match) {
        throw createRepositoryError(`${label} is not a valid monetary amount.`, "PAYMENT_AMOUNT_MISMATCH", 409);
    }
    return BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
}

function centsToDecimal(cents) {
    const whole = cents / 100n;
    const fraction = String(cents % 100n).padStart(2, "0");
    return `${whole}.${fraction}`;
}

function failureStatusesFor(resultCode) {
    if (resultCode === "1032") {
        return "CANCELLED";
    }
    if (resultCode === "1037") {
        return "TIMED_OUT";
    }
    return "FAILED";
}

function createMpesaPaymentAttemptRepository(
    databasePool,
    { providerModeProvider = () => getPaymentProviderConfiguration() } = {}
) {
    if (!databasePool || typeof databasePool.connect !== "function") {
        throw new TypeError("A database pool with a connect() method is required.");
    }

    function configuredProviderMode() {
        const configuration = providerModeProvider();
        const providerMode = typeof configuration === "string"
            ? configuration
            : configuration?.provider;
        if (!["DARAJA", "SIMULATOR"].includes(providerMode) ||
            (providerMode === "SIMULATOR" &&
                typeof configuration !== "string" &&
                configuration.simulatorEnabled !== true)) {
            throw createRepositoryError(
                "The configured payment provider is not enabled for new attempts.",
                "PAYMENT_PROVIDER_CONFIGURATION_ERROR",
                503
            );
        }
        return providerMode;
    }

    async function findById(attemptId, queryable = databasePool) {
        requireIdentifier(attemptId, "Payment attempt ID");
        const result = await queryable.query(
            `SELECT a.attempt_id, a.account_id, a.contribution_id, a.transaction_id,
                    a.idempotency_key, a.expected_amount, a.mpesa_phone, a.attempt_status,
                    a.checkout_request_id, a.merchant_request_id, a.provider_mode,
                    a.provider_result_code,
                    a.provider_result_description, a.created_at, a.updated_at,
                    a.provider_accepted_at,
                    p.user_id
             FROM mpesa_payment_attempts a
             JOIN pension_accounts p ON p.account_id = a.account_id
             WHERE a.attempt_id = $1`,
            [attemptId]
        );
        return result.rows[0] || null;
    }

    async function findByCheckoutRequestId(checkoutRequestId, queryable = databasePool) {
        requireIdentifier(checkoutRequestId, "Checkout request ID");
        const result = await queryable.query(
            `SELECT a.attempt_id, a.account_id, a.contribution_id, a.transaction_id,
                    a.idempotency_key, a.expected_amount, a.mpesa_phone, a.attempt_status,
                    a.checkout_request_id, a.merchant_request_id, a.provider_mode,
                    a.provider_result_code,
                    a.provider_result_description, a.created_at, a.updated_at,
                    a.provider_accepted_at,
                    p.user_id
             FROM mpesa_payment_attempts a
             JOIN pension_accounts p ON p.account_id = a.account_id
             WHERE a.checkout_request_id = $1`,
            [checkoutRequestId]
        );
        return result.rows[0] || null;
    }

    async function getWorkerPaymentStatus(statusReference, workerId) {
        requireIdentifier(statusReference, "Payment status reference");
        requireIdentifier(workerId, "Worker ID");
        const result = await databasePool.query(
            `SELECT a.attempt_id, a.contribution_id, t.transaction_id, t.amount,
                    a.attempt_status, t.transaction_status, c.contribution_status,
                    CASE WHEN a.provider_mode = 'SIMULATOR'
                         THEN a.checkout_request_id ELSE NULL END AS checkout_request_id,
                    CASE WHEN a.provider_mode = 'SIMULATOR'
                         THEN 'SIMULATED'
                         WHEN a.provider_mode = 'DARAJA' THEN 'DARAJA'
                         ELSE 'UNRESOLVED' END AS payment_provider,
                    t.mpesa_result_description,
                    latest_verification.verification_status AS latest_verification_status,
                    latest_verification.provider_result_description AS verification_description,
                    CASE WHEN a.provider_mode = 'SIMULATOR' THEN
                        CASE
                            WHEN latest_verification.verification_status = 'VERIFIED_SUCCESS' THEN 'SUCCESS'
                            WHEN latest_verification.verification_status = 'VERIFIED_FAILURE' THEN 'FAILED'
                            WHEN latest_verification.verification_status = 'UNVERIFIED'
                             AND latest_verification.provider_result_description LIKE 'SIMULATED: Payment is still pending%'
                                THEN 'PENDING'
                            WHEN latest_verification.verification_status IN ('UNVERIFIED', 'INCONSISTENT') THEN 'UNKNOWN'
                            ELSE NULL
                        END
                    ELSE NULL END AS payment_outcome,
                    (
                        t.transaction_status = 'COMPLETED'
                        AND c.contribution_status = 'COMPLETED'
                        AND t.mpesa_result_code = 0
                        AND t.completed_at IS NOT NULL
                        AND a.attempt_status IN ('PROMPT_ACCEPTED', 'OUTCOME_UNKNOWN')
                    ) AS settlement_confirmed,
                    t.mpesa_receipt AS receipt_reference,
                    CASE
                        WHEN t.transaction_status = 'COMPLETED'
                         AND c.contribution_status = 'COMPLETED'
                         AND t.mpesa_result_code = 0
                         AND t.completed_at IS NOT NULL
                         AND a.attempt_status IN ('PROMPT_ACCEPTED', 'OUTCOME_UNKNOWN')
                        THEN t.completed_at
                        ELSE NULL
                    END AS settled_at
             FROM mpesa_payment_attempts a
             JOIN transactions t
               ON t.transaction_id = a.transaction_id
              AND t.transaction_type = 'CONTRIBUTION'
             JOIN contributions c
               ON c.contribution_id = a.contribution_id
              AND c.account_id = a.account_id
              AND c.transaction_id = a.transaction_id
              AND c.channel = 'MPESA'
             JOIN pension_accounts p ON p.account_id = a.account_id
             LEFT JOIN LATERAL (
                 SELECT verification_status, provider_result_description
                 FROM mpesa_payment_verifications
                 WHERE attempt_id = a.attempt_id
                 ORDER BY created_at DESC, verification_id DESC
                 LIMIT 1
             ) latest_verification ON TRUE
             WHERE p.user_id = $2
               AND (a.attempt_id = $1 OR a.checkout_request_id = $1 OR a.transaction_id = $1)
             ORDER BY CASE
                 WHEN a.attempt_id = $1 THEN 1
                 WHEN a.checkout_request_id = $1 THEN 2
                 ELSE 3
             END
             LIMIT 1`,
            [statusReference, workerId]
        );
        return result.rows[0] || null;
    }

    async function getWorkerPaymentStatusByIdempotencyKey(idempotencyKey, workerId) {
        requireIdempotencyKey(idempotencyKey);
        requireIdentifier(workerId, "Worker ID");
        const result = await databasePool.query(
            `SELECT a.attempt_id, a.contribution_id, t.transaction_id, t.amount,
                    a.attempt_status, t.transaction_status, c.contribution_status,
                    CASE WHEN a.provider_mode = 'SIMULATOR'
                         THEN a.checkout_request_id ELSE NULL END AS checkout_request_id,
                    CASE WHEN a.provider_mode = 'SIMULATOR'
                         THEN 'SIMULATED'
                         WHEN a.provider_mode = 'DARAJA' THEN 'DARAJA'
                         ELSE 'UNRESOLVED' END AS payment_provider,
                    t.mpesa_result_description,
                    latest_verification.verification_status AS latest_verification_status,
                    latest_verification.provider_result_description AS verification_description,
                    CASE WHEN a.provider_mode = 'SIMULATOR' THEN
                        CASE
                            WHEN latest_verification.verification_status = 'VERIFIED_SUCCESS' THEN 'SUCCESS'
                            WHEN latest_verification.verification_status = 'VERIFIED_FAILURE' THEN 'FAILED'
                            WHEN latest_verification.verification_status = 'UNVERIFIED'
                             AND latest_verification.provider_result_description LIKE 'SIMULATED: Payment is still pending%'
                                THEN 'PENDING'
                            WHEN latest_verification.verification_status IN ('UNVERIFIED', 'INCONSISTENT') THEN 'UNKNOWN'
                            ELSE NULL
                        END
                    ELSE NULL END AS payment_outcome,
                    (
                        t.transaction_status = 'COMPLETED'
                        AND c.contribution_status = 'COMPLETED'
                        AND t.mpesa_result_code = 0
                        AND t.completed_at IS NOT NULL
                        AND a.attempt_status IN ('PROMPT_ACCEPTED', 'OUTCOME_UNKNOWN')
                    ) AS settlement_confirmed,
                    t.mpesa_receipt AS receipt_reference,
                    CASE
                        WHEN t.transaction_status = 'COMPLETED'
                         AND c.contribution_status = 'COMPLETED'
                         AND t.mpesa_result_code = 0
                         AND t.completed_at IS NOT NULL
                         AND a.attempt_status IN ('PROMPT_ACCEPTED', 'OUTCOME_UNKNOWN')
                        THEN t.completed_at
                        ELSE NULL
                    END AS settled_at
             FROM mpesa_payment_attempts a
             JOIN transactions t
               ON t.transaction_id = a.transaction_id
              AND t.transaction_type = 'CONTRIBUTION'
             JOIN contributions c
               ON c.contribution_id = a.contribution_id
              AND c.account_id = a.account_id
              AND c.transaction_id = a.transaction_id
              AND c.channel = 'MPESA'
             JOIN pension_accounts p ON p.account_id = a.account_id
             LEFT JOIN LATERAL (
                 SELECT verification_status, provider_result_description
                 FROM mpesa_payment_verifications
                 WHERE attempt_id = a.attempt_id
                 ORDER BY created_at DESC, verification_id DESC
                 LIMIT 1
             ) latest_verification ON TRUE
             WHERE p.user_id = $2
               AND a.idempotency_key = $1
             LIMIT 1`,
            [idempotencyKey, workerId]
        );
        return result.rows[0] || null;
    }

    async function selectExistingByIdempotencyKey(client, idempotencyKey) {
        const result = await client.query(
            `SELECT a.attempt_id, a.account_id, a.contribution_id, a.transaction_id,
                    a.idempotency_key, a.expected_amount, a.mpesa_phone, a.attempt_status,
                    a.checkout_request_id, a.merchant_request_id, a.provider_mode,
                    a.provider_result_code,
                    a.provider_result_description, a.created_at, a.updated_at,
                    a.provider_accepted_at, p.user_id
             FROM mpesa_payment_attempts a
             JOIN pension_accounts p ON p.account_id = a.account_id
             WHERE a.idempotency_key = $1
             FOR UPDATE OF a`,
            [idempotencyKey]
        );
        return result.rows[0] || null;
    }

    function assertSameIdempotentRequest(attempt, request) {
        if (!sameAttemptRequest(attempt, request)) {
            throw createRepositoryError(
                "Idempotency key was already used for a different payment attempt request.",
                "IDEMPOTENCY_KEY_CONFLICT",
                409
            );
        }
    }

    async function loadEligibleContribution(client, { workerId, contributionId }) {
        const result = await client.query(
            `SELECT c.contribution_id, c.account_id, c.transaction_id,
                    c.amount AS contribution_amount, c.channel,
                    c.contribution_status, t.transaction_type,
                    t.amount AS transaction_amount, t.transaction_status,
                    p.user_id
             FROM contributions c
             JOIN transactions t ON t.transaction_id = c.transaction_id
             JOIN pension_accounts p ON p.account_id = c.account_id
             JOIN users u ON u.user_id = p.user_id
             WHERE c.contribution_id = $1
               AND p.user_id = $2
               AND p.account_status = 'ACTIVE'
               AND u.role = 'WORKER'
               AND u.account_status = 'ACTIVE'
             FOR UPDATE OF c, t, p, u`,
            [contributionId, workerId]
        );
        const contribution = result.rows[0];
        if (!contribution) {
            throw createRepositoryError(
                "Pending M-Pesa contribution was not found for this active worker.",
                "PAYMENT_CONTRIBUTION_NOT_FOUND",
                404
            );
        }
        if (
            contribution.channel !== "MPESA" ||
            contribution.contribution_status !== "PENDING" ||
            contribution.transaction_type !== "CONTRIBUTION" ||
            contribution.transaction_status !== "PENDING" ||
            Number(contribution.contribution_amount) !== Number(contribution.transaction_amount) ||
            !isWholeKesAmount(contribution.contribution_amount)
        ) {
            throw createRepositoryError(
                "Payment attempt requires a matching pending M-Pesa contribution and transaction.",
                "PAYMENT_CONTRIBUTION_NOT_ELIGIBLE",
                409
            );
        }
        return contribution;
    }

    async function createPendingMpesaPayment({
        workerId,
        idempotencyKey,
        amount,
        phoneNumber,
    }) {
        const request = {
            workerId: requireIdentifier(workerId, "Worker ID"),
            idempotencyKey: requireIdempotencyKey(idempotencyKey),
            expectedAmount: requireWholeKesAmount(amount),
            phoneNumber: requirePhoneSnapshot(phoneNumber),
            providerMode: configuredProviderMode(),
        };
        const client = await databasePool.connect();
        let transactionStarted = false;
        try {
            await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
            transactionStarted = true;

            const existing = await selectExistingByIdempotencyKey(client, request.idempotencyKey);
            if (existing) {
                assertSameIdempotentRequest(existing, request);
                await client.query("COMMIT");
                transactionStarted = false;
                return { attempt: existing, created: false };
            }

            const accountResult = await client.query(
                `SELECT p.account_id
                 FROM pension_accounts p
                 JOIN users u ON u.user_id = p.user_id
                 WHERE p.user_id = $1
                   AND p.account_status = 'ACTIVE'
                   AND u.role = 'WORKER'
                   AND u.account_status = 'ACTIVE'
                 FOR UPDATE OF p, u`,
                [request.workerId]
            );
            const account = accountResult.rows[0];
            if (!account) {
                throw createRepositoryError(
                    "No active pension account is available for this worker.",
                    "PAYMENT_ACCOUNT_NOT_FOUND",
                    404
                );
            }

            const allocationResult = await client.query(
                `SELECT fa.allocation_id, fa.fund_id, fa.percentage, f.fund_name, f.fund_status
                 FROM fund_allocations fa
                 JOIN funds f ON f.fund_id = fa.fund_id
                 WHERE fa.account_id = $1
                   AND fa.effective_from <= CURRENT_DATE
                   AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)
                 ORDER BY fa.fund_id, fa.allocation_id
                 FOR SHARE OF fa, f`,
                [account.account_id]
            );
            const allocations = allocationResult.rows;
            const fundIds = new Set();
            let totalWeight = 0;
            for (const allocation of allocations) {
                const weight = parsePercentageHundredths(allocation.percentage);
                if (
                    allocation.fund_status !== "ACTIVE" ||
                    !weight ||
                    fundIds.has(allocation.fund_id)
                ) {
                    throw createRepositoryError(
                        "The worker's current fund allocation configuration is invalid.",
                        "PAYMENT_ALLOCATION_INVALID",
                        409
                    );
                }
                fundIds.add(allocation.fund_id);
                totalWeight += weight;
            }
            if (allocations.length === 0 || totalWeight !== 10000) {
                throw createRepositoryError(
                    "The worker must have valid active fund allocations totaling 100%.",
                    "PAYMENT_ALLOCATION_INVALID",
                    409
                );
            }

            const amountCents = BigInt(request.expectedAmount) * 100n;
            const fundShares = distributeContributionAmount(amountCents, allocations);
            const transactionResult = await client.query(
                `INSERT INTO transactions (transaction_type, amount, transaction_status)
                 VALUES ('CONTRIBUTION', $1, 'PENDING')
                 RETURNING transaction_id, amount, transaction_status, initiated_at`,
                [request.expectedAmount]
            );
            const transaction = transactionResult.rows[0];
            const contributionResult = await client.query(
                `INSERT INTO contributions
                    (account_id, transaction_id, amount, channel, contribution_status)
                 VALUES ($1, $2, $3, 'MPESA', 'PENDING')
                 RETURNING contribution_id, account_id, transaction_id, amount, channel,
                           contribution_status, created_at`,
                [account.account_id, transaction.transaction_id, request.expectedAmount]
            );
            const contribution = contributionResult.rows[0];

            for (const share of fundShares) {
                await client.query(
                    `INSERT INTO contribution_fund_allocations
                        (contribution_id, account_id, fund_id, fund_name,
                         allocation_percentage, allocated_amount)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                        contribution.contribution_id,
                        account.account_id,
                        share.fund_id,
                        share.fund_name,
                        share.allocation_percentage,
                        share.allocated_amount,
                    ]
                );
            }

            const attemptResult = await client.query(
                `INSERT INTO mpesa_payment_attempts
                    (account_id, contribution_id, transaction_id, idempotency_key,
                     expected_amount, mpesa_phone, attempt_status, provider_mode)
                 VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7)
                 ON CONFLICT (idempotency_key) DO NOTHING
                 RETURNING attempt_id, account_id, contribution_id, transaction_id,
                           idempotency_key, expected_amount, mpesa_phone, attempt_status,
                           checkout_request_id, merchant_request_id, provider_mode,
                           provider_result_code,
                           provider_result_description, created_at, updated_at,
                           provider_accepted_at`,
                [
                    account.account_id,
                    contribution.contribution_id,
                    transaction.transaction_id,
                    request.idempotencyKey,
                    request.expectedAmount,
                    request.phoneNumber,
                    request.providerMode,
                ]
            );
            if (!attemptResult.rows[0]) {
                const concurrentAttempt = await selectExistingByIdempotencyKey(
                    client,
                    request.idempotencyKey
                );
                if (!concurrentAttempt) {
                    throw createRepositoryError(
                        "Could not resolve the payment attempt idempotency key.",
                        "PAYMENT_ATTEMPT_IDEMPOTENCY_ERROR",
                        409
                    );
                }
                assertSameIdempotentRequest(concurrentAttempt, request);
                await client.query("ROLLBACK");
                transactionStarted = false;
                return { attempt: concurrentAttempt, created: false };
            }

            await client.query("COMMIT");
            transactionStarted = false;
            return {
                attempt: attemptResult.rows[0],
                contribution,
                created: true,
                fundAllocations: fundShares,
                transaction,
            };
        } catch (error) {
            if (transactionStarted) {
                await client.query("ROLLBACK");
                transactionStarted = false;
            }
            throw error;
        } finally {
            client.release();
        }
    }

    async function markProviderRequestStarted(attemptId) {
        const normalizedAttemptId = requireIdentifier(attemptId, "Payment attempt ID");
        const result = await databasePool.query(
            `UPDATE mpesa_payment_attempts
             SET attempt_status = 'OUTCOME_UNKNOWN', updated_at = now()
             WHERE attempt_id = $1 AND attempt_status = 'PENDING'
             RETURNING attempt_id, attempt_status`,
            [normalizedAttemptId]
        );
        return result.rows[0] || null;
    }

    async function markProviderRequestRejected({
        attemptId,
        providerResultCode = null,
        providerResultDescription = null,
    }) {
        const normalizedAttemptId = requireIdentifier(attemptId, "Payment attempt ID");
        const resultCode = requireProviderResultCode(providerResultCode);
        const resultDescription = requireResultDescription(providerResultDescription);
        const result = await databasePool.query(
            `UPDATE mpesa_payment_attempts
             SET attempt_status = 'FAILED',
                 provider_result_code = $1,
                 provider_result_description = $2,
                 updated_at = now()
             WHERE attempt_id = $3 AND attempt_status = 'OUTCOME_UNKNOWN'
             RETURNING attempt_id, attempt_status, provider_result_code,
                       provider_result_description`,
            [resultCode, resultDescription, normalizedAttemptId]
        );
        return result.rows[0] || null;
    }

    async function createPaymentAttemptForContribution(input, { allowOmittedAmount = false } = {}) {
        const {
            workerId,
            contributionId,
            idempotencyKey,
            phoneNumber,
            amount,
        } = input || {};
        const request = {
            workerId: requireIdentifier(workerId, "Worker ID"),
            contributionId: requireIdentifier(contributionId, "Contribution ID"),
            idempotencyKey: requireIdempotencyKey(idempotencyKey),
            phoneNumber: requirePhoneSnapshot(phoneNumber),
            providerMode: configuredProviderMode(),
            expectedAmount: amount === undefined && allowOmittedAmount
                ? undefined
                : requireWholeKesAmount(amount),
        };
        const client = await databasePool.connect();
        let transactionStarted = false;
        try {
            await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
            transactionStarted = true;
            const existing = await selectExistingByIdempotencyKey(client, request.idempotencyKey);
            if (existing) {
                assertSameIdempotentRequest(existing, request);
                await client.query("COMMIT");
                transactionStarted = false;
                return { attempt: existing, created: false };
            }

            const contribution = await loadEligibleContribution(client, request);
            const expectedAmount = request.expectedAmount ??
                requireWholeKesAmount(Number(contribution.contribution_amount));
            const expectedCents = BigInt(expectedAmount) * 100n;
            if (
                decimalToCents(contribution.contribution_amount, "Contribution amount") !== expectedCents ||
                decimalToCents(contribution.transaction_amount, "Transaction amount") !== expectedCents
            ) {
                throw createRepositoryError(
                    "Payment amount must match the existing pending contribution and transaction.",
                    "PAYMENT_AMOUNT_MISMATCH",
                    409
                );
            }

            const activeAttempt = await client.query(
                `SELECT attempt_id, attempt_status
                 FROM mpesa_payment_attempts
                 WHERE contribution_id = $1
                   AND attempt_status IN ('PENDING', 'OUTCOME_UNKNOWN', 'PROMPT_ACCEPTED')
                 ORDER BY created_at DESC, attempt_id
                 LIMIT 1
                 FOR UPDATE`,
                [contribution.contribution_id]
            );
            if (activeAttempt.rows[0]) {
                throw createRepositoryError(
                    "A payment attempt for this contribution is still active.",
                    "PAYMENT_ATTEMPT_ACTIVE",
                    409
                );
            }

            const inserted = await client.query(
                `INSERT INTO mpesa_payment_attempts
                    (account_id, contribution_id, transaction_id, idempotency_key,
                     expected_amount, mpesa_phone, attempt_status, provider_mode)
                 VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7)
                 ON CONFLICT (idempotency_key) DO NOTHING
                 RETURNING attempt_id, account_id, contribution_id, transaction_id,
                           idempotency_key, expected_amount, mpesa_phone, attempt_status,
                           checkout_request_id, merchant_request_id, provider_mode,
                           provider_result_code,
                           provider_result_description, created_at, updated_at,
                           provider_accepted_at`,
                [
                    contribution.account_id,
                    contribution.contribution_id,
                    contribution.transaction_id,
                    request.idempotencyKey,
                    expectedAmount,
                    request.phoneNumber,
                    request.providerMode,
                ]
            );
            if (!inserted.rows[0]) {
                const concurrentAttempt = await selectExistingByIdempotencyKey(
                    client,
                    request.idempotencyKey
                );
                if (!concurrentAttempt) {
                    throw createRepositoryError(
                        "Could not resolve the payment attempt idempotency key.",
                        "PAYMENT_ATTEMPT_IDEMPOTENCY_ERROR",
                        409
                    );
                }
                assertSameIdempotentRequest(concurrentAttempt, request);
                await client.query("COMMIT");
                transactionStarted = false;
                return { attempt: concurrentAttempt, created: false };
            }
            await client.query("COMMIT");
            transactionStarted = false;
            return { attempt: inserted.rows[0], created: true };
        } catch (error) {
            if (transactionStarted) {
                await client.query("ROLLBACK");
                transactionStarted = false;
            }
            if (
                error?.code === "23505" &&
                error?.constraint === "uq_mpesa_payment_attempts_one_active_per_contribution"
            ) {
                throw createRepositoryError(
                    "A payment attempt for this contribution is still active.",
                    "PAYMENT_ATTEMPT_ACTIVE",
                    409
                );
            }
            throw error;
        } finally {
            client.release();
        }
    }

    async function createPendingPaymentAttempt(input) {
        return createPaymentAttemptForContribution(input, { allowOmittedAmount: true });
    }

    async function recordProviderRequestAcceptedForStatus(input, requiredStatus) {
        const {
            attemptId,
            checkoutRequestId,
            merchantRequestId,
            providerResultCode = "0",
            providerResultDescription = null,
        } = input || {};
        const normalizedAttemptId = requireIdentifier(attemptId, "Payment attempt ID");
        const checkoutId = requireProviderId(checkoutRequestId, "Checkout request ID");
        const merchantId = requireProviderId(merchantRequestId, "Merchant request ID");
        if (!checkoutId || !merchantId) {
            throw createRepositoryError(
                "Checkout and merchant request IDs are required for an accepted provider request.",
                "INVALID_PAYMENT_ATTEMPT_INPUT",
                400
            );
        }
        const resultCode = requireProviderResultCode(providerResultCode);
        const resultDescription = requireResultDescription(providerResultDescription);
        const client = await databasePool.connect();
        let transactionStarted = false;
        try {
            await client.query("BEGIN");
            transactionStarted = true;
            const updated = await client.query(
                `UPDATE mpesa_payment_attempts
                 SET checkout_request_id = $1,
                     merchant_request_id = $2,
                     provider_result_code = $3,
                     provider_result_description = $4,
                     attempt_status = 'PROMPT_ACCEPTED',
                     provider_accepted_at = now(),
                     updated_at = now()
                 WHERE attempt_id = $5
                   AND attempt_status = $6
                 RETURNING attempt_id, account_id, contribution_id, transaction_id,
                           idempotency_key, expected_amount, mpesa_phone, attempt_status,
                           checkout_request_id, merchant_request_id, provider_result_code,
                           provider_result_description, created_at, updated_at,
                           provider_accepted_at`,
                [checkoutId, merchantId, resultCode, resultDescription, normalizedAttemptId, requiredStatus]
            );
            if (!updated.rows[0]) {
                const existingResult = await client.query(
                    `SELECT a.attempt_id, a.account_id, a.contribution_id, a.transaction_id,
                            a.idempotency_key, a.expected_amount, a.mpesa_phone, a.attempt_status,
                            a.checkout_request_id, a.merchant_request_id, a.provider_result_code,
                            a.provider_result_description, a.created_at, a.updated_at,
                            a.provider_accepted_at, p.user_id
                     FROM mpesa_payment_attempts a
                     JOIN pension_accounts p ON p.account_id = a.account_id
                     WHERE a.attempt_id = $1
                     FOR UPDATE OF a`,
                    [normalizedAttemptId]
                );
                const existing = existingResult.rows[0];
                if (!existing) {
                    throw createRepositoryError("Payment attempt was not found.", "PAYMENT_ATTEMPT_NOT_FOUND", 404);
                }
                if (existing.attempt_status === "PROMPT_ACCEPTED") {
                    if (
                        existing.checkout_request_id === checkoutId &&
                        existing.merchant_request_id === merchantId
                    ) {
                        await client.query("COMMIT");
                        transactionStarted = false;
                        return existing;
                    }
                    throw createRepositoryError(
                        "Provider request identifiers conflict with the recorded acceptance.",
                        "PAYMENT_PROVIDER_ID_CONFLICT",
                        409
                    );
                }
                throw createRepositoryError(
                    "Provider acceptance cannot be recorded from the current payment attempt state.",
                    "PAYMENT_ATTEMPT_NOT_PENDING",
                    409
                );
            }
            await client.query("COMMIT");
            transactionStarted = false;
            return updated.rows[0];
        } catch (error) {
            if (transactionStarted) await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async function recordProviderRequestAccepted(input) {
        return recordProviderRequestAcceptedForStatus(input, "PENDING");
    }

    async function recordDispatchedProviderRequestAccepted(input) {
        return recordProviderRequestAcceptedForStatus(input, "OUTCOME_UNKNOWN");
    }

    async function claimVerification({
        attemptId,
        source,
        callbackFingerprint = null,
        callbackResultCode = null,
        callbackAmountMatches = null,
        callbackPhoneMatches = null,
        callbackReceipt = null,
        checkoutRequestId = null,
        merchantRequestId = null,
    }) {
        const normalizedAttemptId = requireIdentifier(attemptId, "Payment attempt ID");
        if (!["CALLBACK", "RECONCILIATION"].includes(source)) {
            throw createRepositoryError("Verification source is invalid.", "INVALID_VERIFICATION_INPUT", 400);
        }
        if (
            (source === "CALLBACK" &&
                (typeof callbackFingerprint !== "string" ||
                    !CALLBACK_FINGERPRINT_PATTERN.test(callbackFingerprint))) ||
            (source === "RECONCILIATION" && callbackFingerprint !== null)
        ) {
            throw createRepositoryError("Callback fingerprint is invalid.", "INVALID_VERIFICATION_INPUT", 400);
        }
        const normalizedCallbackCode = requireProviderResultCode(callbackResultCode);
        if (
            (callbackAmountMatches !== null && typeof callbackAmountMatches !== "boolean") ||
            (callbackPhoneMatches !== null && typeof callbackPhoneMatches !== "boolean") ||
            (source === "RECONCILIATION" &&
                (callbackAmountMatches !== null ||
                    callbackPhoneMatches !== null ||
                    callbackReceipt !== null)) ||
            (callbackReceipt !== null &&
                (typeof callbackReceipt !== "string" ||
                    !/^[A-Za-z0-9]{1,25}$/.test(callbackReceipt)))
        ) {
            throw createRepositoryError(
                "Callback match evidence is invalid.",
                "INVALID_VERIFICATION_INPUT",
                400
            );
        }
        const normalizedCheckoutId = requireProviderId(checkoutRequestId, "Checkout request ID");
        const normalizedMerchantId = requireProviderId(merchantRequestId, "Merchant request ID");
        if (!normalizedCheckoutId || !normalizedMerchantId) {
            throw createRepositoryError(
                "Provider request identifiers are required for verification.",
                "PAYMENT_ATTEMPT_NOT_VERIFIABLE",
                409
            );
        }

        const client = await databasePool.connect();
        let transactionStarted = false;
        try {
            await client.query("BEGIN");
            transactionStarted = true;
            const attemptResult = await client.query(
                `SELECT attempt_id, account_id, contribution_id, transaction_id,
                        expected_amount, mpesa_phone, attempt_status,
                        checkout_request_id, merchant_request_id
                 FROM mpesa_payment_attempts
                 WHERE attempt_id = $1
                 FOR UPDATE`,
                [normalizedAttemptId]
            );
            const attempt = attemptResult.rows[0];
            if (!attempt) {
                throw createRepositoryError("Payment attempt was not found.", "PAYMENT_ATTEMPT_NOT_FOUND", 404);
            }
            if (
                attempt.checkout_request_id !== normalizedCheckoutId ||
                attempt.merchant_request_id !== normalizedMerchantId
            ) {
                throw createRepositoryError(
                    "Payment attempt provider identifiers do not match verifiable attempt state.",
                    "PAYMENT_ATTEMPT_NOT_VERIFIABLE",
                    409
                );
            }

            if (source === "CALLBACK") {
                const fingerprintResult = await client.query(
                    `SELECT verification_id, attempt_id, verification_status
                     FROM mpesa_payment_verifications
                     WHERE callback_fingerprint = $1
                     FOR UPDATE`,
                    [callbackFingerprint]
                );
                const existingFingerprint = fingerprintResult.rows[0];
                if (existingFingerprint && existingFingerprint.attempt_id !== normalizedAttemptId) {
                    throw createRepositoryError(
                        "Callback fingerprint is already associated with another attempt.",
                        "CALLBACK_FINGERPRINT_CONFLICT",
                        409
                    );
                }
                if (existingFingerprint &&
                    ["VERIFIED_SUCCESS", "VERIFIED_FAILURE"].includes(existingFingerprint.verification_status)) {
                    await client.query("COMMIT");
                    transactionStarted = false;
                    return {
                        attempt,
                        claimed: false,
                        duplicate: true,
                        verification: existingFingerprint,
                    };
                }
            }

            const confirmedResult = await client.query(
                `SELECT verification_id, attempt_id, verification_source,
                        checkout_request_id, merchant_request_id,
                        callback_result_code, callback_amount_matches,
                        callback_phone_matches, callback_receipt,
                        provider_result_code, provider_result_description,
                        verification_status
                 FROM mpesa_payment_verifications
                 WHERE attempt_id = $1
                   AND verification_status IN ('VERIFIED_SUCCESS', 'VERIFIED_FAILURE')
                   AND (
                       $2 <> 'CALLBACK'
                       OR (
                           verification_source = 'RECONCILIATION'
                           AND verification_status = 'VERIFIED_SUCCESS'
                       )
                   )
                 ORDER BY completed_at DESC, verification_id DESC
                 LIMIT 1
                 FOR UPDATE`,
                [normalizedAttemptId, source]
            );
            const confirmed = confirmedResult.rows[0];
            const lateCallbackAfterQuerySuccess =
                source === "CALLBACK" &&
                confirmed?.verification_status === "VERIFIED_SUCCESS" &&
                confirmed.verification_source === "RECONCILIATION" &&
                confirmed.provider_result_code === "0";
            if (confirmed && !lateCallbackAfterQuerySuccess) {
                await client.query("COMMIT");
                transactionStarted = false;
                return {
                    attempt,
                    claimed: false,
                    duplicate: true,
                    verification: confirmed,
                };
            }
            if (!lateCallbackAfterQuerySuccess &&
                !["PROMPT_ACCEPTED", "OUTCOME_UNKNOWN"].includes(attempt.attempt_status)) {
                throw createRepositoryError(
                    "Payment attempt is not in a verifiable state.",
                    "PAYMENT_ATTEMPT_NOT_VERIFIABLE",
                    409
                );
            }

            const activeResult = await client.query(
                `SELECT verification_id
                 FROM mpesa_payment_verifications
                 WHERE attempt_id = $1
                   AND verification_status = 'PROCESSING'
                   AND updated_at >= now() - INTERVAL '2 minutes'
                 FOR UPDATE`,
                [normalizedAttemptId]
            );
            if (activeResult.rows[0]) {
                await client.query("COMMIT");
                transactionStarted = false;
                return { attempt, claimed: false, duplicate: true, verification: activeResult.rows[0] };
            }

            await client.query(
                `UPDATE mpesa_payment_verifications
                 SET verification_status = 'UNVERIFIED', completed_at = now(), updated_at = now()
                 WHERE attempt_id = $1
                   AND verification_status = 'PROCESSING'
                   AND updated_at < now() - INTERVAL '2 minutes'`,
                [normalizedAttemptId]
            );

            let verification;
            if (source === "CALLBACK") {
                const existingResult = await client.query(
                    `SELECT verification_id, verification_status
                     FROM mpesa_payment_verifications
                     WHERE callback_fingerprint = $1
                     FOR UPDATE`,
                    [callbackFingerprint]
                );
                const existing = existingResult.rows[0];
                if (existing) {
                    const updated = await client.query(
                        `UPDATE mpesa_payment_verifications
                         SET verification_status = 'PROCESSING',
                              checkout_request_id = $2,
                              merchant_request_id = $3,
                              callback_result_code = $4,
                              callback_amount_matches = $5,
                              callback_phone_matches = $6,
                              callback_receipt = $7,
                             provider_result_code = NULL,
                             provider_result_description = NULL,
                             completed_at = NULL,
                             updated_at = now()
                         WHERE verification_id = $1
                         RETURNING verification_id, verification_status`,
                        [
                            existing.verification_id,
                            normalizedCheckoutId,
                            normalizedMerchantId,
                            normalizedCallbackCode,
                            callbackAmountMatches,
                            callbackPhoneMatches,
                            callbackReceipt,
                        ]
                    );
                    verification = updated.rows[0];
                } else {
                    const inserted = await client.query(
                        `INSERT INTO mpesa_payment_verifications
                            (attempt_id, verification_source, checkout_request_id,
                             merchant_request_id, callback_fingerprint,
                            callback_result_code, callback_amount_matches, callback_phone_matches,
                             callback_receipt,
                             verification_status)
                         VALUES ($1, 'CALLBACK', $2, $3, $4, $5, $6, $7, $8, 'PROCESSING')
                         RETURNING verification_id, verification_status`,
                        [
                            normalizedAttemptId,
                            normalizedCheckoutId,
                            normalizedMerchantId,
                            callbackFingerprint,
                            normalizedCallbackCode,
                            callbackAmountMatches,
                            callbackPhoneMatches,
                            callbackReceipt,
                        ]
                    );
                    verification = inserted.rows[0];
                }
            } else {
                const inserted = await client.query(
                    `INSERT INTO mpesa_payment_verifications
                        (attempt_id, verification_source, checkout_request_id,
                         merchant_request_id, verification_status)
                     VALUES ($1, 'RECONCILIATION', $2, $3, 'PROCESSING')
                     RETURNING verification_id, verification_status`,
                    [normalizedAttemptId, normalizedCheckoutId, normalizedMerchantId]
                );
                verification = inserted.rows[0];
            }
            await client.query("COMMIT");
            transactionStarted = false;
            return { attempt, claimed: true, duplicate: false, verification };
        } catch (error) {
            if (transactionStarted) await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async function completeVerification({
        verificationId,
        verificationStatus,
        providerResultCode = null,
        providerResultDescription = null,
        simulatorOutcome = null,
    }) {
        if (!Number.isSafeInteger(Number(verificationId)) || Number(verificationId) <= 0) {
            throw createRepositoryError("Verification ID is invalid.", "INVALID_VERIFICATION_INPUT", 400);
        }
        if (!["UNVERIFIED", "INCONSISTENT", "VERIFIED_SUCCESS", "VERIFIED_FAILURE"].includes(verificationStatus)) {
            throw createRepositoryError("Verification status is invalid.", "INVALID_VERIFICATION_INPUT", 400);
        }
        const resultCode = requireProviderResultCode(providerResultCode);
        const resultDescription = requireResultDescription(providerResultDescription);
        if (simulatorOutcome !== null &&
            !["SUCCESS", "PENDING", "FAILED", "UNKNOWN"].includes(simulatorOutcome)) {
            throw createRepositoryError(
                "Simulator outcome is invalid.",
                "INVALID_VERIFICATION_INPUT",
                400
            );
        }
        const result = await databasePool.query(
            `UPDATE mpesa_payment_verifications
             SET verification_status = CASE
                     WHEN $1 = 'VERIFIED_SUCCESS'
                      AND verification_source = 'CALLBACK'
                      AND EXISTS (
                          SELECT 1
                          FROM mpesa_payment_attempts a
                          JOIN transactions t ON t.transaction_id = a.transaction_id
                          WHERE a.attempt_id = mpesa_payment_verifications.attempt_id
                            AND t.transaction_status = 'COMPLETED'
                            AND t.mpesa_receipt IS NOT NULL
                            AND t.mpesa_receipt IS DISTINCT FROM mpesa_payment_verifications.callback_receipt
                      )
                     THEN 'INCONSISTENT'
                     ELSE $1
                 END,
                 provider_result_code = $2,
                 provider_result_description = $3,
                 simulator_outcome = $4,
                 completed_at = now(),
                 updated_at = now()
             WHERE verification_id = $5
               AND verification_status = 'PROCESSING'
             RETURNING verification_id, attempt_id, verification_source,
                       checkout_request_id, merchant_request_id,
                       callback_result_code, callback_amount_matches,
                       callback_phone_matches, callback_receipt,
                       verification_status, provider_result_code,
                       provider_result_description, provider_mode, simulator_outcome,
                       created_at, completed_at`,
            [verificationStatus, resultCode, resultDescription, simulatorOutcome, Number(verificationId)]
        );
        if (!result.rows[0]) {
            throw createRepositoryError(
                "Verification evidence is no longer processing.",
                "VERIFICATION_NOT_PROCESSING",
                409
            );
        }
        return result.rows[0];
    }

    async function settleVerifiedPayment({ attemptId, verificationId }) {
        const normalizedAttemptId = requireIdentifier(attemptId, "Payment attempt ID");
        const normalizedVerificationId = Number(verificationId);
        if (!Number.isSafeInteger(normalizedVerificationId) || normalizedVerificationId <= 0) {
            throw createRepositoryError("Verification ID is invalid.", "INVALID_VERIFICATION_INPUT", 400);
        }

        const client = await databasePool.connect();
        let transactionStarted = false;
        try {
            await client.query("BEGIN");
            transactionStarted = true;

            const attemptResult = await client.query(
                `SELECT attempt_id, account_id, contribution_id, transaction_id,
                        expected_amount, mpesa_phone, attempt_status, provider_mode,
                        checkout_request_id, merchant_request_id
                 FROM mpesa_payment_attempts
                 WHERE attempt_id = $1`,
                [normalizedAttemptId]
            );
            const attemptReference = attemptResult.rows[0];
            if (!attemptReference) {
                throw createRepositoryError("Payment attempt was not found.", "PAYMENT_ATTEMPT_NOT_FOUND", 404);
            }

            const lockedAccount = await client.query(
                `SELECT account_id
                 FROM pension_accounts
                 WHERE account_id = $1
                 FOR UPDATE`,
                [attemptReference.account_id]
            );
            if (!lockedAccount.rows[0]) {
                throw createRepositoryError(
                    "Payment account was not found.",
                    "PAYMENT_ACCOUNT_MISMATCH",
                    409
                );
            }

            const linkedResult = await client.query(
                `SELECT t.transaction_id, t.transaction_type, t.amount AS transaction_amount,
                        t.transaction_status, t.mpesa_receipt,
                        t.checkout_request_id AS transaction_checkout_request_id,
                        t.mpesa_phone AS transaction_phone,
                        t.mpesa_result_code AS transaction_result_code,
                        c.contribution_id, c.account_id, c.amount AS contribution_amount,
                        c.channel, c.contribution_status,
                        p.account_id AS pension_account_id, p.user_id,
                        p.current_balance, p.account_status, u.role,
                        u.account_status AS user_status, u.phone AS worker_phone
                 FROM transactions t
                 JOIN contributions c ON c.transaction_id = t.transaction_id
                 JOIN pension_accounts p ON p.account_id = c.account_id
                 JOIN users u ON u.user_id = p.user_id
                 WHERE t.transaction_id = $1
                   AND c.contribution_id = $2
                   AND c.account_id = $3
                   AND c.transaction_id = $1
                   AND p.account_id = $3
                 FOR UPDATE OF t, c, u`,
                [
                    attemptReference.transaction_id,
                    attemptReference.contribution_id,
                    attemptReference.account_id,
                ]
            );
            const linked = linkedResult.rows[0];
            if (!linked ||
                linked.transaction_type !== "CONTRIBUTION" ||
                linked.channel !== "MPESA" ||
                linked.pension_account_id !== attemptReference.account_id ||
                linked.account_id !== attemptReference.account_id ||
                linked.contribution_id !== attemptReference.contribution_id ||
                linked.transaction_id !== attemptReference.transaction_id ||
                linked.role !== "WORKER") {
                throw createRepositoryError(
                    "Payment attempt does not match its worker contribution and account.",
                    "PAYMENT_ACCOUNT_MISMATCH",
                    409
                );
            }

            const lockedAttemptResult = await client.query(
                `SELECT attempt_id, account_id, contribution_id, transaction_id,
                        expected_amount, mpesa_phone, attempt_status, provider_mode,
                        checkout_request_id, merchant_request_id
                 FROM mpesa_payment_attempts
                 WHERE attempt_id = $1
                 FOR UPDATE`,
                [normalizedAttemptId]
            );
            const attempt = lockedAttemptResult.rows[0];
            if (!attempt ||
                attempt.account_id !== attemptReference.account_id ||
                attempt.contribution_id !== attemptReference.contribution_id ||
                attempt.transaction_id !== attemptReference.transaction_id) {
                throw createRepositoryError(
                    "Payment attempt changed during settlement.",
                    "PAYMENT_SETTLEMENT_CONFLICT",
                    409
                );
            }

            const evidenceResult = await client.query(
                `SELECT verification_id, attempt_id, verification_source,
                       checkout_request_id, merchant_request_id,
                       callback_fingerprint, callback_result_code,
                       callback_amount_matches, callback_phone_matches, callback_receipt,
                       provider_result_code, provider_result_description,
                       verification_status, provider_mode, simulator_outcome
                 FROM mpesa_payment_verifications
                 WHERE verification_id = $1 AND attempt_id = $2
                 FOR UPDATE`,
                [normalizedVerificationId, normalizedAttemptId]
            );
            const evidence = evidenceResult.rows[0];
            if (!evidence || !["VERIFIED_SUCCESS", "VERIFIED_FAILURE"].includes(evidence.verification_status)) {
                throw createRepositoryError(
                    "Payment has no definitive provider verification evidence.",
                    "PAYMENT_NOT_VERIFIED",
                    409
                );
            }
            if (
                !attempt.checkout_request_id ||
                !attempt.merchant_request_id ||
                evidence.checkout_request_id !== attempt.checkout_request_id ||
                evidence.merchant_request_id !== attempt.merchant_request_id ||
                !attempt.provider_mode ||
                evidence.provider_mode !== attempt.provider_mode
            ) {
                throw createRepositoryError(
                    "Payment attempt has no matching persisted provider evidence.",
                    "PAYMENT_NOT_VERIFIED",
                    409
                );
            }

            const expectedCents = decimalToCents(attempt.expected_amount, "Expected amount");
            const transactionCents = decimalToCents(linked.transaction_amount, "Transaction amount");
            const contributionCents = decimalToCents(linked.contribution_amount, "Contribution amount");
            if (
                expectedCents <= 0n ||
                expectedCents !== transactionCents ||
                expectedCents !== contributionCents
            ) {
                throw createRepositoryError(
                    "Payment, transaction, and contribution amounts do not match.",
                    "PAYMENT_AMOUNT_MISMATCH",
                    409
                );
            }

            if (evidence.verification_status === "VERIFIED_SUCCESS") {
                const callbackVerified =
                    evidence.verification_source === "CALLBACK" &&
                    evidence.callback_result_code === "0" &&
                    evidence.callback_amount_matches === true &&
                    evidence.callback_phone_matches === true &&
                    /^[A-Za-z0-9]{1,25}$/.test(evidence.callback_receipt || "");
                const queryVerified =
                    evidence.verification_source === "RECONCILIATION" &&
                    evidence.callback_result_code === null &&
                    evidence.callback_amount_matches === null &&
                    evidence.callback_phone_matches === null &&
                    evidence.callback_receipt === null;
                if (!callbackVerified && !queryVerified || evidence.provider_result_code !== "0") {
                    throw createRepositoryError(
                        "Verified success evidence does not match an allowed callback or query-only evidence path.",
                        "PAYMENT_NOT_VERIFIED",
                        409
                    );
                }

                let callbackEvidenceId = null;
                let simulatorConfirmationId = null;
                if (attempt.provider_mode === "DARAJA") {
                    if (evidence.simulator_outcome !== null) {
                        throw createRepositoryError(
                            "Simulator evidence cannot verify a Daraja attempt.",
                            "PAYMENT_PROVIDER_MISMATCH",
                            409
                        );
                    }
                    if (callbackVerified) {
                        const callbackResult = await client.query(
                            `SELECT callback_id
                             FROM mpesa_callback_inbox
                             WHERE callback_fingerprint = $1
                               AND attempt_id = $2
                               AND verification_id = $3
                               AND callback_status = 'VERIFIED'
                             FOR UPDATE`,
                            [
                                evidence.callback_fingerprint,
                                normalizedAttemptId,
                                normalizedVerificationId,
                            ]
                        );
                        callbackEvidenceId = callbackResult.rows[0]?.callback_id ?? null;
                        if (!callbackEvidenceId) {
                            throw createRepositoryError(
                                "Daraja callback evidence is not durably linked to its verification.",
                                "PAYMENT_NOT_VERIFIED",
                                409
                            );
                        }
                    }
                } else if (attempt.provider_mode === "SIMULATOR") {
                    if (!queryVerified ||
                        evidence.simulator_outcome !== "SUCCESS" ||
                        !/^SIM[A-F0-9]{22}$/.test(attempt.checkout_request_id) ||
                        !/^SIMULATED: .*no real money was transferred\.$/i.test(
                            evidence.provider_result_description || ""
                        )) {
                        throw createRepositoryError(
                            "Simulator success requires explicit synthetic confirmation evidence.",
                            "PAYMENT_PROVIDER_MISMATCH",
                            409
                        );
                    }
                    const simulatorEvidence = await client.query(
                        `SELECT confirmation_id
                         FROM simulator_payment_confirmations
                         WHERE attempt_id = $1
                           AND verification_id = $2
                           AND synthetic_reference = $3
                           AND outcome = 'SUCCESS'
                         FOR UPDATE`,
                        [
                            normalizedAttemptId,
                            normalizedVerificationId,
                            attempt.checkout_request_id,
                        ]
                    );
                    simulatorConfirmationId =
                        simulatorEvidence.rows[0]?.confirmation_id ?? null;
                    if (!simulatorConfirmationId) {
                        throw createRepositoryError(
                            "Simulator confirmation record is missing.",
                            "PAYMENT_NOT_VERIFIED",
                            409
                        );
                    }
                } else {
                    throw createRepositoryError(
                        "Unresolved payment provider cannot settle.",
                        "PAYMENT_PROVIDER_MISMATCH",
                        409
                    );
                }

                if (
                    linked.transaction_status === "COMPLETED" &&
                    linked.contribution_status === "COMPLETED" &&
                    ["PROMPT_ACCEPTED", "OUTCOME_UNKNOWN"].includes(attempt.attempt_status) &&
                    linked.transaction_checkout_request_id === attempt.checkout_request_id &&
                    linked.transaction_phone === attempt.mpesa_phone &&
                    String(linked.transaction_result_code) === "0"
                ) {
                    if (evidence.callback_receipt !== null &&
                        linked.mpesa_receipt !== evidence.callback_receipt) {
                        if (linked.mpesa_receipt !== null) {
                            throw createRepositoryError(
                                "A verified callback receipt conflicts with the settled transaction receipt.",
                                "PAYMENT_RECEIPT_CONFLICT",
                                409
                            );
                        }
                        const receiptOwner = await client.query(
                            `SELECT transaction_id
                             FROM transactions
                             WHERE mpesa_receipt = $1 AND transaction_id <> $2
                             FOR UPDATE`,
                            [evidence.callback_receipt, attempt.transaction_id]
                        );
                        if (receiptOwner.rows[0]) {
                            throw createRepositoryError(
                                "Provider receipt is already associated with another transaction.",
                                "DUPLICATE_MPESA_RECEIPT",
                                409
                            );
                        }
                        const enrichedTransaction = await client.query(
                            `UPDATE transactions
                             SET mpesa_receipt = $1, updated_at = now()
                             WHERE transaction_id = $2
                               AND transaction_status = 'COMPLETED'
                               AND mpesa_receipt IS NULL
                               AND checkout_request_id = $3
                               AND mpesa_phone = $4
                               AND mpesa_result_code = 0
                             RETURNING transaction_id`,
                            [
                                evidence.callback_receipt,
                                attempt.transaction_id,
                                attempt.checkout_request_id,
                                attempt.mpesa_phone,
                            ]
                        );
                        if (!enrichedTransaction.rows[0]) {
                            throw createRepositoryError(
                                "Settled transaction receipt could not be safely enriched.",
                                "PAYMENT_RECEIPT_CONFLICT",
                                409
                            );
                        }
                    }
                    await client.query("COMMIT");
                    transactionStarted = false;
                    return {
                        attempt_id: normalizedAttemptId,
                        alreadySettled: true,
                        contribution_status: linked.contribution_status,
                        transaction_status: linked.transaction_status,
                    };
                }

                if (
                    linked.transaction_status !== "PENDING" ||
                    linked.contribution_status !== "PENDING" ||
                    !["PROMPT_ACCEPTED", "OUTCOME_UNKNOWN"].includes(attempt.attempt_status)
                ) {
                    throw createRepositoryError(
                        "Payment records are not in a settleable pending state.",
                        "PAYMENT_ALREADY_TERMINAL",
                        409
                    );
                }

                if (evidence.callback_receipt !== null) {
                    const receiptOwner = await client.query(
                        `SELECT transaction_id
                         FROM transactions
                         WHERE mpesa_receipt = $1 AND transaction_id <> $2
                         FOR UPDATE`,
                        [evidence.callback_receipt, attempt.transaction_id]
                    );
                    if (receiptOwner.rows[0]) {
                        throw createRepositoryError(
                            "Provider receipt is already associated with another transaction.",
                            "DUPLICATE_MPESA_RECEIPT",
                            409
                        );
                    }
                }

                const verifiedReceipt = evidence.callback_receipt;
                const updatedTransaction = await client.query(
                    `UPDATE transactions
                     SET transaction_status = 'COMPLETED',
                         mpesa_receipt = $1,
                         checkout_request_id = $2,
                         mpesa_phone = $3,
                         mpesa_result_code = 0,
                         mpesa_result_description = $4,
                         completed_at = COALESCE(completed_at, now()),
                         updated_at = now()
                     WHERE transaction_id = $5
                       AND transaction_status = 'PENDING'
                     RETURNING transaction_id`,
                    [
                        verifiedReceipt,
                        attempt.checkout_request_id,
                        attempt.mpesa_phone,
                        evidence.provider_result_description,
                        attempt.transaction_id,
                    ]
                );
                if (!updatedTransaction.rows[0]) {
                    throw createRepositoryError(
                        "Transaction could not be completed.",
                        "PAYMENT_SETTLEMENT_CONFLICT",
                        409
                    );
                }

                const updatedContribution = await client.query(
                    `UPDATE contributions
                     SET contribution_status = 'COMPLETED', updated_at = now()
                     WHERE contribution_id = $1
                       AND account_id = $2
                       AND transaction_id = $3
                       AND contribution_status = 'PENDING'
                     RETURNING contribution_id`,
                    [attempt.contribution_id, attempt.account_id, attempt.transaction_id]
                );
                if (!updatedContribution.rows[0]) {
                    throw createRepositoryError(
                        "Contribution could not be completed.",
                        "PAYMENT_SETTLEMENT_CONFLICT",
                        409
                    );
                }

                const movementResult = await client.query(
                    `INSERT INTO pension_account_movements (
                         ledger_id, account_id, movement_type, amount, currency,
                         idempotency_key, transaction_id, contribution_id,
                         payment_attempt_id, payment_verification_id, payment_callback_id,
                         simulator_confirmation_id, effective_at, actor_type,
                         actor_reference, provider_mode
                     )
                     SELECT l.ledger_id, $1, 'CONTRIBUTION_SETTLEMENT', $2::numeric,
                            'KES', $3, $4, $5, $6, $7, $8, $9, now(), 'SYSTEM',
                            'mpesa-payment-settlement', $10
                     FROM pension_ledger l
                     WHERE l.singleton_key IS TRUE AND l.status = 'ACTIVE'
                     ON CONFLICT (contribution_id)
                         WHERE movement_type = 'CONTRIBUTION_SETTLEMENT'
                     DO NOTHING
                     RETURNING movement_id`,
                    [
                        attempt.account_id,
                        centsToDecimal(expectedCents),
                        `contribution-settlement:${attempt.contribution_id}`,
                        attempt.transaction_id,
                        attempt.contribution_id,
                        normalizedAttemptId,
                        normalizedVerificationId,
                        callbackEvidenceId,
                        simulatorConfirmationId,
                        attempt.provider_mode,
                    ]
                );
                if (!movementResult.rows[0]) {
                    throw createRepositoryError(
                        "A contribution settlement movement already exists for this source.",
                        "PAYMENT_ALREADY_SETTLED",
                        409
                    );
                }
                const balanceResult = await client.query(
                    `SELECT current_balance
                     FROM pension_accounts
                     WHERE account_id = $1`,
                    [attempt.account_id]
                );
                if (!balanceResult.rows[0]) {
                    throw createRepositoryError(
                        "Pension account balance could not be read after ledger posting.",
                        "PAYMENT_ACCOUNT_MISMATCH",
                        409
                    );
                }
                const reference = verifiedReceipt || attempt.transaction_id;
                const message = `MicoPesa: We received your contribution of KES ${centsToDecimal(expectedCents)}. Ref: ${reference}.`;
                if (attempt.provider_mode === "DARAJA") {
                    await client.query(
                        `INSERT INTO notifications (
                            user_id, notification_type, message, recipient_phone, deduplication_key
                         )
                         VALUES ($1, 'SMS', $2, $3, $4)
                         ON CONFLICT (deduplication_key)
                         WHERE notification_type = 'SMS' AND deduplication_key IS NOT NULL
                         DO NOTHING`,
                        [
                            linked.user_id,
                            message,
                            linked.worker_phone,
                            `mpesa-contribution:${normalizedAttemptId}`,
                        ]
                    );
                }
                await client.query("COMMIT");
                transactionStarted = false;
                return {
                    attempt_id: normalizedAttemptId,
                    alreadySettled: false,
                    account_balance: balanceResult.rows[0].current_balance,
                    contribution_status: "COMPLETED",
                    transaction_status: "COMPLETED",
                };
            }

            const failureCode = evidence.provider_result_code;
            if (
                !failureCode ||
                failureCode === "0" ||
                (evidence.verification_source === "CALLBACK" &&
                    evidence.callback_result_code !== failureCode) ||
                !["PROMPT_ACCEPTED", "OUTCOME_UNKNOWN", "FAILED", "CANCELLED", "TIMED_OUT"].includes(
                    attempt.attempt_status
                )
            ) {
                throw createRepositoryError(
                    "Payment failure is not definitively verified.",
                    "PAYMENT_NOT_VERIFIED",
                    409
                );
            }
            const numericFailureCode = Number(failureCode);
            if (
                !Number.isInteger(numericFailureCode) ||
                numericFailureCode < -2147483648 ||
                numericFailureCode > 2147483647
            ) {
                throw createRepositoryError(
                    "Verified provider result code is outside the transaction schema range.",
                    "INVALID_PROVIDER_RESULT_CODE",
                    409
                );
            }
            const failureAttemptStatus = failureStatusesFor(failureCode);
            if (attempt.attempt_status === failureAttemptStatus &&
                linked.transaction_status === "PENDING" &&
                linked.contribution_status === "PENDING") {
                await client.query("COMMIT");
                transactionStarted = false;
                return {
                    attempt_id: normalizedAttemptId,
                    alreadySettled: true,
                    contribution_status: linked.contribution_status,
                    transaction_status: linked.transaction_status,
                };
            }
            if (
                linked.transaction_status !== "PENDING" ||
                linked.contribution_status !== "PENDING" ||
                !["PROMPT_ACCEPTED", "OUTCOME_UNKNOWN"].includes(attempt.attempt_status)
            ) {
                throw createRepositoryError(
                    "Payment records are not in a settleable pending state.",
                    "PAYMENT_ALREADY_TERMINAL",
                    409
                );
            }

            const failedAttempt = await client.query(
                `UPDATE mpesa_payment_attempts
                 SET attempt_status = $1, updated_at = now()
                 WHERE attempt_id = $2
                   AND attempt_status IN ('PROMPT_ACCEPTED', 'OUTCOME_UNKNOWN')
                 RETURNING attempt_id`,
                [failureAttemptStatus, normalizedAttemptId]
            );
            if (!failedAttempt.rows[0]) {
                throw createRepositoryError("Payment attempt could not be marked failed.", "PAYMENT_SETTLEMENT_CONFLICT", 409);
            }
            await client.query("COMMIT");
            transactionStarted = false;
            return {
                attempt_id: normalizedAttemptId,
                alreadySettled: false,
                attempt_status: failureAttemptStatus,
                contribution_status: "PENDING",
                transaction_status: "PENDING",
            };
        } catch (error) {
            if (transactionStarted) {
                await client.query("ROLLBACK");
                transactionStarted = false;
            }
            if (error?.code === "23505" && error?.constraint === "uq_transactions_mpesa_receipt") {
                throw createRepositoryError(
                    "Provider receipt is already associated with another transaction.",
                    "DUPLICATE_MPESA_RECEIPT",
                    409
                );
            }
            throw error;
        } finally {
            client.release();
        }
    }

    return {
        claimVerification,
        completeVerification,
        createPaymentAttemptForContribution: (input) =>
            createPaymentAttemptForContribution(input),
        createPendingMpesaPayment,
        createPendingPaymentAttempt,
        findByCheckoutRequestId,
        findById,
        getWorkerPaymentStatus,
        getWorkerPaymentStatusByIdempotencyKey,
        markProviderRequestRejected,
        markProviderRequestStarted,
        recordDispatchedProviderRequestAccepted,
        recordProviderRequestAccepted,
        settleVerifiedPayment,
    };
}

let defaultRepository;
function getDefaultRepository() {
    if (!defaultRepository) {
        defaultRepository = createMpesaPaymentAttemptRepository(require("../db/database"));
    }
    return defaultRepository;
}

module.exports = {
    claimVerification: (...args) => getDefaultRepository().claimVerification(...args),
    completeVerification: (...args) => getDefaultRepository().completeVerification(...args),
    createMpesaPaymentAttemptRepository,
    createPaymentAttemptForContribution: (...args) =>
        getDefaultRepository().createPaymentAttemptForContribution(...args),
    createPendingMpesaPayment: (...args) => getDefaultRepository().createPendingMpesaPayment(...args),
    createPendingPaymentAttempt: (...args) => getDefaultRepository().createPendingPaymentAttempt(...args),
    findByCheckoutRequestId: (...args) => getDefaultRepository().findByCheckoutRequestId(...args),
    findById: (...args) => getDefaultRepository().findById(...args),
    getWorkerPaymentStatus: (...args) => getDefaultRepository().getWorkerPaymentStatus(...args),
    getWorkerPaymentStatusByIdempotencyKey: (...args) =>
        getDefaultRepository().getWorkerPaymentStatusByIdempotencyKey(...args),
    markProviderRequestRejected: (...args) => getDefaultRepository().markProviderRequestRejected(...args),
    markProviderRequestStarted: (...args) => getDefaultRepository().markProviderRequestStarted(...args),
    recordDispatchedProviderRequestAccepted: (...args) =>
        getDefaultRepository().recordDispatchedProviderRequestAccepted(...args),
    recordProviderRequestAccepted: (...args) => getDefaultRepository().recordProviderRequestAccepted(...args),
    settleVerifiedPayment: (...args) => getDefaultRepository().settleVerifiedPayment(...args),
};
