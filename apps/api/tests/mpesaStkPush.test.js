const { after, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");

process.env.MPESA_CONSUMER_KEY = "key";
process.env.MPESA_CONSUMER_SECRET = "secret";
process.env.MPESA_PASSKEY = "passkey";
process.env.MPESA_SHORTCODE = "174379";
process.env.MPESA_CALLBACK_SECRET = "s".repeat(32);
process.env.MPESA_CALLBACK_URL = `https://example.test/api/mpesa/callback/${"s".repeat(32)}`;

const pool = require("../src/db/database");
const { startStkPush, handleStkCallback } = require("../src/controllers/mpesaController");

const originalQuery = pool.query;
const originalConnect = pool.connect;
const originalFetch = global.fetch;
const CHECKOUT = "ws_CO_123456789";
const SECRET = process.env.MPESA_CALLBACK_SECRET;

let statements;
let pendingPayment;
let providerStatus;

function makeResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

function runSql(sql, params = []) {
    statements.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    const text = sql.replace(/\s+/g, " ");
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [], rowCount: 0 };
    if (text.includes("SELECT phone FROM users")) return { rows: [{ phone: "0712345678" }], rowCount: 1 };
    if (text.includes("FROM pension_accounts WHERE user_id")) return { rows: [{ account_id: "A".repeat(25) }], rowCount: 1 };
    if (text.includes("SELECT DISTINCT fa.fund_id")) return { rows: [{ fund_id: "F".repeat(25) }], rowCount: 1 };
    if (text.includes("FROM fund_allocations fa JOIN funds f")) {
        return { rows: [{ allocation_id: "L".repeat(25), fund_id: "F".repeat(25), percentage: "100.00", fund_name: "Test Fund" }], rowCount: 1 };
    }
    if (text.includes("INSERT INTO transactions")) return { rows: [{ transaction_id: "T".repeat(25), amount: "100.00", transaction_status: "PENDING", initiated_at: "now" }], rowCount: 1 };
    if (text.includes("INSERT INTO contributions")) return { rows: [{ contribution_id: "C".repeat(25), account_id: "A".repeat(25), transaction_id: "T".repeat(25), amount: "100.00", channel: "MPESA", contribution_status: "PENDING", created_at: "now" }], rowCount: 1 };
    if (text.includes("WHERE t.checkout_request_id = $1 AND t.transaction_type = 'CONTRIBUTION'")) {
        return pendingPayment ? { rows: [pendingPayment], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (text.includes("SELECT transaction_status FROM transactions WHERE transaction_id")) {
        return { rows: [{ transaction_status: pendingPayment?.transaction_status ?? "PENDING" }], rowCount: 1 };
    }
    if (text.includes("FOR UPDATE OF t, c")) {
        return { rows: [{ transaction_status: "PENDING", contribution_id: "C".repeat(25), user_id: "U".repeat(25) }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
}

function installFakes() {
    pool.query = async (sql, params) => runSql(sql, params);
    pool.connect = async () => ({ query: async (sql, params) => runSql(sql, params), release() {} });
    global.fetch = async (input, init) => {
        const url = String(typeof input === "string" ? input : input.url);
        const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
        if (url.includes("/oauth/")) return json({ access_token: "token", expires_in: "3599" });
        if (url.includes("/stkpushquery/")) {
            if (providerStatus instanceof Error) throw providerStatus;
            return json({ ResponseCode: "0", CheckoutRequestID: CHECKOUT, ResultCode: String(providerStatus), ResultDesc: "provider says" });
        }
        if (url.includes("/stkpush/")) return json({ ResponseCode: "0", CheckoutRequestID: CHECKOUT });
        throw new Error(`Unexpected fetch ${url}`);
    };
}

function callbackBody({ resultCode = 0, amount = 100, receipt = "SLK1234ABC", phone = 254712345678 } = {}) {
    const stkCallback = { MerchantRequestID: "m", CheckoutRequestID: CHECKOUT, ResultCode: resultCode, ResultDesc: "desc" };
    if (resultCode === 0) {
        stkCallback.CallbackMetadata = { Item: [
            { Name: "Amount", Value: amount },
            { Name: "MpesaReceiptNumber", Value: receipt },
            { Name: "PhoneNumber", Value: phone },
        ] };
    }
    return { Body: { stkCallback } };
}

const wrote = (pattern) => statements.some((s) => pattern.test(s.sql));

beforeEach(() => {
    statements = [];
    providerStatus = 0;
    process.env.MPESA_STK_ENABLED = "true";
    pendingPayment = {
        transaction_id: "T".repeat(25), amount: "100.00", transaction_status: "PENDING", mpesa_phone: "254712345678",
        contribution_id: "C".repeat(25), account_id: "A".repeat(25), user_id: "U".repeat(25),
    };
    installFakes();
});

after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    global.fetch = originalFetch;
    delete process.env.MPESA_STK_ENABLED;
});

test("STK Push stays disabled unless explicitly enabled with a callback secret", async () => {
    process.env.MPESA_STK_ENABLED = "false";
    const res = makeResponse();
    await startStkPush({ user: { userId: "U" }, body: { amount: 100 } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(statements.length, 0);
});

test("starting a payment records a pending contribution and returns the checkout id", async () => {
    const res = makeResponse();
    await startStkPush({ user: { userId: "U".repeat(25) }, body: { amount: 100 } }, res);
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.data.checkout_request_id, CHECKOUT);
    assert.equal(res.body.data.payment_status, "PENDING");
    assert.ok(wrote(/INSERT INTO contributions/));
    assert.ok(wrote(/INSERT INTO audit_logs/), "contribution creation is audited");
    assert.ok(wrote(/UPDATE transactions SET checkout_request_id/));
});

test("rejects fractional, tiny and oversized amounts before touching the database", async () => {
    for (const amount of [10, 100.5, 150001, "abc", 0]) {
        const res = makeResponse();
        await startStkPush({ user: { userId: "U" }, body: { amount } }, res);
        assert.equal(res.statusCode, 400, `amount ${amount}`);
    }
    assert.equal(statements.length, 0);
});

test("a verified successful callback completes the payment and credits the balance once", async () => {
    const res = makeResponse();
    await handleStkCallback({ params: { secret: SECRET }, body: callbackBody() }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(wrote(/SET transaction_status = 'COMPLETED'/));
    assert.ok(wrote(/UPDATE pension_accounts SET current_balance = current_balance \+ \$2/));
    assert.ok(wrote(/INSERT INTO notifications/));

    statements = [];
    pendingPayment.transaction_status = "COMPLETED";
    await handleStkCallback({ params: { secret: SECRET }, body: callbackBody() }, makeResponse());
    assert.ok(!wrote(/UPDATE pension_accounts/), "duplicate callback must not credit again");
});

test("callbacks without the correct secret change nothing", async () => {
    for (const secret of [undefined, "wrong", "s".repeat(31)]) {
        statements = [];
        const res = makeResponse();
        await handleStkCallback({ params: { secret }, body: callbackBody() }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(statements.length, 0);
    }
});

test("a callback that Daraja's query does not confirm is not credited", async () => {
    providerStatus = 1032; // provider says cancelled, callback claims success
    await handleStkCallback({ params: { secret: SECRET }, body: callbackBody({ resultCode: 0 }) }, makeResponse());
    assert.ok(!wrote(/UPDATE pension_accounts/));
    assert.ok(!wrote(/SET transaction_status = 'COMPLETED'/));
});

test("an unreachable verification service leaves the payment pending", async () => {
    providerStatus = new TypeError("network down");
    await handleStkCallback({ params: { secret: SECRET }, body: callbackBody() }, makeResponse());
    assert.ok(!wrote(/UPDATE pension_accounts/));
});

test("a mismatched amount or malformed receipt is not credited", async () => {
    await handleStkCallback({ params: { secret: SECRET }, body: callbackBody({ amount: 1 }) }, makeResponse());
    await handleStkCallback({ params: { secret: SECRET }, body: callbackBody({ receipt: "bad" }) }, makeResponse());
    assert.ok(!wrote(/UPDATE pension_accounts/));
});

test("cancelled and timed-out outcomes are recorded without crediting", async () => {
    providerStatus = 1032;
    await handleStkCallback({ params: { secret: SECRET }, body: callbackBody({ resultCode: 1032 }) }, makeResponse());
    const cancelled = statements.find((s) => /UPDATE transactions SET transaction_status = \$2/.test(s.sql));
    assert.equal(cancelled.params[1], "CANCELLED");
    assert.ok(!wrote(/UPDATE pension_accounts/));

    statements = [];
    providerStatus = 1037;
    await handleStkCallback({ params: { secret: SECRET }, body: callbackBody({ resultCode: 1037 }) }, makeResponse());
    const timedOut = statements.find((s) => /UPDATE transactions SET transaction_status = \$2/.test(s.sql));
    assert.equal(timedOut.params[1], "TIMED_OUT");
});
