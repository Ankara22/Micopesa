const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { createSmsNotificationRepository } = require("../src/services/smsNotificationRepository");
const { createSmsDeliveryDispatcher } = require("../src/services/smsDeliveryDispatcher");
const { sendAdminEmail } = require("../src/services/adminEmailNotificationService");
const {
    createBusinessNotificationEnqueuer,
    createNotificationEventService,
    EVENT_MESSAGES,
    escapeHtml,
    renderTransactionalTemplate,
} = require("../src/services/notificationEventService");
const {
    ESSENTIAL_TRANSACTIONAL_EVENT_TYPES,
    NOTIFICATION_EVENT_POLICIES,
    isEssentialTransactionalNotification,
} = require("../src/services/notificationEventPolicy");

function withModuleMocks(mocks, callback) {
    const originalLoad = Module._load;
    Module._load = function loadWithMocks(request, parent, isMain) {
        let resolved;
        try {
            resolved = Module._resolveFilename(request, parent, isMain);
        } catch {
            resolved = null;
        }
        if (resolved && Object.prototype.hasOwnProperty.call(mocks, resolved)) {
            return mocks[resolved];
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        return callback();
    } finally {
        Module._load = originalLoad;
    }
}

const databasePath = require.resolve("../src/db/database");
const controllerPath = require.resolve("../src/controllers/notificationController");
const mockDatabase = { async query() { throw new Error("Unexpected database access"); } };
const mockMobileSasa = {
    isSmsConfigured: () => false,
    isTestSmsConfigured: () => false,
    sendSms: async () => assert.fail("Unexpected SMS provider call"),
    sendEmail: async () => assert.fail("Unexpected email provider call"),
    sendTestSms: async () => assert.fail("Unexpected SMS provider call"),
};
const mockPushModule = {
    createWebPushService: () => ({ getPublicKey: () => "unused" }),
    validatePushEndpoint: () => false,
};
const mockNotificationRepository = { createNotificationRepository: () => ({}) };
const { createNotificationController } = withModuleMocks({
    [databasePath]: mockDatabase,
    [require.resolve("../src/services/mobileSasaService")]: mockMobileSasa,
    [require.resolve("../src/services/webPushService")]: mockPushModule,
    [require.resolve("../src/services/notificationRepository")]: mockNotificationRepository,
}, () => require(controllerPath));

function createPool({
    recipient = {
        phone: "0712345678",
        phone_verified_at: "2026-01-01T00:00:00Z",
        email: "worker@example.test",
        email_verified: true,
        sms_enabled: true,
        email_enabled: true,
    },
    recipientByUser = null,
    preferences = { sms_enabled: false, email_enabled: false },
    failChannel = null,
} = {}) {
    const calls = [];
    const records = [];
    let preferenceState = preferences ? { ...preferences } : null;
    function queueRecord(values) {
        const key = `${values[0]}:${values[1]}:${values[7]}`;
        if (records.some((record) => record.key === key)) {
            return { rows: [], rowCount: 0 };
        }
        records.push({
            key,
            userId: values[0],
            channel: values[1],
            text: values[2],
            phone: values[3],
            email: values[4],
            subject: values[5],
            html: values[6],
            eventKey: values[7],
            eventType: values[8],
        });
        return { rows: [{ notification_id: `notification-${records.length}` }], rowCount: 1 };
    }
    const client = {
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
            if (sql.includes("INSERT INTO notifications")) {
                if (values[1] === failChannel) throw Object.assign(new Error("mock insert failure"), { code: "XX000" });
                return queueRecord(values);
            }
            if (sql.includes("INSERT INTO notification_preferences")) {
                preferenceState = {
                    sms_enabled: values[1] === null ? preferenceState?.sms_enabled ?? false : values[1],
                    email_enabled: values[2] === null ? preferenceState?.email_enabled ?? false : values[2],
                };
                return { rows: [{ ...preferenceState }] };
            }
            if (sql.includes("FROM users u")) {
                return {
                    rows: [{
                        ...preferenceState,
                        phone_registered: Boolean(recipient.phone),
                        phone_verified: Boolean(recipient.phone_verified_at),
                        email_registered: Boolean(recipient.email || recipient.pending_email),
                        email_verified: recipient.email_verified === true && Boolean(recipient.email),
                        push_enabled: false,
                    }],
                };
            }
            if (sql.includes("UPDATE notifications")) return { rows: [], rowCount: 0 };
            assert.fail(`Unexpected mocked client SQL: ${sql}`);
        },
        release() {},
    };
    const pool = {
        async connect() { return client; },
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (sql.includes("EXISTS (") && sql.includes("push_subscriptions")) {
                return {
                    rows: [{
                        ...(preferenceState || { sms_enabled: false, email_enabled: false }),
                        phone_registered: Boolean(recipient.phone),
                        phone_verified: Boolean(recipient.phone_verified_at),
                        email_registered: Boolean(recipient.email || recipient.pending_email),
                        email_verified: recipient.email_verified === true && Boolean(recipient.email),
                        push_enabled: false,
                    }],
                };
            }
            if (sql.includes("FROM notification_preferences")) {
                return { rows: preferenceState ? [{ ...preferenceState }] : [] };
            }
            if (sql.includes("FROM users u")) {
                const selectedRecipient = recipientByUser
                    ? recipientByUser[values[0]]
                    : recipient;
                return { rows: selectedRecipient ? [{ ...selectedRecipient }] : [] };
            }
            assert.fail(`Unexpected mocked pool SQL: ${sql}`);
        },
    };
    return { pool, calls, records };
}

function response() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

test("event notifications keep in-app delivery and enqueue opted-in verified channels idempotently", async () => {
    const mock = createPool({
        preferences: { sms_enabled: true, email_enabled: true },
    });

    test("the central policy classifies every supported business event as essential and no unknown event", () => {
        assert.deepEqual(
            Object.keys(EVENT_MESSAGES).sort(),
            Object.keys(NOTIFICATION_EVENT_POLICIES).sort()
        );
        assert.deepEqual(
            [...ESSENTIAL_TRANSACTIONAL_EVENT_TYPES].sort(),
            Object.keys(EVENT_MESSAGES).sort()
        );
        for (const eventType of Object.keys(EVENT_MESSAGES)) {
            assert.equal(isEssentialTransactionalNotification(eventType), true);
        }
        assert.equal(isEssentialTransactionalNotification("UNSUPPORTED_EVENT"), false);
    });
    const service = createNotificationEventService(mock.pool);
    const event = {
        userId: "worker-1",
        eventType: "CONTRIBUTION_CONFIRMED",
        referenceId: "contribution-123",
    };

    const first = await service.enqueueEvent(event);
    const replay = await service.enqueueEvent(event);

    assert.deepEqual(first.channels, ["IN_APP", "SMS", "EMAIL"]);
    assert.equal(first.queued, 3);
    assert.equal(replay.queued, 0);
    assert.equal(mock.records.length, 3);
    assert.equal(mock.records.find((row) => row.channel === "SMS").phone, "+254712345678");
    const email = mock.records.find((row) => row.channel === "EMAIL");
    assert.equal(email.email, "worker@example.test");
    assert.equal(email.text.includes("KES"), false);
    assert.equal(email.html.includes("contribution-123"), false);
    assert.equal(email.eventType, "CONTRIBUTION_CONFIRMED");
    assert.equal(new Set(mock.records.map((row) => row.eventKey)).size, 1);
});

test("essential business events reach only verified channels when optional preferences are off", async () => {
    const mock = createPool({
        preferences: { sms_enabled: false, email_enabled: false },
        recipient: {
            phone: "0712345678",
            phone_verified_at: "2026-01-01T00:00:00Z",
            email: "worker@example.test",
            email_verified: true,
            sms_enabled: false,
            email_enabled: false,
        },
    });
    const service = createNotificationEventService(mock.pool);

    const result = await service.enqueueEvent({
        userId: "worker-1",
        eventType: "CONTRIBUTION_CONFIRMED",
        referenceId: "contribution-essential",
    });

    assert.deepEqual(result.channels, ["IN_APP", "SMS", "EMAIL"]);
    assert.equal(mock.records.length, 3);
    assert.ok(mock.records.every((record) =>
        record.eventType === "CONTRIBUTION_CONFIRMED"
    ));
    assert.deepEqual(
        mock.records.find((record) => record.channel === "SMS").phone,
        "+254712345678"
    );
    assert.equal(
        mock.records.find((record) => record.channel === "EMAIL").email,
        "worker@example.test"
    );
});

test("simulated contribution confirmations queue verified email but never queue SMS", async () => {
    const mock = createPool({
        preferences: { sms_enabled: true, email_enabled: true },
    });
    const service = createNotificationEventService(mock.pool);

    const result = await service.enqueueEvent({
        userId: "worker-1",
        eventType: "CONTRIBUTION_CONFIRMED",
        referenceId: "contribution-simulated",
        simulated: true,
    });

    assert.deepEqual(result, { queued: 2, channels: ["IN_APP", "EMAIL"] });
    assert.deepEqual(mock.records.map((record) => record.channel), ["IN_APP", "EMAIL"]);
    assert.equal(mock.records[0].text.includes("simulated"), true);
    assert.equal(mock.records[0].text.includes("No real money was transferred"), true);
    assert.equal(mock.records[1].subject, "Simulated contribution confirmed");
    assert.equal(mock.records[1].html.includes("No real money was transferred"), true);
});

test("simulated essential confirmation email bypasses optional opt-in only for verified email", async () => {
    const mock = createPool({
        preferences: { sms_enabled: false, email_enabled: false },
        recipient: {
            phone: "0712345678",
            phone_verified_at: "2026-01-01T00:00:00Z",
            email: "worker@example.test",
            email_verified: true,
            sms_enabled: false,
            email_enabled: false,
        },
    });
    const service = createNotificationEventService(mock.pool);

    const result = await service.enqueueEvent({
        userId: "worker-1",
        eventType: "CONTRIBUTION_CONFIRMED",
        referenceId: "contribution-simulated-opt-out",
        simulated: true,
    });

    assert.deepEqual(result.channels, ["IN_APP", "EMAIL"]);
    assert.equal(mock.records.length, 2);
    assert.equal(mock.records.some((record) => record.channel === "SMS"), false);
    assert.equal(mock.records.find((record) => record.channel === "EMAIL").email,
        "worker@example.test");
});

test("event notifications use the selected active profile across roles without notifying others", async () => {
    const profiles = [
        { userId: "worker-1", phone: "0700000001", email: "worker@example.test", role: "WORKER" },
        { userId: "manager-1", phone: "0700000002", email: "manager@example.test", role: "FUND_MANAGER" },
        { userId: "regulator-1", phone: "0700000003", email: "regulator@example.test", role: "REGULATOR" },
        { userId: "admin-1", phone: "0700000004", email: "admin@example.test", role: "ADMIN" },
        { userId: "unrelated-user", phone: "0700000005", email: "unrelated@example.test", role: "WORKER" },
    ];
    const mock = createPool({
        recipientByUser: Object.fromEntries(profiles.map((profile) => [
            profile.userId,
            {
                phone: profile.phone,
                phone_verified_at: "2026-01-01T00:00:00Z",
                email: profile.email,
                email_verified: true,
                sms_enabled: true,
                email_enabled: true,
                role: profile.role,
            },
        ])),
        preferences: { sms_enabled: true, email_enabled: true },
    });
    const service = createNotificationEventService(mock.pool);

    for (const profile of profiles.slice(0, 4)) {
        await service.enqueueEvent({
            userId: profile.userId,
            eventType: "KYC_VERIFIED",
            referenceId: `kyc-${profile.userId}`,
        });
    }

    assert.equal(mock.records.length, 12);
    for (const profile of profiles.slice(0, 4)) {
        const deliveries = mock.records.filter((record) => record.userId === profile.userId);
        assert.deepEqual(deliveries.map((record) => record.channel).sort(), [
            "EMAIL", "IN_APP", "SMS",
        ]);
        assert.equal(deliveries.find((record) => record.channel === "SMS").phone,
            `+254${profile.phone.slice(1)}`);
        assert.equal(deliveries.find((record) => record.channel === "EMAIL").email,
            profile.email);
    }
    assert.equal(mock.records.some((record) => record.userId === "unrelated-user"), false);
    assert.equal(mock.calls.some((call) =>
        call.sql.includes("FROM users u") && call.values[0] === "unrelated-user"
    ), false);
});

test("simulated contribution confirmation reaches mocked email transport without SMS", async () => {
    const mock = createPool({
        preferences: { sms_enabled: true, email_enabled: false },
        recipient: {
            phone: "0712345678",
            phone_verified_at: "2026-01-01T00:00:00Z",
            email: "worker@example.test",
            email_verified: true,
            sms_enabled: false,
            email_enabled: false,
        },
    });
    const eventService = createNotificationEventService(mock.pool);
    const event = {
        userId: "worker-1",
        eventType: "CONTRIBUTION_CONFIRMED",
        referenceId: "contribution-email-123",
        simulated: true,
    };
    const first = await eventService.enqueueEvent(event);
    const duplicate = await eventService.enqueueEvent(event);
    const queuedEmail = mock.records.find((row) => row.channel === "EMAIL");
    const notification = {
        notification_id: "email-notification-1",
        user_id: queuedEmail.userId,
        notification_type: "EMAIL",
        recipient_email: queuedEmail.email,
        email_subject: queuedEmail.subject,
        email_html_body: queuedEmail.html,
        message: queuedEmail.text,
        attempt_count: 1,
        claim_token: "claim-email-1",
    };
    let claimed = false;
    const persisted = [];
    const environment = {
        NODE_ENV: "production",
        NOTIFICATION_DISPATCHER_ENABLED: "true",
        EMAIL_NOTIFICATIONS_ENABLED: "true",
        GMAIL_USER: "sender@example.test",
        GMAIL_APP_PASSWORD: "abcdefghijklmnop",
    };
    const deliveries = [];
    const dispatcher = createSmsDeliveryDispatcher({
        repository: {
            async claimBatch() {
                if (claimed) return [];
                claimed = true;
                return [notification];
            },
            async isClaimEligible() { return true; },
            async markProviderAccepted(value, response) {
                persisted.push([value.notification_id, response.messageId]);
            },
            async markFailed(_value, code) { assert.fail(`Unexpected failure: ${code}`); },
            async markUnknown(_value, code) { assert.fail(`Unexpected unknown status: ${code}`); },
            async retryRejected(_value, options) { assert.fail(`Unexpected retry: ${options.errorCode}`); },
        },
        sendSms: async () => assert.fail("SMS was not opted in"),
        sendEmail: (message) => sendAdminEmail(message, {
            environment,
            emailService: {
                async sendEmail(payload) {
                    deliveries.push(payload);
                    return { messageId: "mock-email-acceptance" };
                },
            },
        }),
        environment,
        logger: { error() { assert.fail("Unexpected dispatcher error"); } },
    });

    await dispatcher.runOnce();
    await dispatcher.runOnce();

    assert.equal(first.queued, 2);
    assert.equal(duplicate.queued, 0);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].to, "worker@example.test");
    assert.equal(deliveries[0].text, queuedEmail.text);
    assert.match(deliveries[0].html, /Simulated contribution confirmed/);
    assert.match(deliveries[0].text, /No real money was transferred/);
    assert.equal(mock.records.some((row) => row.channel === "SMS"), false);
    assert.deepEqual(persisted, [["email-notification-1", "mock-email-acceptance"]]);
});

test("event channel enqueue is atomic when one queue insert fails", async () => {
    const mock = createPool({
        preferences: { sms_enabled: true, email_enabled: true },
        failChannel: "EMAIL",
    });
    const service = createNotificationEventService(mock.pool);

    await assert.rejects(() => service.enqueueEvent({
        userId: "worker-1",
        eventType: "CONTRIBUTION_CONFIRMED",
        referenceId: "contribution-124",
    }));
    assert.equal(mock.calls.some((call) => call.sql === "ROLLBACK"), true);
});

test("unverified contacts and disabled preferences cannot disable in-app events", async () => {
    const mock = createPool({
        preferences: { sms_enabled: false, email_enabled: false },
        recipient: {
            phone: "0712345678",
            phone_verified_at: null,
            email: "worker@example.test",
            email_verified: false,
            sms_enabled: false,
            email_enabled: false,
        },
    });
    const service = createNotificationEventService(mock.pool);
    const result = await service.enqueueEvent({
        userId: "worker-1",
        eventType: "KYC_VERIFIED",
        referenceId: "kyc-123",
    });

    assert.deepEqual(result, { queued: 1, channels: ["IN_APP"] });
    assert.equal(mock.records[0].channel, "IN_APP");
    assert.equal(mock.records[0].phone, null);
    assert.equal(mock.records[0].email, null);
});

test("preference reads default to explicit opt-out", async () => {
    const mock = createPool({ preferences: null });
    const service = createNotificationEventService(mock.pool);
    assert.deepEqual(await service.getPreferences("worker-1"), {
        sms_enabled: false,
        email_enabled: false,
        phone_registered: true,
        phone_verified: true,
        email_registered: true,
        email_verified: true,
        push_enabled: false,
    });
});

test("preference updates patch only the authenticated user's supplied channel fields", async () => {
    const mock = createPool({
        preferences: { sms_enabled: true, email_enabled: true },
    });
    const service = createNotificationEventService(mock.pool);
    const result = await service.updatePreferences("worker-1", { sms_enabled: false });

    assert.deepEqual(await service.getPreferences("worker-1"), result);
    assert.deepEqual(result, {
        sms_enabled: false,
        email_enabled: true,
        phone_registered: true,
        phone_verified: true,
        email_registered: true,
        email_verified: true,
        push_enabled: false,
    });
    assert.deepEqual(mock.calls.find((call) =>
        call.sql.includes("INSERT INTO notification_preferences")
    ).values, ["worker-1", false, null]);
    assert.deepEqual(mock.calls.find((call) =>
        call.sql.includes("UPDATE notifications")
    ).values, [
        "worker-1",
        ["SMS"],
        [
            "CONTRIBUTION_CONFIRMED",
            "KYC_VERIFIED",
            "KYC_REJECTED",
            "RETIREMENT_PLAN_SAVED",
        ],
    ]);
    assert.match(
        mock.calls.find((call) => call.sql.includes("UPDATE notifications")).sql,
        /notification_event_type IS NULL/
    );
});

test("delivery claims require explicit per-user SMS/email opt-in while push remains independent", async () => {
    let claimQuery;
    const client = {
        async query(sql) {
            if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
                return { rows: [] };
            }
            if (sql.includes("UPDATE notifications") && sql.includes("SET delivery_status = 'UNKNOWN'")) {
                return { rows: [], rowCount: 0 };
            }
            if (sql.includes("UPDATE notifications n") &&
                sql.includes("NOTIFICATION_RECIPIENT_STALE")) {
                return { rows: [], rowCount: 0 };
            }
            if (sql.includes("SELECT notification_id")) {
                claimQuery = sql;
                return { rows: [{ notification_id: "notification-1" }] };
            }
            if (sql.includes("UPDATE notifications") && sql.includes("RETURNING")) {
                return {
                    rows: [{
                        notification_id: "notification-1",
                        notification_type: "EMAIL",
                        email_html_body: "<p>Example</p>",
                        claim_token: "mock-claim-token",
                    }],
                };
            }
            assert.fail(`Unexpected mocked client SQL: ${sql}`);
        },
        release() {},
    };
    const repository = createSmsNotificationRepository({
        async connect() { return client; },
        async query() { assert.fail("Unexpected pool query"); },
    });

    const claimed = await repository.claimBatch(5, ["SMS", "EMAIL", "PUSH"]);

    assert.match(claimQuery, /notification_preferences np/);
    assert.match(claimQuery, /np\.sms_enabled IS TRUE/);
    assert.match(claimQuery, /np\.email_enabled IS TRUE/);
    assert.match(claimQuery, /OR notification_type = 'PUSH'/);
    assert.equal(claimed[0].email_html_body, "<p>Example</p>");
});

test("preference controller exposes only current-user boolean state and ignores supplied user IDs", async () => {
    const calls = [];
    const eventService = {
        async getPreferences(userId) {
            calls.push(["get", userId]);
            return { sms_enabled: false, email_enabled: true };
        },
        async updatePreferences(userId, input) {
            calls.push(["patch", userId, input]);
            return { sms_enabled: true, email_enabled: true };
        },
    };
    const controller = createNotificationController({
        repository: {},
        eventService,
        webPushService: { getPublicKey: () => "unused" },
        environment: { NODE_ENV: "test" },
    });
    const req = {
        user: { userId: "worker-1" },
        params: { userId: "other-user" },
        query: { user_id: "other-user" },
        body: { user_id: "other-user", sms_enabled: true },
    };
    const getResponse = response();
    await controller.getMyNotificationPreferences(req, getResponse);
    const patchResponse = response();
    await controller.updateMyNotificationPreferences(req, patchResponse);

    assert.deepEqual(calls, [
        ["get", "worker-1"],
        ["patch", "worker-1", { user_id: "other-user", sms_enabled: true }],
    ]);
    assert.deepEqual(getResponse.body, {
        status: "success",
        data: {
            sms_enabled: false,
            email_enabled: true,
            sms_delivery_enabled: false,
            email_delivery_enabled: false,
            push_delivery_enabled: false,
        },
    });
    assert.deepEqual(patchResponse.body.data, {
        sms_enabled: true,
        email_enabled: true,
        sms_delivery_enabled: false,
        email_delivery_enabled: false,
        push_delivery_enabled: false,
    });
    assert.equal(JSON.stringify(getResponse.body).includes("worker@example.test"), false);
});

test("preference controller rejects extra fields instead of accepting user targeting", async () => {
    const controller = createNotificationController({
        repository: {},
        eventService: {
            getPreferences: async () => ({ sms_enabled: false, email_enabled: false }),
            updatePreferences: async (_userId, input) => {
                if (Object.keys(input).some((key) => !["sms_enabled", "email_enabled"].includes(key))) {
                    const error = new Error("Set SMS and/or email preferences to true or false.");
                    error.code = "NOTIFICATION_INVALID_PREFERENCES";
                    error.statusCode = 400;
                    throw error;
                }
            },
        },
        webPushService: { getPublicKey: () => "unused" },
    });
    const res = response();
    await controller.updateMyNotificationPreferences({
        user: { userId: "worker-1" },
        body: { user_id: "other-user" },
    }, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "NOTIFICATION_INVALID_PREFERENCES");
});

test("GET and PATCH /api/notifications/preferences are authenticated current-user routes", () => {
    const router = withModuleMocks({
        [databasePath]: mockDatabase,
    }, () => require("../src/routes/workerNotificationRoutes"));
    const getRoute = router.stack.find((layer) =>
        layer.route?.path === "/preferences" && layer.route.methods.get
    );
    const patchRoute = router.stack.find((layer) =>
        layer.route?.path === "/preferences" && layer.route.methods.patch
    );

    assert.ok(getRoute);
    assert.ok(patchRoute);
    assert.equal(getRoute.route.stack.length, 2);
    assert.equal(patchRoute.route.stack.length, 2);
    assert.equal(getRoute.route.stack[0].name, "requireAuth");
    assert.equal(patchRoute.route.stack[0].name, "requireAuth");
    assert.equal(typeof getRoute.route.stack[1].handle, "function");
    assert.equal(typeof patchRoute.route.stack[1].handle, "function");
});

test("transactional templates are concise, plain-text and HTML escaped without sensitive data", () => {
    const template = renderTransactionalTemplate("RETIREMENT_PLAN_SAVED");
    const approval = renderTransactionalTemplate("KYC_VERIFIED");
    const previousFrontendUrl = process.env.FRONTEND_BASE_URL;
    process.env.FRONTEND_BASE_URL = "https://micopesa.example.test";
    const rejection = renderTransactionalTemplate("KYC_REJECTED");
    if (previousFrontendUrl === undefined) delete process.env.FRONTEND_BASE_URL;
    else process.env.FRONTEND_BASE_URL = previousFrontendUrl;
    assert.equal(template.subject, "Retirement plan saved");
    assert.match(template.text, /retirement plan has been saved/);
    assert.match(template.html, /MicoPesa/);
    assert.equal(template.html.includes("plan_id"), false);
    assert.match(approval.text, /was approved/);
    assert.match(rejection.text, /was not approved/);
    assert.match(rejection.text, /https:\/\/micopesa\.example\.test\/worker\/profile#kyc-status/);
    assert.match(rejection.html, /href="https:\/\/micopesa\.example\.test\/worker\/profile#kyc-status"/);
    assert.match(rejection.text, /contact your fund administrator/);
    assert.equal(escapeHtml(`<script>&"'`), "&lt;script&gt;&amp;&quot;&#39;");
    assert.throws(() => renderTransactionalTemplate("UNSUPPORTED"));
});

test("business event enqueue failures are logged safely and do not propagate", async () => {
    const logs = [];
    const enqueue = createBusinessNotificationEnqueuer({
        async enqueueEvent() {
            throw Object.assign(new Error("worker@example.test should never be logged"), {
                code: "DB_ERROR",
            });
        },
    }, {
        error(...args) { logs.push(args); },
    });
    const result = await enqueue({
        userId: "worker-1",
        eventType: "KYC_REJECTED",
        referenceId: "kyc-123",
    });

    assert.deepEqual(result, { queued: 0 });
    assert.deepEqual(logs, [["Business notification enqueue failed.", {
        code: "NOTIFICATION_ENQUEUE_FAILED",
    }]]);
    assert.equal(JSON.stringify(logs).includes("worker@example.test"), false);
});
