const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createMobileSasaDlrRepository,
    normalizeDeliveryReport,
} = require("../src/services/mobileSasaDlrRepository");
const VERIFIED_AT = new Date("2026-01-02T03:04:05.000Z");

function createPool({ notifications = [] } = {}) {
    const state = {
        inbox: [],
        notifications: notifications.map((row) => ({ ...row })),
        nextId: 1,
        commits: 0,
        rollbacks: 0,
        statements: [],
    };

    function query(sql, params = []) {
        const statement = sql.trim();
        state.statements.push(statement);
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) {
            if (statement === "COMMIT") state.commits += 1;
            if (statement === "ROLLBACK") state.rollbacks += 1;
            return { rows: [] };
        }
        if (statement.startsWith("INSERT INTO mobilesasa_sms_delivery_callbacks")) {
            const [
                providerMessageReference,
                trackingId,
                providerDispatchReference,
                deliveryStatus,
                deliveryDescription,
                deliveryCode,
                gateway,
                providerDeliveryTime,
                providerDeliveredAt,
                providerReportedAt,
                signatureVerifiedAt,
            ] = params;
            const existing = state.inbox.find((row) =>
                row.provider === "MOBILE_SASA" &&
                row.provider_message_reference === providerMessageReference &&
                row.delivery_status === deliveryStatus
            );
            if (existing) return { rows: [] };
            const row = {
                callback_id: state.nextId++,
                provider: "MOBILE_SASA",
                provider_message_reference: providerMessageReference,
                tracking_id: trackingId,
                provider_dispatch_reference: providerDispatchReference,
                delivery_status: deliveryStatus,
                delivery_description: deliveryDescription,
                delivery_code: deliveryCode,
                gateway,
                provider_delivery_time: providerDeliveryTime,
                provider_delivered_at: providerDeliveredAt,
                provider_reported_at: providerReportedAt,
                signature_verified_at: signatureVerifiedAt,
                received_at: new Date().toISOString(),
                processing_status: "UNMATCHED",
                notification_id: null,
                duplicate_count: 0,
                correlated_at: null,
                processed_at: null,
            };
            state.inbox.push(row);
            return { rows: [row] };
        }
        if (statement.startsWith("SELECT * FROM mobilesasa_sms_delivery_callbacks")) {
            const [providerMessageReference, deliveryStatus] = params;
            const row = state.inbox.find((item) =>
                item.provider_message_reference === providerMessageReference &&
                item.delivery_status === deliveryStatus
            );
            return { rows: row ? [row] : [] };
        }
        if (statement.startsWith("UPDATE mobilesasa_sms_delivery_callbacks") &&
            statement.includes("duplicate_count = duplicate_count + 1")) {
            const row = state.inbox.find((item) => item.callback_id === params[0]);
            row.duplicate_count += 1;
            return { rows: [] };
        }
        if (statement.startsWith("SELECT notification_id, delivery_status")) {
            const [providerMessageReference, trackingId, providerDispatchReference] = params;
            return {
                rows: state.notifications.filter((notification) =>
                    (providerMessageReference &&
                        notification.provider_message_id === providerMessageReference) ||
                    (trackingId && notification.notification_id === trackingId) ||
                    (trackingId && notification.delivery_result?.trackingId === trackingId) ||
                    (providerDispatchReference &&
                        notification.delivery_result?.providerDispatchReference === providerDispatchReference)
                ),
            };
        }
        if (statement.startsWith("UPDATE notifications")) {
            const [
                providerMessageReference,
                providerDeliveredAt,
                existingFinal,
                mappedStatus,
                deliveryStatus,
                deliveryResult,
                notificationId,
            ] = params;
            const row = state.notifications.find((item) => item.notification_id === notificationId);
            if (providerMessageReference) row.provider_message_id ||= providerMessageReference;
            if (!existingFinal) row.delivery_status = mappedStatus;
            if (!existingFinal && deliveryStatus === "DELIVERED") {
                row.delivered_at ||= providerDeliveredAt || null;
            }
            row.delivery_result = JSON.parse(deliveryResult);
            if (!existingFinal && ["FAILED", "REJECTED", "EXPIRED", "UNREACHABLE"].includes(deliveryStatus)) {
                row.last_error_code = "SMS_PROVIDER_REJECTED";
            } else if (!existingFinal && deliveryStatus === "DELIVERED") {
                row.last_error_code = null;
            }
            row.claimed_at = null;
            row.claim_token = null;
            return { rows: [], rowCount: 1 };
        }
        if (statement.startsWith("UPDATE mobilesasa_sms_delivery_callbacks") &&
            statement.includes("rejection_code = 'AMBIGUOUS_NOTIFICATION_MATCH'")) {
            const row = state.inbox.find((item) => item.callback_id === params[0]);
            row.processing_status = "REJECTED";
            row.rejection_code = "AMBIGUOUS_NOTIFICATION_MATCH";
            row.processed_at = new Date().toISOString();
            return { rows: [] };
        }
        if (statement.startsWith("UPDATE mobilesasa_sms_delivery_callbacks") &&
            statement.includes("rejection_code = 'PROVIDER_REFERENCE_CONFLICT'")) {
            const row = state.inbox.find((item) => item.callback_id === params[0]);
            row.processing_status = "REJECTED";
            row.notification_id = params[1];
            row.rejection_code = "PROVIDER_REFERENCE_CONFLICT";
            row.processed_at = new Date().toISOString();
            return { rows: [] };
        }
        if (statement.startsWith("UPDATE mobilesasa_sms_delivery_callbacks") &&
            statement.includes("SET notification_id = $2")) {
            const row = state.inbox.find((item) => item.callback_id === params[0]);
            row.notification_id = params[1];
            row.processing_status = params[2];
            row.correlated_at ||= new Date().toISOString();
            row.processed_at ||= new Date().toISOString();
            return { rows: [] };
        }
        if (statement.startsWith("SELECT *") &&
            statement.includes("WHERE processing_status = 'UNMATCHED'")) {
            return {
                rows: state.inbox.filter((row) => row.processing_status === "UNMATCHED")
                    .sort((a, b) => a.callback_id - b.callback_id)
                    .slice(0, params[0]),
            };
        }
        throw new Error(`Unexpected mocked SQL: ${statement}`);
    }

    return {
        state,
        async connect() {
            return {
                query: async (sql, params = []) => query(sql, params),
                release() {},
            };
        },
    };
}

function notification(overrides = {}) {
    return {
        notification_id: "notification-123",
        delivery_status: "PROVIDER_ACCEPTED",
        delivery_result: {
            provider: "MOBILE_SASA",
            trackingId: "notification-123",
            smsParts: 2,
        },
        provider_message_id: "message-123",
        provider_accepted_at: "2026-01-02T03:04:05.000Z",
        delivered_at: null,
        sent_at: null,
        ...overrides,
    };
}

function report(overrides = {}) {
    return {
        status: "Delivered",
        reference: "message-123",
        trackingId: "notification-123",
        deliveryTime: "2026-01-02 06:04:05",
        dlr: {
            description: "DeliveredToTerminal",
            delivery_code: "000",
            gateway: "safaricom",
            updated_at: "2026-01-02T03:04:05Z",
        },
        msisdn: "254712345678",
        ...overrides,
    };
}

test("normalizes documented DLR outcomes without retaining the recipient number", () => {
    const normalized = normalizeDeliveryReport(report());

    assert.equal(normalized.deliveryStatus, "DELIVERED");
    assert.equal(normalized.providerMessageReference, "message-123");
    assert.equal(normalized.trackingId, "notification-123");
    assert.equal(normalized.providerDispatchReference, null);
    assert.equal(normalized.providerDeliveryTime, "2026-01-02 06:04:05");
    assert.equal(normalized.providerDeliveredAt, "2026-01-02T03:04:05.000Z");
    assert.equal(JSON.stringify(normalized).includes("254712345678"), false);
    assert.equal(normalizeDeliveryReport({
        ...report(),
        status: undefined,
        deliveryStatus: "AbsentSubscriber",
    }).deliveryStatus, "UNREACHABLE");
});

test("persists an unmatched callback and correlates it later by exact stable tracking ID", async () => {
    const pool = createPool();
    const repository = createMobileSasaDlrRepository(pool);
    const incoming = report({ reference: "message-late", trackingId: "notification-later" });

    const received = await repository.ingestDeliveryReport(incoming, VERIFIED_AT);
    assert.deepEqual(received, { duplicate: false, matched: false, status: "UNMATCHED" });
    assert.equal(pool.state.inbox[0].processing_status, "UNMATCHED");
    assert.equal(pool.state.inbox[0].provider_message_reference, "message-late");
    assert.equal(pool.state.commits, 1);
    assert.equal(pool.state.statements.some((sql) => /msisdn|phone|amount/i.test(sql)), false);

    pool.state.notifications.push(notification({
        notification_id: "notification-later",
        delivery_result: { provider: "MOBILE_SASA", trackingId: "notification-later", smsParts: 1 },
        provider_message_id: null,
        delivery_status: "PENDING",
        provider_accepted_at: null,
    }));
    const replay = await repository.reconcileUnmatched();

    assert.deepEqual(replay, { checked: 1, applied: 1, ignored: 0, unmatched: 0, rejected: 0 });
    assert.equal(pool.state.inbox[0].processing_status, "APPLIED");
    assert.equal(pool.state.inbox[0].notification_id, "notification-later");
    const delivered = pool.state.notifications.find((row) => row.notification_id === "notification-later");
    assert.equal(delivered.delivery_status, "DELIVERED");
    assert.ok(delivered.delivered_at);
    assert.equal(delivered.provider_message_id, "message-late");
});

test("delivery reports do not fabricate provider acceptance timestamps", async () => {
    const pool = createPool({
        notifications: [notification({
            delivery_status: "PROCESSING",
            provider_accepted_at: null,
            sent_at: null,
        })],
    });
    const repository = createMobileSasaDlrRepository(pool);

    const result = await repository.ingestDeliveryReport(report({ status: "Sent" }), VERIFIED_AT);

    assert.equal(result.status, "APPLIED");
    assert.equal(pool.state.notifications[0].delivery_status, "PROVIDER_ACCEPTED");
    assert.equal(pool.state.notifications[0].delivered_at, null);
    assert.equal(pool.state.notifications[0].provider_accepted_at, null);
    assert.equal(pool.state.notifications[0].sent_at, null);
});

test("delivery timestamp is stored separately without changing an existing acceptance timestamp", async () => {
    const pool = createPool({ notifications: [notification()] });
    const repository = createMobileSasaDlrRepository(pool);

    await repository.ingestDeliveryReport(report(), VERIFIED_AT);

    assert.equal(pool.state.notifications[0].provider_accepted_at, "2026-01-02T03:04:05.000Z");
    assert.equal(pool.state.notifications[0].delivered_at, "2026-01-02T03:04:05.000Z");
});

test("duplicate reports are deduplicated and do not apply a notification update twice", async () => {
    const pool = createPool({ notifications: [notification()] });
    const repository = createMobileSasaDlrRepository(pool);

    await repository.ingestDeliveryReport(report(), VERIFIED_AT);
    const duplicate = await repository.ingestDeliveryReport(report(), VERIFIED_AT);

    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.status, "APPLIED");
    assert.equal(pool.state.inbox.length, 1);
    assert.equal(pool.state.inbox[0].duplicate_count, 1);
    assert.equal(
        pool.state.statements.filter((sql) => sql.startsWith("UPDATE notifications")).length,
        1
    );
});

test("same provider reference and status deduplicate despite different tracking IDs", async () => {
    const pool = createPool({ notifications: [notification()] });
    const repository = createMobileSasaDlrRepository(pool);

    await repository.ingestDeliveryReport(report(), VERIFIED_AT);
    const duplicate = await repository.ingestDeliveryReport(report({
        trackingId: "different-tracking-id",
        dlr: { ...report().dlr, tracking_id: "different-dispatch-id" },
    }), VERIFIED_AT);

    assert.equal(duplicate.duplicate, true);
    assert.equal(pool.state.inbox.length, 1);
    assert.equal(pool.state.inbox[0].tracking_id, "notification-123");
    assert.equal(pool.state.inbox[0].duplicate_count, 1);
});

test("provider dispatch reference correlates independently of the tracking ID", async () => {
    const pool = createPool({
        notifications: [notification({
            notification_id: "notification-by-dispatch",
            provider_message_id: null,
            delivery_result: { providerDispatchReference: "dispatch-123" },
        })],
    });
    const repository = createMobileSasaDlrRepository(pool);

    const result = await repository.ingestDeliveryReport(report({
        reference: "provider-reference-123",
        trackingId: "tracking-not-matched",
        dlr: { ...report().dlr, tracking_id: "dispatch-123" },
    }), VERIFIED_AT);

    assert.equal(result.matched, true);
    assert.equal(pool.state.inbox[0].notification_id, "notification-by-dispatch");
});

test("callbacks without a usable exact provider reference are rejected", async () => {
    assert.throws(() => normalizeDeliveryReport({
        status: "Delivered",
        msisdn: "254712345678",
        amount: 100,
    }), { code: "MOBILE_SASA_DLR_INVALID", statusCode: 400 });
});
