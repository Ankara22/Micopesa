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
        commits: 0,
        persistCalls: [],
    };
    const repository = {
        async claimBatch(batchSize) {
            state.claimCalls += 1;
            const claimed = state.notifications
                .filter((item) => item.delivery_status === "PENDING")
                .slice(0, batchSize);
            for (const item of claimed) {
                item.delivery_status = "PROCESSING";
                item.claim_token = `claim-${state.commits}-${item.notification_id}`;
                item.attempt_count += 1;
            }
            state.commits += 1;
            return copy(claimed);
        },
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

    assert.equal(await dispatcher.runOnce(), 1);
    assert.equal(accepted, true);
    assert.equal(state.notifications[0].delivery_status, "PROVIDER_ACCEPTED");
    assert.equal(state.notifications[0].provider_message_id, "provider-1");
    assert.equal(state.notifications[0].delivered_at, undefined);
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
        MOBILESASA_SMS_ENABLED: "true",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };

    assert.equal(isSmsDispatcherEnabled(environment), true);
    assert.equal(isSmsDispatcherEnabled({ ...environment, MOBILESASA_SMS_ENABLED: "false" }), false);
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
