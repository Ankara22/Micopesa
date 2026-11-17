const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    deleteExpiredPendingRegistrations,
    startPendingRegistrationCleanup,
} = require("../src/services/pendingRegistrationCleanupService");

test("expired pending registrations are deleted by expiry without selecting personal data", async () => {
    let query;
    const result = await deleteExpiredPendingRegistrations({
        async query(statement) {
            query = statement;
            return { rowCount: 2 };
        },
    });

    assert.equal(query, "DELETE FROM pending_registrations WHERE expires_at <= now()");
    assert.equal(result.rowCount, 2);
});

test("development mode does not schedule automatic pending-registration deletion", () => {
    let scheduled = false;
    let queried = false;
    const stop = startPendingRegistrationCleanup({
        async query() {
            queried = true;
        },
    }, {
        environment: { NODE_ENV: "development" },
        setIntervalImpl() {
            scheduled = true;
            return { unref() {} };
        },
    });

    stop();
    assert.equal(scheduled, false);
    assert.equal(queried, false);
});

test("production mode keeps the expiry cleanup schedule", async () => {
    let cleanup;
    let intervalMs;
    let queryCount = 0;
    startPendingRegistrationCleanup({
        async query() {
            queryCount += 1;
        },
    }, {
        environment: { NODE_ENV: "production" },
        setIntervalImpl(callback, delay) {
            cleanup = callback;
            intervalMs = delay;
            return { unref() {} };
        },
    });

    assert.equal(intervalMs, 5 * 60 * 1000);
    await cleanup();
    assert.equal(queryCount, 1);
});
