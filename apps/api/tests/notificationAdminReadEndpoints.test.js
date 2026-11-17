const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createNotificationController } = require("../src/controllers/notificationController");
const { createNotificationRepository } = require("../src/services/notificationRepository");

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
            return [{
                user_id: "worker-1",
                role: "WORKER",
                sms_recipient_allowed: true,
                email_recipient_allowed: false,
            }];
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
        data: [{
            user_id: "worker-1",
            role: "WORKER",
            sms_delivery_enabled: false,
            email_delivery_enabled: false,
            push_delivery_enabled: false,
        }],
    });

    const availability = createResponse();
    await controller.getExternalSmsAvailability({}, availability);
    assert.equal(availability.statusCode, 200);
    assert.deepEqual(availability.body, { status: "success", data: { enabled: false } });
    assert.deepEqual(calls, ["history", ["recipients", "synthetic"]]);
});

test("admin recipient diagnostics distinguish a missing provider opt-in without exposing credentials", async () => {
    const config = {
        NODE_ENV: "development",
        COMMUNICATIONS_DEV_DELIVERY_ENABLED: "true",
        COMMUNICATIONS_DEV_SMS_ENABLED: "true",
        COMMUNICATIONS_DEV_EMAIL_ENABLED: "true",
        TRANSACTIONAL_SMS_PROVIDER: "MOBILE_SASA",
        MOBILESASA_SMS_ENABLED: "false",
        MOBILESASA_TEST_SMS_ENABLED: "true",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_synthetic-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
        EMAIL_PROVIDER: "GMAIL",
        GMAIL_USER: "sender@example.test",
        GMAIL_APP_PASSWORD: "abcdefghijklmnop",
    };
    const controller = createController({
        async listRecipients() {
            return [{
                user_id: "worker-1",
                sms_enabled: false,
                email_enabled: true,
                push_subscription_count: 0,
                sms_recipient_allowed: true,
                email_recipient_allowed: false,
            }];
        },
    }, config);
    const recipients = createResponse();

    await controller.listRecipients({
        user: { role: "ADMIN" },
        query: {},
    }, recipients);

    const [diagnostic] = recipients.body.data;
    assert.equal(diagnostic.sms_delivery_enabled, false);
    assert.equal(diagnostic.sms_delivery_diagnostic.reason_code, "system_delivery_disabled");
    assert.deepEqual(diagnostic.sms_delivery_diagnostic.missing_variables, [
        "MOBILESASA_NOTIFICATION_SMS_ENABLED",
    ]);
    assert.deepEqual(diagnostic.sms_delivery_diagnostic.disabled_variables, []);
    assert.deepEqual(diagnostic.sms_delivery_diagnostic.invalid_variables, []);
    assert.equal(diagnostic.email_delivery_enabled, true);
    assert.equal(diagnostic.email_delivery_diagnostic.enabled, true);
    assert.equal(diagnostic.email_delivery_diagnostic.reason_code, null);
    assert.equal(diagnostic.email_delivery_diagnostic.provider, "GMAIL");
    assert.equal(diagnostic.sms_recipient_allowed, true);
    assert.equal(diagnostic.email_recipient_allowed, false);
    assert.deepEqual(diagnostic.email_delivery_diagnostic.missing_variables, []);
    assert.deepEqual(diagnostic.email_delivery_diagnostic.invalid_variables, []);
    assert.equal(diagnostic.push_delivery_enabled, false);
    assert.equal(JSON.stringify(diagnostic).includes("mbs_synthetic-token"), false);
    assert.equal(JSON.stringify(diagnostic).includes("abcdefghijklmnop"), false);
});

test("Admin operational notifications queue combined channels when optional preferences are off", async () => {
    const calls = [];
    const controller = createNotificationController({
        repository: {
            async queueRoleNotifications(input) {
                calls.push(input);
                return [
                    {
                        notification_id: "admin-email-1",
                        notification_type: "EMAIL",
                        delivery_status: "PENDING",
                    },
                    {
                        notification_id: "admin-sms-1",
                        notification_type: "SMS",
                        delivery_status: "PENDING",
                    },
                ];
            },
        },
        webPushService: { getPublicKey: () => null },
        environment: {
            NODE_ENV: "development",
            COMMUNICATIONS_DEV_DELIVERY_ENABLED: "true",
            COMMUNICATIONS_DEV_EMAIL_ENABLED: "true",
            COMMUNICATIONS_DEV_SMS_ENABLED: "true",
            MOBILESASA_NOTIFICATION_SMS_ENABLED: "true",
            TRANSACTIONAL_SMS_PROVIDER: "MOBILE_SASA",
            MOBILE_SASA_SMS_API_TOKEN: "mbs_synthetic-token",
            MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
            EMAIL_PROVIDER: "GMAIL",
            GMAIL_USER: "sender@example.test",
            GMAIL_APP_PASSWORD: "abcdefghijklmnop",
        },
    });
    const response = createResponse();

    await controller.createNotification({
        user: { userId: "admin-1", role: "ADMIN" },
        body: {
            user_id: "worker-1",
            channels: ["EMAIL", "SMS"],
            category: "ACCOUNT_SERVICE",
            message: "Official account service notice",
            subject: "Account service notice",
            request_id: "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5",
        },
    }, response);

    assert.equal(response.statusCode, 202);
    assert.deepEqual(calls, [{
        senderId: "admin-1",
        senderRole: "ADMIN",
        userId: "worker-1",
        userIds: undefined,
        channels: ["EMAIL", "SMS"],
        message: "Official account service notice",
        subject: "Account service notice",
        html: undefined,
        title: undefined,
        requestId: "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5",
        category: "ACCOUNT_SERVICE",
        fundId: null,
    }]);
    assert.deepEqual(response.body.data.notifications.map(({ notification_type }) =>
        notification_type
    ).sort(), ["EMAIL", "SMS"]);
});

test("admin email diagnostics distinguish intentionally disabled development switches", async () => {
    const controller = createController({
        async listRecipients() {
            return [{ user_id: "worker-1", email_enabled: true }];
        },
    }, {
        NODE_ENV: "development",
        COMMUNICATIONS_DEV_DELIVERY_ENABLED: "false",
        COMMUNICATIONS_DEV_EMAIL_ENABLED: "false",
        EMAIL_PROVIDER: "GMAIL",
        GMAIL_USER: "sender@example.test",
        GMAIL_APP_PASSWORD: "abcdefghijklmnop",
    });
    const recipients = createResponse();

    await controller.listRecipients({
        user: { role: "ADMIN" },
        query: {},
    }, recipients);

    const [diagnostic] = recipients.body.data;
    assert.equal(diagnostic.email_delivery_enabled, false);
    assert.equal(diagnostic.email_delivery_diagnostic.reason_code, "system_delivery_disabled");
    assert.deepEqual(diagnostic.email_delivery_diagnostic.disabled_variables, [
        "COMMUNICATIONS_DEV_DELIVERY_ENABLED",
        "COMMUNICATIONS_DEV_EMAIL_ENABLED",
    ]);
    assert.deepEqual(diagnostic.email_delivery_diagnostic.invalid_variables, []);
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

test("recipient lookup reports development allowlist eligibility without returning contacts", async () => {
    let query;
    const repository = createNotificationRepository({
        async query(sql, params) {
            query = { sql, params };
            return {
                rows: [{
                    user_id: "worker-1",
                    full_name: "Worker One",
                    role: "WORKER",
                    delivery_phone: "+254712345678",
                    delivery_email: "blocked@example.test",
                    phone_registered: true,
                    phone_verified: false,
                    phone_available: false,
                    email_registered: true,
                    email_verified: false,
                    email_available: false,
                    sms_enabled: false,
                    email_enabled: true,
                    push_subscription_count: 0,
                }],
            };
        },
        async connect() {
            throw new Error("Recipient lookup must not open a write transaction.");
        },
    }, {
        environment: {
            NODE_ENV: "development",
            COMMUNICATIONS_DEV_ALLOWED_PHONES: "+254712345678",
            COMMUNICATIONS_DEV_ALLOWED_EMAILS: "allowed@example.test",
        },
    });

    const recipients = await repository.listRecipients("Worker");

    assert.match(query.sql, /LEFT JOIN notification_preferences np/);
    assert.match(query.sql, /COALESCE\(np\.sms_enabled, FALSE\) AS sms_enabled/);
    assert.match(query.sql, /COALESCE\(np\.email_enabled, FALSE\) AS email_enabled/);
    assert.ok(query.sql.includes("~ '^[+]254[17][0-9]{8}$'"));
    assert.ok(query.sql.includes("~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'"));
    assert.ok(query.sql.includes("COALESCE(u.email, u.pending_email)"));
    assert.equal(query.params[0], "%Worker%");
    assert.equal(recipients[0].phone_registered, true);
    assert.equal(recipients[0].phone_verified, false);
    assert.equal(recipients[0].sms_enabled, false);
    assert.equal(recipients[0].email_registered, true);
    assert.equal(recipients[0].email_verified, false);
    assert.equal(recipients[0].email_available, false);
    assert.equal(recipients[0].email_enabled, true);
    assert.equal(recipients[0].sms_recipient_allowed, true);
    assert.equal(recipients[0].email_recipient_allowed, false);
    assert.doesNotMatch(JSON.stringify(recipients), /0712345678|worker@example\.test/);
    assert.doesNotMatch(JSON.stringify(recipients), /blocked@example\.test|delivery_phone|delivery_email/);
});

test("admin notification history exposes event classification metadata", async () => {
    let query;
    const repository = createNotificationRepository({
        async query(sql) {
            query = sql;
            return { rows: [] };
        },
        async connect() {
            throw new Error("Reading notification history must not open a write transaction.");
        },
    });

    await repository.listAdminNotifications();

    assert.match(query, /n\.notification_event_type/);
});
