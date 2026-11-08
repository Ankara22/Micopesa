const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    assertSimulatorRequest,
    getPaymentProviderConfiguration,
} = require("../src/services/mpesaPaymentProviderConfig");
const { createMpesaSimulatorService } = require("../src/services/mpesaSimulatorService");
const {
    createMpesaSimulatorController,
} = require("../src/controllers/mpesaSimulatorController");

const enabledEnvironment = (outcome = "SUCCESS") => ({
    NODE_ENV: "test",
    MPESA_PAYMENT_PROVIDER: "SIMULATOR",
    MPESA_SIMULATOR_ENABLED: "true",
    MPESA_SIMULATOR_OUTCOME: outcome,
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

test("the simulator is disabled by default", async () => {
    const config = getPaymentProviderConfiguration({ NODE_ENV: "development" });
    const simulator = createMpesaSimulatorService({
        environmentProvider: () => ({ NODE_ENV: "development" }),
    });

    assert.equal(config.simulatorEnabled, false);
    await assert.rejects(simulator.initiateStkPush(), { statusCode: 409 });
});

test("production rejects simulated payments even if explicitly enabled", () => {
    const environment = {
        NODE_ENV: "production",
        MPESA_PAYMENT_PROVIDER: "SIMULATOR",
        MPESA_SIMULATOR_ENABLED: "true",
    };
    assert.throws(() => assertSimulatorRequest("SIMULATOR", environment), {
        statusCode: 403,
    });
    assert.equal(getPaymentProviderConfiguration(environment).simulatorEnabled, false);
});

test("the requested simulator provider must match explicit server configuration", () => {
    assert.throws(() => assertSimulatorRequest("SIMULATOR", {
        NODE_ENV: "development",
        MPESA_PAYMENT_PROVIDER: "DARAJA",
        MPESA_SIMULATOR_ENABLED: "true",
    }), { statusCode: 409 });
    assert.throws(() => assertSimulatorRequest("DARAJA", enabledEnvironment()), {
        statusCode: 400,
    });
});

test("synthetic transaction identifiers are deterministic in shape and cannot be Safaricom codes", async () => {
    const simulator = createMpesaSimulatorService({
        environmentProvider: () => enabledEnvironment(),
        idGenerator: () => "01234567-89ab-cdef-0123-456789abcdef",
    });
    const initiated = await simulator.initiateStkPush();

    assert.match(initiated.checkoutRequestId, /^SIM[A-F0-9]{22}$/);
    assert.match(initiated.merchantRequestId, /^SIMM[A-F0-9]{21}$/);
    assert.equal(initiated.checkoutRequestId.length, 25);
    assert.equal(initiated.merchantRequestId.length, 25);
    assert.match(initiated.checkoutRequestId, /^SIM/);
});

test("configured success, pending, failure and unknown outcomes repeat consistently", async () => {
    const identifier = `SIM${"A".repeat(22)}`;
    for (const [outcome, expectedCode, expectedStatus] of [
        ["SUCCESS", "0", undefined],
        ["PENDING", "0", "PENDING"],
        ["FAILED", "1", undefined],
    ]) {
        const simulator = createMpesaSimulatorService({
            environmentProvider: () => enabledEnvironment(outcome),
        });
        const first = await simulator.queryStkPush({ checkoutRequestId: identifier });
        const second = await simulator.queryStkPush({ checkoutRequestId: identifier });
        assert.equal(first.resultCode, expectedCode);
        assert.equal(first.outcomeStatus, expectedStatus);
        assert.deepEqual(second, first);
        assert.match(first.resultDescription, /SIMULATED/);
        assert.match(first.resultDescription, /no real money was transferred/i);
    }

    const unknownSimulator = createMpesaSimulatorService({
        environmentProvider: () => enabledEnvironment("UNKNOWN"),
    });
    await assert.rejects(
        unknownSimulator.queryStkPush({ checkoutRequestId: identifier }),
        { code: "SIMULATOR_OUTCOME_UNKNOWN" }
    );
});

test("simulator controller rejects non-worker roles and ignores caller-supplied success outcomes", async () => {
    const calls = [];
    const repository = {
        async createPendingMpesaPayment() {
            calls.push("create");
            return { attempt: {}, created: true };
        },
        async getWorkerPaymentStatus() {
            return {
                attempt_id: "attempt_1",
                transaction_id: "transaction_1",
                amount: 100,
                attempt_status: "PROMPT_ACCEPTED",
                transaction_status: "PENDING",
                contribution_status: "PENDING",
                settlement_confirmed: false,
                payment_provider: "SIMULATED",
                verification_description: null,
            };
        },
        async findById(attemptId) {
            return {
                attempt_id: attemptId,
                user_id: "worker_1",
                expected_amount: "100",
                attempt_status: "PROMPT_ACCEPTED",
            };
        },
    };
    const paymentVerificationService = {
        async confirmSimulatorAttempt(...args) {
            calls.push(args);
            return { verification_status: "UNVERIFIED", outcome: "UNKNOWN" };
        },
    };
    const controller = createMpesaSimulatorController({
        repository,
        providerService: { async initiateStkPush() {} },
        paymentVerificationService,
        environmentProvider: () => enabledEnvironment(),
    });

    const denied = response();
    await controller.initiateSimulatedPayment({
        user: { userId: "manager_1", role: "FUND_MANAGER" },
        body: { provider: "SIMULATOR", amount: 100, phoneNumber: "0712345678" },
    }, denied);
    assert.equal(denied.statusCode, 403);
    assert.deepEqual(calls, []);

    const confirmationResponse = response();
    await controller.confirmSimulatedPayment({
        user: { userId: "worker_1", role: "WORKER" },
        params: { attemptId: "attempt_1" },
        body: {
            provider: "SIMULATOR",
            outcome: "SUCCESS",
            resultCode: "0",
        },
    }, confirmationResponse);
    assert.equal(confirmationResponse.statusCode, 200);
    assert.equal(confirmationResponse.body.data.payment_outcome, "UNKNOWN");
    assert.deepEqual(calls[0], ["attempt_1", "worker_1"]);
});

test("simulator confirmation logs sanitized database diagnostics and preserves the 503 response", async () => {
    const persistedDiagnostics = [];
    const error = Object.assign(
        new Error("new row violates check constraint for phone 0712345678 with idempotency_key=secret-value"),
        {
            code: "23514",
            constraint: "chk_mpesa_verifications_verified_success",
            table: "mpesa_payment_verifications",
            column: "verification_status",
            stack: "Error: database failure\n    at completeVerification (D:\\repo\\apps\\api\\src\\services\\mpesaPaymentAttemptRepository.js:1100:12)",
        }
    );
    const controller = createMpesaSimulatorController({
        repository: {
            async createPendingMpesaPayment() {
                assert.fail("confirmation must not create another attempt");
            },
        },
        providerService: { async initiateStkPush() {} },
        paymentVerificationService: {
            async confirmSimulatorAttempt() {
                throw error;
            },
        },
        environmentProvider: () => enabledEnvironment(),
        diagnosticSink: (diagnostic) => persistedDiagnostics.push(diagnostic),
    });
    const originalConsoleError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    try {
        const res = response();
        await controller.confirmSimulatedPayment({
            method: "POST",
            baseUrl: "/api/mpesa",
            path: "/simulator/attempts/attempt_1/confirm",
            route: { path: "/simulator/attempts/:attemptId/confirm" },
            user: { userId: "worker_1", role: "WORKER" },
            params: { attemptId: "attempt_1" },
            body: { provider: "SIMULATOR" },
        }, res);

        assert.equal(res.statusCode, 503);
        assert.equal(res.body.message, "The payment simulator is unavailable");
    } finally {
        console.error = originalConsoleError;
    }

    assert.equal(logged.length, 1);
    assert.equal(logged[0][1].category, "DATABASE");
    assert.equal(logged[0][1].code, "23514");
    assert.equal(logged[0][1].constraint, "chk_mpesa_verifications_verified_success");
    assert.equal(logged[0][1].table, "mpesa_payment_verifications");
    assert.equal(logged[0][1].column, "verification_status");
    assert.equal(logged[0][1].attemptId, "attempt_1");
    assert.equal(logged[0][1].route, "POST /api/mpesa/simulator/attempts/:attemptId/confirm");
    assert.equal(logged[0][1].stage, "simulator_confirmation");
    assert.match(logged[0][1].sourceLocation, /apps\/api\/src\/services\/mpesaPaymentAttemptRepository\.js:1100:12/);
    assert.doesNotMatch(logged[0][1].message, /0712345678|secret-value/);
    assert.doesNotMatch(logged[0][1].stack, /0712345678|secret-value/);
    assert.deepEqual(persistedDiagnostics, [logged[0][1]]);
});

test("an enabled simulator rejects a request when Daraja is the configured provider", async () => {
    const controller = createMpesaSimulatorController({
        repository: {
            async createPendingMpesaPayment() {
                assert.fail("provider mismatch must be rejected before creating an attempt");
            },
        },
        providerService: { async initiateStkPush() {} },
        paymentVerificationService: {},
        environmentProvider: () => ({
            NODE_ENV: "development",
            MPESA_PAYMENT_PROVIDER: "DARAJA",
            MPESA_SIMULATOR_ENABLED: "true",
        }),
    });
    const res = response();
    await controller.initiateSimulatedPayment({
        user: { userId: "worker_1", role: "WORKER" },
        body: { provider: "SIMULATOR" },
    }, res);

    assert.equal(res.statusCode, 409);
});
