const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    readArguments,
    runNationalIdBackfill,
} = require("../scripts/backfillNationalIdEncryption");
const { encryptNationalId } = require("../src/services/nationalIdCrypto");

const environment = {
    NATIONAL_ID_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
    NATIONAL_ID_FINGERPRINT_KEY: Buffer.alloc(32, 6).toString("base64"),
};

function createBackfillDatabase({ databaseName = "isolated_test" } = {}) {
    const calls = [];
    const writes = [];
    const client = {
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
                return { rows: [] };
            }
            if (sql.includes("UPDATE public.")) {
                writes.push({ sql, values });
                return { rows: [], rowCount: 1 };
            }
            return { rows: [], rowCount: 1 };
        },
        release() {},
    };
    return {
        calls,
        writes,
        async connect() { return client; },
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (sql.includes("current_database()")) {
                return {
                    rows: [{
                        database_name: databaseName,
                        database_user: "micopesa_national_id_verifier",
                    }],
                };
            }
            if (sql.includes("SELECT count(*) AS duplicate_fingerprint_count")) {
                return { rows: [{ duplicate_fingerprint_count: 0 }] };
            }
            if (sql.includes("SELECT count(*) FILTER")) {
                return { rows: [{ missing: 0, conflicting: 0 }] };
            }
            if (sql.includes("INSERT INTO public.worker_national_id_claims")) {
                return { rows: [], rowCount: 1 };
            }
            const table = sql.includes("public.kyc_records")
                ? "kyc_records"
                : "pending_registrations";
            if (values[0] !== null) return { rows: [] };
            return {
                rows: [{
                    record_id: table === "kyc_records" ? "KYC-1" : "PENDING-1",
                    user_id: table === "kyc_records" ? "USER-1" : null,
                    national_id: table === "kyc_records" ? "00123456" : "87654321",
                    national_id_ciphertext: null,
                    national_id_iv: null,
                    national_id_tag: null,
                    national_id_fingerprint: null,
                    national_id_last_four: null,
                    expires_at: null,
                }],
            };
        },
    };
}

function createEvidenceApplyDatabase({ interruptFirstUpdate = false } = {}) {
    const calls = [];
    const evidenceRows = [];
    let batchRead = false;
    let interruptUpdate = interruptFirstUpdate;
    let current = {
        record_id: "KYC-EVIDENCE",
        user_id: "USER-EVIDENCE",
        national_id: "00123456",
        national_id_ciphertext: null,
        national_id_iv: null,
        national_id_tag: null,
        national_id_key_version: null,
        national_id_fingerprint: null,
        national_id_last_four: null,
    };
    const client = {
        async query(sql, values = []) {
            calls.push({ sql, values });
            if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
                return { rows: [] };
            }
            if (/SELECT national_id, national_id_ciphertext/i.test(sql)) {
                return { rows: [{ ...current }] };
            }
            if (sql.includes("UPDATE public.kyc_records")) {
                if (interruptUpdate) {
                    interruptUpdate = false;
                    throw new Error("simulated interruption");
                }
                current = {
                    ...current,
                    national_id_ciphertext: values[0],
                    national_id_iv: values[1],
                    national_id_tag: values[2],
                    national_id_key_version: values[3],
                    national_id_fingerprint: values[4],
                    national_id_last_four: values[5],
                };
                return { rows: [], rowCount: 1 };
            }
            if (sql.includes("INSERT INTO public.worker_national_id_verification_evidence")) {
                const exists = evidenceRows.some((evidence) =>
                    evidence.source_table === values[0] &&
                    evidence.source_record_id === values[1]);
                if (!exists) evidenceRows.push({
                    source_table: values[0],
                    source_record_id: values[1],
                    national_id_fingerprint: values[2],
                    national_id_ciphertext: values[3],
                    national_id_iv: values[4],
                    national_id_tag: values[5],
                    national_id_key_version: values[6],
                    national_id_last_four: values[7],
                    verified_plaintext_fingerprint: values[2],
                    plaintext_matched: true,
                    verified_by: "micopesa_national_id_verifier",
                });
                return { rows: [], rowCount: exists ? 0 : 1 };
            }
            if (sql.includes("FROM public.worker_national_id_verification_evidence")) {
                return { rows: evidenceRows };
            }
            return { rows: [], rowCount: 1 };
        },
        release() {},
    };

    return {
        calls,
        evidenceRows,
        resetBatches() { batchRead = false; },
        resumeUpdates() { interruptUpdate = false; },
        async connect() { return client; },
        async query(sql, values = []) {
            if (sql.includes("current_database()")) {
                return {
                    rows: [{
                        database_name: "isolated_test",
                        database_user: "micopesa_national_id_verifier",
                    }],
                };
            }
            if (sql.includes("AS record_id")) {
                if (!sql.includes("public.kyc_records") || values[0] !== null || batchRead) {
                    return { rows: [] };
                }
                batchRead = true;
                return { rows: [{ ...current }] };
            }
            if (sql.includes("SELECT count(*) AS duplicate_fingerprint_count")) {
                return { rows: [{ duplicate_fingerprint_count: 0 }] };
            }
            if (sql.includes("INSERT INTO public.worker_national_id_claims")) {
                return { rows: [], rowCount: 0 };
            }
            if (sql.includes("SELECT count(*) FILTER")) {
                return { rows: [{ missing: 0, conflicting: 0 }] };
            }
            return { rows: [] };
        },
    };
}

test("backfill CLI requires explicit database confirmation for write mode", () => {
    assert.deepEqual(readArguments([]), { apply: false, confirmedDatabase: null });
    assert.throws(() => readArguments(["--apply"]), /requires --confirm-database/);
    assert.throws(() => readArguments(["--unsupported"]), /Unsupported argument/);
    assert.deepEqual(readArguments([
        "--apply",
        "--confirm-database",
        "isolated_test",
    ]), { apply: true, confirmedDatabase: "isolated_test" });
});

test("National ID backfill dry-run scans without opening a write transaction", async () => {
    const database = createBackfillDatabase();
    const report = await runNationalIdBackfill({ database, environment });

    assert.equal(report.mode, "dry-run");
    assert.equal(report.complete, true);
    assert.equal(report.scanned, 2);
    assert.equal(report.encrypted, 2);
    assert.equal(report.contractReady, false);
    assert.equal(database.writes.length, 0);
    assert.equal(database.calls.some(({ sql }) => sql === "BEGIN"), false);
});

test("National ID backfill refuses apply under the ordinary application database role", async () => {
    const database = createBackfillDatabase();
    const query = database.query;
    database.query = async (sql, values) => {
        const result = await query(sql, values);
        if (sql.includes("current_database()")) {
            result.rows[0].database_user = "micopesa_api";
        }
        return result;
    };

    await assert.rejects(
        runNationalIdBackfill({
            database,
            environment,
            apply: true,
            confirmedDatabase: "isolated_test",
        }),
        { code: "NATIONAL_ID_BACKFILL_VERIFIER_ROLE_REQUIRED" }
    );
    assert.equal(database.writes.length, 0);
    assert.equal(database.calls.some(({ sql }) => sql === "BEGIN"), false);
});

test("backfill stores exact cryptographic verification evidence atomically with ciphertext", async () => {
    const database = createEvidenceApplyDatabase();
    const report = await runNationalIdBackfill({
        database,
        environment,
        apply: true,
        confirmedDatabase: "isolated_test",
    });

    assert.equal(report.complete, true);
    assert.equal(report.contractReady, true);
    assert.equal(report.verificationEvidenceRecorded, 1);
    assert.equal(database.evidenceRows.length, 1);
    const evidence = database.evidenceRows[0];
    assert.equal(evidence.source_table, "kyc_records");
    assert.equal(evidence.source_record_id, "KYC-EVIDENCE");
    assert.equal(evidence.national_id_fingerprint, evidence.verified_plaintext_fingerprint);
    assert.equal(evidence.plaintext_matched, true);
    assert.equal(evidence.verified_by, "micopesa_national_id_verifier");
    const updateIndex = database.calls.findIndex(({ sql }) => sql.includes("UPDATE public.kyc_records"));
    const evidenceIndex = database.calls.findIndex(({ sql }) => sql.includes("INSERT INTO public.worker_national_id_verification_evidence"));
    const evidenceInsert = database.calls[evidenceIndex];
    assert.ok(updateIndex >= 0 && evidenceIndex > updateIndex);
    assert.doesNotMatch(evidenceInsert.sql, /verified_by\s*\)/i);
    assert.equal(evidenceInsert.values.length, 8);
    assert.equal(
        database.calls.slice(updateIndex, evidenceIndex + 1).some(({ sql }) => sql === "COMMIT"),
        false
    );
});

test("interrupted backfill rolls back and safely resumes with one exact evidence row", async () => {
    const database = createEvidenceApplyDatabase({ interruptFirstUpdate: true });
    const options = {
        database,
        environment,
        apply: true,
        confirmedDatabase: "isolated_test",
    };
    await assert.rejects(runNationalIdBackfill(options), /simulated interruption/);
    assert.equal(database.evidenceRows.length, 0);
    const failedWrites = database.calls.filter(({ sql }) => sql.includes("UPDATE public.kyc_records"));
    assert.equal(failedWrites.length, 1);
    database.resumeUpdates();
    database.resetBatches();
    const second = await runNationalIdBackfill(options);

    assert.equal(second.encrypted, 1);
    assert.equal(second.alreadyVerified, 0);
    assert.equal(second.verificationEvidenceRecorded, 1);
    assert.equal(second.contractReady, true);
    assert.equal(database.evidenceRows.length, 1);
});

test("tampered but structurally complete ciphertext is rejected before evidence writes", async () => {
    const encrypted = encryptNationalId("00123456", { environment });
    const tamperedTag = Buffer.from(encrypted.tag);
    tamperedTag[0] ^= 0xff;
    let returned = false;
    const writes = [];
    const database = {
        async connect() {
            return {
                async query(sql) {
                    writes.push(sql);
                    return { rows: [], rowCount: 1 };
                },
                release() {},
            };
        },
        async query(sql, values = []) {
            if (sql.includes("FROM public.kyc_records")) {
                if (returned || values[0] !== null) return { rows: [] };
                returned = true;
                return {
                    rows: [{
                        record_id: "KYC-TAMPERED",
                        user_id: "USER-TAMPERED",
                        national_id: "00123456",
                        national_id_ciphertext: encrypted.ciphertext,
                        national_id_iv: encrypted.iv,
                        national_id_tag: tamperedTag,
                        national_id_key_version: encrypted.keyVersion,
                        national_id_fingerprint: encrypted.fingerprint,
                        national_id_last_four: encrypted.lastFour,
                    }],
                };
            }
            if (sql.includes("SELECT count(*) AS duplicate_fingerprint_count")) {
                return { rows: [{ duplicate_fingerprint_count: 0 }] };
            }
            if (sql.includes("SELECT count(*) FILTER")) {
                return { rows: [{ missing: 0, conflicting: 0 }] };
            }
            return { rows: [] };
        },
    };

    const report = await runNationalIdBackfill({ database, environment });
    assert.equal(report.complete, false);
    assert.deepEqual(report.invalidCiphertext, [{
        source: "kyc_records",
        recordId: "KYC-TAMPERED",
    }]);
    assert.equal(writes.length, 0);
});

test("National ID backfill refuses a database-name mismatch before writing", async () => {
    const database = createBackfillDatabase({ databaseName: "unexpected_database" });

    await assert.rejects(
        runNationalIdBackfill({
            database,
            environment,
            apply: true,
            confirmedDatabase: "isolated_test",
        }),
        { code: "NATIONAL_ID_BACKFILL_DATABASE_MISMATCH" }
    );
    assert.equal(database.writes.length, 0);
    assert.equal(database.calls.some(({ sql }) => sql === "BEGIN"), false);
});

test("malformed and duplicate legacy records are reported without merging or redaction", async () => {
    const calls = [];
    let kycBatchReturned = false;
    const database = {
        async connect() {
            throw new Error("Write client should not be needed in dry-run.");
        },
        async query(sql) {
            calls.push(sql);
            if (sql.includes("SELECT count(*) AS duplicate_fingerprint_count")) {
                return { rows: [{ duplicate_fingerprint_count: 1 }] };
            }
            if (sql.includes("SELECT count(*) FILTER")) {
                return { rows: [{ missing: 0, conflicting: 0 }] };
            }
            if (sql.includes("FROM public.kyc_records")) {
                if (kycBatchReturned) return { rows: [] };
                kycBatchReturned = true;
                return {
                    rows: [{
                        record_id: "KYC-MALFORMED",
                        user_id: "USER-MALFORMED",
                        national_id: "not-an-id",
                        national_id_ciphertext: null,
                        national_id_iv: null,
                        national_id_tag: null,
                        national_id_key_version: null,
                        national_id_fingerprint: null,
                        national_id_last_four: null,
                    }],
                };
            }
            return { rows: [] };
        },
    };

    const report = await runNationalIdBackfill({ database, environment });
    assert.equal(report.complete, false);
    assert.equal(report.malformed.length, 1);
    assert.equal(report.malformed[0].recordId, "KYC-MALFORMED");
    assert.equal(report.duplicateFingerprints, 1);
    assert.equal(calls.some((sql) => /UPDATE public\.(kyc_records|pending_registrations)/i.test(sql)), false);
});

test("duplicate fingerprints from distinct source records block contract readiness", async () => {
    let kycRead = false;
    let pendingRead = false;
    const writes = [];
    const database = {
        async connect() {
            return {
                async query(sql) {
                    writes.push(sql);
                    return { rows: [], rowCount: 1 };
                },
                release() {},
            };
        },
        async query(sql, values = []) {
            if (sql.includes("AS record_id")) {
                if (sql.includes("public.kyc_records") && values[0] === null && !kycRead) {
                    kycRead = true;
                    return {
                        rows: [{
                            record_id: "KYC-DUPLICATE",
                            user_id: "USER-DUPLICATE",
                            national_id: "00123456",
                            national_id_ciphertext: null,
                            national_id_iv: null,
                            national_id_tag: null,
                            national_id_key_version: null,
                            national_id_fingerprint: null,
                            national_id_last_four: null,
                        }],
                    };
                }
                if (sql.includes("public.pending_registrations") &&
                    values[0] === null &&
                    !pendingRead) {
                    pendingRead = true;
                    return {
                        rows: [{
                            record_id: "PENDING-DUPLICATE",
                            user_id: null,
                            national_id: "00123456",
                            national_id_ciphertext: null,
                            national_id_iv: null,
                            national_id_tag: null,
                            national_id_key_version: null,
                            national_id_fingerprint: null,
                            national_id_last_four: null,
                            expires_at: new Date("2030-01-01T00:00:00.000Z"),
                        }],
                    };
                }
                return { rows: [] };
            }
            if (sql.includes("SELECT count(*) AS duplicate_fingerprint_count")) {
                return { rows: [{ duplicate_fingerprint_count: 0 }] };
            }
            if (sql.includes("SELECT count(*) FILTER")) {
                return { rows: [{ missing: 0, conflicting: 0 }] };
            }
            return { rows: [] };
        },
    };

    const report = await runNationalIdBackfill({ database, environment });
    assert.equal(report.duplicateFingerprints, 1);
    assert.equal(report.complete, false);
    assert.equal(report.contractReady, false);
    assert.equal(writes.length, 0);
});

test("an interrupted apply rolls back and leaves a resumable, unredacted record", async () => {
    const writes = [];
    let began = 0;
    let rolledBack = 0;
    const client = {
        async query(sql, values = []) {
            if (sql === "BEGIN") {
                began += 1;
                return { rows: [] };
            }
            if (sql === "ROLLBACK") {
                rolledBack += 1;
                return { rows: [] };
            }
            if (/SELECT national_id, national_id_ciphertext/i.test(sql)) {
                return { rows: [{ national_id: "00123456" }] };
            }
            if (sql.includes("UPDATE public.kyc_records")) {
                writes.push({ sql, values });
                throw new Error("interrupted");
            }
            return { rows: [], rowCount: 1 };
        },
        release() {},
    };
    let batchReturned = false;
    const database = {
        async connect() { return client; },
        async query(sql) {
            if (sql.includes("current_database()")) {
                return {
                    rows: [{
                        database_name: "isolated_test",
                        database_user: "micopesa_national_id_verifier",
                    }],
                };
            }
            if (sql.includes("FROM public.kyc_records")) {
                if (batchReturned) return { rows: [] };
                batchReturned = true;
                return {
                    rows: [{
                        record_id: "KYC-INTERRUPTED",
                        user_id: "USER-INTERRUPTED",
                        national_id: "00123456",
                        national_id_ciphertext: null,
                        national_id_iv: null,
                        national_id_tag: null,
                        national_id_key_version: null,
                        national_id_fingerprint: null,
                        national_id_last_four: null,
                    }],
                };
            }
            if (sql.includes("SELECT count(*) AS duplicate_fingerprint_count")) {
                return { rows: [{ duplicate_fingerprint_count: 0 }] };
            }
            if (sql.includes("SELECT count(*) FILTER")) {
                return { rows: [{ missing: 0, conflicting: 0 }] };
            }
            return { rows: [] };
        },
    };

    await assert.rejects(
        runNationalIdBackfill({
            database,
            environment,
            apply: true,
            confirmedDatabase: "isolated_test",
        }),
        /interrupted/,
    );
    assert.equal(began, 1);
    assert.equal(rolledBack, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].values[0] instanceof Buffer, true);
    assert.equal(writes[0].values[3], "v1");
});
