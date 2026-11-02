const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../src/db/database");
const { updateOperationalSettings, validateSettings } = require("../src/controllers/adminOperationalSettingsController");
const { calculateProjection } = require("../src/services/projectionService");

const originalConnect = pool.connect;
const DEFAULTS = {
    assumed_yearly_growth: 8,
    max_failed_login_attempts: 5,
    account_lockout_duration_minutes: 15,
    require_otp_on_withdrawal: true,
};

after(() => {
    pool.connect = originalConnect;
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

test("validates operational setting ranges and value types", () => {
    assert.equal(validateSettings(DEFAULTS), null);
    assert.match(validateSettings({ ...DEFAULTS, assumed_yearly_growth: 20.1 }), /between 1 and 20/);
    assert.match(validateSettings({ ...DEFAULTS, max_failed_login_attempts: 2 }), /between 3 and 10/);
    assert.match(validateSettings({ ...DEFAULTS, account_lockout_duration_minutes: 4 }), /between 5 and 60/);
    assert.match(validateSettings({ ...DEFAULTS, require_otp_on_withdrawal: "true" }), /must be true or false/);
});

test("updates settings and writes immutable old/new audit details in one transaction", async () => {
    const stored = { ...DEFAULTS };
    const auditEntries = [];
    const statements = [];
    pool.connect = async () => ({
        async query(query, values = []) {
            statements.push(query);
            if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { rows: [] };
            if (query.includes("SELECT setting_key, setting_value")) {
                return {
                    rows: Object.entries(stored).map(([setting_key, setting_value]) => ({
                        setting_key,
                        setting_value: String(setting_value),
                    })),
                };
            }
            if (query.includes("UPDATE system_settings")) {
                stored[values[2]] = values[0] === "true" ? true : values[0] === "false" ? false : Number(values[0]);
                return { rows: [{ setting_key: values[2] }] };
            }
            if (query.includes("INSERT INTO audit_logs")) {
                auditEntries.push({ userId: values[0], details: JSON.parse(values[4]) });
                return { rows: [] };
            }
            assert.fail(`Unexpected transaction query: ${query}`);
        },
        release() {},
    });

    const res = response();
    await updateOperationalSettings({
        user: { userId: "ADMIN-USER-12345678901234567890" },
        body: { settings: { ...DEFAULTS, assumed_yearly_growth: 9.5 } },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(stored.assumed_yearly_growth, 9.5);
    assert.deepEqual(auditEntries, [{
        userId: "ADMIN-USER-12345678901234567890",
        details: { key: "assumed_yearly_growth", old_value: 8, new_value: 9.5 },
    }]);
    assert.equal(statements.includes("COMMIT"), true);
    assert.equal(statements.includes("ROLLBACK"), false);
});

test("rejects invalid settings before opening a database transaction", async () => {
    pool.connect = async () => assert.fail("Invalid settings must be rejected before connecting");
    const res = response();
    await updateOperationalSettings({
        user: { userId: "admin" },
        body: { settings: { ...DEFAULTS, max_failed_login_attempts: 11 } },
    }, res);
    assert.equal(res.statusCode, 400);
});

test("the configured annual growth rate changes the projection result", () => {
    const projectionAtEightPercent = calculateProjection({
        currentBalance: 10000,
        monthlyContribution: 100,
        targetAmount: 100000,
        targetAge: 65,
        currentAge: 30,
        annualRate: 0.08,
    });
    const projectionAtTwelvePercent = calculateProjection({
        currentBalance: 10000,
        monthlyContribution: 100,
        targetAmount: 100000,
        targetAge: 65,
        currentAge: 30,
        annualRate: 0.12,
    });
    assert.equal(projectionAtEightPercent.annualRate, 0.08);
    assert.ok(projectionAtTwelvePercent.projectedBalance > projectionAtEightPercent.projectedBalance);
});
