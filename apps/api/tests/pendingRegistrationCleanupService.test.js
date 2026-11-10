const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    deleteExpiredPendingRegistrations,
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
