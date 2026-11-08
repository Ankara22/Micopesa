const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const pool = require("../src/db/database");
const {
    createMpesaVerificationController,
    handleStkCallback,
    startStkPush,
} = require("../src/controllers/mpesaController");
const { initiateMyContribution } = require("../src/controllers/accountController");
const mpesaRoutes = require("../src/routes/mpesaRoutes");
const { generateToken } = require("../src/utils/token");

process.env.JWT_SECRET ||= "micopesa-callback-security-test-secret";

let databaseCalls = 0;
let authenticationLookups = 0;
let providerRequests = 0;
const originalFetch = global.fetch;
const originalConnect = pool.connect;
const originalQuery = pool.query;
pool.connect = async () => {
    databaseCalls += 1;
    throw new Error("Database access is disabled in callback security tests");
};
pool.query = async (sql, params = []) => {
    const normalizedSql = sql.replace(/\s+/g, " ").trim();
    if (
        normalizedSql === "SELECT user_id, role, account_status, auth_version, force_password_change, is_temp_password FROM users WHERE user_id = $1" &&
        params.length === 1 &&
        params[0] === "worker-test-id"
    ) {
        authenticationLookups += 1;
        return {
            rows: [{
                user_id: "worker-test-id",
                role: "WORKER",
                account_status: "ACTIVE",
                auth_version: 0,
                force_password_change: false,
                is_temp_password: false,
            }],
        };
    }
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

async function assertNotificationOnly(handler, payload) {
    const response = makeResponse();
    await handler({ body: payload }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
        ResultCode: 0,
        ResultDesc: "Notification received; payment outcome not verified",
    });
    return response;
}

test("callback controller delegates payloads to verifier without echoing callback data", async () => {
    const delivered = [];
    const controller = createMpesaVerificationController({
        async processCallback(payload) {
            delivered.push(payload);
            return { accepted: true, verification_status: "VERIFIED_SUCCESS" };
        },
        async reconcileAttempt() {
            throw new Error("Not used in this test");
        },
    });

    const response = await assertNotificationOnly(
        controller.handleStkCallback,
        successfulLookingCallback()
    );
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].Body.stkCallback.CheckoutRequestID, "ws_CO_CALLBACK_TEST");
    assert.equal(JSON.stringify(response.body).includes("254700000004"), false);
    assert.equal(databaseCalls, 0);
});

test("callback controller rejects malformed notifications without returning internal errors", async () => {
    const controller = createMpesaVerificationController({
        async processCallback() {
            const error = new Error("Malformed test callback");
            error.code = "INVALID_MPESA_CALLBACK";
            error.statusCode = 400;
            throw error;
        },
        async reconcileAttempt() {},
    });
    const response = makeResponse();
    await controller.handleStkCallback({ body: {} }, response);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, {
        ResultCode: 1,
        ResultDesc: "Invalid payment notification",
    });
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
        if (url.hostname !== "127.0.0.1" || url.port !== String(server.address().port)) {
            throw new Error("External network requests are disabled in callback security tests");
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
        assert.equal(authenticationLookups, 1);
        assert.equal(databaseCalls, 0);
        assert.equal(providerRequests, beforeProviderRequests);
    } finally {
        global.fetch = originalFetch;
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
