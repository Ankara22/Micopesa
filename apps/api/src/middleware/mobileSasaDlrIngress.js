const { createHash, createHmac, timingSafeEqual } = require("node:crypto");
const express = require("express");

const BODY_LIMIT = "8kb";
const DEFAULT_REPLAY_WINDOW_SECONDS = 300;
const DEFAULT_RATE_LIMIT = 1200;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_ENTRIES = 4096;
const SIGNATURE_PATTERN = /^t=(\d{10}),v1=([a-f0-9]{64})$/;

function safeEqual(left, right) {
    const leftHash = createHash("sha256").update(String(left)).digest();
    const rightHash = createHash("sha256").update(String(right)).digest();
    return timingSafeEqual(leftHash, rightHash);
}

function createMobileSasaDlrIngress({
    environment = process.env,
    now = Date.now,
    replayWindowSeconds = environment.MOBILESASA_WEBHOOK_REPLAY_WINDOW_SECONDS === undefined
        ? DEFAULT_REPLAY_WINDOW_SECONDS
        : Number(environment.MOBILESASA_WEBHOOK_REPLAY_WINDOW_SECONDS),
    bodyLimit = BODY_LIMIT,
    rateLimit = DEFAULT_RATE_LIMIT,
    rateWindowMs = DEFAULT_RATE_WINDOW_MS,
    maxRateLimitEntries = DEFAULT_RATE_LIMIT_ENTRIES,
} = {}) {
    if (
        typeof now !== "function" ||
        !Number.isInteger(replayWindowSeconds) ||
        replayWindowSeconds < 30 ||
        replayWindowSeconds > 900 ||
        !Number.isInteger(rateLimit) ||
        rateLimit < 1 ||
        !Number.isInteger(rateWindowMs) ||
        rateWindowMs < 1000 ||
        !Number.isInteger(maxRateLimitEntries) ||
        maxRateLimitEntries < 1
    ) {
        throw new TypeError("Mobile Sasa webhook ingress settings are invalid.");
    }

    const parser = express.raw({ type: "application/json", limit: bodyLimit });
    const requestCounts = new Map();

    function allowRequest(req, res) {
        const address = req.socket?.remoteAddress;
        if (typeof address !== "string" || !address) {
            res.set("Retry-After", "1");
            res.set("Connection", "close");
            res.status(503).json({ status: "error", message: "Webhook is temporarily unavailable." });
            return false;
        }

        const currentTime = now();
        for (const [key, entry] of requestCounts) {
            if (entry.resetAt <= currentTime) requestCounts.delete(key);
        }

        let entry = requestCounts.get(address);
        if (!entry) {
            if (requestCounts.size >= maxRateLimitEntries) {
                res.set("Retry-After", "1");
                res.set("Connection", "close");
                res.status(503).json({ status: "error", message: "Webhook is temporarily unavailable." });
                return false;
            }
            entry = { count: 0, resetAt: currentTime + rateWindowMs };
            requestCounts.set(address, entry);
        }

        if (entry.count >= rateLimit) {
            res.set("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1000))));
            res.set("Connection", "close");
            res.status(503).json({ status: "error", message: "Webhook is temporarily unavailable." });
            return false;
        }
        entry.count += 1;
        return true;
    }

    return function mobileSasaDlrIngress(req, res, next) {
        if (environment.MOBILESASA_SMS_DLR_ENABLED !== "true") {
            return res.status(404).json({ status: "error", message: "Webhook is unavailable." });
        }
        if (environment.NODE_ENV !== "production" ||
            typeof environment.MOBILESASA_WEBHOOK_SECRET !== "string" ||
            !environment.MOBILESASA_WEBHOOK_SECRET.trim()) {
            return res.status(503).json({ status: "error", message: "Webhook is unavailable." });
        }
        if (!allowRequest(req, res)) return undefined;
        const contentType = req.get("content-type") || "";
        if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
            return res.status(400).json({ status: "error", message: "Invalid delivery report." });
        }

        parser(req, res, (parseError) => {
            if (parseError) {
                const status = parseError.type === "entity.too.large" ? 413 : 400;
                return res.status(status).json({
                    status: "error",
                    message: status === 413 ? "Delivery report is too large." : "Invalid delivery report.",
                });
            }
            if (!Buffer.isBuffer(req.body)) {
                return res.status(400).json({ status: "error", message: "Invalid delivery report." });
            }

            const suppliedSecret = req.get("X-MobileSasa-Secret") || "";
            const suppliedSignature = req.get("X-MobileSasa-Signature") || "";
            const match = SIGNATURE_PATTERN.exec(suppliedSignature);
            if (!match || !safeEqual(suppliedSecret, environment.MOBILESASA_WEBHOOK_SECRET)) {
                return res.status(401).json({ status: "error", message: "Invalid webhook authentication." });
            }

            const timestamp = Number(match[1]);
            const currentTime = now();
            const currentSeconds = Math.floor(currentTime / 1000);
            if (!Number.isSafeInteger(timestamp) ||
                Math.abs(currentSeconds - timestamp) > replayWindowSeconds) {
                return res.status(401).json({ status: "error", message: "Invalid webhook authentication." });
            }

            const expected = createHmac("sha256", environment.MOBILESASA_WEBHOOK_SECRET)
                .update(`${match[1]}.`)
                .update(req.body)
                .digest();
            const supplied = Buffer.from(match[2], "hex");
            if (!timingSafeEqual(expected, supplied)) {
                return res.status(401).json({ status: "error", message: "Invalid webhook authentication." });
            }

            let payload;
            try {
                payload = JSON.parse(req.body.toString("utf8"));
            } catch {
                return res.status(400).json({ status: "error", message: "Invalid delivery report." });
            }
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
                return res.status(400).json({ status: "error", message: "Invalid delivery report." });
            }
            req.mobileSasaDeliveryReport = payload;
            req.mobileSasaWebhookVerifiedAt = new Date(currentTime);
            return next();
        });
    };
}

module.exports = {
    BODY_LIMIT,
    DEFAULT_RATE_LIMIT,
    DEFAULT_RATE_LIMIT_ENTRIES,
    DEFAULT_RATE_WINDOW_MS,
    DEFAULT_REPLAY_WINDOW_SECONDS,
    createMobileSasaDlrIngress,
};
