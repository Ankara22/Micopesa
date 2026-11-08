const { test } = require("node:test");
const assert = require("node:assert/strict");

const databasePath = require.resolve("../src/db/database");
let databaseCalls = 0;
const previousDatabaseModule = require.cache[databasePath];
require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: {
        async query() {
            databaseCalls += 1;
            throw new Error("Database access is disabled in this test");
        },
    },
};

const controller = require("../src/controllers/mpesaController");
if (previousDatabaseModule) {
    require.cache[databasePath] = previousDatabaseModule;
} else {
    delete require.cache[databasePath];
}

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

test("public STK initiation remains unavailable without provider or database access", async () => {
    const res = response();
    await controller.startStkPush({}, res);

    assert.equal(res.statusCode, 503);
    assert.match(res.body.message, /temporarily unavailable/i);
    assert.equal(databaseCalls, 0);
});

test("callback controller acknowledges only a generic non-sensitive response", async () => {
    let received;
    const injected = controller.createMpesaVerificationController({
        async processCallback(body) {
            received = body;
            return { accepted: true, verification_status: "VERIFIED_SUCCESS" };
        },
        async reconcileAttempt() {},
    });
    const res = response();
    const callback = {
        Body: {
            stkCallback: {
                CheckoutRequestID: "checkout_safe_test",
                PhoneNumber: "254712345678",
            },
        },
    };
    await injected.handleStkCallback({ body: callback }, res);

    assert.equal(received, callback);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
        ResultCode: 0,
        ResultDesc: "Notification received; payment outcome not verified",
    });
    assert.equal(JSON.stringify(res.body).includes("254712345678"), false);
    assert.equal(databaseCalls, 0);
});

test("callback errors return sanitized responses and log only an error code", async () => {
    const originalConsoleError = console.error;
    const logs = [];
    console.error = (...args) => logs.push(args);
    try {
        const injected = controller.createMpesaVerificationController({
            async processCallback() {
                const error = new Error("must not be logged");
                error.code = "DATABASE_UNAVAILABLE";
                throw error;
            },
            async reconcileAttempt() {},
        });
        const res = response();
        await injected.handleStkCallback({ body: {} }, res);

        assert.equal(res.statusCode, 503);
        assert.doesNotMatch(JSON.stringify(res.body), /must not be logged/i);
        assert.equal(JSON.stringify(logs).includes("must not be logged"), false);
        assert.deepEqual(logs[0], [
            "M-Pesa callback verification failed.",
            { code: "DATABASE_UNAVAILABLE" },
        ]);
    } finally {
        console.error = originalConsoleError;
    }
});
