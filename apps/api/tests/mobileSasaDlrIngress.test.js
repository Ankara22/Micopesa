const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const http = require("node:http");
const express = require("express");
const { createMobileSasaDlrIngress } = require("../src/middleware/mobileSasaDlrIngress");
const { createGeneralJsonParser } = require("../src/middleware/mpesaCallbackIngress");

async function withServer(app, run) {
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    try {
        await run(server.address().port);
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
}

function signature(secret, timestamp, rawBody) {
    const digest = createHmac("sha256", secret)
        .update(`${timestamp}.`)
        .update(rawBody)
        .digest("hex");
    return `t=${timestamp},v1=${digest}`;
}

function post(port, rawBody, headers = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: "127.0.0.1",
            port,
            path: "/api/integrations/mobilesasa/delivery-reports",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(rawBody),
                ...headers,
            },
        }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => resolve({
                status: response.statusCode,
                headers: response.headers,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            }));
        });
        request.on("error", reject);
        request.end(rawBody);
    });
}

function appFor(environment, now, bodyLimit = "8kb", rateLimitOptions = {}) {
    const app = express();
    app.use(createGeneralJsonParser());
    app.post(
        "/api/integrations/mobilesasa/delivery-reports",
        createMobileSasaDlrIngress({ environment, now, bodyLimit, ...rateLimitOptions }),
        (req, res) => res.status(200).json({ report: req.mobileSasaDeliveryReport })
    );
    return app;
}

test("DLR ingress verifies the raw-body signature and accepts a valid signed report", async () => {
    const secret = "test-webhook-secret";
    const now = 1_700_000_000_000;
    const timestamp = String(Math.floor(now / 1000));
    const rawBody = '{ "status":"Delivered", "reference":"message-123" }\n';
    const app = appFor({
        NODE_ENV: "production",
        MOBILESASA_SMS_DLR_ENABLED: "true",
        MOBILESASA_WEBHOOK_SECRET: secret,
    }, () => now);

    await withServer(app, async (port) => {
        const result = await post(port, rawBody, {
            "X-MobileSasa-Secret": secret,
            "X-MobileSasa-Signature": signature(secret, timestamp, rawBody),
        });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.report, {
            status: "Delivered",
            reference: "message-123",
        });
    });

    test("callback rate limiting returns a retryable response without growing past its bound", async () => {
        const secret = "test-webhook-secret";
        const now = 1_700_000_000_000;
        const timestamp = String(Math.floor(now / 1000));
        const rawBody = '{"status":"Delivered","reference":"message-123"}';
        const app = appFor({
            NODE_ENV: "production",
            MOBILESASA_SMS_DLR_ENABLED: "true",
            MOBILESASA_WEBHOOK_SECRET: secret,
        }, () => now, "8kb", {
            rateLimit: 1,
            rateWindowMs: 60_000,
            maxRateLimitEntries: 1,
        });

        await withServer(app, async (port) => {
            const headers = {
                "X-MobileSasa-Secret": secret,
                "X-MobileSasa-Signature": signature(secret, timestamp, rawBody),
            };
            assert.equal((await post(port, rawBody, headers)).status, 200);
            const limited = await post(port, rawBody, headers);
            assert.equal(limited.status, 503);
            assert.equal(limited.headers["retry-after"], "60");
        });
    });
});

test("DLR ingress rejects stale, forged, disabled, oversized, and malformed callbacks", async () => {
    const secret = "test-webhook-secret";
    const now = 1_700_000_000_000;
    const timestamp = String(Math.floor(now / 1000));
    const rawBody = '{"status":"Delivered","reference":"message-123"}';
    const enabled = {
        NODE_ENV: "production",
        MOBILESASA_SMS_DLR_ENABLED: "true",
        MOBILESASA_WEBHOOK_SECRET: secret,
    };

    await withServer(appFor(enabled, () => now, "128b"), async (port) => {
        assert.equal((await post(port, rawBody, {
            "X-MobileSasa-Secret": secret,
            "X-MobileSasa-Signature": signature(secret, String(Number(timestamp) - 301), rawBody),
        })).status, 401);
        assert.equal((await post(port, rawBody, {
            "X-MobileSasa-Secret": secret,
            "X-MobileSasa-Signature": signature(secret, timestamp, `${rawBody} `),
        })).status, 401);
        assert.equal((await post(port, "x".repeat(256), {
            "X-MobileSasa-Secret": secret,
            "X-MobileSasa-Signature": signature(secret, timestamp, "x".repeat(256)),
        })).status, 413);
        const malformed = "{";
        assert.equal((await post(port, malformed, {
            "X-MobileSasa-Secret": secret,
            "X-MobileSasa-Signature": signature(secret, timestamp, malformed),
        })).status, 400);
    });

    await withServer(appFor({
        NODE_ENV: "production",
        MOBILESASA_SMS_DLR_ENABLED: "false",
        MOBILESASA_WEBHOOK_SECRET: secret,
    }, () => now), async (port) => {
        assert.equal((await post(port, rawBody)).status, 404);
    });
});
