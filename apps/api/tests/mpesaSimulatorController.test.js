const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const pool = require("../src/db/database");
const { generateToken } = require("../src/utils/token");
const {
    createMpesaSimulatorController,
} = require("../src/controllers/mpesaSimulatorController");
const mpesaRoutes = require("../src/routes/mpesaRoutes");

const originalQuery = pool.query;
const originalJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET ||= "micopesa-simulator-controller-test-secret";
let authenticatedUser;
let kycStatus;
const routeQueries = [];

after(() => {
    pool.query = originalQuery;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
});

function response() {
    return {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

function enabledEnvironment(outcome = "UNKNOWN") {
    return {
        NODE_ENV: "test",
        MPESA_PAYMENT_PROVIDER: "SIMULATOR",
        MPESA_SIMULATOR_ENABLED: "true",
        MPESA_SIMULATOR_OUTCOME: outcome,
        MPESA_LEDGER_ENFORCEMENT_ENABLED: "false",
    };
}

function createInitiationHarness({
    verifiedPhone = "254712345678",
    ledgerFailure = null,
    initiationError = null,
    diagnosticSink = () => {},
} = {}) {
    const calls = {
        profileLookups: [],
        ledgerChecks: 0,
        pendingPayments: [],
        persistedAttempts: [],
        providerRequests: [],
        confirmations: [],
    };
    const attempt = {
        attempt_id: "attempt-simulator-1",
        contribution_id: "contribution-1",
        transaction_id: "transaction-1",
        expected_amount: "2500",
        attempt_status: "PENDING",
    };
    const repository = {
        async getVerifiedWorkerPhone(workerId) {
            calls.profileLookups.push(workerId);
            return verifiedPhone;
        },
        async assertPensionLedgerActive() {
            calls.ledgerChecks += 1;
            if (ledgerFailure) throw ledgerFailure;
            return true;
        },
        async createPendingMpesaPayment(input) {
            calls.pendingPayments.push(input);
            if (initiationError) throw initiationError;
            calls.persistedAttempts.push(attempt);
            return { attempt, created: true };
        },
        async markProviderRequestStarted(attemptId) {
            assert.equal(attemptId, attempt.attempt_id);
            return true;
        },
        async recordDispatchedProviderRequestAccepted(input) {
            return {
                checkout_request_id: input.checkoutRequestId,
                merchant_request_id: input.merchantRequestId,
                attempt_status: "PROMPT_ACCEPTED",
            };
        },
        async getWorkerPaymentStatus(attemptId, workerId) {
            assert.equal(attemptId, attempt.attempt_id);
            assert.equal(workerId, "worker-1");
            return {
                attempt_id: attempt.attempt_id,
                transaction_id: attempt.transaction_id,
                amount: 2500,
                attempt_status: "PROMPT_ACCEPTED",
                transaction_status: "PENDING",
                contribution_status: "PENDING",
                settlement_confirmed: false,
                payment_provider: "SIMULATED",
                payment_outcome: "UNKNOWN",
            };
        },
    };
    const providerService = {
        async initiateStkPush(input) {
            calls.providerRequests.push(input);
            return {
                checkoutRequestId: `SIM${"A".repeat(22)}`,
                merchantRequestId: `SIMM${"A".repeat(21)}`,
            };
        },
    };
    const paymentVerificationService = {
        async confirmSimulatorAttempt(attemptId, workerId) {
            calls.confirmations.push([attemptId, workerId]);
            return { verification_status: "UNVERIFIED", outcome: "UNKNOWN" };
        },
    };
    const controller = createMpesaSimulatorController({
        repository,
        providerService,
        paymentVerificationService,
        environmentProvider: () => enabledEnvironment(),
        diagnosticSink,
    });
    return { calls, controller, repository };
}

test("simulator initiation uses the worker's verified profile phone instead of request input", async () => {
    const { calls, controller } = createInitiationHarness();
    const res = response();

    await controller.initiateSimulatedPayment({
        user: { userId: "worker-1", role: "WORKER" },
        body: {
            provider: "SIMULATOR",
            amount: 2500,
            idempotencyKey: "simulator-phone-test",
            phoneNumber: "254700000001",
        },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.profileLookups, ["worker-1"]);
    assert.equal(calls.pendingPayments[0].phoneNumber, "254712345678");
    assert.equal(calls.providerRequests[0].phoneNumber, "254712345678");
    assert.notEqual(calls.pendingPayments[0].phoneNumber, "254700000001");
    assert.equal(calls.ledgerChecks, 1);
});

test("simulator initiation fails closed when the verified worker phone is missing", async () => {
    const { calls, controller } = createInitiationHarness({ verifiedPhone: null });
    const res = response();

    await controller.initiateSimulatedPayment({
        user: { userId: "worker-1", role: "WORKER" },
        body: {
            provider: "SIMULATOR",
            amount: 2500,
            idempotencyKey: "simulator-no-phone",
            phoneNumber: "254700000001",
        },
    }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.message_key, "MPESA_VERIFIED_PHONE_REQUIRED");
    assert.deepEqual(calls.pendingPayments, []);
    assert.deepEqual(calls.providerRequests, []);
});

test("allocation rejection returns an accurate sanitized explanation without dispatching", async () => {
    const diagnostics = [];
    const { calls, controller } = createInitiationHarness({
        initiationError: Object.assign(
            new Error("The worker must have valid active fund allocations totaling 100%."),
            { code: "PAYMENT_ALLOCATION_INVALID", statusCode: 409 }
        ),
        diagnosticSink: (entry) => diagnostics.push(entry),
    });
    const res = response();

    await controller.initiateSimulatedPayment({
        user: { userId: "worker-1", role: "WORKER" },
        body: {
            provider: "SIMULATOR",
            amount: 2500,
            idempotencyKey: "allocation-invalid",
        },
        method: "POST",
        baseUrl: "/api/mpesa",
        route: { path: "/payments" },
    }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.message_key, "MPESA_ALLOCATION_INVALID");
    assert.match(res.body.message, /allocations.*100%/i);
    assert.doesNotMatch(res.body.message, /phone|password|token|secret/i);
    assert.equal(diagnostics[0].statusCode, 409);
    assert.equal(diagnostics[0].code, "PAYMENT_ALLOCATION_INVALID");
    assert.deepEqual(calls.providerRequests, []);
    assert.deepEqual(calls.confirmations, []);
    assert.equal(calls.pendingPayments.length, 1);
    assert.equal(calls.persistedAttempts.length, 0);
});

test("simulator initiation fails closed when verified-phone lookup is unavailable", async () => {
    let attemptsCreated = 0;
    const controller = createMpesaSimulatorController({
        repository: {
            async assertPensionLedgerActive() {},
            async createPendingMpesaPayment() {
                attemptsCreated += 1;
            },
        },
        providerService: { async initiateStkPush() {
            assert.fail("Phone lookup failure must stop provider dispatch");
        } },
        paymentVerificationService: {},
        environmentProvider: () => enabledEnvironment(),
        diagnosticSink() {},
    });
    const res = response();

    await controller.initiateSimulatedPayment({
        user: { userId: "worker-1", role: "WORKER" },
        body: {
            provider: "SIMULATOR",
            amount: 2500,
            idempotencyKey: "simulator-phone-lookup-unavailable",
            phoneNumber: "254712345678",
        },
    }, res);

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.message_key, "MPESA_VERIFIED_PHONE_REQUIRED");
    assert.equal(attemptsCreated, 0);
});

test("simulator initiation does not create an attempt when the ledger is inactive", async () => {
    const { calls, controller } = createInitiationHarness({
        ledgerFailure: Object.assign(new Error("ledger not active"), {
            code: "PENSION_LEDGER_NOT_ACTIVE",
            statusCode: 503,
        }),
    });
    const res = response();

    await controller.initiateSimulatedPayment({
        user: { userId: "worker-1", role: "WORKER" },
        body: {
            provider: "SIMULATOR",
            amount: 2500,
            idempotencyKey: "simulator-inactive-ledger",
            phoneNumber: "254712345678",
        },
    }, res);

    assert.equal(res.statusCode, 503);
    assert.equal(calls.ledgerChecks, 1);
    assert.deepEqual(calls.pendingPayments, []);
    assert.deepEqual(calls.providerRequests, []);
});

test("UNKNOWN recovery confirms the existing attempt without creating another payment", async () => {
    const calls = [];
    const repository = {
        async assertPensionLedgerActive() {
            calls.push("ledger-ready");
            throw Object.assign(new Error("ledger is not active"), {
                code: "PENSION_LEDGER_NOT_ACTIVE",
                statusCode: 503,
            });
        },
        async findById(attemptId) {
            calls.push(["find-attempt", attemptId]);
            return {
                attempt_id: attemptId,
                user_id: "worker-1",
                expected_amount: "2500",
                attempt_status: "OUTCOME_UNKNOWN",
            };
        },
        async getWorkerPaymentStatus(attemptId, workerId) {
            return {
                attempt_id: attemptId,
                transaction_id: "transaction-1",
                amount: 2500,
                attempt_status: "OUTCOME_UNKNOWN",
                transaction_status: "PENDING",
                contribution_status: "PENDING",
                settlement_confirmed: false,
                payment_provider: "SIMULATED",
                payment_outcome: "UNKNOWN",
            };
        },
        async createPendingMpesaPayment() {
            assert.fail("UNKNOWN recovery must not initiate a new payment");
        },
    };
    const controller = createMpesaSimulatorController({
        repository,
        providerService: { async initiateStkPush() {
            assert.fail("UNKNOWN recovery must not initiate a new provider request");
        } },
        paymentVerificationService: {
            async confirmSimulatorAttempt(attemptId, workerId) {
                calls.push(["confirm-attempt", attemptId, workerId]);
                return { verification_status: "UNVERIFIED", outcome: "UNKNOWN" };
            },
        },
        environmentProvider: () => enabledEnvironment(),
        diagnosticSink() {},
    });
    const res = response();

    await controller.confirmSimulatedPayment({
        user: { userId: "worker-1", role: "WORKER" },
        params: { attemptId: "attempt-original" },
        body: { provider: "SIMULATOR" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.payment_outcome, "UNKNOWN");
    assert.equal(res.body.data.attempt_id, "attempt-original");
    assert.deepEqual(calls, [
        ["confirm-attempt", "attempt-original", "worker-1"],
        ["find-attempt", "attempt-original"],
    ]);
});

async function startRouteApi() {
    const app = express();
    app.use(express.json());
    app.use("/api/mpesa", mpesaRoutes);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    return {
        async close() {
            await new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
        },
        url: `http://127.0.0.1:${server.address().port}`,
    };
}

pool.query = async (sql, params = []) => {
    routeQueries.push(sql.replace(/\s+/g, " ").trim());
    if (/SELECT user_id, role, account_status(?:, approval_status)?, auth_version/.test(sql)) {
        return {
            rows: [{
                user_id: authenticatedUser.user_id,
                role: authenticatedUser.role,
                account_status: "ACTIVE",
                auth_version: 0,
                force_password_change: false,
                is_temp_password: false,
            }],
        };
    }
    if (sql.includes("SELECT kyc_status FROM kyc_records")) {
        return { rows: kycStatus ? [{ kyc_status: kycStatus }] : [] };
    }
    assert.fail(`Unexpected database query in simulator route test: ${sql}`);
};

test("simulator routes retain worker authorization and verified-KYC middleware", async () => {
    const api = await startRouteApi();
    try {
        authenticatedUser = { user_id: "admin-1", role: "ADMIN" };
        kycStatus = "VERIFIED";
        const adminResponse = await fetch(`${api.url}/api/mpesa/payments`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${generateToken({
                    userId: authenticatedUser.user_id,
                    role: authenticatedUser.role,
                })}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ provider: "SIMULATOR" }),
        });
        assert.equal(adminResponse.status, 403);
        assert.equal(routeQueries.some((query) => query.includes("kyc_records")), false);

        authenticatedUser = { user_id: "worker-1", role: "WORKER" };
        kycStatus = null;
        const workerToken = generateToken({
            userId: authenticatedUser.user_id,
            role: authenticatedUser.role,
        });
        for (const route of [
            "/api/mpesa/payments",
            "/api/mpesa/simulator/attempts/attempt-1/confirm",
        ]) {
            const deniedResponse = await fetch(`${api.url}${route}`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${workerToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ provider: "SIMULATOR" }),
            });
            assert.equal(deniedResponse.status, 403);
            assert.equal((await deniedResponse.json()).code, "KYC_VERIFICATION_REQUIRED");
        }
        assert.equal(routeQueries.filter((query) => query.includes("kyc_records")).length, 2);
    } finally {
        await api.close();
    }
});
