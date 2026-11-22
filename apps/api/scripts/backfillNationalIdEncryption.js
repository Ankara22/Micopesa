const crypto = require("node:crypto");
const {
    decryptNationalId,
    encryptNationalId,
    getNationalIdKeys,
    NATIONAL_ID_KEY_VERSION,
    normalizeNationalId,
} = require("../src/services/nationalIdCrypto");

const BATCH_SIZE = 200;
const VERIFIER_ROLE = "micopesa_national_id_verifier";
const SOURCES = [
    { table: "kyc_records", idColumn: "kyc_id", hasUserId: true, hasExpiresAt: false },
    { table: "pending_registrations", idColumn: "pending_registration_id", hasUserId: false, hasExpiresAt: true },
];

function readArguments(argv) {
    const options = { apply: false, confirmedDatabase: null };
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === "--apply") {
            options.apply = true;
        } else if (argv[index] === "--confirm-database") {
            const name = argv[index + 1];
            if (!name || name.startsWith("--")) {
                throw new TypeError("--confirm-database requires the exact database name.");
            }
            options.confirmedDatabase = name;
            index += 1;
        } else {
            throw new TypeError(`Unsupported argument: ${argv[index]}`);
        }
    }
    if (options.apply && !options.confirmedDatabase) {
        throw new TypeError("--apply requires --confirm-database with the exact database name.");
    }
    return options;
}

function verifyStoredRecord(row, keys) {
    const value = {
        ciphertext: row.national_id_ciphertext,
        iv: row.national_id_iv,
        tag: row.national_id_tag,
        keyVersion: row.national_id_key_version,
        fingerprint: row.national_id_fingerprint,
        lastFour: typeof row.national_id_last_four === "string"
            ? row.national_id_last_four.trim()
            : row.national_id_last_four,
    };
    const decrypted = decryptNationalId(value, keys);
    const plaintext = normalizeNationalId(row.national_id);
    if (row.national_id === "ENCRYPTED") return false;
    if (!plaintext || plaintext !== decrypted) return false;
    return decrypted;
}

function sameBuffer(left, right) {
    return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
}

function sameEnvelope(left, right) {
    return sameBuffer(left.national_id_ciphertext, right.ciphertext) &&
        sameBuffer(left.national_id_iv, right.iv) &&
        sameBuffer(left.national_id_tag, right.tag) &&
        left.national_id_key_version === right.keyVersion &&
        left.national_id_fingerprint === right.fingerprint &&
        String(left.national_id_last_four).trim() === right.lastFour;
}

async function persistVerificationEvidence(database, source, row, envelope, normalized) {
    const client = await database.connect();
    let transactionStarted = false;
    try {
        await client.query("BEGIN");
        transactionStarted = true;
        const currentResult = await client.query(
            `SELECT national_id, national_id_ciphertext, national_id_iv,
                    national_id_tag, national_id_key_version,
                    national_id_fingerprint, national_id_last_four
             FROM public.${source.table}
             WHERE ${source.idColumn} = $1
             FOR UPDATE`,
            [row.record_id]
        );
        const current = currentResult.rows[0];
        if (!current || current.national_id !== row.national_id) {
            throw Object.assign(new Error("The source record changed during National ID verification."), {
                code: "NATIONAL_ID_BACKFILL_CONCURRENT_CHANGE",
            });
        }

        if (row.national_id_ciphertext) {
            if (!sameEnvelope(current, envelope)) {
                throw Object.assign(new Error("The encrypted National ID changed during verification."), {
                    code: "NATIONAL_ID_BACKFILL_CONCURRENT_CHANGE",
                });
            }
        } else {
            if (normalizeNationalId(current.national_id) !== normalized) {
                throw Object.assign(new Error("The plaintext National ID changed during verification."), {
                    code: "NATIONAL_ID_BACKFILL_CONCURRENT_CHANGE",
                });
            }
            const update = await client.query(
                `UPDATE public.${source.table}
                 SET national_id_ciphertext = $1,
                     national_id_iv = $2,
                     national_id_tag = $3,
                     national_id_key_version = $4,
                     national_id_fingerprint = $5,
                     national_id_last_four = $6
                 WHERE ${source.idColumn} = $7
                   AND national_id = $8
                   AND national_id_ciphertext IS NULL`,
                [
                    envelope.ciphertext,
                    envelope.iv,
                    envelope.tag,
                    envelope.keyVersion,
                    envelope.fingerprint,
                    envelope.lastFour,
                    row.record_id,
                    normalized,
                ]
            );
            if (update.rowCount !== 1) {
                throw Object.assign(new Error("The source record changed during National ID backfill."), {
                    code: "NATIONAL_ID_BACKFILL_CONCURRENT_CHANGE",
                });
            }
        }

        const inserted = await client.query(
            `INSERT INTO public.worker_national_id_verification_evidence (
                 source_table, source_record_id, national_id_fingerprint,
                 national_id_ciphertext, national_id_iv, national_id_tag,
                 national_id_key_version, national_id_last_four,
                 verified_plaintext_fingerprint, plaintext_matched
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $3, TRUE)
             ON CONFLICT (source_table, source_record_id) DO NOTHING`,
            [
                source.table,
                row.record_id,
                envelope.fingerprint,
                envelope.ciphertext,
                envelope.iv,
                envelope.tag,
                envelope.keyVersion,
                envelope.lastFour,
            ]
        );
        const evidenceResult = await client.query(
            `SELECT national_id_fingerprint, national_id_ciphertext, national_id_iv,
                    national_id_tag, national_id_key_version, national_id_last_four,
                    verified_plaintext_fingerprint, plaintext_matched, verified_by
             FROM public.worker_national_id_verification_evidence
             WHERE source_table = $1 AND source_record_id = $2`,
            [source.table, row.record_id]
        );
        const evidence = evidenceResult.rows[0];
        if (!evidence ||
            evidence.national_id_fingerprint !== envelope.fingerprint ||
            !sameEnvelope(evidence, envelope) ||
            evidence.verified_plaintext_fingerprint !== envelope.fingerprint ||
            evidence.plaintext_matched !== true ||
            evidence.verified_by !== VERIFIER_ROLE) {
            throw Object.assign(new Error("National ID verification evidence is missing or mismatched."), {
                code: "NATIONAL_ID_VERIFICATION_EVIDENCE_INVALID",
            });
        }
        await client.query("COMMIT");
        transactionStarted = false;
        return inserted.rowCount === 1 ? "recorded" : "existing";
    } catch (error) {
        if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function loadBatch(database, source, afterId) {
    return database.query(
        `SELECT ${source.idColumn} AS record_id,
                ${source.hasUserId ? "user_id" : "NULL::varchar AS user_id"},
                national_id,
                national_id_ciphertext, national_id_iv, national_id_tag,
                national_id_key_version,
                national_id_fingerprint, national_id_last_four
                ${source.hasExpiresAt ? ", expires_at" : ""}
         FROM public.${source.table}
         WHERE ($1::varchar IS NULL OR ${source.idColumn} > $1)
         ORDER BY ${source.idColumn}
         LIMIT $2`,
        [afterId, BATCH_SIZE]
    );
}

async function readClaimSummary(database) {
    const result = await database.query(
        `WITH source_identities AS (
            SELECT national_id_fingerprint, user_id, NULL::varchar AS pending_registration_id,
                   NULL::timestamptz AS expires_at
            FROM public.kyc_records
            WHERE national_id_fingerprint IS NOT NULL
            UNION ALL
            SELECT national_id_fingerprint, NULL::varchar, pending_registration_id, expires_at
            FROM public.pending_registrations
            WHERE national_id_fingerprint IS NOT NULL
         ),
         expected_claims AS (
            SELECT national_id_fingerprint,
                   count(*) AS source_count,
                   max(user_id) AS user_id,
                   max(pending_registration_id) AS pending_registration_id,
                   max(expires_at) AS expires_at
            FROM source_identities
            GROUP BY national_id_fingerprint
         )
         SELECT count(*) FILTER (WHERE claims.national_id_fingerprint IS NULL) AS missing,
                count(*) FILTER (
                    WHERE claims.national_id_fingerprint IS NOT NULL
                      AND (
                          (expected.source_count > 1 AND claims.claim_status <> 'LEGACY_CONFLICT')
                          OR
                          (expected.source_count = 1 AND expected.user_id IS NOT NULL
                              AND (claims.claim_status <> 'CLAIMED'
                                  OR claims.user_id IS DISTINCT FROM expected.user_id))
                          OR
                          (expected.source_count = 1 AND expected.pending_registration_id IS NOT NULL
                              AND (claims.claim_status <> 'RESERVED'
                                  OR claims.pending_registration_id IS DISTINCT FROM expected.pending_registration_id))
                      )
                ) AS conflicting
         FROM expected_claims expected
         LEFT JOIN public.worker_national_id_claims claims
           ON claims.national_id_fingerprint = expected.national_id_fingerprint`
    );
    return {
        missing: Number(result.rows[0]?.missing || 0),
        conflicting: Number(result.rows[0]?.conflicting || 0),
    };
}

async function insertMissingClaims(database) {
    return database.query(
        `WITH source_identities AS (
            SELECT national_id_fingerprint, user_id, NULL::varchar AS pending_registration_id,
                   NULL::timestamptz AS expires_at
            FROM public.kyc_records
            WHERE national_id_fingerprint IS NOT NULL
            UNION ALL
            SELECT national_id_fingerprint, NULL::varchar, pending_registration_id, expires_at
            FROM public.pending_registrations
            WHERE national_id_fingerprint IS NOT NULL
         ),
         expected_claims AS (
            SELECT national_id_fingerprint,
                   count(*) AS source_count,
                   max(user_id) AS user_id,
                   max(pending_registration_id) AS pending_registration_id,
                   max(expires_at) AS expires_at
            FROM source_identities
            GROUP BY national_id_fingerprint
         )
         INSERT INTO public.worker_national_id_claims (
             national_id_fingerprint, claim_status, user_id,
             pending_registration_id, expires_at
         )
         SELECT expected.national_id_fingerprint,
                CASE
                    WHEN expected.source_count > 1 THEN 'LEGACY_CONFLICT'
                    WHEN expected.user_id IS NOT NULL THEN 'CLAIMED'
                    ELSE 'RESERVED'
                END,
                CASE WHEN expected.source_count = 1 THEN expected.user_id END,
                CASE WHEN expected.source_count = 1
                          AND expected.pending_registration_id IS NOT NULL
                     THEN expected.pending_registration_id END,
                CASE WHEN expected.source_count = 1
                          AND expected.pending_registration_id IS NOT NULL
                     THEN expected.expires_at END
         FROM expected_claims expected
         ON CONFLICT (national_id_fingerprint) DO NOTHING`
    );
}

async function runNationalIdBackfill({
    database,
    environment = process.env,
    apply = false,
    confirmedDatabase = null,
}) {
    if (!database || typeof database.query !== "function" ||
        typeof database.connect !== "function") {
        throw new TypeError("A PostgreSQL database client is required.");
    }
    if (apply && typeof confirmedDatabase !== "string") {
        throw new TypeError("Apply mode requires explicit database-name confirmation.");
    }
    const keys = getNationalIdKeys(environment);
    const counts = {
        scanned: 0,
        encrypted: 0,
        alreadyVerified: 0,
        verificationEvidenceRecorded: 0,
        verificationEvidenceExisting: 0,
        malformed: [],
        invalidCiphertext: [],
        invalidVerificationEvidence: [],
        duplicateFingerprints: 0,
        missingClaims: 0,
        conflictingClaims: 0,
    };
    const seenFingerprints = new Set();
    const duplicateFingerprints = new Set();

    if (apply) {
        const identity = await database.query(
            "SELECT current_database() AS database_name, session_user AS database_user"
        );
        if (identity.rows[0]?.database_name !== confirmedDatabase) {
            throw Object.assign(new Error("The connected database does not match the confirmed name."), {
                code: "NATIONAL_ID_BACKFILL_DATABASE_MISMATCH",
            });
        }
        if (identity.rows[0]?.database_user !== VERIFIER_ROLE) {
            throw Object.assign(new Error("Apply mode requires the dedicated National ID verifier database role."), {
                code: "NATIONAL_ID_BACKFILL_VERIFIER_ROLE_REQUIRED",
            });
        }
    }

    for (const source of SOURCES) {
        let afterId = null;
        while (true) {
            const result = await loadBatch(database, source, afterId);
            if (result.rows.length === 0) break;
            for (const row of result.rows) {
                counts.scanned += 1;
                afterId = row.record_id;
                if (row.national_id_ciphertext) {
                    let verifiedPlaintext;
                    try {
                        verifiedPlaintext = verifyStoredRecord(row, keys);
                    } catch {
                        counts.invalidCiphertext.push({ source: source.table, recordId: row.record_id });
                        continue;
                    }
                    if (!verifiedPlaintext) {
                        counts.invalidCiphertext.push({ source: source.table, recordId: row.record_id });
                        continue;
                    }
                    counts.alreadyVerified += 1;
                    const envelope = {
                        ciphertext: row.national_id_ciphertext,
                        iv: row.national_id_iv,
                        tag: row.national_id_tag,
                        keyVersion: row.national_id_key_version,
                        fingerprint: row.national_id_fingerprint,
                        lastFour: typeof row.national_id_last_four === "string"
                            ? row.national_id_last_four.trim()
                            : row.national_id_last_four,
                    };
                    if (typeof row.national_id_fingerprint === "string") {
                        if (seenFingerprints.has(row.national_id_fingerprint)) {
                            duplicateFingerprints.add(row.national_id_fingerprint);
                        }
                        seenFingerprints.add(row.national_id_fingerprint);
                    }
                    if (apply) {
                        try {
                            const result = await persistVerificationEvidence(
                                database,
                                source,
                                row,
                                envelope,
                                verifiedPlaintext
                            );
                            counts[result === "recorded"
                                ? "verificationEvidenceRecorded"
                                : "verificationEvidenceExisting"] += 1;
                        } catch (error) {
                            if (error.code === "NATIONAL_ID_VERIFICATION_EVIDENCE_INVALID") {
                                counts.invalidVerificationEvidence.push({
                                    source: source.table,
                                    recordId: row.record_id,
                                });
                                continue;
                            }
                            throw error;
                        }
                    }
                    continue;
                }

                const normalized = normalizeNationalId(row.national_id);
                if (!normalized) {
                    counts.malformed.push({ source: source.table, recordId: row.record_id });
                    continue;
                }
                const encrypted = encryptNationalId(normalized, keys);
                const verified = decryptNationalId(encrypted, keys);
                if (verified !== normalized) {
                    counts.invalidCiphertext.push({ source: source.table, recordId: row.record_id });
                    continue;
                }
                if (seenFingerprints.has(encrypted.fingerprint)) {
                    duplicateFingerprints.add(encrypted.fingerprint);
                }
                seenFingerprints.add(encrypted.fingerprint);
                if (apply) {
                    await persistVerificationEvidence(database, source, row, encrypted, normalized);
                    counts.verificationEvidenceRecorded += 1;
                }
                counts.encrypted += 1;
            }
        }
    }

    const duplicates = await database.query(
        `SELECT count(*) AS duplicate_fingerprint_count
         FROM (
             SELECT national_id_fingerprint
             FROM (
                 SELECT national_id_fingerprint FROM public.kyc_records
                 UNION ALL
                 SELECT national_id_fingerprint FROM public.pending_registrations
             ) identities
             WHERE national_id_fingerprint IS NOT NULL
             GROUP BY national_id_fingerprint
             HAVING count(*) > 1
         ) duplicate_identities`
    );
    counts.duplicateFingerprints = Math.max(
        Number(duplicates.rows[0]?.duplicate_fingerprint_count || 0),
        duplicateFingerprints.size
    );

    if (apply &&
        counts.malformed.length === 0 &&
        counts.invalidCiphertext.length === 0 &&
        counts.invalidVerificationEvidence.length === 0) {
        await insertMissingClaims(database);
    }
    const claims = await readClaimSummary(database);
    counts.missingClaims = claims.missing;
    counts.conflictingClaims = claims.conflicting;
    return {
        mode: apply ? "apply" : "dry-run",
        complete: counts.malformed.length === 0 &&
            counts.invalidCiphertext.length === 0 &&
            counts.invalidVerificationEvidence.length === 0 &&
            counts.duplicateFingerprints === 0 &&
            counts.missingClaims === 0 &&
            counts.conflictingClaims === 0,
        contractReady: apply &&
            counts.malformed.length === 0 &&
            counts.invalidCiphertext.length === 0 &&
            counts.invalidVerificationEvidence.length === 0 &&
            counts.duplicateFingerprints === 0 &&
            counts.missingClaims === 0 &&
            counts.conflictingClaims === 0,
        ...counts,
    };
}

async function main(argv) {
    const options = readArguments(argv);
    let database;
    let ownedPool = false;
    if (options.apply) {
        const connectionString = process.env.NATIONAL_ID_BACKFILL_DATABASE_URL;
        if (typeof connectionString !== "string" || !connectionString.trim()) {
            throw Object.assign(new Error("The dedicated verifier database connection is required."), {
                code: "NATIONAL_ID_BACKFILL_VERIFIER_CONNECTION_REQUIRED",
            });
        }
        const { Pool } = require("pg");
        database = new Pool({ connectionString });
        ownedPool = true;
    } else {
        database = require("../src/db/database");
    }
    try {
        const report = await runNationalIdBackfill({ database, ...options });
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        if (!report.complete) process.exitCode = 2;
    } finally {
        if (ownedPool) await database.end();
    }
}

if (require.main === module) {
    main(process.argv.slice(2)).catch((error) => {
        const code = typeof error?.code === "string" &&
            /^NATIONAL_ID_[A-Z0-9_]+$/.test(error.code)
            ? error.code
            : "NATIONAL_ID_BACKFILL_FAILED";
        console.error(JSON.stringify({ error: code }));
        process.exitCode = 1;
    });
}

module.exports = {
    readArguments,
    runNationalIdBackfill,
};
