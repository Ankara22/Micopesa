const { before, after, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl || new URL(testDatabaseUrl).pathname.slice(1) !== "micopesa_test" ||
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(testDatabaseUrl).hostname)) {
    throw new Error("API tests require TEST_DATABASE_URL pointing exactly to micopesa_test.");
}
process.env.DATABASE_URL = testDatabaseUrl;
process.env.JWT_SECRET ||= "micopesa-test-only-jwt-secret";
process.env.MPESA_CONSUMER_KEY ||= "test-consumer-key";
process.env.MPESA_CONSUMER_SECRET ||= "test-consumer-secret";
process.env.MPESA_PASSKEY ||= "test-passkey";
process.env.MPESA_SHORTCODE ||= "test-shortcode";
process.env.MPESA_CALLBACK_URL ||= "https://example.test/api/mpesa/callback";

const { createRequire } = require("node:module");
const apiRequire = createRequire(path.resolve(__dirname, "../package.json"));
const pool = apiRequire("./src/db/database");
const app = apiRequire("./src/server");
const { generateToken } = apiRequire("./src/utils/token");
const { calculateProjection } = apiRequire("./src/services/projectionService");
const { seedTestDatabase, TEST_PASSWORD } = require("../../../tests/fixtures/seedTestDatabase");

const originalFetch = global.fetch;
let darajaMockResponse;
const darajaRequests = [];
const suiteDarajaRequests = [];
let mockedCheckoutCounter = 0;

const guardedFetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "sandbox.safaricom.co.ke" || url.hostname === "api.safaricom.co.ke") {
        if (!darajaMockResponse) throw new Error("Daraja request blocked: no test mock is configured.");
        const request = { host: url.hostname, pathname: url.pathname, method: init.method || "GET" };
        darajaRequests.push(request);
        suiteDarajaRequests.push(request);
        return darajaMockResponse(url, init);
    }
    if (["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
        return originalFetch(input, init);
    }
    throw new Error(`External network access blocked in API tests (${url.hostname}).`);
};
global.fetch = guardedFetch;

const server = http.createServer(app);
let baseUrl;
let fixtures;

async function request(route, { method = "GET", token, body } = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const responseText = await response.text();
    let responseBody;
    try {
        responseBody = JSON.parse(responseText);
    } catch {
        responseBody = { raw: responseText };
    }
    return { status: response.status, body: responseBody };
}

async function login(phone, password = TEST_PASSWORD) {
    const response = await request("/api/auth/login", { method: "POST", body: { phone, password } });
    return response.body?.data?.token;
}

function mockDaraja({ amount = 2500, phoneNumber = "254700000004", missingCheckoutRequestId = false } = {}) {
    darajaMockResponse = async (url, init) => {
        if (url.pathname.startsWith("/oauth/")) {
            return Response.json({ access_token: "mock-access-token", expires_in: "3600" });
        }
        if (url.pathname.includes("/stkpush/")) {
            assert.equal(init.method, "POST");
            const payload = JSON.parse(init.body);
            assert.equal(payload.TransactionType, "CustomerPayBillOnline");
            assert.equal(payload.PartyA, payload.PhoneNumber);
            assert.equal(payload.PhoneNumber, phoneNumber);
            assert.equal(payload.Amount, amount);
            const response = {
                ResponseCode: "0",
                CustomerMessage: "Success. Request accepted for processing",
            };
            if (!missingCheckoutRequestId) {
                response.CheckoutRequestID = `ws_CO_TEST_${++mockedCheckoutCounter}`;
            }
            return Response.json(response);
        }
        throw new Error(`Unexpected Daraja URL in mock: ${url.pathname}`);
    };
}

async function addBalanceThroughMockedPayment(phoneNumber, amount) {
    mockDaraja({ amount, phoneNumber });
    const token = await login(phoneNumber);
    const initiated = await request("/api/mpesa/stkpush", {
        method: "POST",
        token,
        body: { amount, phoneNumber },
    });
    assert.equal(initiated.status, 202);
    assert.ok(initiated.body.data.checkout_request_id);
    const callback = await request("/api/mpesa/callback", {
        method: "POST",
        body: {
            Body: {
                stkCallback: {
                    CheckoutRequestID: initiated.body.data.checkout_request_id,
                    ResultCode: 0,
                    ResultDesc: "The service request is processed successfully.",
                    CallbackMetadata: {
                        Item: [
                            { Name: "Amount", Value: amount },
                            { Name: "MpesaReceiptNumber", Value: `TEST${mockedCheckoutCounter}` },
                            { Name: "PhoneNumber", Value: Number(phoneNumber) },
                        ],
                    },
                },
            },
        },
    });
    assert.equal(callback.status, 200);
    const persisted = await pool.query(
        `SELECT t.transaction_status, p.current_balance
         FROM transactions t
         JOIN contributions c ON c.transaction_id = t.transaction_id
         JOIN pension_accounts p ON p.account_id = c.account_id
         WHERE t.checkout_request_id = $1`,
        [initiated.body.data.checkout_request_id]
    );
    assert.equal(persisted.rows[0].transaction_status, "COMPLETED");
    assert.equal(Number(persisted.rows[0].current_balance), amount);
}

before(async () => {
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
    darajaMockResponse = null;
    global.fetch = originalFetch;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
});

beforeEach(async () => {
    darajaMockResponse = null;
    darajaRequests.length = 0;
    mockedCheckoutCounter = 0;
    fixtures = await seedTestDatabase(pool);
});

test("Daraja requests are intercepted and all external network access is blocked", () => {
    assert.equal(global.fetch, guardedFetch);
    assert.notEqual(global.fetch, originalFetch);
    assert.equal(process.env.MPESA_CONSUMER_KEY, "test-consumer-key");
});

test("valid login returns role-specific token without password material", async () => {
    for (const [phone, role] of [
        ["254700000001", "ADMIN"],
        ["254700000002", "FUND_MANAGER"],
        ["254700000003", "REGULATOR"],
        ["254700000004", "WORKER"],
    ]) {
        const result = await request("/api/auth/login", {
            method: "POST",
            body: { phone, password: TEST_PASSWORD },
        });
        assert.equal(result.status, 200);
        assert.ok(result.body.data.token);
        assert.equal(result.body.data.user.role, role);
        assert.equal(JSON.stringify(result.body).includes("password_hash"), false);
        assert.equal(JSON.stringify(result.body).includes(TEST_PASSWORD), false);
    }
});

test("wrong password and unknown user return the same generic 401 response", async () => {
    const wrongPassword = await request("/api/auth/login", {
        method: "POST",
        body: { phone: "254700000004", password: "incorrect-password" },
    });
    const unknownUser = await request("/api/auth/login", {
        method: "POST",
        body: { phone: "254799999999", password: TEST_PASSWORD },
    });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    assert.equal(wrongPassword.body.message, unknownUser.body.message);
});

test("inactive account cannot log in", async () => {
    const response = await request("/api/auth/login", {
        method: "POST",
        body: { phone: "254700000006", password: TEST_PASSWORD },
    });
    assert.equal(response.status, 403);
});

test("protected route rejects missing, invalid, and expired tokens with 401", async () => {
    const missing = await request("/api/auth/me");
    const invalid = await request("/api/auth/me", { token: "not.a.valid.token" });
    const expiredToken = apiRequire("jsonwebtoken").sign(
        { userId: fixtures.users["4"], role: "WORKER", exp: Math.floor(Date.now() / 1000) - 10 },
        process.env.JWT_SECRET
    );
    const expired = await request("/api/auth/me", { token: expiredToken });
    assert.equal(missing.status, 401);
    assert.equal(invalid.status, 401);
    assert.equal(expired.status, 401);
});

test("rate limiting repeated authentication failures", { skip: "TODO: login rate limiting/lockout is not implemented." }, () => {});

test("worker cannot access manager and admin endpoints", async () => {
    const token = await login("254700000004");
    assert.equal((await request("/api/withdrawals/pending", { token })).status, 403);
    assert.equal((await request("/api/audit-logs/operational", { token })).status, 403);
    assert.equal((await request("/api/admin/users", { token })).status, 403);
    assert.equal((await request("/api/auth/test/admin", { token })).status, 403);
});

test("fund manager can access withdrawal queue and operational audit logs", async () => {
    const token = await login("254700000002");
    assert.equal((await request("/api/withdrawals/pending", { token })).status, 200);
    assert.equal((await request("/api/audit-logs/operational", { token })).status, 200);
    assert.equal((await request("/api/admin/users", { token })).status, 403);
});

test("unauthenticated manager route returns 401 rather than 403", async () => {
    assert.equal((await request("/api/withdrawals/pending")).status, 401);
});

test("worker profile includes safe profile fields and excludes secrets", async () => {
    const token = await login("254700000004");
    const response = await request("/api/auth/me", { token });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.user.full_name, "Worker A Example");
    assert.equal(response.body.data.user.phone, "254700000004");
    assert.equal(response.body.data.user.role, "WORKER");
    assert.ok(response.body.data.user.created_at);
    assert.equal(JSON.stringify(response.body).includes("password_hash"), false);
});

test("profile identity is token-scoped and malformed profile paths do not resolve", async () => {
    const token = await login("254700000004");
    const scoped = await request(`/api/auth/me?user_id=${fixtures.users["5"]}`, { token });
    assert.equal(scoped.status, 200);
    assert.equal(scoped.body.data.user.user_id, fixtures.users["4"]);
    assert.equal((await request(`/api/auth/me/${fixtures.users["5"]}`, { token })).status, 404);
});

test("admin role and account-status updates persist independently and append audit records", async () => {
    const adminToken = await login("254700000001");
    const userId = fixtures.users["4"];
    const initial = await request(`/api/admin/users/${userId}`, { token: adminToken });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.data.user.role, "WORKER");
    assert.equal(initial.body.data.user.account_status, "ACTIVE");

    const suspended = await request(`/api/admin/users/${userId}/status`, {
        method: "PATCH",
        token: adminToken,
        body: { account_status: "SUSPENDED" },
    });
    assert.equal(suspended.status, 200);
    assert.equal(suspended.body.data.user.account_status, "SUSPENDED");
    assert.equal(suspended.body.data.user.role, "WORKER");
    const statusReadback = await request(`/api/admin/users/${userId}`, { token: adminToken });
    assert.equal(statusReadback.body.data.user.account_status, "SUSPENDED");

    const promoted = await request(`/api/admin/users/${userId}/role`, {
        method: "PATCH",
        token: adminToken,
        body: { role: "FUND_MANAGER" },
    });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.data.user.role, "FUND_MANAGER");
    assert.equal(promoted.body.data.user.account_status, "SUSPENDED");
    const roleReadback = await request(`/api/admin/users/${userId}`, { token: adminToken });
    assert.equal(roleReadback.body.data.user.role, "FUND_MANAGER");
    assert.equal(roleReadback.body.data.user.account_status, "SUSPENDED");

    const reactivated = await request(`/api/admin/users/${userId}/status`, {
        method: "PATCH",
        token: adminToken,
        body: { account_status: "ACTIVE" },
    });
    assert.equal(reactivated.body.data.user.role, "FUND_MANAGER");
    assert.equal(reactivated.body.data.user.account_status, "ACTIVE");

    const audit = await request("/api/audit-logs/system", { token: adminToken });
    const userUpdates = audit.body.data.filter((entry) => entry.entity_id === userId);
    assert.deepEqual(
        userUpdates.map((entry) => entry.entity_name).sort(),
        ["USERS_ACCOUNT_STATUS", "USERS_ACCOUNT_STATUS", "USERS_ROLE"]
    );
    assert.ok(userUpdates.every((entry) => entry.user_id === fixtures.users.admin && entry.timestamp));
});

test("invalid or unauthorized admin role and status updates leave the user unchanged", async () => {
    const adminToken = await login("254700000001");
    const workerToken = await login("254700000004");
    const userId = fixtures.users["5"];
    const initial = await request(`/api/admin/users/${userId}`, { token: adminToken });
    const originalUser = initial.body.data.user;

    assert.equal((await request(`/api/admin/users/${userId}/role`, {
        method: "PATCH",
        token: adminToken,
        body: { role: "SUPERADMIN" },
    })).status, 400);
    assert.equal((await request(`/api/admin/users/${userId}/status`, {
        method: "PATCH",
        token: adminToken,
        body: { account_status: "DELETED" },
    })).status, 400);
    assert.equal((await request(`/api/admin/users/${userId}/role`, {
        method: "PATCH",
        token: workerToken,
        body: { role: "REGULATOR" },
    })).status, 403);
    assert.equal((await request(`/api/admin/users/${userId}/status`, {
        method: "PATCH",
        token: workerToken,
        body: { account_status: "SUSPENDED" },
    })).status, 403);

    const readback = await request(`/api/admin/users/${userId}`, { token: adminToken });
    assert.equal(readback.body.data.user.role, originalUser.role);
    assert.equal(readback.body.data.user.account_status, originalUser.account_status);
});

test("worker receives only own pending contributions with exact decimal amounts", async () => {
    const token = await login("254700000004");
    const response = await request("/api/accounts/my-contributions", { token });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 2);
    assert.deepEqual(response.body.data.map((row) => row.contribution_status), ["PENDING", "PENDING"]);
    assert.deepEqual(response.body.data.map((row) => row.amount).sort(), ["1200.00", "3400.00"]);
});

test("worker cannot see another worker's contributions or retirement plan", async () => {
    const workerAToken = await login("254700000004");
    const workerBToken = await login("254700000005");
    const workerAContributions = await request("/api/accounts/my-contributions", { token: workerAToken });
    const workerBContributions = await request("/api/accounts/my-contributions", { token: workerBToken });
    assert.deepEqual(workerAContributions.body.data.map((row) => row.amount).sort(), ["1200.00", "3400.00"]);
    assert.deepEqual(workerBContributions.body.data.map((row) => row.amount), ["777.00"]);
    assert.equal((await request("/api/retirement/my-plan", { token: workerAToken })).status, 404);

    await addBalanceThroughMockedPayment("254700000005", 1000);
    const workerBClaim = await request("/api/withdrawals", {
        method: "POST",
        token: workerBToken,
        body: { amount_requested: 300, destination_phone: "254700000005", withdrawal_reason: "medical" },
    });
    assert.equal(workerBClaim.status, 201);
    const workerAClaims = await request("/api/withdrawals/my-claims", { token: workerAToken });
    assert.equal(workerAClaims.body.data.length, 1);
    assert.notEqual(workerAClaims.body.data[0].claim_id, workerBClaim.body.data.claim.claim_id);
});

test("direct contribution confirmation is rejected; only the mocked callback can complete an STK payment", async () => {
    mockDaraja();
    const token = await login("254700000004");
    const before = await pool.query("SELECT current_balance FROM pension_accounts WHERE account_id = $1", [fixtures.accounts.workerA]);
    const directConfirmation = await request("/api/accounts/my-contributions/unknown/confirm", {
        method: "POST",
        token,
        body: { status: "COMPLETED" },
    });
    assert.equal(directConfirmation.status, 404);

    const initiated = await request("/api/mpesa/stkpush", {
        method: "POST",
        token,
        body: { amount: 2500, phoneNumber: "0700000004" },
    });
    assert.equal(initiated.status, 202);
    assert.equal(initiated.body.data.transaction_status, "PENDING");
    assert.equal(darajaRequests.some(({ pathname }) => pathname.includes("/stkpush/")), true);
    assert.equal((await request(`/api/mpesa/status/${initiated.body.data.checkout_request_id}`, { token })).body.data.transaction_status, "PENDING");

    const afterInitiation = await pool.query("SELECT current_balance FROM pension_accounts WHERE account_id = $1", [fixtures.accounts.workerA]);
    assert.equal(afterInitiation.rows[0].current_balance, before.rows[0].current_balance);

    const callback = {
        Body: {
            stkCallback: {
                CheckoutRequestID: initiated.body.data.checkout_request_id,
                ResultCode: 0,
                ResultDesc: "The service request is processed successfully.",
                CallbackMetadata: {
                    Item: [
                        { Name: "Amount", Value: 2500 },
                        { Name: "MpesaReceiptNumber", Value: "TESTRECEIPT001" },
                        { Name: "PhoneNumber", Value: 254700000004 },
                    ],
                },
            },
        },
    };
    assert.equal((await request("/api/mpesa/callback", { method: "POST", body: callback })).status, 200);
    assert.equal((await request("/api/mpesa/callback", { method: "POST", body: callback })).status, 200);
    const persisted = await pool.query(
        `SELECT t.transaction_status, c.contribution_status, p.current_balance
         FROM transactions t
         JOIN contributions c ON c.transaction_id = t.transaction_id
         JOIN pension_accounts p ON p.account_id = c.account_id
         WHERE t.checkout_request_id = $1`,
        [initiated.body.data.checkout_request_id]
    );
    assert.equal(persisted.rows[0].transaction_status, "COMPLETED");
    assert.equal(persisted.rows[0].contribution_status, "COMPLETED");
    assert.equal(Number(persisted.rows[0].current_balance), Number(before.rows[0].current_balance) + 2500);
    const count = await pool.query("SELECT count(*)::int AS count FROM transactions WHERE mpesa_receipt = 'TESTRECEIPT001'");
    assert.equal(count.rows[0].count, 1);
});

test("invalid M-Pesa amounts and phone numbers are rejected before creating payment records", async () => {
    const token = await login("254700000004");
    const before = await pool.query("SELECT count(*)::int AS count FROM transactions");

    for (const amount of [0, -1, 1.5, "not-a-number"]) {
        assert.equal((await request("/api/mpesa/stkpush", {
            method: "POST",
            token,
            body: { amount, phoneNumber: "0700000004" },
        })).status, 400);
    }
    for (const phoneNumber of ["12345", "2547000000041", "0200000000"]) {
        assert.equal((await request("/api/mpesa/stkpush", {
            method: "POST",
            token,
            body: { amount: 2500, phoneNumber },
        })).status, 400);
    }

    const after = await pool.query("SELECT count(*)::int AS count FROM transactions");
    assert.equal(after.rows[0].count, before.rows[0].count);
    assert.equal(darajaRequests.length, 0);
});

test("payment callback amount or phone mismatches never credit an account", async () => {
    mockDaraja();
    const token = await login("254700000004");
    const before = await pool.query(
        "SELECT current_balance FROM pension_accounts WHERE account_id = $1",
        [fixtures.accounts.workerA]
    );

    for (const [callbackAmount, callbackPhone, expectedDescription] of [
        [2499, 254700000004, "Payment amount did not match the pending deposit"],
        [2500, 254700000005, "Payment phone number did not match the pending deposit"],
    ]) {
        const initiated = await request("/api/mpesa/stkpush", {
            method: "POST",
            token,
            body: { amount: 2500, phoneNumber: "0700000004" },
        });
        assert.equal(initiated.status, 202);
        const callback = await request("/api/mpesa/callback", {
            method: "POST",
            body: {
                Body: {
                    stkCallback: {
                        CheckoutRequestID: initiated.body.data.checkout_request_id,
                        ResultCode: 0,
                        CallbackMetadata: {
                            Item: [
                                { Name: "Amount", Value: callbackAmount },
                                { Name: "MpesaReceiptNumber", Value: `MISMATCH${mockedCheckoutCounter}` },
                                { Name: "PhoneNumber", Value: callbackPhone },
                            ],
                        },
                    },
                },
            },
        });
        assert.equal(callback.status, 200);
        const saved = await pool.query(
            `SELECT t.transaction_status, t.mpesa_result_description, c.contribution_status
             FROM transactions t JOIN contributions c ON c.transaction_id = t.transaction_id
             WHERE t.checkout_request_id = $1`,
            [initiated.body.data.checkout_request_id]
        );
        assert.equal(saved.rows[0].transaction_status, "FAILED");
        assert.equal(saved.rows[0].contribution_status, "FAILED");
        assert.equal(saved.rows[0].mpesa_result_description, expectedDescription);
    }

    const after = await pool.query(
        "SELECT current_balance FROM pension_accounts WHERE account_id = $1",
        [fixtures.accounts.workerA]
    );
    assert.equal(after.rows[0].current_balance, before.rows[0].current_balance);
});

test("payment status is user-scoped and missing provider identifiers remain pending", async () => {
    mockDaraja();
    const workerAToken = await login("254700000004");
    const workerBToken = await login("254700000005");
    const initiated = await request("/api/mpesa/stkpush", {
        method: "POST",
        token: workerAToken,
        body: { amount: 2500, phoneNumber: "0700000004" },
    });
    assert.equal(initiated.status, 202);
    assert.equal((await request(`/api/mpesa/status/${initiated.body.data.checkout_request_id}`, {
        token: workerBToken,
    })).status, 404);
    assert.equal((await request(`/api/mpesa/status/${initiated.body.data.checkout_request_id}`, {
        token: workerAToken,
    })).body.data.transaction_status, "PENDING");

    mockDaraja({ missingCheckoutRequestId: true });
    const noProviderId = await request("/api/mpesa/stkpush", {
        method: "POST",
        token: workerAToken,
        body: { amount: 2500, phoneNumber: "0700000004" },
    });
    assert.equal(noProviderId.status, 202);
    assert.equal(noProviderId.body.data.checkout_request_id, null);
    assert.equal(noProviderId.body.data.transaction_status, "PENDING");
    assert.equal((await request(`/api/mpesa/status/${noProviderId.body.data.transaction_id}`, {
        token: workerAToken,
    })).body.data.transaction_status, "PENDING");
});

test("mocked Daraja cancellation and timeout callbacks retain distinct statuses", async () => {
    mockDaraja();
    const token = await login("254700000004");
    for (const [resultCode, expectedStatus] of [[1032, "CANCELLED"], [1037, "TIMED_OUT"]]) {
        const initiated = await request("/api/mpesa/stkpush", {
            method: "POST",
            token,
            body: { amount: 2500, phoneNumber: "0700000004" },
        });
        assert.equal(initiated.status, 202);
        await request("/api/mpesa/callback", {
            method: "POST",
            body: { Body: { stkCallback: { CheckoutRequestID: initiated.body.data.checkout_request_id, ResultCode: resultCode } } },
        });
        const status = await pool.query(
            "SELECT transaction_status FROM transactions WHERE checkout_request_id = $1",
            [initiated.body.data.checkout_request_id]
        );
        assert.equal(status.rows[0].transaction_status, expectedStatus);
    }
});

test("unknown Daraja result codes fail closed and do not credit a balance", async () => {
    mockDaraja();
    const token = await login("254700000004");
    const before = await pool.query("SELECT current_balance FROM pension_accounts WHERE account_id = $1", [fixtures.accounts.workerA]);
    const initiated = await request("/api/mpesa/stkpush", {
        method: "POST",
        token,
        body: { amount: 2500, phoneNumber: "0700000004" },
    });
    await request("/api/mpesa/callback", {
        method: "POST",
        body: { Body: { stkCallback: { CheckoutRequestID: initiated.body.data.checkout_request_id, ResultCode: 9999 } } },
    });
    const transaction = await pool.query(
        "SELECT transaction_status FROM transactions WHERE checkout_request_id = $1",
        [initiated.body.data.checkout_request_id]
    );
    const after = await pool.query("SELECT current_balance FROM pension_accounts WHERE account_id = $1", [fixtures.accounts.workerA]);
    assert.equal(transaction.rows[0].transaction_status, "FAILED");
    assert.equal(after.rows[0].current_balance, before.rows[0].current_balance);
});

test("withdrawal submission validates amount and records reason as PENDING", async () => {
    const managerToken = await login("254700000002");
    const approved = await request(`/api/withdrawals/${fixtures.pendingWithdrawalId}/approve`, {
        method: "PATCH",
        token: managerToken,
    });
    assert.equal(approved.status, 200);
    await addBalanceThroughMockedPayment("254700000004", 10000);
    const workerToken = await login("254700000004");
    const submitted = await request("/api/withdrawals", {
        method: "POST",
        token: workerToken,
        body: { amount_requested: 5000, destination_phone: "254700000004", withdrawal_reason: "medical" },
    });
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.data.claim.claim_status, "PENDING");
    assert.equal(submitted.body.data.claim.withdrawal_reason, "medical");

    for (const amount of [0, -1, "not-a-number"]) {
        assert.equal((await request("/api/withdrawals", {
            method: "POST",
            token: await login("254700000005"),
            body: { amount_requested: amount, destination_phone: "254700000005", withdrawal_reason: "medical" },
        })).status, 400);
    }
});

test("withdrawal exceeding available balance is rejected", async () => {
    await addBalanceThroughMockedPayment("254700000005", 3000);
    const token = await login("254700000005");
    const response = await request("/api/withdrawals", {
        method: "POST",
        token,
        body: { amount_requested: 3001, destination_phone: "254700000005", withdrawal_reason: "medical" },
    });
    assert.equal(response.status, 400);
});

test("manager approval changes claim status without changing balance or ledger", async () => {
    const managerToken = await login("254700000002");
    const beforeBalance = await pool.query("SELECT current_balance FROM pension_accounts WHERE account_id = $1", [fixtures.accounts.workerA]);
    const beforeLedger = await pool.query("SELECT count(*)::int AS count FROM transactions");
    const review = await request(`/api/withdrawals/${fixtures.pendingWithdrawalId}/approve`, {
        method: "PATCH",
        token: managerToken,
    });
    assert.equal(review.status, 200);
    assert.equal(review.body.data.claim.claim_status, "APPROVED");
    const afterBalance = await pool.query("SELECT current_balance FROM pension_accounts WHERE account_id = $1", [fixtures.accounts.workerA]);
    const afterLedger = await pool.query("SELECT count(*)::int AS count FROM transactions");
    assert.equal(afterBalance.rows[0].current_balance, beforeBalance.rows[0].current_balance);
    assert.equal(afterLedger.rows[0].count, beforeLedger.rows[0].count);
});

test("worker cannot review claims and repeated manager review returns conflict", async () => {
    const workerToken = await login("254700000004");
    const forbidden = await request(`/api/withdrawals/${fixtures.pendingWithdrawalId}/approve`, {
        method: "PATCH",
        token: workerToken,
    });
    assert.equal(forbidden.status, 403);
    const managerToken = await login("254700000002");
    const first = await request(`/api/withdrawals/${fixtures.pendingWithdrawalId}/approve`, {
        method: "PATCH",
        token: managerToken,
    });
    const second = await request(`/api/withdrawals/${fixtures.pendingWithdrawalId}/approve`, {
        method: "PATCH",
        token: managerToken,
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 409);
});

test("manager rejection records rejected status", async () => {
    const token = await login("254700000002");
    const response = await request(`/api/withdrawals/${fixtures.pendingWithdrawalId}/reject`, {
        method: "PATCH",
        token,
        body: { reason: "Insufficient supporting documents" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.claim.claim_status, "REJECTED");
});

test("storing a reviewer rejection reason", { skip: "TODO: schema and review endpoint do not persist a separate reviewer decision reason." }, () => {});
test("pending-confirmation contribution status", { skip: "TODO: schema only supports PENDING, COMPLETED, FAILED, CANCELLED, and TIMED_OUT." }, () => {});
test("login success and failure audit records", { skip: "TODO: login audit hooks are not implemented." }, () => {});
test("contribution creation audit record", { skip: "TODO: contribution creation does not write an audit record." }, () => {});
test("withdrawal submission audit record", { skip: "TODO: withdrawal submission does not write an audit record." }, () => {});
test("denied permission audit record", { skip: "TODO: denied permission actions are not audited." }, () => {});

test("manager approval and rejection append audit records; audit API exposes no mutation routes", async () => {
    const token = await login("254700000002");
    const reviewed = await request(`/api/withdrawals/${fixtures.pendingWithdrawalId}/approve`, { method: "PATCH", token });
    assert.equal(reviewed.status, 200);
    await addBalanceThroughMockedPayment("254700000004", 500);
    const workerToken = await login("254700000004");
    const submitted = await request("/api/withdrawals", {
        method: "POST",
        token: workerToken,
        body: { amount_requested: 500, destination_phone: "254700000004", withdrawal_reason: "medical" },
    });
    const rejected = await request(`/api/withdrawals/${submitted.body.data.claim.claim_id}/reject`, {
        method: "PATCH",
        token,
        body: { reason: "Insufficient documents" },
    });
    assert.equal(rejected.status, 200);
    const logs = await request("/api/audit-logs/operational", { token });
    assert.equal(logs.status, 200);
    assert.equal(logs.body.data.length, 2);
    assert.deepEqual(logs.body.data.map((row) => row.action_type).sort(), ["APPROVE", "REJECT"]);
    assert.ok(logs.body.data.every((row) => row.user_id === fixtures.users.fund_manager));
    assert.ok(logs.body.data.every((row) => row.entity_name === "WITHDRAWAL_CLAIMS" && row.timestamp));
    for (const method of ["POST", "PATCH", "DELETE"]) {
        assert.equal((await request("/api/audit-logs/operational", { method, token, body: {} })).status, 404);
    }
    assert.equal((await request("/api/audit-logs/operational", { token: await login("254700000004") })).status, 403);
});

test("retirement projection matches an independent monthly-compounding calculation at the implemented 8% rate", () => {
    // The service uses FV = current balance*(1+r)^n + contribution*((1+r)^n-1)/r, r=0.08/12, n=months.
    const independent = (balance, contribution, years) => {
        const monthlyRate = 0.08 / 12;
        const months = years * 12;
        const growth = (1 + monthlyRate) ** months;
        return Math.round((balance * growth + contribution * ((growth - 1) / monthlyRate) + Number.EPSILON) * 100) / 100;
    };
    for (const [currentAge, targetAge, contribution, balance] of [[30, 60, 2000, 0], [45, 60, 5000, 0]]) {
        const projection = calculateProjection({
            currentBalance: balance,
            monthlyContribution: contribution,
            targetAmount: 1,
            currentAge,
            targetAge,
        });
        assert.equal(projection.projectedBalance, independent(balance, contribution, targetAge - currentAge));
    }
});

test("projection handles zero years and rejects negative contribution at the API boundary", async () => {
    const zeroYears = calculateProjection({
        currentBalance: 1200,
        monthlyContribution: 500,
        targetAmount: 1000,
        targetAge: 60,
        currentAge: 60,
    });
    assert.equal(zeroYears.projectedBalance, 1200);
    assert.equal(zeroYears.months, 0);
    const zeroContribution = calculateProjection({
        currentBalance: 0,
        monthlyContribution: 0,
        targetAmount: 1000,
        targetAge: 60,
        currentAge: 30,
    });
    assert.equal(zeroContribution.projectedBalance, 0);
    const token = await login("254700000004");
    const negative = await request("/api/retirement/my-plan", {
        method: "POST",
        token,
        body: { target_amount: 10000, target_retirement_age: 60, monthly_contribution_target: -1, current_age: 30 },
    });
    assert.equal(negative.status, 400);
});

test("retirement projection at configurable 10% and 7% rates", { skip: "TODO: projection service fixes annual return at 8% and accepts no rate parameter." }, () => {});
test("retirement dashboard chart receives calculator series", { skip: "TODO: no retirement chart series is implemented in the frontend." }, () => {});

test("workerA cannot access workerB data through guessed resource paths", async () => {
    const token = await login("254700000004");
    const deniedPaths = [
        `/api/users/${fixtures.users["5"]}`,
        `/api/accounts/${fixtures.accounts.workerB}`,
        `/api/withdrawals/${fixtures.pendingWithdrawalId}`,
        `/api/retirement/users/${fixtures.users["5"]}`,
    ];
    for (const route of deniedPaths) {
        assert.equal((await request(route, { token })).status, 404, `Expected no foreign-resource route at ${route}`);
    }
});

test("fund manager cannot access admin-only routes", async () => {
    const token = await login("254700000002");
    assert.equal((await request("/api/audit-logs/system", { token })).status, 403);
    assert.equal((await request("/api/auth/test/admin", { token })).status, 403);
});

test("Daraja OAuth and STK requests were handled by the test interceptor", () => {
    assert.ok(suiteDarajaRequests.some(({ pathname }) => pathname.startsWith("/oauth/")));
    assert.ok(suiteDarajaRequests.some(({ pathname }) => pathname.includes("/stkpush/")));
    assert.ok(suiteDarajaRequests.every(({ host }) => host === "sandbox.safaricom.co.ke"));
});
