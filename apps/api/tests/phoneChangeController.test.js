const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { requireAuth } = require("../src/middleware/authMiddleware");
const { createPhoneChangeController } = require("../src/controllers/phoneChangeController");

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
