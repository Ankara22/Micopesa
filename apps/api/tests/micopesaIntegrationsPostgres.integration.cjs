const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { Client } = require("pg");
const {
    getValidationDatabaseConfig,
    verifyValidationDatabaseIdentity,
} = require("../../../tests/scripts/micopesaValidationDatabase");
const {
    createNotificationEventService,
} = require("../src/services/notificationEventService");
const {
    createMpesaCallbackInboxRepository,
} = require("../src/services/mpesaCallbackInboxRepository");
const {
    createMobileSasaDlrRepository,
} = require("../src/services/mobileSasaDlrRepository");

const databaseConfig = getValidationDatabaseConfig(process.env);
const runId = randomUUID().replace(/-/g, "").slice(0, 12);
let sequence = 0;
let verified = false;

before(async () => {
    const client = new Client(databaseConfig);
    try {
        await client.connect();
        await verifyValidationDatabaseIdentity(client, databaseConfig);
        verified = true;
    } finally {
        await client.end();
    }
});

function createRepositoryPool(client) {
    let savepointSequence = 0;
    return {
        query(sql, values) {
            return values === undefined ? client.query(sql) : client.query(sql, values);
        },
        async connect() {
            const savepoints = [];
            return {
                async query(sql, values) {
                    const command = sql.trim().toUpperCase();
                    if (command === "BEGIN") {
                        const name = `micopesa_repository_${++savepointSequence}`;
                        savepoints.push(name);
                        return client.query(`SAVEPOINT ${name}`);
                    }
                    if (command === "COMMIT") {
                        const name = savepoints.pop();
                        assert.ok(name, "repository transaction savepoint must exist");
                        return client.query(`RELEASE SAVEPOINT ${name}`);
                    }
                    if (command === "ROLLBACK") {
                        const name = savepoints.pop();
                        assert.ok(name, "repository transaction savepoint must exist");
                        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
                        return client.query(`RELEASE SAVEPOINT ${name}`);
                    }
                    return values === undefined
                        ? client.query(sql)
                        : client.query(sql, values);
                },
                release() {},
            };
        },
    };
}

function normalizePostgresTextPredicate(predicate) {
    let normalized = predicate
        .replace(/::text\b/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    let previous;
    do {
        previous = normalized;
        normalized = normalized.replace(/^\((.*)\)$/, "$1");
    } while (normalized !== previous);
    return normalized.replace(/\(([a-z_][a-z0-9_]*)\)/g, "$1");
}

async function withRollback(operation) {
    assert.equal(verified, true, "database identity must be verified before writes");
    const client = new Client(databaseConfig);
    let transactionStarted = false;
    try {
        await client.connect();
        await verifyValidationDatabaseIdentity(client, databaseConfig);
        await client.query("BEGIN");
        transactionStarted = true;
        return await operation(client, createRepositoryPool(client));
    } finally {
        try {
            if (transactionStarted) await client.query("ROLLBACK");
        } finally {
            await client.end();
        }
    }
}

async function createSyntheticUser(client) {
    const userId = `it${runId}${++sequence}`;
    const phoneNumber = Number(
        BigInt(`0x${randomBytes(4).toString("hex")}`) % 100000000n
    ).toString().padStart(8, "0");
    const phone = `07${phoneNumber}`;
    const email = `${userId}@example.invalid`;
    await client.query(
        `INSERT INTO users (
            user_id, full_name, phone, phone_verified_at, email, email_verified,
            password_hash, role, account_status
         ) VALUES ($1, 'Synthetic Integration User', $2, now(), $3, TRUE,
                   'integration-test-only', 'WORKER', 'ACTIVE')`,
        [userId, phone, email]
    );
    return { userId, phone, email };
}

test("notification preferences persist partial updates and enforce required references", async () => {
    await withRollback(async (client, pool) => {
        const user = await createSyntheticUser(client);
        const service = createNotificationEventService(pool);

        assert.deepEqual(await service.getPreferences(user.userId), {
            sms_enabled: false,
            email_enabled: false,
        });
        assert.deepEqual(
            await service.updatePreferences(user.userId, { sms_enabled: true }),
            { sms_enabled: true, email_enabled: false }
        );
        assert.deepEqual(
            await service.updatePreferences(user.userId, { email_enabled: true }),
            { sms_enabled: true, email_enabled: true }
        );
        assert.deepEqual(await service.getPreferences(user.userId), {
            sms_enabled: true,
            email_enabled: true,
        });

        await client.query("SAVEPOINT invalid_preference_null");
        await assert.rejects(
            client.query(
                `INSERT INTO notification_preferences (user_id, sms_enabled, email_enabled)
                 VALUES ($1, NULL, FALSE)`,
                [user.userId]
            ),
            (error) => error.code === "23502" && error.column === "sms_enabled"
        );
        await client.query("ROLLBACK TO SAVEPOINT invalid_preference_null");
        await client.query("RELEASE SAVEPOINT invalid_preference_null");

        await client.query("SAVEPOINT invalid_preference_user");
        await assert.rejects(
            client.query(
                `INSERT INTO notification_preferences (user_id, sms_enabled, email_enabled)
                 VALUES ($1, TRUE, FALSE)`,
                [`missing-${runId}`]
            ),
            (error) => error.code === "23503"
        );
        await client.query("ROLLBACK TO SAVEPOINT invalid_preference_user");
        await client.query("RELEASE SAVEPOINT invalid_preference_user");
    });
});

test("transactional event notifications persist all opted-in channels and deduplicate replays", async () => {
    await withRollback(async (client, pool) => {
        const user = await createSyntheticUser(client);
        const service = createNotificationEventService(pool);
        await service.updatePreferences(user.userId, {
            sms_enabled: true,
            email_enabled: true,
        });

        const event = {
            userId: user.userId,
            eventType: "CONTRIBUTION_CONFIRMED",
            referenceId: `synthetic-${runId}`,
        };
        assert.deepEqual(await service.enqueueEvent(event), {
            queued: 3,
            channels: ["IN_APP", "SMS", "EMAIL"],
        });
        assert.deepEqual(await service.enqueueEvent(event), {
            queued: 0,
            channels: ["IN_APP", "SMS", "EMAIL"],
        });

        const persisted = await client.query(
            `SELECT notification_type, deduplication_key, recipient_phone, recipient_email
             FROM notifications
             WHERE user_id = $1
             ORDER BY notification_type`,
            [user.userId]
        );
        assert.deepEqual(
            persisted.rows.map((row) => row.notification_type),
            ["EMAIL", "IN_APP", "SMS"]
        );
        assert.equal(new Set(persisted.rows.map((row) => row.deduplication_key)).size, 1);
        assert.ok(persisted.rows.every((row) => row.deduplication_key));
        assert.equal(
            persisted.rows.find((row) => row.notification_type === "SMS").recipient_phone,
            `+254${user.phone.slice(1)}`
        );
        assert.equal(
            persisted.rows.find((row) => row.notification_type === "EMAIL").recipient_email,
            user.email
        );
    });
});

test("Daraja callback inbox persists callbacks and safely counts exact duplicates", async () => {
    await withRollback(async (client) => {
        const user = await createSyntheticUser(client);
        const repository = createMpesaCallbackInboxRepository(client);
        const callback = {
            checkoutRequestId: `checkout_${runId}`,
            fingerprint: createHash("sha256").update(`callback-${runId}`).digest("hex"),
            merchantRequestId: `merchant_${runId}`,
            metadata: {
                amount: 1250,
                phone: `254${user.phone.slice(1)}`,
                receipt: `T${runId}`,
            },
            resultCode: "0",
        };

        const first = await repository.storeCallback(callback);
        const duplicate = await repository.storeCallback(callback);
        assert.equal(first.duplicate, false);
        assert.equal(duplicate.duplicate, true);
        assert.equal(duplicate.callback.callback_id, first.callback.callback_id);
        assert.equal(duplicate.callback.duplicate_count, 1);

        const persisted = await client.query(
            `SELECT callback_status, callback_amount, duplicate_count
             FROM mpesa_callback_inbox
             WHERE callback_fingerprint = $1`,
            [callback.fingerprint]
        );
        assert.equal(persisted.rowCount, 1);
        assert.equal(persisted.rows[0].callback_status, "UNMATCHED");
        assert.equal(Number(persisted.rows[0].callback_amount), 1250);
        assert.equal(persisted.rows[0].duplicate_count, 1);

        await assert.rejects(
            repository.storeCallback({
                ...callback,
                merchantRequestId: `conflict_${runId}`,
            }),
            { code: "CALLBACK_FINGERPRINT_CONFLICT" }
        );
    });
});

test("MobileSasa delivery reports persist once, correlate and deduplicate repeats", async () => {
    await withRollback(async (client) => {
        const user = await createSyntheticUser(client);
        const providerReference = `synthetic-message-${runId}`;
        const notification = await client.query(
            `INSERT INTO notifications (
                user_id, notification_type, message, recipient_phone,
                provider_message_id, provider_accepted_at, delivery_status,
                delivery_result, notification_category
             ) VALUES ($1, 'SMS', 'Synthetic delivery test', $2,
                       $3, now(), 'PROVIDER_ACCEPTED',
                       '{"provider":"MOBILE_SASA"}'::jsonb, 'ACCOUNT_SERVICE')
             RETURNING notification_id, provider_accepted_at`,
            [user.userId, user.phone, providerReference]
        );
        const repository = createMobileSasaDlrRepository(createRepositoryPool(client));
        const report = {
            reference: providerReference,
            status: "Delivered",
            trackingId: `tracking-${runId}`,
            deliveryTime: "2026-11-11 12:00:00",
            dlr: {
                delivery_code: "0",
                gateway: "SYNTHETIC",
                updated_at: "2026-11-11T09:00:00.000Z",
            },
        };
        const first = await repository.ingestDeliveryReport(report, new Date());
        const duplicate = await repository.ingestDeliveryReport(report, new Date());

        assert.deepEqual(first, { duplicate: false, matched: true, status: "APPLIED" });
        assert.deepEqual(duplicate, { duplicate: true, matched: true, status: "APPLIED" });

        const callback = await client.query(
            `SELECT processing_status, duplicate_count, notification_id,
                    original_notification_id
             FROM mobilesasa_sms_delivery_callbacks
             WHERE provider_message_reference = $1 AND delivery_status = 'DELIVERED'`,
            [providerReference]
        );
        assert.equal(callback.rowCount, 1);
        assert.equal(callback.rows[0].processing_status, "APPLIED");
        assert.equal(callback.rows[0].duplicate_count, 1);
        assert.equal(callback.rows[0].notification_id, notification.rows[0].notification_id);
        assert.equal(callback.rows[0].original_notification_id, notification.rows[0].notification_id);

        const persistedNotification = await client.query(
            `SELECT delivery_status, provider_accepted_at, delivered_at,
                    jsonb_array_length(delivery_result->'deliveryReports') AS report_count
             FROM notifications
             WHERE notification_id = $1`,
            [notification.rows[0].notification_id]
        );
        assert.equal(persistedNotification.rows[0].delivery_status, "DELIVERED");
        assert.equal(
            persistedNotification.rows[0].provider_accepted_at.toISOString(),
            notification.rows[0].provider_accepted_at.toISOString()
        );
        assert.ok(persistedNotification.rows[0].delivered_at instanceof Date);
        assert.equal(Number(persistedNotification.rows[0].report_count), 1);
    });
});

test("integration columns, indexes and validated constraints exist with expected definitions", async () => {
    await withRollback(async (client) => {
        const requiredColumns = {
            notification_preferences: ["user_id", "sms_enabled", "email_enabled", "created_at", "updated_at"],
            notifications: [
                "deduplication_key", "notification_type", "delivery_result",
                "provider_message_id", "provider_accepted_at", "delivered_at",
            ],
            mpesa_callback_inbox: [
                "callback_fingerprint", "checkout_request_id", "merchant_request_id",
                "callback_result_code", "callback_amount", "callback_phone",
                "callback_receipt", "callback_status", "duplicate_count",
            ],
            mobilesasa_sms_delivery_callbacks: [
                "provider_message_reference", "tracking_id", "provider_dispatch_reference",
                "delivery_status", "notification_id", "original_notification_id",
                "processing_status", "duplicate_count", "signature_verified_at",
            ],
        };
        const tableNames = Object.keys(requiredColumns);
        const columnResult = await client.query(
            `SELECT table_name, column_name, is_nullable
             FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = ANY($1::text[])`,
            [tableNames]
        );
        const actualColumns = new Set(
            columnResult.rows.map((row) => `${row.table_name}.${row.column_name}`)
        );
        for (const [table, columns] of Object.entries(requiredColumns)) {
            for (const column of columns) {
                assert.ok(actualColumns.has(`${table}.${column}`), `missing ${table}.${column}`);
            }
        }
        for (const preference of ["sms_enabled", "email_enabled"]) {
            const column = columnResult.rows.find((row) =>
                row.table_name === "notification_preferences" &&
                row.column_name === preference
            );
            assert.equal(column?.is_nullable, "NO", `${preference} must be NOT NULL`);
        }

        const expectedIndexes = [
            {
                name: "uq_notifications_user_channel_event_key",
                table: "notifications",
                columns: /\(user_id, notification_type, deduplication_key\)/,
                predicate: /deduplication_key IS NOT NULL/i,
                unique: true,
            },
            {
                name: "idx_mpesa_callback_inbox_status_received",
                table: "mpesa_callback_inbox",
                columns: /\(callback_status, received_at\)/,
                unique: false,
            },
            {
                name: "idx_mpesa_callback_inbox_provider_ids",
                table: "mpesa_callback_inbox",
                columns: /\(checkout_request_id, merchant_request_id\)/,
                unique: false,
            },
            {
                name: "idx_mpesa_callback_inbox_attempt",
                table: "mpesa_callback_inbox",
                columns: /\(attempt_id\)/,
                predicate: /attempt_id IS NOT NULL/i,
                unique: false,
            },
            {
                name: "idx_mobilesasa_callbacks_unmatched",
                table: "mobilesasa_sms_delivery_callbacks",
                columns: /\(received_at, callback_id\)/,
                normalizedPredicate: "processing_status = 'unmatched'",
                unique: false,
            },
            {
                name: "idx_mobilesasa_callbacks_notification",
                table: "mobilesasa_sms_delivery_callbacks",
                columns: /\(notification_id, received_at DESC\)/,
                predicate: /notification_id IS NOT NULL/i,
                unique: false,
            },
            {
                name: "idx_mobilesasa_callbacks_original_notification",
                table: "mobilesasa_sms_delivery_callbacks",
                columns: /\(original_notification_id, received_at DESC\)/,
                predicate: /original_notification_id IS NOT NULL/i,
                unique: false,
            },
            {
                name: "idx_mobilesasa_callbacks_tracking_id",
                table: "mobilesasa_sms_delivery_callbacks",
                columns: /\(tracking_id\)/,
                predicate: /tracking_id IS NOT NULL/i,
                unique: false,
            },
            {
                name: "idx_mobilesasa_callbacks_dispatch_reference",
                table: "mobilesasa_sms_delivery_callbacks",
                columns: /\(provider_dispatch_reference\)/,
                predicate: /provider_dispatch_reference IS NOT NULL/i,
                unique: false,
            },
        ];
        const indexes = await client.query(
            `SELECT index_class.relname AS index_name,
                    table_class.relname AS table_name,
                    index_data.indisunique AS is_unique,
                    index_data.indisvalid AS is_valid,
                    pg_get_indexdef(index_data.indexrelid) AS definition,
                    pg_get_expr(index_data.indpred, index_data.indrelid) AS predicate
             FROM pg_index index_data
             JOIN pg_class index_class ON index_class.oid = index_data.indexrelid
             JOIN pg_namespace index_schema ON index_schema.oid = index_class.relnamespace
             JOIN pg_class table_class ON table_class.oid = index_data.indrelid
             WHERE index_schema.nspname = current_schema()
               AND index_class.relname = ANY($1::text[])`,
            [expectedIndexes.map((index) => index.name)]
        );
        const indexesByName = new Map(indexes.rows.map((row) => [row.index_name, row]));
        for (const expected of expectedIndexes) {
            const index = indexesByName.get(expected.name);
            assert.ok(index, `missing index ${expected.name}`);
            assert.equal(index.table_name, expected.table, `${expected.name} table`);
            assert.equal(index.is_valid, true, `${expected.name} must be valid`);
            assert.equal(index.is_unique, expected.unique, `${expected.name} uniqueness`);
            assert.match(index.definition, expected.columns, `${expected.name} columns`);
            if (expected.normalizedPredicate) {
                assert.equal(
                    normalizePostgresTextPredicate(index.predicate),
                    expected.normalizedPredicate,
                    `${expected.name} predicate`
                );
                continue;
            }
            if (expected.predicate) {
                assert.match(index.predicate, expected.predicate, `${expected.name} predicate`);
            } else {
                assert.equal(index.predicate, null, `${expected.name} must not be partial`);
            }
        }

        const constraintResult = await client.query(
            `SELECT relation.relname AS table_name,
                    constraint_data.conname AS constraint_name,
                    constraint_data.contype AS constraint_type,
                    constraint_data.convalidated AS is_validated,
                    pg_get_constraintdef(constraint_data.oid) AS definition
             FROM pg_constraint constraint_data
             JOIN pg_class relation ON relation.oid = constraint_data.conrelid
             JOIN pg_namespace relation_schema ON relation_schema.oid = relation.relnamespace
             WHERE relation_schema.nspname = current_schema()
               AND relation.relname = ANY($1::text[])`,
            [tableNames]
        );
        const constraintsByName = new Map(
            constraintResult.rows.map((row) => [row.constraint_name, row])
        );
        for (const name of [
            "notification_preferences_pkey",
            "notification_preferences_user_id_fkey",
            "mpesa_callback_inbox_callback_fingerprint_key",
            "ck_mpesa_callback_success_metadata",
            "ck_mpesa_callback_lifecycle",
            "mpesa_callback_inbox_callback_status_check",
            "mpesa_callback_inbox_duplicate_count_check",
            "uq_mobilesasa_callback_provider_reference_status",
            "mobilesasa_sms_delivery_callbacks_provider_check",
            "mobilesasa_sms_delivery_callbacks_delivery_status_check",
            "mobilesasa_sms_delivery_callbacks_processing_status_check",
            "mobilesasa_sms_delivery_callbacks_duplicate_count_check",
            "ck_mobilesasa_callback_notification_reference",
            "ck_mobilesasa_callback_lifecycle",
            "mobilesasa_sms_delivery_callbacks_notification_id_fkey",
        ]) {
            assert.ok(constraintsByName.has(name), `missing constraint ${name}`);
            assert.equal(constraintsByName.get(name).is_validated, true, `${name} must be validated`);
        }
        assert.equal(constraintsByName.get("notification_preferences_pkey").constraint_type, "p");
        assert.equal(constraintsByName.get("notification_preferences_user_id_fkey").constraint_type, "f");
        assert.equal(
            constraintsByName.get("uq_mobilesasa_callback_provider_reference_status").constraint_type,
            "u"
        );
        assert.ok(
            constraintResult.rows.some((row) =>
                row.table_name === "notifications" &&
                row.constraint_type === "c" &&
                /notification_type/.test(row.definition) &&
                /IN_APP/.test(row.definition)
            ),
            "notifications must allow the IN_APP channel"
        );
    });
});
