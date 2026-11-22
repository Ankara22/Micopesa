const { test } = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../src/db/database");
const auditLog = require("../src/utils/auditLog");
const notifications = require("../src/services/notificationEventService");

const originalConnect = pool.connect;
const originalWriteAuditLog = auditLog.writeAuditLog;
const originalEnqueue = notifications.enqueueBusinessNotification;
let decideWorkerApplication;

test.after(() => {
    pool.connect = originalConnect;
    auditLog.writeAuditLog = originalWriteAuditLog;
    notifications.enqueueBusinessNotification = originalEnqueue;
});

function createResponse() {
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

test("administrator worker approval records a review, invalidates the worker session and queues its outcome", async () => {
    const calls = [];
    const auditEntries = [];
    const queuedNotifications = [];
    const workerId = "ABCDEF1234567890ABCDEF123";
    const adminId = "FEDCBA0987654321FEDCBA098";
    const client = {
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
                return { rows: [] };
            }
            if (sql.includes("SELECT user_id, role, account_status, approval_status")) {
                return {
                    rows: [{
                        user_id: workerId,
                        role: "WORKER",
                        account_status: "ACTIVE",
                        approval_status: "PENDING",
                    }],
                };
            }
            if (sql.includes("UPDATE users") && sql.includes("auth_version = auth_version + 1")) {
                return { rows: [{ user_id: workerId, approval_status: "APPROVED" }] };
            }
            if (sql.includes("INSERT INTO worker_approval_reviews")) {
                return { rows: [{ review_id: 17 }] };
            }
            return { rows: [], rowCount: 1 };
        },
        release() {},
    };
    pool.connect = async () => client;
    auditLog.writeAuditLog = async (_client, entry) => auditEntries.push(entry);
    notifications.enqueueBusinessNotification = async (entry) => queuedNotifications.push(entry);
    decideWorkerApplication ??= require("../src/controllers/workerApprovalController")
        .decideWorkerApplication;

    const response = createResponse();
    await decideWorkerApplication({
        params: { userId: workerId },
        body: { decision: "APPROVED", reason: "Identity and eligibility verified." },
        user: { userId: adminId },
    }, response);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data.approval_status, "APPROVED");
    assert.ok(calls.some(({ sql }) =>
        sql.includes("auth_version = auth_version + 1")
    ));
    assert.ok(calls.some(({ sql }) => sql === "COMMIT"));
    assert.equal(auditEntries[0].entityName, "WORKER_APPROVAL");
    assert.equal(auditEntries[0].details.decision, "APPROVED");
    assert.deepEqual(queuedNotifications, [{
        userId: workerId,
        eventType: "WORKER_APPROVED",
        referenceId: "17",
    }]);
});

test("worker approval rejects malformed decisions and short reasons without opening a transaction", async () => {
    let connected = false;
    pool.connect = async () => {
        connected = true;
        throw new Error("A transaction must not be opened.");
    };
    const response = createResponse();

    await decideWorkerApplication({
        params: { userId: "ABCDEF1234567890ABCDEF123" },
        body: { decision: "APPROVED", reason: "No" },
        user: { userId: "FEDCBA0987654321FEDCBA098" },
    }, response);

    assert.equal(response.statusCode, 400);
    assert.equal(connected, false);
});
