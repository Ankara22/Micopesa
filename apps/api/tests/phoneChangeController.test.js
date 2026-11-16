const { test } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");
const express = require("express");
const http = require("node:http");
const { requireAuth } = require("../src/middleware/authMiddleware");
const { createPhoneChangeController } = require("../src/controllers/phoneChangeController");
const phoneChangeService = require("../src/services/phoneChangeService");

function response() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

test("phone change controller binds requests to the authenticated user and never returns the code", async () => {
    const calls = [];
    const controller = createPhoneChangeController({
        async startPhoneChange(input) {
            calls.push(["start", input]);
            return { phone: "+254712345678", expiresAt: "2026-11-05T12:10:00.000Z" };
        },
        async verifyPhoneChange(input) {
            calls.push(["verify", input]);
            return { phone: "+254712345678", phoneVerified: true };
        },
    });

    const startResponse = response();
    await controller.requestPhoneChange({
        user: { userId: "admin-user" },
        body: {
            new_phone: "0712345678",
            current_password: "current-password",
            confirmed: true,
            user_id: "attacker-selected-user",
        },
    }, startResponse);
    assert.equal(startResponse.statusCode, 202);
    assert.deepEqual(calls[0], ["start", {
        userId: "admin-user",
        currentPassword: "current-password",
        newPhone: "0712345678",
        confirmed: true,
    }]);
    assert.equal(JSON.stringify(startResponse.body).includes("code"), false);

    const verifyResponse = response();
    await controller.verifyPhoneChange({
        user: { userId: "admin-user" },
        body: { code: "123456", user_id: "attacker-selected-user" },
    }, verifyResponse);
    assert.deepEqual(calls[1], ["verify", { userId: "admin-user", code: "123456" }]);
});

test("phone change controller returns a sanitized provider diagnosis", async () => {
    const records = [];
    const originalConsoleError = console.error;
    console.error = (...args) => records.push(args);
    try {
        const controller = createPhoneChangeController({
            async startPhoneChange() {
                throw Object.assign(new Error("private provider response"), {
                    code: "PHONE_CHANGE_SMS_OUTCOME_UNKNOWN",
                    statusCode: 503,
                    diagnostics: {
                        provider: "MOBILE_SASA",
                        providerErrorCode: "SMS_TIMEOUT",
                        missingVariables: ["AT_API_KEY", "private-value"],
                        invalidVariables: ["MOBILESASA_SMS_ENABLED"],
                        recipient: "+254712345678",
                    },
                });
            },
            async verifyPhoneChange() {},
        });
        const result = response();
        await controller.requestPhoneChange({
            user: { userId: "user-1" },
            body: { new_phone: "0712345678", current_password: "password", confirmed: true },
        }, result);

        assert.equal(result.statusCode, 503);
        assert.equal(result.body.code, "PHONE_CHANGE_SMS_OUTCOME_UNKNOWN");
        assert.equal(result.body.message, "Unable to complete phone verification right now.");
        const log = JSON.stringify(records);
        assert.match(log, /MOBILE_SASA/);
        assert.match(log, /SMS_TIMEOUT/);
        assert.match(log, /AT_API_KEY/);
        assert.doesNotMatch(log, /private provider response|private-value|\+254712345678/);
    } finally {
        console.error = originalConsoleError;
    }
});

test("mocked phone-change request and verification endpoints persist and consume an OTP", async (t) => {
    const state = {
        account: {
            user_id: "user-1",
            phone: "254700000001",
            phone_verified_at: null,
            password_hash: await bcrypt.hash("correct-password", 4),
        },
        challenge: null,
        sent: [],
    };
    const client = {
        async query(sql, values = []) {
            if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
            if (sql.includes("SELECT user_id, phone, phone_verified_at, password_hash")) {
                return { rows: [state.account] };
            }
            if (sql.trimStart().startsWith("SELECT") &&
                sql.includes("user_id <>") && sql.includes("FROM users")) return { rows: [] };
            if (sql.trimStart().startsWith("SELECT") && sql.includes("user_id <>") &&
                sql.includes("FROM phone_change_verifications")) return { rows: [] };
            if (sql.includes("SELECT send_count, window_started_at")) return { rows: [] };
            if (sql.includes("INSERT INTO phone_change_verifications")) {
                const [
                    userId, phone, hash, salt, expiresAt, sendCount, windowStartedAt,
                    lastSentAt, attemptCount, attemptWindowStartedAt,
                ] = values;
                state.challenge = {
                    user_id: userId,
                    pending_phone: phone,
                    code_hash: hash,
                    code_salt: salt,
                    expires_at: expiresAt,
                    send_count: sendCount,
                    window_started_at: windowStartedAt,
                    last_sent_at: lastSentAt,
                    attempt_count: attemptCount,
                    attempt_window_started_at: attemptWindowStartedAt,
                    locked_until: null,
                };
                return { rows: [] };
            }
            if (sql.includes("SELECT pending_phone, code_hash, code_salt")) {
                return { rows: state.challenge ? [state.challenge] : [] };
            }
            if (sql.includes("UPDATE users") && sql.includes("phone_verified_at")) {
                state.account.phone = values[1];
                state.account.phone_verified_at = values[2];
                return { rows: [{
                    user_id: state.account.user_id,
                    phone: state.account.phone,
                    phone_verified_at: state.account.phone_verified_at,
                }] };
            }
            if (sql.includes("UPDATE phone_change_verifications") &&
                sql.includes("SET pending_phone = NULL")) {
                state.challenge.pending_phone = null;
                state.challenge.code_hash = null;
                state.challenge.code_salt = null;
                state.challenge.expires_at = null;
                return { rows: [] };
            }
            throw new Error(`Unexpected mocked SQL: ${sql}`);
        },
        release() {},
    };
    const database = { async connect() { return client; } };
    const smsService = {
        getPhoneVerificationSmsConfiguration: () => ({
            available: true,
            mode: "development-test",
            provider: "MOBILE_SASA",
        }),
        async sendPhoneVerificationSms(request) {
            state.sent.push(request);
            return { accepted: true, status: "PROVIDER_ACCEPTED" };
        },
    };
    const now = () => new Date("2026-11-05T12:00:00Z");
    const controller = createPhoneChangeController({
        startPhoneChange: (input) => phoneChangeService.startPhoneChange(input, {
            database,
            smsService,
            environment: { NODE_ENV: "development" },
            now,
        }),
        verifyPhoneChange: (input) => phoneChangeService.verifyPhoneChange(input, {
            database,
            now: () => new Date("2026-11-05T12:01:00Z"),
        }),
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { userId: "user-1" };
        next();
    });
    app.post("/api/profile/me/phone-change/request", controller.requestPhoneChange);
    app.post("/api/profile/me/phone-change/verify", controller.verifyPhoneChange);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    }));

    const baseUrl = `http://127.0.0.1:${server.address().port}/api/profile/me/phone-change`;
    const requestResponse = await fetch(`${baseUrl}/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            new_phone: "0712345678",
            current_password: "correct-password",
            confirmed: true,
        }),
    });
    const requestBody = await requestResponse.json();
    assert.equal(requestResponse.status, 202);
    assert.equal(state.sent.length, 1);
    assert.equal(state.challenge.pending_phone, "+254712345678");
    assert.equal(Buffer.isBuffer(state.challenge.code_hash), true);
    assert.equal(JSON.stringify(requestBody).includes(state.sent[0].message), false);

    const code = state.sent[0].message.match(/\b(\d{6})\b/)[1];
    assert.equal(JSON.stringify(requestBody).includes(code), false);
    const verifyResponse = await fetch(`${baseUrl}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
    });
    const verifyBody = await verifyResponse.json();
    assert.equal(verifyResponse.status, 200);
    assert.equal(verifyBody.data.phoneVerified, true);
    assert.equal(state.account.phone, "+254712345678");
    assert.equal(state.challenge.pending_phone, null);
});

test("phone change routes reject unauthenticated callers before invoking the controller", async (t) => {
    let controllerCalls = 0;
    const controller = createPhoneChangeController({
        async startPhoneChange() { controllerCalls += 1; },
        async verifyPhoneChange() { controllerCalls += 1; },
    });
    const app = express();
    app.use(express.json());
    app.post("/phone-change/request", requireAuth, controller.requestPhoneChange);
    app.post("/phone-change/verify", requireAuth, controller.verifyPhoneChange);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    }));

    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    for (const endpoint of ["/phone-change/request", "/phone-change/verify"]) {
        const result = await fetch(`${baseUrl}${endpoint}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ new_phone: "0712345678", code: "123456" }),
        });
        assert.equal(result.status, 401);
    }
    assert.equal(controllerCalls, 0);
});
