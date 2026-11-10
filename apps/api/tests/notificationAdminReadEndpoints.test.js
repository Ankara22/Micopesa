const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createNotificationController } = require("../src/controllers/notificationController");

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

function createController(repository, environment = { NODE_ENV: "test" }) {
    return createNotificationController({
        repository,
        webPushService: { getPublicKey: () => null },
        environment,
        externalSmsService: { isSmsConfigured: () => false },
    });
}

test("Admin read endpoints return their documented response shapes without dispatching notifications", async () => {
    const calls = [];
    const controller = createController({
        async listAdminNotifications() {
            calls.push("history");
            return [{ notification_id: "notification-1", delivery_status: "PENDING" }];
        },
        async listRecipients(search) {
            calls.push(["recipients", search]);
            return [{ user_id: "worker-1", role: "WORKER" }];
        },
        async isExternalSmsSchemaAvailable() {
            calls.push("external-schema-check");
            throw new Error("Must not be queried outside production provider configuration.");
        },
    });

    const history = createResponse();
    await controller.listNotifications({}, history);
    assert.equal(history.statusCode, 200);
    assert.deepEqual(history.body, {
        status: "success",
        data: [{ notification_id: "notification-1", delivery_status: "PENDING" }],
    });

    const recipients = createResponse();
    await controller.listRecipients({ query: { search: "synthetic" } }, recipients);
    assert.equal(recipients.statusCode, 200);
    assert.deepEqual(recipients.body, {
        status: "success",
        data: [{ user_id: "worker-1", role: "WORKER" }],
    });

    const availability = createResponse();
    await controller.getExternalSmsAvailability({}, availability);
    assert.equal(availability.statusCode, 200);
    assert.deepEqual(availability.body, { status: "success", data: { enabled: false } });
    assert.deepEqual(calls, ["history", ["recipients", "synthetic"]]);
});

test("Admin read endpoint database errors return generic messages and log only sanitized error codes", async () => {
    const controller = createController({
        async listAdminNotifications() {
            const error = new Error("SQL parameters and private data");
            error.code = "42703";
            throw error;
        },
        async listRecipients() {
            const error = new Error("recipient search and private data");
            error.code = "42P01";
            throw error;
        },
    });
    const logged = [];
    const originalConsoleError = console.error;
    console.error = (...args) => logged.push(args);

    try {
        const history = createResponse();
        await controller.listNotifications({}, history);
        assert.equal(history.statusCode, 500);
        assert.deepEqual(history.body, {
            status: "error",
            message: "Could not retrieve notifications.",
        });

        const recipients = createResponse();
        await controller.listRecipients({ query: {} }, recipients);
        assert.equal(recipients.statusCode, 500);
        assert.deepEqual(recipients.body, {
            status: "error",
            message: "Could not retrieve notification recipients.",
        });
    } finally {
        console.error = originalConsoleError;
    }

    assert.deepEqual(logged, [
        ["Notification operation failed.", { code: "NOTIFICATION_OPERATION_FAILED" }],
        ["Notification operation failed.", { code: "NOTIFICATION_OPERATION_FAILED" }],
    ]);
    assert.doesNotMatch(JSON.stringify(logged), /SQL parameters|private data|recipient search/);
});
