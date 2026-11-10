const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const {
    createGeneralJsonParser,
    createMpesaCallbackIngress,
} = require("../src/middleware/mpesaCallbackIngress");
const {
    createMpesaVerificationController,
} = require("../src/controllers/mpesaController");

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

function post(port, body, headers = {}, path = "/api/mpesa/callback") {
    const payload = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: "127.0.0.1",
            port,
            path,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": payload.length,
                ...headers,
            },
        }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
                resolve({
                    status: response.statusCode,
                    headers: response.headers,
                    body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                });
            });
        });
        request.on("error", reject);
        request.end(payload);
    });
}

function ingressApp(ingress, handler) {
    const app = express();
    app.use(createGeneralJsonParser());
    app.post("/api/mpesa/callback", ingress, handler);
    return app;
}

test("callback JSON parser rejects oversized payloads before callback processing", async () => {
    let callbackCalls = 0;
    const app = ingressApp(
        createMpesaCallbackIngress({ bodyLimit: "256b" }),
        (_req, res) => {
            callbackCalls += 1;
            res.status(200).json({ ResultCode: 0 });
        }
    );

    await withServer(app, async (port) => {
        const response = await post(port, JSON.stringify({ payload: "x".repeat(512) }));
        const trailingSlashResponse = await post(
            port,
            JSON.stringify({ payload: "x".repeat(512) }),
            {},
            "/api/mpesa/callback/"
        );
        assert.equal(response.status, 413);
        assert.equal(trailingSlashResponse.status, 413);
        assert.deepEqual(response.body, {
            ResultCode: 1,
            ResultDesc: "Payment notification is too large",
        });
        assert.equal(callbackCalls, 0);
    });
});

test("callback overload responds 503 with Retry-After and ignores forwarded IP headers", async () => {
    let timestamp = 10_000;
    let callbackCalls = 0;
    const app = ingressApp(
        createMpesaCallbackIngress({
            rateLimit: 1,
            windowMs: 2_000,
            now: () => timestamp,
        }),
        (_req, res) => {
            callbackCalls += 1;
            res.status(200).json({ ResultCode: 0 });
        }
    );

    await withServer(app, async (port) => {
        const forwardedHeaders = { "X-Forwarded-For": "198.51.100.10" };
        assert.equal((await post(port, {}, forwardedHeaders)).status, 200);
        const limited = await post(port, {}, { "X-Forwarded-For": "203.0.113.20" });
        assert.equal(limited.status, 503);
        assert.equal(limited.headers["retry-after"], "2");
        assert.deepEqual(limited.body, {
            ResultCode: 1,
            ResultDesc: "Payment notification temporarily unavailable",
        });
        assert.equal(callbackCalls, 1);

        timestamp += 2_000;
        assert.equal((await post(port, {})).status, 200);
        assert.equal(callbackCalls, 2);
    });
});

test("repeated callbacks remain idempotent and receive normal acknowledgements", async () => {
    const seen = new Set();
    let verificationCalls = 0;
    let verifiedEffects = 0;
    const controller = createMpesaVerificationController({
        async processCallback(payload) {
            verificationCalls += 1;
            const fingerprint = JSON.stringify(payload);
            const duplicate = seen.has(fingerprint);
            if (!duplicate) {
                seen.add(fingerprint);
                verifiedEffects += 1;
            }
            return { accepted: true, duplicate };
        },
        async reconcileAttempt() {},
    });
    const app = ingressApp(
        createMpesaCallbackIngress({ rateLimit: 3 }),
        controller.handleStkCallback
    );
    const callback = {
        Body: {
            stkCallback: {
                CheckoutRequestID: "checkout_retry_test",
                MerchantRequestID: "merchant_retry_test",
                ResultCode: 1032,
                ResultDesc: "Request cancelled",
            },
        },
    };

    await withServer(app, async (port) => {
        const first = await post(port, callback);
        const retry = await post(port, callback);
        assert.equal(first.status, 200);
        assert.equal(retry.status, 200);
        assert.deepEqual(first.body, retry.body);
        assert.equal(verificationCalls, 2);
        assert.equal(verifiedEffects, 1);
    });
});

test("ordinary provider retry after a transient callback failure is accepted", async () => {
    let callbackCalls = 0;
    const app = ingressApp(
        createMpesaCallbackIngress({ rateLimit: 5 }),
        (_req, res) => {
            callbackCalls += 1;
            if (callbackCalls === 1) {
                return res.set("Retry-After", "1").status(503).json({
                    ResultCode: 1,
                    ResultDesc: "Payment notification could not be verified",
                });
            }
            return res.status(200).json({ ResultCode: 0 });
        }
    );

    await withServer(app, async (port) => {
        const first = await post(port, {});
        const retry = await post(port, {});
        assert.equal(first.status, 503);
        assert.equal(first.headers["retry-after"], "1");
        assert.equal(retry.status, 200);
        assert.equal(callbackCalls, 2);
    });
});
