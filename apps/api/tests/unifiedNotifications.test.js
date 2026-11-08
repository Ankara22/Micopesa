const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const {
    createNotificationRepository,
} = require("../src/services/notificationRepository");
const {
    createNotificationController,
} = require("../src/controllers/notificationController");
const {
    createWebPushService,
} = require("../src/services/webPushService");
const {
    sendAdminEmail,
    sanitizeAdminEmailHtml,
} = require("../src/services/adminEmailNotificationService");
const {
    createSmsDeliveryDispatcher,
    isSmsDispatcherEnabled,
} = require("../src/services/smsDeliveryDispatcher");
const mobileSasaService = require("../src/services/mobileSasaService");

function createResponse() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

function createQueuePool() {
    const state = { records: [], auditEvents: 0 };
    const client = {
        async query(sql, params = []) {
            if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
                return { rows: [], rowCount: null };
            }
            if (sql.includes("FROM users")) {
                return {
                    rows: [{
                        user_id: "worker-1",
                        full_name: "Worker One",
                        phone: "0712345678",
                        email: "worker@example.test",
                        email_verified: true,
                        account_status: "ACTIVE",
                    }],
                };
            }
            if (sql.includes("INSERT INTO notifications")) {
                const [
                    userId,
                    createdBy,
                    type,
                    message,
                    phone,
                    email,
                    subject,
                    html,
                    title,
                    requestId,
                ] = params;
                const duplicate = state.records.some((row) =>
                    row.admin_request_key === requestId && row.notification_type === type
                );
                if (!duplicate) {
                    state.records.push({
                        notification_id: `notification-${state.records.length + 1}`,
                        user_id: userId,
                        created_by: createdBy,
                        notification_type: type,
                        message,
                        recipient_phone: phone,
                        recipient_email: email,
                        email_subject: subject,
                        email_html_body: html,
                        push_title: title,
                        admin_request_key: requestId,
                        delivery_status: "PENDING",
                    });
                    return { rows: [], rowCount: 1 };
                }
                return { rows: [], rowCount: 0 };
            }
            if (sql.includes("SELECT notification_id, user_id, created_by")) {
                return {
                    rows: state.records.filter((row) => row.admin_request_key === params[0]),
                };
            }
            if (sql.includes("INSERT INTO audit_logs")) {
                state.auditEvents += 1;
                return { rows: [], rowCount: 1 };
            }
            throw new Error(`Unexpected mocked SQL: ${sql}`);
        },
        release() {},
    };
    return {
        state,
        pool: {
            async connect() { return client; },
            async query() { throw new Error("Unexpected pool query"); },
        },
    };
}

function createTestSmsPool({ recentTests = () => 0 } = {}) {
    const state = { records: [], auditEvents: 0 };
    const client = {
        async query(sql, params = []) {
            if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
                return { rows: [], rowCount: null };
            }
            if (sql.includes("SELECT pg_advisory_xact_lock")) {
                return { rows: [], rowCount: null };
            }
            if (sql.includes("SELECT notification_id") && sql.includes("FOR UPDATE")) {
                return {
                    rows: state.records.filter((row) =>
                        row.admin_request_key === params[0] &&
                        row.user_id === params[1] &&
                        row.created_by === params[1] &&
                        row.notification_type === "SMS" &&
                        row.message === params[2]
                    ),
                };
            }
            if (sql.includes("count(*)::integer AS request_count")) {
                return { rows: [{ request_count: recentTests(state.records) }] };
            }
            if (sql.includes("FROM users") && sql.includes("FOR SHARE")) {
                return {
                    rows: [{
                        user_id: "admin-1",
                        full_name: "Admin One",
                        phone: "0712345678",
                        role: "ADMIN",
                        account_status: "ACTIVE",
                    }],
                };
            }
            if (sql.includes("INSERT INTO notifications")) {
                const [
                    userId, createdBy, type, message, phone, email,
                    subject, html, title, requestId, category,
                ] = params;
                const exists = state.records.some((row) =>
                    row.admin_request_key === requestId &&
                    row.user_id === userId &&
                    row.notification_type === type
                );
                if (exists) return { rows: [], rowCount: 0 };
                state.records.push({
                    notification_id: "test-sms-1",
                    user_id: userId,
                    created_by: createdBy,
                    notification_type: type,
                    message,
                    recipient_phone: phone,
                    recipient_email: email,
                    email_subject: subject,
                    email_html_body: html,
                    push_title: title,
                    admin_request_key: requestId,
                    notification_category: category,
                    scope_fund_id: null,
                    delivery_status: "PENDING",
                });
                return { rows: [], rowCount: 1 };
            }
            if (sql.includes("SELECT notification_id, user_id, created_by")) {
                return {
                    rows: state.records.filter((row) =>
                        row.admin_request_key === params[0] && row.user_id === params[1]
                    ),
                };
            }
            if (sql.includes("INSERT INTO notification_audit_events")) {
                state.auditEvents += 1;
                return { rows: [], rowCount: 1 };
            }
            if (sql.includes("INSERT INTO audit_logs")) {
                return { rows: [], rowCount: 1 };
            }
            throw new Error(`Unexpected mocked SQL: ${sql}`);
        },
        release() {},
    };
    return {
        state,
        pool: {
            async connect() { return client; },
            async query() { throw new Error("Unexpected pool query"); },
        },
    };
}

test("admin multi-channel notifications queue independently and exact retries do not duplicate audit events", async () => {
    const { pool, state } = createQueuePool();
    const repository = createNotificationRepository(pool);
    const input = {
        adminId: "admin-1",
        userId: "worker-1",
        channels: ["SMS", "EMAIL"],
        message: "Your savings update",
        subject: "MicoPesa update",
        html: "<p>Formatted update</p>",
        requestId: "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5",
        recipientEmail: "untrusted@example.test",
    };

    const first = await repository.queueAdminNotifications(input);
    const replay = await repository.queueAdminNotifications(input);

    assert.deepEqual(first.map((row) => row.notification_type), ["SMS", "EMAIL"]);
    assert.deepEqual(replay.map((row) => row.notification_id), first.map((row) => row.notification_id));
    assert.equal(state.records.length, 2);
    assert.equal(state.auditEvents, 1);
    assert.equal(state.records[1].recipient_email, "worker@example.test");
    assert.equal(state.records[1].email_html_body, "<p>Formatted update</p>");
});

test("admin test SMS is fixed to the authenticated admin, rate-limited, and idempotent", async () => {
    const { pool, state } = createTestSmsPool();
    const repository = createNotificationRepository(pool);
    const requestId = "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5";

    const first = await repository.queueAdminTestSms({ adminId: "admin-1", requestId });
    const replay = await repository.queueAdminTestSms({ adminId: "admin-1", requestId });

    assert.equal(first.length, 1);
    assert.equal(first[0].notification_type, "SMS");
    assert.equal(first[0].delivery_status, "PENDING");
    assert.equal(state.records[0].user_id, "admin-1");
    assert.equal(state.records[0].recipient_phone, "0712345678");
    assert.equal(
        state.records[0].message,
        "MicoPesa test notification: Your SMS notification service is working. This is a test message. No payment has been made."
    );
    assert.deepEqual(replay.map((row) => row.notification_id), ["test-sms-1"]);
    assert.equal(state.records.length, 1);
    assert.equal(state.auditEvents, 1);

    const limitedRepository = createNotificationRepository(createTestSmsPool({
        recentTests: () => 1,
    }).pool);
    await assert.rejects(() => limitedRepository.queueAdminTestSms({
        adminId: "admin-1",
        requestId: "3d1a5d19-8fd5-49e1-9049-00d872e24f32",
    }), { code: "NOTIFICATION_RATE_LIMITED", statusCode: 429 });
});

test("development test SMS claim targets only its confirmed record and never claims the general queue", async () => {
    let query;
    const repository = createNotificationRepository({
        async query(...args) {
            query = args;
            return {
                rows: [{
                    notification_id: "self-test-1",
                    recipient_phone: "0712345678",
                    message: "MicoPesa test notification: Your SMS notification service is working. This is a test message. No payment has been made.",
                    claim_token: args[1][0],
                }],
            };
        },
        async connect() {
            throw new Error("The isolated claim does not use a general queue batch.");
        },
    });

    const claimed = await repository.claimAdminTestSms({
        adminId: "admin-1",
        requestId: "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5",
    });
    assert.equal(claimed.notification_id, "self-test-1");
    assert.equal(claimed.recipient_phone, "0712345678");
    assert.match(query[0], /WHERE user_id = \$2/);
    assert.match(query[0], /created_by = \$2/);
    assert.match(query[0], /admin_request_key = \$3/);
    assert.match(query[0], /delivery_status = 'PENDING'/);
    assert.match(query[0], /notification_category = 'ACCOUNT_SERVICE'/);
    assert.deepEqual(query[1].slice(1), [
        "admin-1",
        "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5",
        "MicoPesa test notification: Your SMS notification service is working. This is a test message. No payment has been made.",
    ]);
});

test("admin test SMS controller keeps the existing production queue path", async () => {
    const calls = [];
    const config = {
        NODE_ENV: "production",
        SMS_DISPATCHER_ENABLED: "true",
        NOTIFICATION_SMS_PROVIDER: "MOBILE_SASA",
        MOBILESASA_SMS_ENABLED: "true",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MICO",
    };
    const repository = {
        async queueAdminTestSms(input) {
            calls.push(input);
            return [{
                notification_id: "test-sms-1",
                notification_type: "SMS",
                delivery_status: "PENDING",
            }];
        },
    };
    const controller = createNotificationController({
        repository,
        webPushService: { getPublicKey: () => "public-key" },
        environment: config,
    });
    const response = createResponse();

    await controller.sendAdminTestSms({
        user: { userId: "admin-1", role: "ADMIN" },
        body: {
            request_id: "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5",
            user_id: "other-user",
            confirmed: true,
        },
    }, response);
    assert.equal(response.statusCode, 202);
    assert.deepEqual(calls, [{
        adminId: "admin-1",
        requestId: "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5",
    }]);

    config.SMS_DISPATCHER_ENABLED = "false";
    await controller.sendAdminTestSms({
        user: { userId: "admin-1", role: "ADMIN" },
        body: { request_id: "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5", confirmed: true },
    }, response);
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, "NOTIFICATION_SMS_UNAVAILABLE");
    assert.equal(calls.length, 1);
});

test("development admin self-test dispatch is isolated, recipient-bound, and idempotent", async () => {
    const config = {
        NODE_ENV: "development",
        SMS_DISPATCHER_ENABLED: "true",
        MOBILESASA_TEST_SMS_ENABLED: "true",
        MOBILESASA_SMS_ENABLED: "false",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };
    const state = {
        notification: {
            notification_id: "test-sms-1",
            notification_type: "SMS",
            delivery_status: "PENDING",
            recipient_phone: "0712345678",
        },
        claims: 0,
        generalClaims: 0,
        sends: [],
    };
    const repository = {
        async claimBatch() {
            state.generalClaims += 1;
            throw new Error("The self-test must not touch the general notification queue.");
        },
        async queueAdminTestSms({ adminId, requestId }) {
            assert.equal(adminId, "admin-1");
            assert.equal(requestId, "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5");
            return [{ ...state.notification }];
        },
        async claimAdminTestSms({ adminId, requestId }) {
            state.claims += 1;
            assert.equal(adminId, "admin-1");
            assert.equal(requestId, "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5");
            if (state.notification.delivery_status !== "PENDING") return null;
            state.notification.delivery_status = "PROCESSING";
            return {
                notification_id: state.notification.notification_id,
                recipient_phone: state.notification.recipient_phone,
                claim_token: "claim-1",
            };
        },
        async markAdminTestSmsAccepted(_claim, result) {
            state.notification.delivery_status = "PROVIDER_ACCEPTED";
            state.notification.delivery_result = result.deliveryResult;
            return { ...state.notification };
        },
        async getAdminTestSmsStatus() {
            return { ...state.notification };
        },
    };
    const testSmsService = {
        isTestSmsConfigured: mobileSasaService.isTestSmsConfigured,
        async sendTestSms(input, options) {
            state.sends.push({ input, options });
            return {
                accepted: true,
                status: "PROVIDER_ACCEPTED",
                messageId: "provider-msg-1",
                deliveryResult: { provider: "MOBILE_SASA" },
            };
        },
    };
    const controller = createNotificationController({
        repository,
        webPushService: { getPublicKey: () => "public-key" },
        environment: config,
        testSmsService,
    });
    const invoke = async () => {
        const res = createResponse();
        await controller.sendAdminTestSms({
            user: { userId: "admin-1", role: "ADMIN" },
            body: {
                request_id: "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5",
                user_id: "attacker-selected-user",
                recipient_phone: "+254700000000",
                confirmed: true,
            },
        }, res);
        return res;
    };

    assert.equal(isSmsDispatcherEnabled(config), false);
    const first = await invoke();
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.data.notifications[0].delivery_status, "PROVIDER_ACCEPTED");
    assert.deepEqual(state.sends, [{
        input: {
            to: "0712345678",
            trackingId: "test-sms-1",
        },
        options: { environment: config },
    }]);

    const duplicate = await invoke();
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.body.data.notifications[0].delivery_status, "PROVIDER_ACCEPTED");
    assert.equal(state.sends.length, 1);
    assert.equal(state.claims, 2);
    assert.equal(state.generalClaims, 0);
});

test("development self-test rejects missing or unsafe Mobile Sasa configuration without queueing", async () => {
    const config = {
        NODE_ENV: "development",
        MOBILESASA_TEST_SMS_ENABLED: "true",
        MOBILESASA_SMS_ENABLED: "false",
        MOBILE_SASA_SMS_API_TOKEN: "",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };
    let queued = 0;
    let sends = 0;
    const controller = createNotificationController({
        repository: {
            async queueAdminTestSms() { queued += 1; return []; },
        },
        webPushService: { getPublicKey: () => "public-key" },
        environment: config,
        testSmsService: {
            isTestSmsConfigured: mobileSasaService.isTestSmsConfigured,
            async sendTestSms() { sends += 1; },
        },
    });
    const res = createResponse();
    await controller.sendAdminTestSms({
        user: { userId: "admin-1", role: "ADMIN" },
        body: { request_id: "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5", confirmed: true },
    }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, "NOTIFICATION_SMS_UNAVAILABLE");
    assert.equal(queued, 0);
    assert.equal(sends, 0);
});

test("self-test acceptance persistence failures are not reclassified as provider outcomes", async () => {
    let sends = 0;
    let unknownUpdates = 0;
    const controller = createNotificationController({
        repository: {
            async queueAdminTestSms() {
                return [{ notification_id: "test-1", delivery_status: "PENDING" }];
            },
            async claimAdminTestSms() {
                return {
                    notification_id: "test-1",
                    recipient_phone: "0712345678",
                    claim_token: "claim-1",
                };
            },
            async markAdminTestSmsAccepted() {
                throw new Error("Acceptance persistence failed.");
            },
            async markAdminTestSmsUnknown() {
                unknownUpdates += 1;
            },
        },
        webPushService: { getPublicKey: () => "public-key" },
        environment: {
            NODE_ENV: "development",
            MOBILESASA_TEST_SMS_ENABLED: "true",
            MOBILESASA_SMS_ENABLED: "false",
            MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
            MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
        },
        testSmsService: {
            isTestSmsConfigured: mobileSasaService.isTestSmsConfigured,
            async sendTestSms() {
                sends += 1;
                return { accepted: true, status: "PROVIDER_ACCEPTED" };
            },
        },
    });
    const res = createResponse();
    await controller.sendAdminTestSms({
        user: { userId: "admin-1", role: "ADMIN" },
        body: {
            request_id: "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5",
            confirmed: true,
        },
    }, res);

    assert.equal(sends, 1);
    assert.equal(unknownUpdates, 0);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, undefined);
});

test("admin self-test endpoint requires explicit confirmation", async () => {
    let queued = 0;
    const controller = createNotificationController({
        repository: {
            async queueAdminTestSms() { queued += 1; return []; },
        },
        webPushService: { getPublicKey: () => "public-key" },
        environment: {
            NODE_ENV: "development",
            MOBILESASA_TEST_SMS_ENABLED: "true",
            MOBILESASA_SMS_ENABLED: "false",
            MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
            MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
        },
    });
    const res = createResponse();
    await controller.sendAdminTestSms({
        user: { userId: "admin-1", role: "ADMIN" },
        body: { request_id: "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5" },
    }, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "NOTIFICATION_CONFIRMATION_REQUIRED");
    assert.equal(queued, 0);
});

test("ambiguous development provider outcome is stored as UNKNOWN and never resent on duplicate confirmation", async () => {
    const config = {
        NODE_ENV: "development",
        MOBILESASA_TEST_SMS_ENABLED: "true",
        MOBILESASA_SMS_ENABLED: "false",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };
    const state = { status: "PENDING", sends: 0 };
    const repository = {
        async queueAdminTestSms() {
            return [{
                notification_id: "ambiguous-test-1",
                notification_type: "SMS",
                delivery_status: state.status,
            }];
        },
        async claimAdminTestSms() {
            if (state.status !== "PENDING") return null;
            state.status = "PROCESSING";
            return {
                notification_id: "ambiguous-test-1",
                recipient_phone: "0712345678",
                claim_token: "claim-ambiguous",
            };
        },
        async markAdminTestSmsUnknown() {
            state.status = "UNKNOWN";
            return {
                notification_id: "ambiguous-test-1",
                notification_type: "SMS",
                delivery_status: state.status,
            };
        },
        async getAdminTestSmsStatus() {
            return {
                notification_id: "ambiguous-test-1",
                notification_type: "SMS",
                delivery_status: state.status,
            };
        },
    };
    const controller = createNotificationController({
        repository,
        webPushService: { getPublicKey: () => "public-key" },
        environment: config,
        testSmsService: {
            isTestSmsConfigured: mobileSasaService.isTestSmsConfigured,
            async sendTestSms() {
                state.sends += 1;
                const error = new Error("Ambiguous provider request");
                error.code = "SMS_TIMEOUT";
                throw error;
            },
        },
    });
    const invoke = async () => {
        const res = createResponse();
        await controller.sendAdminTestSms({
            user: { userId: "admin-1", role: "ADMIN" },
            body: { request_id: "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5", confirmed: true },
        }, res);
        return res;
    };

    const first = await invoke();
    assert.equal(first.body.data.notifications[0].delivery_status, "UNKNOWN");
    const replay = await invoke();
    assert.equal(replay.body.data.notifications[0].delivery_status, "UNKNOWN");
    assert.equal(state.sends, 1);
});

test("recipient search is parameterized, bounded, and returns all active account roles", async () => {
    let query;
    const repository = createNotificationRepository({
        async query(...args) {
            query = args;
            return { rows: [{ user_id: "manager-1", role: "FUND_MANAGER" }] };
        },
        async connect() { throw new Error("Not expected"); },
    });

    const recipients = await repository.listRecipients("A_%");
    assert.equal(recipients[0].role, "FUND_MANAGER");
    assert.deepEqual(query[1], ["%A\\_\\%%"]);
    assert.match(query[0], /LIMIT 100/);
    await assert.rejects(() => repository.listRecipients("x".repeat(101)), {
        code: "INVALID_NOTIFICATION_INPUT",
    });
});

test("push subscription removal is scoped to the authenticated user", async () => {
    let queryParameters;
    const repository = createNotificationRepository({
        query: async (_sql, params) => {
            queryParameters = params;
            return { rows: [] };
        },
        connect: async () => { throw new Error("Not expected"); },
    });

    assert.equal(await repository.deletePushSubscription("worker-1", "sub-1"), false);
    assert.deepEqual(queryParameters, ["sub-1", "worker-1"]);
});

test("push removal controller passes only the authenticated user's identity to the repository", async () => {
    const calls = [];
    const controller = createNotificationController({
        repository: {
            async deletePushSubscription(userId, subscriptionId) {
                calls.push([userId, subscriptionId]);
                return false;
            },
        },
        webPushService: { getPublicKey: () => "public-key" },
    });
    const response = {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };

    await controller.removePushSubscription({
        user: { userId: "worker-1" },
        params: { subscriptionId: "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5" },
    }, response);

    assert.deepEqual(calls, [["worker-1", "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5"]]);
    assert.equal(response.statusCode, 404);
});

test("push subscription registration validates browser keys and binds storage to the signed-in user", async () => {
    const saved = [];
    const controller = createNotificationController({
        repository: {
            async upsertPushSubscription(userId, subscription) {
                saved.push([userId, subscription]);
                return "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5";
            },
        },
        webPushService: { getPublicKey: () => "public-key" },
        environment: { NODE_ENV: "production" },
    });
    const response = {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
    const subscription = {
        endpoint: "https://fcm.googleapis.com/fcm/send/subscription",
        keys: { p256dh: "A".repeat(40), auth: "B".repeat(16) },
    };

    await controller.registerPushSubscription({
        user: { userId: "worker-1" },
        body: { subscription: { ...subscription, keys: { ...subscription.keys, p256dh: "short" } } },
    }, response);
    assert.equal(response.statusCode, 400);
    assert.equal(saved.length, 0);

    await controller.registerPushSubscription({
        user: { userId: "worker-1" },
        body: { subscription },
    }, response);
    assert.equal(response.statusCode, 201);
    assert.deepEqual(saved, [["worker-1", subscription]]);
});

test("notification composition route rejects non-admin roles", () => {
    const originalLoad = Module._load;
    let router;
    try {
        Module._load = function loadWithMockedDatabase(request, parent, isMain) {
            if (request === "../db/database" && parent?.filename.endsWith("authMiddleware.js")) {
                return { query: async () => ({ rows: [] }) };
            }
            return originalLoad.call(this, request, parent, isMain);
        };
        router = require("../src/routes/notificationRoutes");
    } finally {
        Module._load = originalLoad;
    }

    const postRoute = router.stack.find((layer) => layer.route?.path === "/").route;
    const requireAdmin = postRoute.stack[1].handle;
    const response = {
        statusCode: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
    let nextCalled = false;
    requireAdmin({ user: { role: "WORKER" } }, response, () => { nextCalled = true; });

    assert.equal(response.statusCode, 403);
    assert.equal(nextCalled, false);
});

test("email service reports only SMTP acceptance and rejects malformed addresses", async () => {
    const sent = [];
    const result = await sendAdminEmail({
        to: "worker@example.test",
        subject: "Savings update",
        text: "Your account has an update.",
        html: '<p>Hello <strong>there</strong><script>window.alert("x")</script><a href="javascript:alert(1)">unsafe</a></p>',
    }, {
        environment: {
            NODE_ENV: "production",
            EMAIL_NOTIFICATIONS_ENABLED: "true",
        },
        emailService: {
            async sendEmail(message) {
                sent.push(message);
                return { messageId: "smtp-message-1" };
            },
        },
    });

    assert.equal(result.status, "PROVIDER_ACCEPTED");
    assert.equal(result.accepted, true);
    assert.equal(sent[0].text, "Your account has an update.");
    assert.match(sent[0].html, /<strong>there<\/strong>/);
    assert.doesNotMatch(sent[0].html, /script|javascript:/i);
    assert.equal(
        sanitizeAdminEmailHtml('<img src=x onerror="alert(1)"><p>Safe</p>'),
        "<p>Safe</p>"
    );
    await assert.rejects(() => sendAdminEmail({
        to: "not-an-email",
        subject: "Subject",
        text: "Message",
    }, {
        environment: { NODE_ENV: "production", EMAIL_NOTIFICATIONS_ENABLED: "true" },
        emailService: { async sendEmail() { throw new Error("Must not send"); } },
    }), { code: "EMAIL_INVALID_INPUT" });
});

test("Mobile Sasa email is opt-in and reports provider acceptance without claiming delivery", async () => {
    const originalFetch = global.fetch;
    let request;
    global.fetch = async (url, options) => {
        request = { url, options, body: JSON.parse(options.body) };
        return {
            ok: true,
            status: 200,
            async json() {
                return {
                    success: true,
                    data: { accepted: 1, suppressed: 0, failed: 0 },
                };
            },
        };
    };
    try {
        const result = await sendAdminEmail({
            to: "worker@example.test",
            subject: "Savings update",
            text: "First line\nSecond <line>",
        }, {
            environment: {
                NODE_ENV: "production",
                EMAIL_NOTIFICATIONS_ENABLED: "true",
                EMAIL_PROVIDER: "MOBILE_SASA",
                MOBILESASA_EMAIL_ENABLED: "true",
                MOBILE_SASA_EMAIL_API_TOKEN: "mbs_test-token",
                MOBILE_SASA_EMAIL_FROM: "billing@example.test",
            },
        });

        assert.deepEqual(result, {
            accepted: true,
            status: "PROVIDER_ACCEPTED",
            messageId: null,
            deliveryResult: {
                provider: "MOBILE_SASA",
                accepted: 1,
                suppressed: 0,
                failed: 0,
            },
        });
        assert.equal(request.url, "https://api.mobilesasa.com/api/v1/email/send");
        assert.equal(request.options.headers.Authorization, "Bearer mbs_test-token");
        assert.deepEqual(request.body, {
            to: ["worker@example.test"],
            subject: "Savings update",
            text: "First line\nSecond <line>",
            html: "<p>First line<br>Second &lt;line&gt;</p>",
            from: "billing@example.test",
        });
    } finally {
        global.fetch = originalFetch;
    }
});

test("push sender records provider acceptance and removes expired subscriptions", async () => {
    const removed = [];
    let pushResponse = "accepted";
    const repository = {
        async listPushSubscriptions() {
            return [{
                subscription_id: "sub-1",
                endpoint: "https://fcm.googleapis.com/fcm/send/subscription",
                p256dh_key: "A".repeat(40),
                auth_key: "B".repeat(16),
            }];
        },
        async removePushSubscription(id) { removed.push(id); },
    };
    const webPushImpl = {
        setVapidDetails() {},
        async sendNotification() {
            if (pushResponse === "expired") {
                const error = new Error("Gone");
                error.statusCode = 410;
                throw error;
            }
        },
    };
    const service = createWebPushService({
        repository,
        webPushImpl,
        environment: {
            NODE_ENV: "production",
            WEB_PUSH_ENABLED: "true",
            WEB_PUSH_PUBLIC_KEY: "public",
            WEB_PUSH_PRIVATE_KEY: "private",
            WEB_PUSH_SUBJECT: "mailto:ops@example.test",
        },
    });

    assert.equal((await service.sendToUser({
        userId: "worker-1",
        title: "Account update",
        body: "A new update is available.",
    })).status, "PROVIDER_ACCEPTED");
    pushResponse = "expired";
    await assert.rejects(() => service.sendToUser({
        userId: "worker-1",
        title: "Account update",
        body: "A new update is available.",
    }), { code: "PUSH_PROVIDER_REJECTED" });
    assert.deepEqual(removed, ["sub-1"]);
});

test("email and push failures do not prevent another channel from succeeding", async () => {
    const rows = [
        { notification_id: "sms-1", notification_type: "SMS", delivery_status: "PENDING" },
        { notification_id: "email-1", notification_type: "EMAIL", delivery_status: "PENDING" },
        { notification_id: "push-1", notification_type: "PUSH", delivery_status: "PENDING" },
    ];
    const updates = [];
    const repository = {
        async claimBatch() { return rows; },
        async markProviderAccepted(row) { updates.push([row.notification_id, "PROVIDER_ACCEPTED"]); },
        async markFailed(row, code) { updates.push([row.notification_id, "FAILED", code]); },
        async markUnknown(row, code) { updates.push([row.notification_id, "UNKNOWN", code]); },
        async retryRejected(row, options) { updates.push([row.notification_id, "RETRY", options.errorCode]); },
    };
    const environment = {
        NODE_ENV: "production",
        AT_ENVIRONMENT: "production",
        SMS_DISPATCHER_ENABLED: "true",
        AT_USERNAME: "production",
        AT_API_KEY: "mock",
        NOTIFICATION_DISPATCHER_ENABLED: "true",
        EMAIL_NOTIFICATIONS_ENABLED: "true",
        GMAIL_USER: "sender@example.test",
        GMAIL_APP_PASSWORD: "mock",
        WEB_PUSH_ENABLED: "true",
        WEB_PUSH_PUBLIC_KEY: "public",
        WEB_PUSH_PRIVATE_KEY: "private",
        WEB_PUSH_SUBJECT: "mailto:ops@example.test",
    };
    const dispatcher = createSmsDeliveryDispatcher({
        repository,
        environment,
        sendSms: async () => ({ accepted: true, status: "PROVIDER_ACCEPTED" }),
        sendEmail: async () => {
            const error = new Error("SMTP recipient rejected");
            error.code = "EMAIL_SMTP_RECIPIENT_REJECTED";
            throw error;
        },
        sendPush: async () => ({ accepted: true, status: "PROVIDER_ACCEPTED" }),
        logger: { error() {} },
    });

    assert.equal(await dispatcher.runOnce(), 3);
    assert.deepEqual(updates.sort((left, right) => left[0].localeCompare(right[0])), [
        ["email-1", "FAILED", "EMAIL_SMTP_RECIPIENT_REJECTED"],
        ["push-1", "PROVIDER_ACCEPTED"],
        ["sms-1", "PROVIDER_ACCEPTED"],
    ]);
});

test("ambiguous SMTP outcomes remain UNKNOWN while push delivery continues", async () => {
    const updates = [];
    const dispatcher = createSmsDeliveryDispatcher({
        repository: {
            async claimBatch() {
                return [
                    {
                        notification_id: "email-unknown",
                        notification_type: "EMAIL",
                        recipient_email: "worker@example.test",
                        email_subject: "Update",
                        message: "Body",
                        attempt_count: 1,
                    },
                    {
                        notification_id: "push-accepted",
                        notification_type: "PUSH",
                        user_id: "worker-1",
                        message: "Body",
                        push_title: "Update",
                        attempt_count: 1,
                    },
                ];
            },
            async markProviderAccepted(row) {
                updates.push([row.notification_id, "PROVIDER_ACCEPTED"]);
            },
            async markFailed(row, code) {
                updates.push([row.notification_id, "FAILED", code]);
            },
            async markUnknown(row, code) {
                updates.push([row.notification_id, "UNKNOWN", code]);
            },
            async retryRejected(row, options) {
                updates.push([row.notification_id, "RETRY", options.errorCode]);
            },
        },
        environment: {
            NODE_ENV: "production",
            NOTIFICATION_DISPATCHER_ENABLED: "true",
            EMAIL_NOTIFICATIONS_ENABLED: "true",
            GMAIL_USER: "sender@example.test",
            GMAIL_APP_PASSWORD: "mock",
            WEB_PUSH_ENABLED: "true",
            WEB_PUSH_PUBLIC_KEY: "public",
            WEB_PUSH_PRIVATE_KEY: "private",
            WEB_PUSH_SUBJECT: "mailto:ops@example.test",
        },
        sendSms: async () => ({ accepted: true, status: "PROVIDER_ACCEPTED" }),
        sendEmail: async () => {
            const error = new Error("SMTP connection timed out");
            error.code = "EMAIL_SMTP_DELIVERY_FAILED";
            throw error;
        },
        sendPush: async () => ({ accepted: true, status: "PROVIDER_ACCEPTED" }),
        logger: { error() {} },
    });

    assert.equal(await dispatcher.runOnce(), 2);
    assert.deepEqual(updates.sort((left, right) => left[0].localeCompare(right[0])), [
        ["email-unknown", "UNKNOWN", "EMAIL_SMTP_DELIVERY_FAILED"],
        ["push-accepted", "PROVIDER_ACCEPTED"],
    ]);
});
