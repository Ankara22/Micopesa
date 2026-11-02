const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const pool = require("../src/db/database");
const { handleStkCallback, startStkPush } = require("../src/controllers/mpesaController");
const { initiateMyContribution } = require("../src/controllers/accountController");
const mpesaRoutes = require("../src/routes/mpesaRoutes");
const { generateToken } = require("../src/utils/token");

process.env.JWT_SECRET ||= "micopesa-callback-security-test-secret";

let databaseCalls = 0;
let providerRequests = 0;
const originalFetch = global.fetch;
const originalConnect = pool.connect;
const originalQuery = pool.query;
pool.connect = async () => {
    databaseCalls += 1;
    throw new Error("Database access is disabled in callback security tests");
};
pool.query = async () => {
    databaseCalls += 1;
    throw new Error("Database access is disabled in callback security tests");
};

after(() => {
    pool.connect = originalConnect;
    pool.query = originalQuery;
});

function makeResponse() {
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

function successfulLookingCallback(overrides = {}) {
    return {
        Body: {
            stkCallback: {
                CheckoutRequestID: "ws_CO_CALLBACK_TEST",
                ResultCode: 0,
                ResultDesc: "The service request is processed successfully.",
                CallbackMetadata: {
                    Item: [
                        { Name: "Amount", Value: 2500 },
                        { Name: "MpesaReceiptNumber", Value: "TESTRECEIPT001" },
                        { Name: "PhoneNumber", Value: 254700000004 },
                    ],
                },
                ...overrides,
            },
        },
    };
}

async function assertNotificationOnly(payload) {
    const response = makeResponse();
    await handleStkCallback({ body: payload }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
        ResultCode: 0,
        ResultDesc: "Notification received; payment outcome not verified",
    });
}

test("success-looking and manipulated callbacks are acknowledged without database access", async () => {
    const matching = successfulLookingCallback();
    const changedAmount = successfulLookingCallback();
    changedAmount.Body.stkCallback.CallbackMetadata.Item[0].Value = 1;
    const changedPhone = successfulLookingCallback();
    changedPhone.Body.stkCallback.CallbackMetadata.Item[2].Value = 254700000099;
    const changedReceipt = successfulLookingCallback();
    changedReceipt.Body.stkCallback.CallbackMetadata.Item[1].Value = "FORGEDRECEIPT";

    for (const callback of [matching, changedAmount, changedPhone, changedReceipt]) {
        await assertNotificationOnly(callback);
    }
    assert.equal(databaseCalls, 0);
});

test("failure-looking, duplicate, malformed, and unmatched callbacks cannot change payment state", async () => {
    const pendingOutcomes = [1032, 1037, 9999].map((resultCode) => ({
        Body: { stkCallback: { CheckoutRequestID: "ws_CO_CALLBACK_TEST", ResultCode: resultCode } },
    }));
    const unmatched = {
        Body: { stkCallback: { CheckoutRequestID: "unknown-checkout", ResultCode: 0 } },
    };
    const duplicate = successfulLookingCallback();
    const callbacks = [
        ...pendingOutcomes,
        duplicate,
        duplicate,
        {},
        { Body: { stkCallback: { ResultCode: 0 } } },
        unmatched,
    ];

    for (const callback of callbacks) {
        await assertNotificationOnly(callback);
    }
    assert.equal(databaseCalls, 0);
});

test("legacy contribution endpoint rejects M-Pesa completion without database access", async () => {
    const response = makeResponse();
    await initiateMyContribution({
        user: { userId: "worker-test-id" },
        body: { amount: 2500, channel: "MPESA" },
    }, response);

    assert.equal(response.statusCode, 409);
    assert.equal(response.body.status, "error");
    assert.equal(databaseCalls, 0);
});

test("STK Push initiation is unavailable before provider or database access", async () => {
    global.fetch = async () => {
        providerRequests += 1;
        throw new Error("Provider requests are disabled in callback security tests");
    };

    try {
        const response = makeResponse();
        await startStkPush({}, response);

        assert.equal(response.statusCode, 503);
        assert.equal(response.body.status, "error");
        assert.match(response.body.message, /M-Pesa deposits are temporarily unavailable/);
        assert.equal(providerRequests, 0);
        assert.equal(databaseCalls, 0);
    } finally {
        global.fetch = originalFetch;
    }
});

test("authenticated STK Push route responds unavailable without database or provider access", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/mpesa", mpesaRoutes);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    const beforeProviderRequests = providerRequests;
    global.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.hostname === "sandbox.safaricom.co.ke" || url.hostname === "api.safaricom.co.ke") {
            providerRequests += 1;
            throw new Error("Provider requests are disabled in callback security tests");
        }
        return originalFetch(input, init);
    };
    try {
        const address = server.address();
        const token = generateToken({ userId: "worker-test-id", role: "WORKER" });
        const response = await fetch(`http://127.0.0.1:${address.port}/api/mpesa/stkpush`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ amount: 2500, phoneNumber: "0700000004" }),
        });

        assert.equal(response.status, 503);
        assert.match((await response.json()).message, /M-Pesa deposits are temporarily unavailable/);
        assert.equal(databaseCalls, 0);
        assert.equal(providerRequests, beforeProviderRequests);
    } finally {
        global.fetch = originalFetch;
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
