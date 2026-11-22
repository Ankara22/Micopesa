const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createSmsDeliveryDispatcher,
    isEmailDispatcherEnabled,
    isSmsDispatcherEnabled,
    retryDelayMs,
} = require("../src/services/smsDeliveryDispatcher");

function copy(value) {
    return JSON.parse(JSON.stringify(value));
}

const productionEnvironment = {
    NODE_ENV: "production",
    AT_ENVIRONMENT: "production",
    SMS_DISPATCHER_ENABLED: "true",
    AT_USERNAME: "micopesa-production",
    AT_API_KEY: "mock-key",
};

function createHarness({
    sendSms = async () => ({ accepted: true, status: "PROVIDER_ACCEPTED", messageId: "provider-1" }),
    sendEmail = async () => ({ accepted: true, status: "PROVIDER_ACCEPTED", messageId: "email-1" }),
    claimEligible = true,
    environment = productionEnvironment,
    notifications = [{
        notification_id: "notification_001",
        notification_type: "SMS",
        recipient_phone: "0712345678",
        message: "MicoPesa contribution received",
        delivery_status: "PENDING",
        attempt_count: 0,
    }],
    maxAttempts = 4,
} = {}) {
    const state = {
        notifications: copy(notifications),
        claimCalls: 0,
        claimChannels: [],
        commits: 0,
        persistCalls: [],
    };
    const repository = {
        async claimBatch(batchSize, channels) {
            state.claimCalls += 1;
            state.claimChannels.push([...channels]);
            const claimed = state.notifications
                .filter((item) =>
                    channels.includes(item.notification_type) &&
                    item.delivery_status === "PENDING"
                )
                .slice(0, batchSize);
            for (const item of claimed) {
                item.delivery_status = "PROCESSING";
                item.claim_token = `claim-${state.commits}-${item.notification_id}`;
                item.attempt_count += 1;
            }
            state.commits += 1;
            return copy(claimed);
        },
        async isClaimEligible() { return claimEligible; },
        async markProviderAccepted(notification, { messageId }) {
            state.persistCalls.push(["accepted", notification.notification_id, messageId]);
            const item = state.notifications.find((row) => row.notification_id === notification.notification_id);
            item.delivery_status = "PROVIDER_ACCEPTED";
            item.provider_message_id = messageId;
        },
        async markFailed(notification, code) {
            state.persistCalls.push(["failed", notification.notification_id, code]);
            state.notifications.find((row) => row.notification_id === notification.notification_id)
                .delivery_status = "FAILED";
        },
        async retryRejected(notification, { errorCode, delayMs }) {
            state.persistCalls.push(["retry", notification.notification_id, errorCode, delayMs]);
            const item = state.notifications.find((row) => row.notification_id === notification.notification_id);
            item.delivery_status = item.attempt_count >= maxAttempts ? "FAILED" : "PENDING";
            item.next_attempt_at = Date.now() + delayMs;
            item.last_error_code = errorCode;
        },
        async markUnknown(notification, code) {
            state.persistCalls.push(["unknown", notification.notification_id, code]);
            state.notifications.find((row) => row.notification_id === notification.notification_id)
                .delivery_status = "UNKNOWN";
        },
    };
    const dispatcher = createSmsDeliveryDispatcher({
        repository,
        sendSms,
        sendEmail,
        environment,
        logger: { error() {} },
    });
    return { dispatcher, state };
}

test("claims before sending and persists provider acceptance and message ID", async () => {
    let accepted;
    const { dispatcher, state } = createHarness({
        sendSms: async () => {
            accepted = state.commits === 1;
            return { accepted: true, status: "PROVIDER_ACCEPTED", messageId: "provider-1" };
        },
    });

    assert.equal(await dispatcher.runOnce(), 1);
    assert.equal(accepted, true);
    assert.equal(state.notifications[0].delivery_status, "PROVIDER_ACCEPTED");
    assert.equal(state.notifications[0].provider_message_id, "provider-1");
    assert.equal(state.notifications[0].delivered_at, undefined);
});

test("stale or unverified recipient claims are failed without provider dispatch", async () => {
    let sends = 0;
    const { dispatcher, state } = createHarness({
        claimEligible: false,
        sendSms: async () => {
            sends += 1;
            return { accepted: true, status: "PROVIDER_ACCEPTED" };
        },
    });

    await dispatcher.runOnce();

    assert.equal(sends, 0);
    assert.equal(state.notifications[0].delivery_status, "FAILED");
    assert.deepEqual(state.persistCalls, [
        ["failed", "notification_001", "NOTIFICATION_RECIPIENT_STALE"],
    ]);
});

test("development self-test settings do not enable or claim the general SMS queue", async () => {
    const environment = {
        NODE_ENV: "development",
        SMS_DISPATCHER_ENABLED: "true",
        MOBILESASA_TEST_SMS_ENABLED: "true",
        MOBILESASA_SMS_ENABLED: "false",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };
    let claims = 0;
    const dispatcher = createSmsDeliveryDispatcher({
        repository: {
            async isClaimEligible() { return true; },
            async claimBatch() {
                claims += 1;
                return [{ notification_id: "already-queued", delivery_status: "PENDING" }];
            },
        },
        sendSms: async () => {
            throw new Error("The general dispatcher must not send in development.");
        },
        environment,
        logger: { error() {} },
    });

    assert.equal(isSmsDispatcherEnabled(environment), false);
    assert.equal(await dispatcher.runOnce(), 0);
    assert.equal(claims, 0);
});

test("disabled notification SMS does not start SMS-only polling despite broader dispatcher flags", async () => {
    const environment = {
        NODE_ENV: "production",
        NOTIFICATION_SMS_PROVIDER: "MOBILE_SASA",
        SMS_DISPATCHER_ENABLED: "true",
        MOBILESASA_NOTIFICATION_SMS_ENABLED: "false",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };
    const { dispatcher, state } = createHarness({ environment });

    assert.equal(dispatcher.enabled, false);
    assert.equal(dispatcher.start(), false);
    assert.equal(await dispatcher.runOnce(), 0);
    assert.equal(state.claimCalls, 0);
});

test("explicitly enabled notification SMS starts polling with only the SMS channel", async () => {
    const environment = {
        NODE_ENV: "production",
        NOTIFICATION_SMS_PROVIDER: "MOBILE_SASA",
        SMS_DISPATCHER_ENABLED: "true",
        MOBILESASA_NOTIFICATION_SMS_ENABLED: "true",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };
    let intervalCallback;
    const state = { claimCalls: 0, claimChannels: [] };
    const worker = createSmsDeliveryDispatcher({
        repository: {
            async claimBatch(batchSize, channels) {
                state.claimCalls += 1;
                state.claimChannels.push([...channels]);
                return [];
            },
        },
        sendSms: async () => ({ accepted: true, status: "PROVIDER_ACCEPTED" }),
        environment,
        logger: { error() {} },
        setIntervalImpl(callback) {
            intervalCallback = callback;
            return { unref() {} };
        },
        clearIntervalImpl() {},
    });

    assert.equal(worker.start(), true);
    await new Promise((resolve) => setImmediate(resolve));
    await worker.stop();

    assert.equal(typeof intervalCallback, "function");
    assert.equal(state.claimCalls, 1);
    assert.deepEqual(state.claimChannels, [["SMS"]]);
    assert.equal(worker.enabled, true);
});

test("email dispatch remains available when notification SMS is explicitly disabled", async () => {
    const environment = {
        NODE_ENV: "production",
        NOTIFICATION_DISPATCHER_ENABLED: "true",
        EMAIL_NOTIFICATIONS_ENABLED: "true",
        EMAIL_PROVIDER: "MOBILE_SASA",
        MOBILESASA_EMAIL_ENABLED: "true",
        MOBILE_SASA_EMAIL_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_EMAIL_FROM: "billing@example.test",
        NOTIFICATION_SMS_PROVIDER: "MOBILE_SASA",
        SMS_DISPATCHER_ENABLED: "true",
        MOBILESASA_NOTIFICATION_SMS_ENABLED: "false",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };
    let smsSends = 0;
    let emailSends = 0;
    const { dispatcher, state } = createHarness({
        environment,
        notifications: [{
            notification_id: "email_001",
            notification_type: "EMAIL",
            recipient_email: "worker@example.test",
            email_subject: "Contribution received",
            message: "Contribution received",
            delivery_status: "PENDING",
            attempt_count: 0,
        }],
        sendSms: async () => {
            smsSends += 1;
            return { accepted: true, status: "PROVIDER_ACCEPTED" };
        },
        sendEmail: async () => {
            emailSends += 1;
            return { accepted: true, status: "PROVIDER_ACCEPTED", messageId: "email-1" };
        },
    });

    await dispatcher.runOnce();

    assert.deepEqual(state.claimChannels, [["EMAIL"]]);
    assert.equal(smsSends, 0);
    assert.equal(emailSends, 1);
    assert.equal(state.notifications[0].delivery_status, "PROVIDER_ACCEPTED");
});

test("missing notification schema stops polling once without calling a provider", async () => {
    let intervalCallback;
    let clearedTimer;
    let claims = 0;
    let smsSends = 0;
    const logs = [];
    const timer = { unref() {} };
    const error = new Error("Notification delivery requires the event classification schema.");
    error.code = "NOTIFICATION_SCHEMA_MISMATCH";
    error.databaseCode = "42703";
    error.schemaObject = "notifications.notification_event_type";
    const worker = createSmsDeliveryDispatcher({
        repository: {
            async claimBatch() {
                claims += 1;
                throw error;
            },
        },
        sendSms: async () => {
            smsSends += 1;
            return { accepted: true, status: "PROVIDER_ACCEPTED" };
        },
        environment: productionEnvironment,
        logger: { error: (...args) => logs.push(args) },
        setIntervalImpl(callback) {
            intervalCallback = callback;
            return timer;
        },
        clearIntervalImpl(value) {
            clearedTimer = value;
        },
    });

    assert.equal(worker.start(), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(clearedTimer, timer);
    assert.equal(claims, 1);
    assert.equal(smsSends, 0);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][1].code, "NOTIFICATION_SCHEMA_MISMATCH");
    assert.equal(logs[0][1].databaseCode, "42703");
    assert.equal(logs[0][1].schemaObject, "notifications.notification_event_type");

    intervalCallback();
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(worker.runOnce(), { code: "NOTIFICATION_SCHEMA_MISMATCH" });
    assert.equal(claims, 1);
    assert.equal(logs.length, 1);
    await worker.stop();
});

test("passes the stable notification ID to the SMS provider for Mobile Sasa reconciliation", async () => {
    let request;
    const { dispatcher } = createHarness({
        sendSms: async (input) => {
            request = input;
            return { accepted: true, status: "PROVIDER_ACCEPTED", messageId: "provider-1" };
        },
    });

    await dispatcher.runOnce();

    assert.equal(request.trackingId, "notification_001");
});

test("concurrent dispatcher instances cannot issue duplicate sends", async () => {
    const state = { claimed: false, sends: 0 };
    const repository = {
        async isClaimEligible() { return true; },
        async claimBatch() {
            if (state.claimed) return [];
            state.claimed = true;
            return [{
                notification_id: "notification_001",
                notification_type: "SMS",
                recipient_phone: "+254712345678",
                message: "confirmation",
                claim_token: "claim-token",
                attempt_count: 1,
            }];
        },
        async markProviderAccepted() {},
        async markFailed() {},
        async markUnknown() {},
        async retryRejected() {},
    };
    const sendSms = async () => {
        state.sends += 1;
        return { accepted: true, status: "PROVIDER_ACCEPTED" };
    };
    const options = { repository, sendSms, environment: productionEnvironment, logger: { error() {} } };
    const first = createSmsDeliveryDispatcher(options);
    const second = createSmsDeliveryDispatcher(options);

    await Promise.all([first.runOnce(), second.runOnce()]);

    assert.equal(state.sends, 1);
});

test("definitive rejection fails permanently without retry", async () => {
    const error = new Error("Rejected");
    error.code = "SMS_PROVIDER_REJECTED";
    const { dispatcher, state } = createHarness({
        sendSms: async () => { throw error; },
    });

    await dispatcher.runOnce();

    assert.equal(state.notifications[0].delivery_status, "FAILED");
    assert.equal(state.persistCalls[0][0], "failed");
});

test("provider authentication failure is recorded as permanent and is not retried", async () => {
    const error = new Error("Authentication rejected");
    error.code = "SMS_PROVIDER_AUTH_FAILED";
    const { dispatcher, state } = createHarness({
        sendSms: async () => { throw error; },
    });

    await dispatcher.runOnce();

    assert.equal(state.notifications[0].delivery_status, "FAILED");
    assert.deepEqual(state.persistCalls[0], [
        "failed",
        "notification_001",
        "SMS_PROVIDER_AUTH_FAILED",
    ]);
});

test("explicit transient rejection uses exponential bounded retries", async () => {
    const error = new Error("Rate limited");
    error.code = "SMS_RETRYABLE_REJECTION";
    const { dispatcher, state } = createHarness({
        sendSms: async () => { throw error; },
    });

    await dispatcher.runOnce();

    assert.deepEqual(state.persistCalls[0], [
        "retry",
        "notification_001",
        "SMS_RETRYABLE_REJECTION",
        30000,
    ]);
    assert.equal(state.notifications[0].delivery_status, "PENDING");
    assert.equal(retryDelayMs(4), 240000);
    assert.equal(retryDelayMs(20), 900000);
});

test("SMS rejection does not prevent independent email delivery", async () => {
    const environment = {
        ...productionEnvironment,
        NOTIFICATION_DISPATCHER_ENABLED: "true",
        EMAIL_NOTIFICATIONS_ENABLED: "true",
        EMAIL_PROVIDER: "MOBILE_SASA",
        MOBILESASA_EMAIL_ENABLED: "true",
        MOBILE_SASA_EMAIL_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_EMAIL_FROM: "billing@example.test",
        NOTIFICATION_SMS_PROVIDER: "MOBILE_SASA",
        MOBILESASA_NOTIFICATION_SMS_ENABLED: "true",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };
    const notifications = [
        {
            notification_id: "sms_001",
            notification_type: "SMS",
            recipient_phone: "+254712345678",
            message: "Financial notice",
            delivery_status: "PENDING",
            attempt_count: 0,
        },
        {
            notification_id: "email_001",
            notification_type: "EMAIL",
            recipient_email: "worker@example.test",
            email_subject: "Financial notice",
            message: "Financial notice",
            delivery_status: "PENDING",
            attempt_count: 0,
        },
    ];
    const { dispatcher, state } = createHarness({
        environment,
        notifications,
        sendSms: async () => {
            throw Object.assign(new Error("Rate limited"), {
                code: "SMS_RETRYABLE_REJECTION",
            });
        },
    });

    await dispatcher.runOnce();

    assert.equal(state.notifications.find(({ notification_id }) =>
        notification_id === "sms_001").delivery_status, "PENDING");
    assert.equal(state.notifications.find(({ notification_id }) =>
        notification_id === "email_001").delivery_status, "PROVIDER_ACCEPTED");
    assert.deepEqual(state.persistCalls.map(([operation, id]) => [operation, id]).sort(), [
        ["accepted", "email_001"],
        ["retry", "sms_001"],
    ]);
});

test("temporary SMTP recipient rejection is retried with a bounded delay", async () => {
    const environment = {
        NODE_ENV: "production",
        NOTIFICATION_DISPATCHER_ENABLED: "true",
        EMAIL_NOTIFICATIONS_ENABLED: "true",
        EMAIL_PROVIDER: "MOBILE_SASA",
        MOBILESASA_EMAIL_ENABLED: "true",
        MOBILE_SASA_EMAIL_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_EMAIL_FROM: "billing@example.test",
    };
    const { dispatcher, state } = createHarness({
        environment,
        notifications: [{
            notification_id: "email_retry_001",
            notification_type: "EMAIL",
            recipient_email: "worker@example.test",
            email_subject: "Financial notice",
            message: "Financial notice",
            delivery_status: "PENDING",
            attempt_count: 0,
        }],
        sendEmail: async () => {
            throw Object.assign(new Error("Temporary SMTP rejection"), {
                code: "EMAIL_SMTP_DELIVERY_FAILED",
                responseCode: 450,
            });
        },
    });

    await dispatcher.runOnce();

    assert.equal(state.notifications[0].delivery_status, "PENDING");
    assert.deepEqual(state.persistCalls[0], [
        "retry",
        "email_retry_001",
        "EMAIL_RETRYABLE_REJECTION",
        30000,
    ]);
});

test("provider timeout becomes UNKNOWN and is not resent after restart", async () => {
    let sends = 0;
    const sendSms = async () => {
        sends += 1;
        const error = new Error("Timed out");
        error.code = "SMS_TIMEOUT";
        throw error;
    };
    const first = createHarness({ sendSms });
    await first.dispatcher.runOnce();
    assert.equal(first.state.notifications[0].delivery_status, "UNKNOWN");

    const restarted = createHarness({
        sendSms,
        notifications: first.state.notifications,
    });
    await restarted.dispatcher.runOnce();

    assert.equal(sends, 1);
    assert.equal(restarted.state.claimCalls, 1);
});

test("email provider failures use canonical sanitized codes without retrying unknown outcomes", async () => {
    const environment = {
        NODE_ENV: "production",
        NOTIFICATION_DISPATCHER_ENABLED: "true",
        EMAIL_NOTIFICATIONS_ENABLED: "true",
        EMAIL_PROVIDER: "MOBILE_SASA",
        MOBILESASA_EMAIL_ENABLED: "true",
        MOBILE_SASA_EMAIL_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_EMAIL_FROM: "billing@example.test",
    };
    const cases = [
        { code: "EMAIL_TIMEOUT", expected: "EMAIL_PROVIDER_TIMEOUT", status: "UNKNOWN" },
        { code: "EMAIL_NETWORK_ERROR", expected: "EMAIL_NETWORK_ERROR", status: "UNKNOWN" },
        { code: "EMAIL_PROVIDER_AUTH_FAILED", expected: "EMAIL_PROVIDER_AUTH_FAILED", status: "FAILED" },
        { code: "EMAIL_PROVIDER_REJECTED", expected: "EMAIL_PROVIDER_REJECTED", status: "FAILED" },
        { code: "EMAIL_DEVELOPMENT_ALLOWLIST_EMPTY", expected: "EMAIL_DEVELOPMENT_ALLOWLIST_EMPTY", status: "FAILED" },
        { code: "EMAIL_INVALID_RESPONSE", expected: "EMAIL_UNKNOWN_OUTCOME", status: "UNKNOWN" },
    ];

    for (const testCase of cases) {
        const { dispatcher, state } = createHarness({
            environment,
            notifications: [{
                notification_id: `email_${testCase.expected}`,
                notification_type: "EMAIL",
                recipient_email: "worker@example.test",
                email_subject: "Contribution received",
                message: "Contribution received",
                delivery_status: "PENDING",
                attempt_count: 0,
            }],
            sendEmail: async () => {
                const error = new Error("provider failure");
                error.code = testCase.code;
                throw error;
            },
        });

        await dispatcher.runOnce();

        assert.equal(state.notifications[0].delivery_status, testCase.status);
        assert.deepEqual(state.persistCalls[0].slice(0, 3), [
            testCase.status === "FAILED" ? "failed" : "unknown",
            `email_${testCase.expected}`,
            testCase.expected,
        ]);
        assert.equal(state.persistCalls.some(([operation]) => operation === "retry"), false);
    }
});

test("accepted notifications are not retried while awaiting delivery reports", async () => {
    let sends = 0;
    const sendSms = async () => {
        sends += 1;
        return { accepted: true, status: "PROVIDER_ACCEPTED", messageId: "provider-1" };
    };
    const first = createHarness({ sendSms });

    await first.dispatcher.runOnce();
    const restarted = createHarness({
        sendSms,
        notifications: first.state.notifications,
    });
    await restarted.dispatcher.runOnce();

    assert.equal(first.state.notifications[0].delivery_status, "PROVIDER_ACCEPTED");
    assert.equal(sends, 1);
    assert.equal(restarted.state.claimCalls, 1);
    assert.equal(restarted.state.persistCalls.length, 0);
});

test("development, test, sandbox, or disabled configurations cannot dispatch", async () => {
    const invalidEnvironments = [
        { ...productionEnvironment, NODE_ENV: "development" },
        { ...productionEnvironment, NODE_ENV: "test" },
        { ...productionEnvironment, AT_ENVIRONMENT: "sandbox" },
        { ...productionEnvironment, AT_USERNAME: "sandbox" },
        { ...productionEnvironment, SMS_DISPATCHER_ENABLED: "false" },
        { ...productionEnvironment, AT_API_KEY: "" },
    ];

    for (const environment of invalidEnvironments) {
        assert.equal(isSmsDispatcherEnabled(environment), false);
        const { dispatcher, state } = createHarness({ environment });
        assert.equal(await dispatcher.runOnce(), 0);
        assert.equal(dispatcher.start(), false);
        assert.equal(state.claimCalls, 0);
    }
});

test("Mobile Sasa SMS dispatch requires explicit provider selection and complete production config", () => {
    const environment = {
        NODE_ENV: "production",
        NOTIFICATION_SMS_PROVIDER: "MOBILE_SASA",
        SMS_DISPATCHER_ENABLED: "true",
        MOBILESASA_NOTIFICATION_SMS_ENABLED: "true",
        MOBILESASA_SMS_ENABLED: "false",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };

    assert.equal(isSmsDispatcherEnabled(environment), true);
    assert.equal(isSmsDispatcherEnabled({
        ...environment,
        MOBILESASA_NOTIFICATION_SMS_ENABLED: "false",
    }), false);
    assert.equal(isSmsDispatcherEnabled({ ...environment, MOBILE_SASA_SMS_API_TOKEN: "legacy-token" }), false);
    assert.equal(isSmsDispatcherEnabled({ ...environment, MOBILE_SASA_SMS_SENDER_ID: "" }), false);
    assert.equal(isSmsDispatcherEnabled({ ...environment, NOTIFICATION_SMS_PROVIDER: "UNKNOWN" }), false);
});

test("Mobile Sasa email dispatch is opt-in and requires its scoped token and verified-domain sender", () => {
    const environment = {
        NODE_ENV: "production",
        NOTIFICATION_DISPATCHER_ENABLED: "true",
        EMAIL_NOTIFICATIONS_ENABLED: "true",
        EMAIL_PROVIDER: "MOBILE_SASA",
        MOBILESASA_EMAIL_ENABLED: "true",
        MOBILE_SASA_EMAIL_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_EMAIL_FROM: "billing@example.test",
    };

    assert.equal(isEmailDispatcherEnabled(environment), true);
    assert.equal(isEmailDispatcherEnabled({ ...environment, MOBILESASA_EMAIL_ENABLED: "false" }), false);
    assert.equal(isEmailDispatcherEnabled({ ...environment, MOBILE_SASA_EMAIL_FROM: "" }), false);
    assert.equal(isEmailDispatcherEnabled({ ...environment, MOBILE_SASA_EMAIL_API_TOKEN: "legacy-token" }), false);
});

test("enabled worker starts polling and clears its timer on shutdown", async () => {
    let intervalCallback;
    let clearedTimer;
    const timer = { unref() {} };
    const worker = createSmsDeliveryDispatcher({
        repository: {
            async claimBatch() { return []; },
        },
        sendSms: async () => ({ accepted: true, status: "PROVIDER_ACCEPTED" }),
        environment: productionEnvironment,
        logger: { error() {} },
        setIntervalImpl(callback) {
            intervalCallback = callback;
            return timer;
        },
        clearIntervalImpl(value) {
            clearedTimer = value;
        },
    });

    assert.equal(worker.start(), true);
    await new Promise((resolve) => setImmediate(resolve));
    await worker.stop();

    assert.equal(typeof intervalCallback, "function");
    assert.equal(clearedTimer, timer);
});

test("shutdown waits for the active dispatch before resolving", async () => {
    let releaseSend;
    let sendStarted;
    const started = new Promise((resolve) => { sendStarted = resolve; });
    const { dispatcher } = createHarness({
        sendSms: () => new Promise((resolve) => {
            releaseSend = resolve;
            sendStarted();
        }),
    });

    const run = dispatcher.runOnce();
    await started;
    let stopped = false;
    const stop = dispatcher.stop().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    releaseSend({ accepted: true, status: "PROVIDER_ACCEPTED", messageId: "provider-1" });
    await Promise.all([run, stop]);
    assert.equal(stopped, true);
});
