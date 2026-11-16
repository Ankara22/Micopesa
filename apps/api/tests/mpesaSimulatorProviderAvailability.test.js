const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createMpesaSimulatorController,
} = require("../src/controllers/mpesaSimulatorController");

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

function createController(assertPensionLedgerActive) {
    return createMpesaSimulatorController({
        repository: {
            async assertPensionLedgerActive() {
                return assertPensionLedgerActive();
            },
            async createPendingMpesaPayment() {},
        },
        providerService: {
            async initiateStkPush() {},
        },
        environmentProvider: () => ({
            NODE_ENV: "test",
            MPESA_PAYMENT_PROVIDER: "SIMULATOR",
            MPESA_SIMULATOR_ENABLED: "true",
            MPESA_LEDGER_ENFORCEMENT_ENABLED: "true",
        }),
    });
}

test("simulator availability is false when enforced ledger readiness fails", async () => {
    const controller = createController(async () => {
        throw Object.assign(new Error("not active"), {
            code: "PENSION_LEDGER_NOT_ACTIVE",
        });
    });
    const res = response();

    await controller.getPaymentProvider({}, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.payment_enabled, false);
    assert.equal(res.body.data.message_key, "MPESA_LEDGER_NOT_READY");
});

test("simulator availability remains enabled when enforced ledger is ACTIVE", async () => {
    const controller = createController(async () => true);
    const res = response();

    await controller.getPaymentProvider({}, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.payment_enabled, true);
    assert.equal(res.body.data.message_key, "MPESA_PAYMENTS_AVAILABLE");
});
