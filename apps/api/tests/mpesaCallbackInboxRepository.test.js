const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createMpesaCallbackInboxRepository,
} = require("../src/services/mpesaCallbackInboxRepository");

function createPool() {
    const records = [];
    const replayQueries = [];
    let nextId = 1;
    let replayTimestamp = 0;
    return {
        records,
        replayQueries,
        pool: {
            async query(sql, params = []) {
                if (sql.startsWith("INSERT INTO mpesa_callback_inbox")) {
                    let record = records.find((item) => item.callback_fingerprint === params[0]);
                    if (record) {
                        const values = [
                            record.checkout_request_id,
                            record.merchant_request_id,
                            record.callback_result_code,
                            record.callback_amount,
                            record.callback_phone,
                            record.callback_receipt,
                        ];
                        if (values.some((value, index) => value !== params[index + 1])) {
                            return { rows: [] };
                        }
                        record.duplicate_count += 1;
                    } else {
                        record = {
                            callback_id: nextId++,
                            callback_fingerprint: params[0],
                            checkout_request_id: params[1],
                            merchant_request_id: params[2],
                            callback_result_code: params[3],
                            callback_amount: params[4],
                            callback_phone: params[5],
                            callback_receipt: params[6],
                            callback_status: "UNMATCHED",
                            attempt_id: null,
                            verification_id: null,
                            rejection_code: null,
                            duplicate_count: 0,
                            updated_at: 0,
                        };
                        records.push(record);
                    }
                    return { rows: [{ ...record }] };
                }
                if (sql.startsWith("UPDATE mpesa_callback_inbox")) {
                    const record = records.find((item) => item.callback_id === params[0]);
                    if (!record) return { rows: [] };
                    if (sql.includes("SET callback_status = 'CORRELATED'")) {
                        if (record.callback_status !== "UNMATCHED") return { rows: [] };
                        record.callback_status = "CORRELATED";
                        record.attempt_id = params[1];
                    } else if (sql.includes("SET callback_status = 'VERIFIED'")) {
                        if (
                            record.callback_status !== "CORRELATED" ||
                            record.attempt_id !== params[1]
                        ) return { rows: [] };
                        record.callback_status = "VERIFIED";
                        record.verification_id = params[2];
                    } else if (sql.includes("SET callback_status = 'REJECTED'")) {
                        if (!["UNMATCHED", "CORRELATED"].includes(record.callback_status)) {
                            return { rows: [] };
                        }
                        record.callback_status = "REJECTED";
                        record.rejection_code = params[1];
                    }
                    return { rows: [{ ...record }] };
                }
                if (sql.includes("WITH replay_batch AS")) {
                    replayQueries.push(sql);
                    const selected = records
                        .filter((item) => ["UNMATCHED", "CORRELATED"].includes(item.callback_status))
                        .sort((left, right) =>
                            left.updated_at - right.updated_at || left.callback_id - right.callback_id
                        )
                        .slice(0, params[0]);
                    for (const record of selected) record.updated_at = ++replayTimestamp;
                    return {
                        rows: selected.map((item) => ({ ...item })),
                    };
                }
                if (sql.startsWith("SELECT callback_id")) {
                    const record = records.find((item) => item.callback_id === params[0]);
                    return { rows: record ? [{ ...record }] : [] };
                }
                throw new Error(`Unexpected inbox query: ${sql}`);
            },
        },
    };
}

function callback(overrides = {}) {
    return {
        checkoutRequestId: "checkout_001",
        fingerprint: "a".repeat(64),
        merchantRequestId: "merchant_001",
        metadata: { amount: 2500, phone: "254712345678", receipt: "QAB123XYZ" },
        resultCode: "0",
        ...overrides,
    };
}

test("stores callbacks durably and deduplicates identical provider deliveries", async () => {
    const database = createPool();
    const repository = createMpesaCallbackInboxRepository(database.pool);

    const first = await repository.storeCallback(callback());
    const duplicate = await repository.storeCallback(callback());

    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.callback.callback_id, first.callback.callback_id);
    assert.equal(duplicate.callback.duplicate_count, 1);
    assert.equal(database.records.length, 1);
});

test("rejects a conflicting payload that reuses a callback fingerprint", async () => {
    const database = createPool();
    const repository = createMpesaCallbackInboxRepository(database.pool);
    await repository.storeCallback(callback());

    await assert.rejects(
        repository.storeCallback(callback({ merchantRequestId: "merchant_other" })),
        { code: "CALLBACK_FINGERPRINT_CONFLICT" }
    );
    assert.equal(database.records.length, 1);
});

test("correlation and verification are explicit inbox state transitions", async () => {
    const database = createPool();
    const repository = createMpesaCallbackInboxRepository(database.pool);
    const stored = await repository.storeCallback(callback());
    const correlated = await repository.markCorrelated(stored.callback.callback_id, "attempt_001");

    assert.equal(correlated.callback_status, "CORRELATED");
    const verified = await repository.markVerified(
        stored.callback.callback_id,
        "attempt_001",
        14
    );
    assert.equal(verified.callback_status, "VERIFIED");
    assert.equal(verified.verification_id, 14);
    assert.deepEqual(await repository.listReplayable(), []);
});

test("replay listing retains callbacks that were correlated but not yet verified", async () => {
    const database = createPool();
    const repository = createMpesaCallbackInboxRepository(database.pool);
    const stored = await repository.storeCallback(callback());
    await repository.markCorrelated(stored.callback.callback_id, "attempt_001");

    const replayable = await repository.listReplayable();
    assert.equal(replayable.length, 1);
    assert.equal(replayable[0].callback_status, "CORRELATED");
});

test("replay batches rotate through old unmatched callbacks instead of starving later rows", async () => {
    const database = createPool();
    const repository = createMpesaCallbackInboxRepository(database.pool);
    for (let index = 1; index <= 3; index += 1) {
        await repository.storeCallback(callback({
            checkoutRequestId: `checkout_00${index}`,
            fingerprint: String(index).repeat(64),
        }));
    }

    const firstBatch = await repository.listReplayable(2);
    const nextBatch = await repository.listReplayable(2);

    assert.deepEqual(firstBatch.map((item) => item.checkout_request_id), ["checkout_001", "checkout_002"]);
    assert.deepEqual(nextBatch.map((item) => item.checkout_request_id), ["checkout_003", "checkout_001"]);
    assert.match(database.replayQueries[0], /ORDER BY updated_at, received_at, callback_id/);
    assert.match(database.replayQueries[0], /FOR UPDATE SKIP LOCKED/);
});

test("successful callbacks cannot be persisted without the amount, phone, and receipt", async () => {
    const database = createPool();
    const repository = createMpesaCallbackInboxRepository(database.pool);

    await assert.rejects(
        repository.storeCallback(callback({ metadata: null })),
        { code: "INVALID_CALLBACK_INBOX_INPUT", statusCode: 400 }
    );
    assert.equal(database.records.length, 0);
});
