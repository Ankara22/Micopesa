const express = require("express");

const CALLBACK_BODY_LIMIT = "32kb";
const CALLBACK_RATE_LIMIT = 120;
const CALLBACK_RATE_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_ENTRIES = 4096;

function sendRetryableOverload(res, retryAfterSeconds = 1) {
    res.set("Retry-After", String(Math.max(1, retryAfterSeconds)));
    res.set("Connection", "close");
    return res.status(503).json({
        ResultCode: 1,
        ResultDesc: "Payment notification temporarily unavailable",
    });
}

function createMpesaCallbackIngress({
    bodyLimit = CALLBACK_BODY_LIMIT,
    rateLimit = CALLBACK_RATE_LIMIT,
    windowMs = CALLBACK_RATE_WINDOW_MS,
    maxEntries = MAX_RATE_LIMIT_ENTRIES,
    now = Date.now,
} = {}) {
    if (
        !Number.isInteger(rateLimit) || rateLimit < 1 ||
        !Number.isInteger(windowMs) || windowMs < 1 ||
        !Number.isInteger(maxEntries) || maxEntries < 1 ||
        typeof now !== "function"
    ) {
        throw new TypeError("M-Pesa callback ingress limits are invalid.");
    }

    const windows = new Map();
    const parser = express.json({ limit: bodyLimit });

    function allowRequest(req, res) {
        const address = req.socket?.remoteAddress;
        if (typeof address !== "string" || address.length === 0) {
            sendRetryableOverload(res);
            return false;
        }

        const timestamp = now();
        let entry = windows.get(address);
        if (!entry || entry.resetAt <= timestamp) {
            if (!entry && windows.size >= maxEntries) {
                for (const [key, value] of windows) {
                    if (value.resetAt <= timestamp) windows.delete(key);
                }
                if (windows.size >= maxEntries) {
                    sendRetryableOverload(res);
                    return false;
                }
            }
            entry = { count: 0, resetAt: timestamp + windowMs };
            windows.set(address, entry);
        }

        if (entry.count >= rateLimit) {
            sendRetryableOverload(res, Math.ceil((entry.resetAt - timestamp) / 1000));
            return false;
        }
        entry.count += 1;
        return true;
    }

    return function mpesaCallbackIngress(req, res, next) {
        if (!allowRequest(req, res)) return;
        parser(req, res, (error) => {
            if (!error) return next();
            if (error.type === "entity.too.large") {
                return res.status(413).json({
                    ResultCode: 1,
                    ResultDesc: "Payment notification is too large",
                });
            }
            return res.status(400).json({
                ResultCode: 1,
                ResultDesc: "Invalid payment notification",
            });
        });
    };
}

function createGeneralJsonParser() {
    const parser = express.json();
    return function parseNonCallbackJson(req, res, next) {
        const requestPath = req.path.replace(/\/+$/, "").toLowerCase();
        if (req.method === "POST" &&
            ["/api/mpesa/callback", "/api/integrations/mobilesasa/delivery-reports"]
                .includes(requestPath)) {
            return next();
        }
        return parser(req, res, next);
    };
}

module.exports = {
    CALLBACK_BODY_LIMIT,
    CALLBACK_RATE_LIMIT,
    CALLBACK_RATE_WINDOW_MS,
    createGeneralJsonParser,
    createMpesaCallbackIngress,
};
