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
const originalSmsProvider = process.env.TRANSACTIONAL_SMS_PROVIDER;

after(() => {
    pool.connect = originalConnect;
    bcrypt.hash = originalHash;
    smsService.sendSms = originalSendSms;
    if (originalSmsProvider === undefined) delete process.env.TRANSACTIONAL_SMS_PROVIDER;
    else process.env.TRANSACTIONAL_SMS_PROVIDER = originalSmsProvider;
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
    let smsRequest;
    process.env.TRANSACTIONAL_SMS_PROVIDER = "MOBILE_SASA";
    bcrypt.hash = async (value) => {
        assert.ok(value.length >= 20);
        return "temporary-password-hash";
    };
    smsService.sendSms = async ({ to, message, trackingId }, options) => {
        assert.equal(to, "+254712345678");
        assert.match(message, /Temporary password:/);
        assert.match(trackingId, /^[0-9a-f-]{36}$/i);
        assert.equal(options.provider, "MOBILE_SASA");
        smsRequest = { trackingId, provider: options.provider };
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
        query.includes("INSERT INTO audit_logs") &&
        values[2] === "STAFF_ONBOARDING" &&
        values[4]?.includes('"sms_provider"')
    );
    assert.ok(createAudit);
    assert.equal(createAudit.values[0], "ADMIN-USER-12345678901234567890");
    const auditDetails = JSON.parse(createAudit.values[4]);
    assert.equal(auditDetails.sms_provider, smsRequest.provider);
    assert.equal(auditDetails.sms_tracking_id, smsRequest.trackingId);
    assert.equal(auditDetails.provider_message_id, "provider-message-1");
    assert.equal(JSON.stringify(res.body).includes("temporary-password-hash"), false);
});

test("leaves a staff account inactive when the SMS provider rejects onboarding", async () => {
    let insertCount = 0;
    const infoLogs = [];
    let loggedFailure;
    bcrypt.hash = async () => "temporary-password-hash";
    smsService.sendSms = async (_payload, options) => {
        assert.equal(options.provider, "MOBILE_SASA");
        assert.equal(options.logger, console);
        const error = new Error("provider rejection");
        error.code = "SMS_PROVIDER_REJECTED";
        error.diagnostics = {
            errorCode: "SMS_PROVIDER_REJECTED",
            errorClass: "Error",
            requestStarted: true,
            httpResponseReceived: true,
            httpStatus: 422,
            responseCode: "0402",
            failureCategory: "provider_rejection",
            deliveryOutcomeUnknown: false,
        };
        throw error;
    };
    process.env.TRANSACTIONAL_SMS_PROVIDER = "MOBILE_SASA";
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
    const originalConsoleInfo = console.info;
    console.info = (message) => infoLogs.push(JSON.parse(message));
    console.error = (message) => {
        loggedFailure = JSON.parse(message);
    };
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
        assert.equal(infoLogs[0].event, "admin.staff_onboarding.sms_attempt_started");
        assert.equal(infoLogs[0].provider, "MOBILE_SASA");
        assert.deepEqual(loggedFailure, {
            event: "admin.staff_onboarding.sms_failed",
            provider: "MOBILE_SASA",
            requestStarted: true,
            httpResponseReceived: true,
            httpStatus: 422,
            responseCode: "0402",
            errorCode: "SMS_PROVIDER_REJECTED",
            errorClass: "Error",
            failureCategory: "provider_rejection",
            deliveryOutcomeUnknown: false,
        });
        assert.doesNotMatch(JSON.stringify([...infoLogs, loggedFailure]), /userId|B{25}|provider rejection|temporary-password|\+254/);
    } finally {
        console.error = originalConsoleError;
        console.info = originalConsoleInfo;
    }
});

test("development onboarding delivers only to the SMS allowlist and activates only after acceptance", async () => {
    const environmentNames = [
        "NODE_ENV",
        "TRANSACTIONAL_SMS_PROVIDER",
        "COMMUNICATIONS_DEV_DELIVERY_ENABLED",
        "COMMUNICATIONS_DEV_SMS_ENABLED",
        "COMMUNICATIONS_DEV_ALLOWED_PHONES",
        "MOBILESASA_SMS_ENABLED",
        "MOBILE_SASA_SMS_API_TOKEN",
        "MOBILE_SASA_SMS_SENDER_ID",
    ];
    const originalEnvironment = Object.fromEntries(
        environmentNames.map((name) => [name, process.env[name]])
    );
    const originalFetch = global.fetch;
    const originalHash = bcrypt.hash;
    const originalConnect = pool.connect;
    const previousSendSms = smsService.sendSms;
    let active = false;
    let providerRequests = 0;
    process.env.NODE_ENV = "development";
    process.env.TRANSACTIONAL_SMS_PROVIDER = "MOBILE_SASA";
    process.env.COMMUNICATIONS_DEV_DELIVERY_ENABLED = "true";
    process.env.COMMUNICATIONS_DEV_SMS_ENABLED = "true";
    process.env.COMMUNICATIONS_DEV_ALLOWED_PHONES = "0712345678";
    process.env.MOBILESASA_SMS_ENABLED = "true";
    process.env.MOBILE_SASA_SMS_API_TOKEN = "mbs_test-token";
    process.env.MOBILE_SASA_SMS_SENDER_ID = "MicoPesa";
    bcrypt.hash = async () => "temporary-password-hash";
    smsService.sendSms = originalSendSms;
    global.fetch = async () => {
        providerRequests += 1;
        return {
            ok: true,
            status: 200,
            async json() {
                return { status: true, responseCode: "0200", messageId: "mock-accepted-1" };
            },
        };
    };

    function installDatabaseMock() {
        pool.connect = async () => ({
            async query(query, values = []) {
                if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") {
                    return { rows: [] };
                }
                if (query.includes("INSERT INTO users")) {
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
    }

    try {
        installDatabaseMock();
        const accepted = response();
        await createStaff({
            user: { userId: "ADMIN-USER-12345678901234567890" },
            body: { full_name: "Development Staff", phone: "0712 345 678", role: "REGULATOR" },
        }, accepted);
        assert.equal(accepted.body.data.sms_accepted, true);
        assert.equal(active, true);
        assert.equal(providerRequests, 1);

        active = false;
        installDatabaseMock();
        const blocked = response();
        await createStaff({
            user: { userId: "ADMIN-USER-12345678901234567890" },
            body: { full_name: "Blocked Staff", phone: "0711 111 111", role: "REGULATOR" },
        }, blocked);
        assert.equal(blocked.body.data.sms_accepted, false);
        assert.equal(active, false);
        assert.equal(providerRequests, 1);
    } finally {
        pool.connect = originalConnect;
        bcrypt.hash = originalHash;
        smsService.sendSms = previousSendSms;
        global.fetch = originalFetch;
        for (const name of environmentNames) {
            if (originalEnvironment[name] === undefined) delete process.env[name];
            else process.env[name] = originalEnvironment[name];
        }
    }
});

test("does not send a duplicate onboarding SMS when staff creation conflicts", async () => {
    let smsCalls = 0;
    bcrypt.hash = async () => "temporary-password-hash";
    smsService.sendSms = async () => {
        smsCalls += 1;
        return { accepted: true, messageId: "unexpected" };
    };
    pool.connect = async () => ({
        async query(query) {
            if (query === "BEGIN" || query === "ROLLBACK") return { rows: [] };
            if (query.includes("INSERT INTO users")) {
                const error = new Error("duplicate account");
                error.code = "23505";
                throw error;
            }
            assert.fail(`Unexpected query: ${query}`);
        },
        release() {},
    });

    const res = response();
    await createStaff({
        user: { userId: "admin" },
        body: { full_name: "New Staff", phone: "+254712345678", role: "REGULATOR" },
    }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(smsCalls, 0);
});

test("reissues credentials for a pending staff account without creating a duplicate user", async () => {
    const queries = [];
    process.env.TRANSACTIONAL_SMS_PROVIDER = "MOBILE_SASA";
    bcrypt.hash = async () => "replacement-password-hash";
    smsService.sendSms = async ({ to, trackingId }, options) => {
        assert.equal(to, "+254712345678");
        assert.match(trackingId, /^[0-9a-f-]{36}$/i);
        assert.equal(options.provider, "MOBILE_SASA");
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
