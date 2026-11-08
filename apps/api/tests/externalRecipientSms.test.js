const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createNotificationController } = require("../src/controllers/notificationController");
const { createNotificationRepository } = require("../src/services/notificationRepository");
const { createSmsNotificationRepository } = require("../src/services/smsNotificationRepository");

const REQUEST_ID = "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5";

function createResponse() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

function createController({ environment, sendSms, schemaAvailable = true }) {
    const state = {
        notification: {
            notification_id: "EXTERNALSMS0000000000000001",
            notification_type: "SMS",
            delivery_status: "PENDING",
            recipient_phone: "+254712345678",
            message: "Demonstration message",
            delivery_result: null,
        },
        claimed: false,
        sends: 0,
    };
    const repository = {
        async isExternalSmsSchemaAvailable() { return schemaAvailable; },
        async queueExternalAdminSms(input) {
            assert.equal(input.adminId, "admin-1");
            state.notification.recipient_phone = input.recipientPhone;
            state.notification.message = input.message.trim();
            return { notification: state.notification, created: !state.claimed };
        },
        async claimExternalAdminSms() {
            if (state.claimed || state.notification.delivery_status !== "PENDING") return null;
            state.claimed = true;
            state.notification.delivery_status = "PROCESSING";
            return {
                notification_id: state.notification.notification_id,
                recipient_phone: state.notification.recipient_phone,
                message: state.notification.message,
                claim_token: "claim-token",
            };
        },
        async getExternalAdminSmsStatus() {
            return state.notification;
        },
        async markExternalAdminSmsAccepted(_claimed, result) {
            state.notification.delivery_status = "PROVIDER_ACCEPTED";
            state.notification.delivery_result = result.deliveryResult;
            return state.notification;
        },
        async markExternalAdminSmsFailed(_claimed, code) {
            state.notification.delivery_status = "FAILED";
            state.notification.last_error_code = code;
            return state.notification;
        },
        async markExternalAdminSmsUnknown(_claimed, code) {
            state.notification.delivery_status = "UNKNOWN";
            state.notification.last_error_code = code;
            return state.notification;
        },
    };
    const externalSmsService = {
        isSmsConfigured: () => true,
        async sendSms(request) {
            state.sends += 1;
            return sendSms(request);
        },
    };
    return {
        state,
        controller: createNotificationController({
            repository,
            webPushService: { getPublicKey: () => "public-key" },
            externalSmsService,
            environment,
        }),
    };
}

function enabledEnvironment(overrides = {}) {
    return {
        NODE_ENV: "production",
        MOBILESASA_EXTERNAL_RECIPIENTS_ENABLED: "true",
        MOBILESASA_SMS_ENABLED: "true",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_mock-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
        ...overrides,
    };
}

function requestBody(overrides = {}) {
    return {
        recipient_phone: "+254712345678",
        message: "Demonstration message",
        recipient_consented: true,
        confirmed: true,
        request_id: REQUEST_ID,
        ...overrides,
    };
}

function createExternalQueuePool({ recentCount = 0 } = {}) {
    const state = { notifications: [], auditEvents: [], locks: 0, statements: [] };
    const client = {
        async query(sql, params = []) {
            state.statements.push({ sql, params });
            if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
            if (sql.includes("pg_advisory_xact_lock")) {
                state.locks += 1;
                return { rows: [] };
            }
            if (sql.includes("user_id IS NULL") &&
                sql.includes("FOR UPDATE")) {
                return {
                    rows: state.notifications.filter((row) =>
                        row.created_by === params[0] && row.admin_request_key === params[1]
                    ),
                };
            }
            if (sql.includes("FROM users") && sql.includes("FOR SHARE")) {
                return { rows: [{ user_id: params[0] }] };
            }
            if (sql.includes("count(*)::integer AS request_count")) {
                return {
                    rows: [{
                        request_count: Math.max(recentCount, state.notifications.length),
                    }],
                };
            }
            if (sql.includes("INSERT INTO notifications")) {
                const row = {
                    notification_id: "EXTERNALSMS0000000000000001",
                    notification_type: "SMS",
                    delivery_status: "PENDING",
                    message: params[1],
                    recipient_phone: params[2],
                    created_by: params[0],
                    admin_request_key: params[3],
                    user_id: null,
                    created_at: new Date(),
                };
                state.notifications.push(row);
                return { rows: [row] };
            }
            if (sql.includes("INSERT INTO notification_audit_events")) {
                state.auditEvents.push(params);
                return { rows: [] };
            }
            throw new Error(`Unexpected mock SQL: ${sql}`);
        },
        release() {},
    };
    return {
        state,
        pool: {
            query: async () => ({ rows: [] }),
            async connect() { return client; },
        },
    };
}

test("external recipient SMS is disabled unless its explicit flag and production provider are enabled", async () => {
    let sends = 0;
    const { controller } = createController({
        environment: enabledEnvironment({ MOBILESASA_EXTERNAL_RECIPIENTS_ENABLED: "false" }),
        sendSms: async () => { sends += 1; },
    });
    const availability = createResponse();
    controller.getExternalSmsAvailability({}, availability);
    assert.equal(availability.body.data.enabled, false);

    const response = createResponse();
    await controller.sendExternalRecipientSms({
        user: { userId: "admin-1" },
        body: requestBody(),
    }, response);
    assert.equal(response.statusCode, 503);
    assert.equal(sends, 0);
});

test("external recipient SMS remains unavailable until its additive schema is present", async () => {
    let sends = 0;
    const { controller } = createController({
        environment: enabledEnvironment(),
        schemaAvailable: false,
        sendSms: async () => { sends += 1; },
    });
    const availability = createResponse();
    await controller.getExternalSmsAvailability({}, availability);
    assert.equal(availability.body.data.enabled, false);

    const response = createResponse();
    await controller.sendExternalRecipientSms({
        user: { userId: "admin-1" },
        body: requestBody(),
    }, response);
    assert.equal(response.statusCode, 503);
    assert.equal(sends, 0);
});

test("external SMS requires explicit send confirmation and recipient consent", async () => {
    let queued = 0;
    const { controller } = createController({
        environment: enabledEnvironment(),
        sendSms: async () => ({ accepted: true, status: "PROVIDER_ACCEPTED" }),
    });
    controller.queueExternalAdminSms = async () => { queued += 1; };
    const response = createResponse();
    await controller.sendExternalRecipientSms({
        user: { userId: "admin-1" },
        body: requestBody({ recipient_consented: false }),
    }, response);
    assert.equal(response.statusCode, 400);
    assert.equal(queued, 0);
});

test("provider acceptance is recorded accurately and duplicate confirmation does not resend", async () => {
    const { controller, state } = createController({
        environment: enabledEnvironment(),
        sendSms: async (request) => {
            assert.equal(request.to, "+254712345678");
            assert.equal(request.message, "Demonstration message");
            assert.equal(request.trackingId, state.notification.notification_id);
            return {
                accepted: true,
                status: "PROVIDER_ACCEPTED",
                messageId: "provider-ref-1",
                deliveryResult: { provider: "MOBILE_SASA" },
            };
        },
    });
    const request = {
        user: { userId: "admin-1", role: "ADMIN" },
        body: requestBody(),
    };
    const first = createResponse();
    await controller.sendExternalRecipientSms(request, first);
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.data.notification.delivery_status, "PROVIDER_ACCEPTED");

    const duplicate = createResponse();
    await controller.sendExternalRecipientSms(request, duplicate);
    assert.equal(duplicate.body.data.notification.delivery_status, "PROVIDER_ACCEPTED");
    assert.equal(state.sends, 1);
});

test("ambiguous Mobile Sasa outcome becomes UNKNOWN and is never automatically resent", async () => {
    const { controller, state } = createController({
        environment: enabledEnvironment(),
        sendSms: async () => {
            const error = new Error("ambiguous");
            error.code = "SMS_TIMEOUT";
            throw error;
        },
    });
    const request = {
        user: { userId: "admin-1", role: "ADMIN" },
        body: requestBody(),
    };
    const first = createResponse();
    await controller.sendExternalRecipientSms(request, first);
    assert.equal(first.body.data.notification.delivery_status, "UNKNOWN");

    const duplicate = createResponse();
    await controller.sendExternalRecipientSms(request, duplicate);
    assert.equal(duplicate.body.data.notification.delivery_status, "UNKNOWN");
    assert.equal(state.sends, 1);
});

test("external SMS repository validates a single E.164 recipient before opening a database connection", async () => {
    let connections = 0;
    const repository = createNotificationRepository({
        query: async () => ({ rows: [] }),
        async connect() {
            connections += 1;
            throw new Error("No database connection expected");
        },
    });
    await assert.rejects(repository.queueExternalAdminSms({
        adminId: "admin-1",
        recipientPhone: "0712345678",
        message: "Demonstration",
        requestId: REQUEST_ID,
        recipientConsented: true,
    }), { code: "INVALID_NOTIFICATION_INPUT", statusCode: 400 });
    await assert.rejects(repository.queueExternalAdminSms({
        adminId: "admin-1",
        recipientPhone: "+254712345678",
        message: "Demonstration",
        requestId: REQUEST_ID,
        recipientConsented: false,
    }), { code: "INVALID_NOTIFICATION_INPUT", statusCode: 400 });
    assert.equal(connections, 0);
});

test("external SMS repository stores an unregistered recipient, consent, idempotency, and rate-limit audit", async () => {
    const { state, pool } = createExternalQueuePool();
    const repository = createNotificationRepository(pool);
    const input = {
        adminId: "admin-1",
        recipientPhone: "+254712345678",
        message: " Demonstration message ",
        requestId: REQUEST_ID,
        recipientConsented: true,
    };

    const first = await repository.queueExternalAdminSms(input);
    const duplicate = await repository.queueExternalAdminSms(input);
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(first.notification.user_id, null);
    assert.equal(state.notifications.length, 1);
    assert.equal(state.auditEvents.length, 1);
    assert.ok(state.statements.some(({ sql }) =>
        sql.includes("user_id, created_by, notification_type") &&
        sql.includes("VALUES (") && sql.includes("NULL, $1")
    ));
    assert.ok(state.statements.every(({ sql }) => !/INSERT INTO users/i.test(sql)));
    assert.equal(state.locks, 2);

    const rateLimited = createExternalQueuePool({ recentCount: 1 });
    const limitedRepository = createNotificationRepository(rateLimited.pool);
    await assert.rejects(limitedRepository.queueExternalAdminSms({
        ...input,
        requestId: "5c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5",
    }), { code: "NOTIFICATION_RATE_LIMITED", statusCode: 429 });
    assert.equal(rateLimited.state.notifications.length, 0);
    assert.equal(rateLimited.state.auditEvents.length, 1);
});

test("general notification dispatcher excludes external-recipient SMS rows", async () => {
    const statements = [];
    const client = {
        async query(sql) {
            statements.push(sql);
            if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
                return { rows: [] };
            }
            if (sql.includes("SELECT notification_id")) return { rows: [] };
            return { rows: [], rowCount: 0 };
        },
        release() {},
    };
    const repository = createSmsNotificationRepository({
        async connect() { return client; },
    });
    await repository.claimBatch(10, ["SMS"]);
    assert.ok(statements.some((sql) =>
        sql.includes("delivery_status = 'PENDING'") &&
        sql.includes("user_id IS NOT NULL")
    ));
    assert.ok(statements.some((sql) =>
        sql.includes("delivery_status = 'PROCESSING'") &&
        sql.includes("user_id IS NOT NULL")
    ));
});
