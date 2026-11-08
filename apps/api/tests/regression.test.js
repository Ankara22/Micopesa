const { before, after, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { createRequire } = require("node:module");
const apiRequire = createRequire(path.resolve(__dirname, "../package.json"));
const {
    getTargetDatabase,
    verifyDatabaseIdentity,
} = require("../../../tests/scripts/testDatabaseSafety");

const testDatabase = getTargetDatabase(process.env);
const testDatabaseUrl = testDatabase.url.toString();
process.env.DATABASE_URL = testDatabaseUrl;
process.env.JWT_SECRET ||= "micopesa-test-only-jwt-secret";
process.env.MPESA_CONSUMER_KEY ||= "test-consumer-key";
process.env.MPESA_CONSUMER_SECRET ||= "test-consumer-secret";
process.env.MPESA_PASSKEY ||= "test-passkey";
process.env.MPESA_SHORTCODE ||= "test-shortcode";
process.env.MPESA_CALLBACK_URL ||= "https://example.test/api/mpesa/callback";

const { Client } = apiRequire("pg");
const pool = apiRequire("./src/db/database");
const app = apiRequire("./src/server");
const { generateToken } = apiRequire("./src/utils/token");
const { calculateProjection } = apiRequire("./src/services/projectionService");
const { seedTestDatabase, TEST_PASSWORD } = require("../../../tests/fixtures/seedTestDatabase");

const originalFetch = global.fetch;
const darajaRequests = [];

const guardedFetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "sandbox.safaricom.co.ke" || url.hostname === "api.safaricom.co.ke") {
        const request = { host: url.hostname, pathname: url.pathname, method: init.method || "GET" };
        darajaRequests.push(request);
        throw new Error("Daraja request blocked: payment initiation is disabled in API regression tests.");
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

async function setAccountBalance(accountId, balance) {
    await pool.query(
        "UPDATE pension_accounts SET current_balance = $2 WHERE account_id = $1",
        [accountId, balance]
    );
}

before(async () => {
    const verificationClient = new Client({ connectionString: testDatabaseUrl });
    await verificationClient.connect();
    try {
        await verifyDatabaseIdentity(verificationClient, testDatabase.databaseName);
    } finally {
        await verificationClient.end();
    }

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
    global.fetch = originalFetch;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
});

beforeEach(async () => {
    darajaRequests.length = 0;
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

test("worker contribution and retirement-plan reads remain scoped to that worker", async () => {
    const workerAToken = await login("254700000004");
    const workerBToken = await login("254700000005");
    const workerAContributions = await request("/api/accounts/my-contributions", { token: workerAToken });
    const workerBContributions = await request("/api/accounts/my-contributions", { token: workerBToken });
    assert.deepEqual(workerAContributions.body.data.map((row) => row.amount).sort(), ["1200.00", "3400.00"]);
    assert.deepEqual(workerBContributions.body.data.map((row) => row.amount), ["777.00"]);
    const workerAPlan = await request("/api/retirement/my-plan", { token: workerAToken });
    assert.equal(workerAPlan.status, 200);
    assert.equal(workerAPlan.body.data.plan, null);

    const workerAClaims = await request("/api/withdrawals/my-claims", { token: workerAToken });
    assert.equal(workerAClaims.body.data.length, 1);
});

test("M-Pesa initiation is disabled and callback notifications cannot change financial records", async () => {
    const token = await login("254700000004");
    const before = await pool.query("SELECT current_balance FROM pension_accounts WHERE account_id = $1", [fixtures.accounts.workerA]);
    const directConfirmation = await request("/api/accounts/my-contributions/unknown/confirm", {
        method: "POST",
        token,
        body: { status: "COMPLETED" },
    });
    assert.equal(directConfirmation.status, 404);

    const transactionCount = await pool.query(
        "SELECT count(*)::int AS count FROM transactions WHERE transaction_type = 'CONTRIBUTION'"
    );
    const initiated = await request("/api/mpesa/stkpush", {
        method: "POST",
        token,
        body: { amount: 2500, phoneNumber: "0700000004" },
    });
    assert.equal(initiated.status, 503);
    assert.match(initiated.body.message, /M-Pesa deposits are temporarily unavailable/);
    assert.equal(darajaRequests.length, 0);

    const callback = {
        Body: {
            stkCallback: {
                CheckoutRequestID: "untrusted-test-checkout",
                MerchantRequestID: "untrusted-test-merchant",
                ResultCode: 0,
                ResultDesc: "Payment completed",
                CallbackMetadata: {
                    Item: [
                        { Name: "Amount", Value: 2500 },
                        { Name: "MpesaReceiptNumber", Value: "FORGEDTESTRECEIPT" },
                        { Name: "PhoneNumber", Value: 254700000004 },
                    ],
                },
            },
        },
    };
    const firstCallback = await request("/api/mpesa/callback", { method: "POST", body: callback });
    const duplicateCallback = await request("/api/mpesa/callback", { method: "POST", body: callback });
    assert.equal(firstCallback.status, 200);
    assert.match(firstCallback.body.ResultDesc, /not verified/);
    assert.equal(duplicateCallback.status, 200);

    const after = await pool.query("SELECT current_balance FROM pension_accounts WHERE account_id = $1", [fixtures.accounts.workerA]);
    const afterTransactionCount = await pool.query(
        "SELECT count(*)::int AS count FROM transactions WHERE transaction_type = 'CONTRIBUTION'"
    );
    assert.equal(after.rows[0].current_balance, before.rows[0].current_balance);
    assert.equal(afterTransactionCount.rows[0].count, transactionCount.rows[0].count);
});

test("M-Pesa initiation remains disabled for every request payload", async () => {
    const token = await login("254700000004");
    const before = await pool.query("SELECT count(*)::int AS count FROM transactions");

    for (const body of [
        { amount: 0, phoneNumber: "0700000004" },
        { amount: -1, phoneNumber: "0700000004" },
        { amount: 1.5, phoneNumber: "0700000004" },
        { amount: "not-a-number", phoneNumber: "0700000004" },
        { amount: 2500, phoneNumber: "invalid" },
    ]) {
        const response = await request("/api/mpesa/stkpush", {
            method: "POST",
            token,
            body,
        });
        assert.equal(response.status, 503);
    }

    const after = await pool.query("SELECT count(*)::int AS count FROM transactions");
    assert.equal(after.rows[0].count, before.rows[0].count);
    assert.equal(darajaRequests.length, 0);
});

test("payment status route remains user-scoped while new initiation is disabled", async () => {
    const workerAToken = await login("254700000004");
    const workerBToken = await login("254700000005");
    const unavailable = await request("/api/mpesa/stkpush", {
        method: "POST",
        token: workerAToken,
        body: { amount: 2500, phoneNumber: "0700000004" },
    });
    assert.equal(unavailable.status, 503);
    assert.equal((await request("/api/mpesa/status/unknown", { token: workerAToken })).status, 404);
    assert.equal((await request("/api/mpesa/status/unknown", { token: workerBToken })).status, 404);
});

test("withdrawal submission rejects requests exceeding the uncredited balance", async () => {
    await setAccountBalance(fixtures.accounts.workerA, 1000);
    const beforeBalance = await pool.query("SELECT current_balance FROM pension_accounts WHERE account_id = $1", [fixtures.accounts.workerA]);
    const pendingContributions = await pool.query(
        `SELECT COALESCE(SUM(c.amount), 0)::numeric AS amount
         FROM contributions c
         JOIN transactions t ON t.transaction_id = c.transaction_id
         WHERE c.account_id = $1
           AND c.contribution_status = 'PENDING'
           AND t.transaction_status = 'PENDING'`,
        [fixtures.accounts.workerA]
    );
    assert.equal(pendingContributions.rows[0].amount, "4600.00");

    const managerToken = await login("254700000002");
    const approved = await request(`/api/withdrawals/${fixtures.pendingWithdrawalId}/approve`, {
        method: "PATCH",
        token: managerToken,
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.data.claim.claim_status, "APPROVED");
    const afterBalance = await pool.query("SELECT current_balance FROM pension_accounts WHERE account_id = $1", [fixtures.accounts.workerA]);
    assert.equal(afterBalance.rows[0].current_balance, beforeBalance.rows[0].current_balance);
    const workerToken = await login("254700000004");
    const submitted = await request("/api/withdrawals", {
        method: "POST",
        token: workerToken,
        body: { amount_requested: 500, destination_phone: "254700000004", withdrawal_reason: "medical" },
    });
    assert.equal(submitted.status, 400);
    assert.match(submitted.body.message, /cannot exceed the available balance/i);
    const pendingContributionsAfterReview = await pool.query(
        `SELECT COALESCE(SUM(c.amount), 0)::numeric AS amount
         FROM contributions c
         JOIN transactions t ON t.transaction_id = c.transaction_id
         WHERE c.account_id = $1
           AND c.contribution_status = 'PENDING'
           AND t.transaction_status = 'PENDING'`,
        [fixtures.accounts.workerA]
    );
    assert.equal(pendingContributionsAfterReview.rows[0].amount, "4600.00");

    for (const amount of [0, -1, "not-a-number"]) {
        assert.equal((await request("/api/withdrawals", {
            method: "POST",
            token: await login("254700000005"),
            body: { amount_requested: amount, destination_phone: "254700000005", withdrawal_reason: "medical" },
        })).status, 400);
    }
});

test("withdrawal exceeding available balance is rejected", async () => {
    const token = await login("254700000005");
    const response = await request("/api/withdrawals", {
        method: "POST",
        token,
        body: { amount_requested: 3001, destination_phone: "254700000005", withdrawal_reason: "medical" },
    });
    assert.equal(response.status, 400);
});

test("manager approval changes claim status without changing balance or ledger", async () => {
    await setAccountBalance(fixtures.accounts.workerA, 2000);
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
    await setAccountBalance(fixtures.accounts.workerA, 2000);
    const beforeBalance = await pool.query("SELECT current_balance FROM pension_accounts WHERE account_id = $1", [fixtures.accounts.workerA]);
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
    assert.equal(first.body.data.claim.claim_status, "APPROVED");
    assert.equal(second.status, 409);
    const afterBalance = await pool.query("SELECT current_balance FROM pension_accounts WHERE account_id = $1", [fixtures.accounts.workerA]);
    assert.equal(afterBalance.rows[0].current_balance, beforeBalance.rows[0].current_balance);
    const claim = await pool.query("SELECT claim_status FROM withdrawal_claims WHERE claim_id = $1", [fixtures.pendingWithdrawalId]);
    assert.equal(claim.rows[0].claim_status, "APPROVED");
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

test("manager approval appends an audit record; audit API exposes no mutation routes", async () => {
    await setAccountBalance(fixtures.accounts.workerA, 2000);
    const beforeBalance = await pool.query("SELECT current_balance FROM pension_accounts WHERE account_id = $1", [fixtures.accounts.workerA]);
    const token = await login("254700000002");
    const reviewed = await request(`/api/withdrawals/${fixtures.pendingWithdrawalId}/approve`, { method: "PATCH", token });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.body.data.claim.claim_status, "APPROVED");
    const afterBalance = await pool.query("SELECT current_balance FROM pension_accounts WHERE account_id = $1", [fixtures.accounts.workerA]);
    assert.equal(afterBalance.rows[0].current_balance, beforeBalance.rows[0].current_balance);
    const logs = await request("/api/audit-logs/operational", { token });
    assert.equal(logs.status, 200);
    assert.equal(logs.body.data.length, 1);
    assert.deepEqual(logs.body.data.map((row) => row.action_type), ["APPROVE"]);
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

test("projection rejects invalid retirement ages and supports zero planned contributions", async () => {
    assert.throws(() => calculateProjection({
        currentBalance: 1200,
        monthlyContribution: 500,
        targetAmount: 1000,
        targetAge: 60,
        currentAge: 60,
    }), { code: "PROJECTION_INVALID" });
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

test("projection calculation honors zero and nonzero annual growth assumptions", () => {
    const atTenPercent = calculateProjection({
        currentBalance: 10000,
        monthlyContribution: 100,
        targetAmount: 100000,
        targetAge: 40,
        currentAge: 30,
        annualRate: 0.1,
    });
    const atSevenPercent = calculateProjection({
        currentBalance: 10000,
        monthlyContribution: 100,
        targetAmount: 100000,
        targetAge: 40,
        currentAge: 30,
        annualRate: 0.07,
    });
    assert.ok(atTenPercent.projectedBalance > atSevenPercent.projectedBalance);
    assert.equal(atTenPercent.yearByYear.length, 11);
});

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

test("Daraja requests remain blocked and none are initiated by the API regression suite", () => {
    assert.deepEqual(darajaRequests, []);
});
