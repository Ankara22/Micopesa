const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");
const pool = require("../src/db/database");
const smsService = require("../src/services/smsService");
const {
    createStaff,
    resendStaffOnboarding,
    normalizeKenyanPhone,
} = require("../src/controllers/staffOnboardingController");

const originalConnect = pool.connect;
const originalHash = bcrypt.hash;
const originalSendSms = smsService.sendSms;

after(() => {
    pool.connect = originalConnect;
    bcrypt.hash = originalHash;
    smsService.sendSms = originalSendSms;
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

test("normalizes valid Kenyan phone numbers and rejects unsupported formats", () => {
    assert.equal(normalizeKenyanPhone("0712 345 678"), "+254712345678");
    assert.equal(normalizeKenyanPhone(" +254 (712) 345-678 "), "+254712345678");
    assert.equal(normalizeKenyanPhone("0700 123"), null);
    assert.equal(normalizeKenyanPhone("not a phone"), null);
});

test("creates staff with a temporary password, activates only after SMS acceptance, and audits the actor", async () => {
    const calls = [];
    let active = false;
    bcrypt.hash = async (value) => {
        assert.ok(value.length >= 20);
        return "temporary-password-hash";
    };
    smsService.sendSms = async ({ to, message }) => {
        assert.equal(to, "+254712345678");
        assert.match(message, /Temporary password:/);
        return { accepted: true, messageId: "provider-message-1" };
    };
    pool.connect = async () => ({
        async query(query, values = []) {
            calls.push({ query, values });
            if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
            if (query.includes("INSERT INTO users")) {
                assert.equal(values[1], "+254712345678");
                assert.equal(values[2], "temporary-password-hash");
                return {
                    rows: [{
                        user_id: "A".repeat(25),
                        full_name: values[0],
                        phone: values[1],
                        role: values[3],
                        account_status: "INACTIVE",
                    }],
                };
            }
            if (query.includes("UPDATE users SET account_status = 'ACTIVE'")) {
                active = true;
                return { rows: [{ user_id: "A".repeat(25) }] };
            }
            if (query.includes("INSERT INTO audit_logs")) return { rows: [] };
            assert.fail(`Unexpected query: ${query}`);
        },
        release() {},
    });

    const res = response();
    await createStaff({
        user: { userId: "ADMIN-USER-12345678901234567890" },
        body: { full_name: "New Staff", phone: "0712 345 678", role: "REGULATOR" },
    }, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.sms_accepted, true);
    assert.equal(res.body.data.user.account_status, "ACTIVE");
    assert.equal(active, true);
    const createAudit = calls.find(({ query, values }) =>
        query.includes("INSERT INTO audit_logs") && values[2] === "STAFF_ONBOARDING"
    );
    assert.ok(createAudit);
    assert.equal(createAudit.values[0], "ADMIN-USER-12345678901234567890");
    assert.equal(JSON.stringify(res.body).includes("temporary-password-hash"), false);
});

test("leaves a staff account inactive when the SMS provider rejects onboarding", async () => {
    let insertCount = 0;
    bcrypt.hash = async () => "temporary-password-hash";
    smsService.sendSms = async () => {
        const error = new Error("provider rejection");
        error.code = "SMS_PROVIDER_REJECTED";
        throw error;
    };
    pool.connect = async () => ({
        async query(query) {
            if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
            if (query.includes("INSERT INTO users")) {
                insertCount += 1;
                return { rows: [{ user_id: "B".repeat(25), account_status: "INACTIVE" }] };
            }
            if (query.includes("INSERT INTO audit_logs")) return { rows: [] };
            assert.fail(`Unexpected query: ${query}`);
        },
        release() {},
    });
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        const res = response();
        await createStaff({
            user: { userId: "admin" },
            body: { full_name: "New Staff", phone: "+254712345678", role: "FUND_MANAGER" },
        }, res);
        assert.equal(res.statusCode, 201);
        assert.equal(res.body.data.sms_accepted, false);
        assert.match(res.body.message, /remains inactive/i);
        assert.equal(insertCount, 1);
    } finally {
        console.error = originalConsoleError;
    }
});

test("reissues credentials for a pending staff account without creating a duplicate user", async () => {
    const queries = [];
    bcrypt.hash = async () => "replacement-password-hash";
    smsService.sendSms = async ({ to }) => {
        assert.equal(to, "+254712345678");
        return { accepted: true, messageId: "retry-message" };
    };
    pool.connect = async () => ({
        async query(query) {
            queries.push(query);
            if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
            if (query.includes("UPDATE users") && query.includes("force_password_change = TRUE")) {
                return {
                    rows: [{
                        user_id: "C".repeat(25),
                        full_name: "New Staff",
                        phone: "+254712345678",
                        role: "REGULATOR",
                    }],
                };
            }
            if (query.includes("INSERT INTO audit_logs")) return { rows: [] };
            assert.fail(`Unexpected query: ${query}`);
        },
        release() {},
    });

    const res = response();
    await resendStaffOnboarding({
        params: { userId: "C".repeat(25) },
        user: { userId: "ADMIN-USER-12345678901234567890" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(queries.some((query) => query.includes("INSERT INTO users")), false);
    assert.ok(queries.some((query) => query.includes("failed_login_attempts = 0")));
    assert.match(res.body.message, /Inbox delivery is not confirmed/);
});
