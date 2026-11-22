const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createMpesaDarajaController,
    getPaymentAvailability,
} = require("../src/controllers/mpesaDarajaController");

const enabledEnvironment = {
    NODE_ENV: "test",
    MPESA_PAYMENT_PROVIDER: "DARAJA",
    MPESA_DARAJA_ENVIRONMENT: "sandbox",
    MPESA_SANDBOX_ENABLED: "true",
    MPESA_PROVIDER_DISPATCH_ENABLED: "true",
    MPESA_LEDGER_ENFORCEMENT_ENABLED: "false",
};

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

test("STK initiation uses only the authenticated worker and verified profile phone", async () => {
    const calls = [];
    const controller = createMpesaDarajaController({
        repository: {
            async getVerifiedWorkerPhone(workerId) {
                calls.push(["phone", workerId]);
                return "254712345678";
            },
        },
        darajaProviderService: {
            assertConfigured() {
                return { paymentEnabled: true };
            },
        },
        orchestrationService: {
            async initiateWorkerPayment(input) {
                calls.push(["initiate", input]);
                return { attempt_id: "attempt_mock_001", payment_status: "PROMPT_ACCEPTED" };
            },
            async retryWorkerPayment(input) {
                calls.push(["retry", input]);
                return { attempt_id: "attempt_mock_002", payment_status: "PROMPT_ACCEPTED" };
            },
        },
        environmentProvider: () => enabledEnvironment,
    });
    const res = response();
    await controller.startStkPush({
        user: { userId: "authenticated_worker", role: "WORKER" },
        body: {
            workerId: "attacker_worker",
            accountId: "attacker_account",
            phoneNumber: "254700000000",
            idempotencyKey: "mock-idempotency-key",
            amount: 2500,
        },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, [
        ["phone", "authenticated_worker"],
        ["initiate", {
            workerId: "authenticated_worker",
            idempotencyKey: "mock-idempotency-key",
            amount: 2500,
            phoneNumber: "254712345678",
        }],
    ]);
    assert.doesNotMatch(JSON.stringify(res.body), /254712345678/);
});

test("STK initiation refuses to proceed without a verified profile phone", async () => {
    let orchestrationCalls = 0;
    const controller = createMpesaDarajaController({
        repository: {
            async getVerifiedWorkerPhone() {
                return null;
            },
        },
        darajaProviderService: {
            assertConfigured() {
                return { paymentEnabled: true };
            },
        },
        orchestrationService: {
            async initiateWorkerPayment() {
                orchestrationCalls += 1;
            },
            async retryWorkerPayment() {
                orchestrationCalls += 1;
            },
        },
        environmentProvider: () => enabledEnvironment,
    });
    const res = response();
    await controller.startStkPush({
        user: { userId: "authenticated_worker", role: "WORKER" },
        body: { phoneNumber: "254700000000", amount: 2500 },
    }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.message_key, "MPESA_VERIFIED_PHONE_REQUIRED");
    assert.equal(orchestrationCalls, 0);
});

test("controller readiness configuration blocks dispatch before attempt creation", async () => {
    const calls = { readiness: 0, create: 0, provider: 0 };
    const controller = createMpesaDarajaController({
        repository: {
            async getVerifiedWorkerPhone() {
                return "254712345678";
            },
            async assertPensionLedgerActive() {
                calls.readiness += 1;
                throw Object.assign(new Error("The pension ledger is not ACTIVE."), {
                    code: "PENSION_LEDGER_NOT_ACTIVE",
                    statusCode: 503,
                });
            },
            async createPendingMpesaPayment() {
                calls.create += 1;
                return { attempt: {}, created: true };
            },
        },
        darajaProviderService: {
            assertConfigured() {
                return { paymentEnabled: true };
            },
            async initiateStkPush() {
                calls.provider += 1;
                return { checkoutRequestId: "mock_checkout", merchantRequestId: "mock_merchant" };
            },
        },
        environmentProvider: () => ({
            ...enabledEnvironment,
            MPESA_LEDGER_ENFORCEMENT_ENABLED: "true",
        }),
    });
    const res = response();

    await controller.startStkPush({
        user: { userId: "authenticated_worker", role: "WORKER" },
        body: { idempotencyKey: "mock-key", amount: 2500 },
    }, res);

    assert.equal(res.statusCode, 503);
    assert.equal(calls.readiness, 1);
    assert.equal(calls.create, 0);
    assert.equal(calls.provider, 0);
});

test("Daraja availability fails closed when the enforced ledger is not ACTIVE", async () => {
    const availability = await getPaymentAvailability({
        environmentProvider: () => ({
            ...enabledEnvironment,
            MPESA_LEDGER_ENFORCEMENT_ENABLED: "true",
        }),
        darajaProviderService: {
            assertConfigured() {
                return { paymentEnabled: true };
            },
        },
        ledgerReadinessCheck: async () => {
            throw Object.assign(new Error("not active"), {
                code: "PENSION_LEDGER_NOT_ACTIVE",
            });
        },
    });

    assert.equal(availability.enabled, false);
    assert.equal(availability.messageKey, "MPESA_LEDGER_NOT_READY");
});

test("STK initiation blocks missing credentials, disabled dispatch, and non-worker identities", async () => {
    let repositoryCalls = 0;
    let orchestrationCalls = 0;
    let configurationAvailable = false;
    const controller = createMpesaDarajaController({
        repository: {
            async getVerifiedWorkerPhone() {
                repositoryCalls += 1;
                return "254712345678";
            },
        },
        darajaProviderService: {
            assertConfigured() {
                if (!configurationAvailable) {
                    throw new Error("offline mock: incomplete config");
                }
                return { paymentEnabled: true };
            },
        },
        orchestrationService: {
            async initiateWorkerPayment() {
                orchestrationCalls += 1;
            },
            async retryWorkerPayment() {
                orchestrationCalls += 1;
            },
        },
        environmentProvider: () => enabledEnvironment,
    });

    const missingConfig = response();
    await controller.startStkPush({
        user: { userId: "authenticated_worker", role: "WORKER" },
        body: { amount: 100 },
    }, missingConfig);
    assert.equal(missingConfig.statusCode, 503);
    assert.equal(missingConfig.body.message_key, "MPESA_CONFIGURATION_INCOMPLETE");

    configurationAvailable = true;
    const unauthorized = response();
    await controller.startStkPush({
        user: { userId: "another_role", role: "FUND_MANAGER" },
        body: { amount: 100 },
    }, unauthorized);
    assert.equal(unauthorized.statusCode, 403);
    assert.equal(repositoryCalls, 0);

    const disabledController = createMpesaDarajaController({
        repository: {
            async getVerifiedWorkerPhone() {
                repositoryCalls += 1;
                return "254712345678";
            },
        },
        darajaProviderService: {
            assertConfigured() {
                assert.fail("disabled payment must not validate credentials");
            },
        },
        orchestrationService: {
            async initiateWorkerPayment() {
                orchestrationCalls += 1;
            },
            async retryWorkerPayment() {
                orchestrationCalls += 1;
            },
        },
        environmentProvider: () => ({
            NODE_ENV: "test",
            MPESA_PAYMENT_PROVIDER: "DARAJA",
            MPESA_DARAJA_ENVIRONMENT: "sandbox",
            MPESA_SANDBOX_ENABLED: "true",
        }),
    });
    const disabled = response();
    await disabledController.startStkPush({
        user: { userId: "authenticated_worker", role: "WORKER" },
        body: { amount: 100 },
    }, disabled);
    assert.equal(disabled.statusCode, 503);
    assert.equal(disabled.body.message_key, "MPESA_PAYMENTS_DISABLED");
    assert.equal(repositoryCalls, 0);
    assert.equal(orchestrationCalls, 0);
});
