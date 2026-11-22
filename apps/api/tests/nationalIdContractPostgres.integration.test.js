const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const requiredEnvironment = [
    "NATIONAL_ID_SECURITY_TEST_SOCKET",
    "NATIONAL_ID_SECURITY_TEST_PORT",
    "NATIONAL_ID_SECURITY_TEST_DATABASE",
    "NATIONAL_ID_SECURITY_TEST_ADMIN",
    "NATIONAL_ID_SECURITY_TEST_DATA_DIRECTORY",
];
const suppliedEnvironment = requiredEnvironment.filter((name) => process.env[name]);
const enabled = suppliedEnvironment.length === requiredEnvironment.length;
if (suppliedEnvironment.length > 0 && !enabled) {
    throw new Error("Provide all non-secret isolated National ID contract test connection fields.");
}

const connection = enabled
    ? {
        host: process.env.NATIONAL_ID_SECURITY_TEST_SOCKET,
        port: Number(process.env.NATIONAL_ID_SECURITY_TEST_PORT),
        database: process.env.NATIONAL_ID_SECURITY_TEST_DATABASE,
        user: process.env.NATIONAL_ID_SECURITY_TEST_ADMIN,
        expectedDataDirectory: process.env.NATIONAL_ID_SECURITY_TEST_DATA_DIRECTORY,
        connectionTimeoutMillis: 3000,
    }
    : null;

if (enabled &&
    (!/^\/tmp\/micopesa_nid_security_socket_[a-zA-Z0-9_-]+$/.test(connection.host) ||
        !/^micopesa_national_id_security_test_[a-zA-Z0-9_-]+$/.test(connection.database) ||
        !/^\/tmp\/micopesa_nid_security_cluster_[a-zA-Z0-9_-]+\/data$/.test(connection.expectedDataDirectory) ||
        !Number.isInteger(connection.port) ||
        connection.port < 1024 ||
        connection.port > 65535)) {
    throw new Error("National ID contract tests accept only the named local disposable socket/database.");
}

const contractSql = fs.readFileSync(
    path.resolve(__dirname, "../../../database/migration_worker_identity_contract_forward.sql"),
    "utf8"
);
const createdDatabases = [];
const clonePrefix = `micopesa_nid_security_test_contract_${process.pid}_`;

function databaseConfig(database) {
    return {
        host: connection.host,
        port: connection.port,
        database,
        user: connection.user,
        connectionTimeoutMillis: connection.connectionTimeoutMillis,
    };
}

async function verifyIdentity(client, database) {
    const result = await client.query(
        `SELECT current_database() AS database_name,
                current_user AS database_user,
                inet_server_addr()::text AS server_address,
                current_setting('port') AS server_port,
                current_setting('data_directory') AS data_directory,
                role.rolsuper AS is_superuser
         FROM pg_roles role
         WHERE role.rolname = current_user`
    );
    assert.deepEqual(result.rows[0], {
        database_name: database,
        database_user: connection.user,
        server_address: null,
        server_port: String(connection.port),
        data_directory: connection.expectedDataDirectory,
        is_superuser: true,
    });
}

async function snapshot(client) {
    const result = await client.query(
        `SELECT
            (SELECT count(*)::int FROM public.kyc_records) AS kyc_count,
            (SELECT count(*)::int FROM public.pending_registrations) AS pending_count,
            (SELECT count(*)::int FROM public.worker_national_id_verification_evidence) AS evidence_count,
            (SELECT count(*)::int FROM public.kyc_records WHERE national_id = 'ENCRYPTED') AS kyc_redacted,
            (SELECT count(*)::int FROM public.pending_registrations WHERE national_id = 'ENCRYPTED') AS pending_redacted,
            md5(COALESCE((
                SELECT string_agg(national_id, ':' ORDER BY kyc_id)
                FROM public.kyc_records
            ), '')) AS kyc_plaintext_digest,
            md5(COALESCE((
                SELECT string_agg(national_id, ':' ORDER BY pending_registration_id)
                FROM public.pending_registrations
            ), '')) AS pending_plaintext_digest`
    );
    return result.rows[0];
}

async function createClone(name) {
    assert.match(name, /^micopesa_nid_security_test_contract_[a-zA-Z0-9_-]+$/);
    const client = new Client(databaseConfig("postgres"));
    await client.connect();
    try {
        await verifyIdentity(client, "postgres");
        const existing = await client.query(
            "SELECT 1 FROM pg_database WHERE datname = $1",
            [name]
        );
        assert.equal(existing.rowCount, 0, "test database name must not already exist");
        const activeConnections = await client.query(
            `SELECT count(*)::int AS count
             FROM pg_stat_activity
             WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [connection.database]
        );
        assert.equal(activeConnections.rows[0].count, 0, "template database must have no active connections");
        await client.query(`CREATE DATABASE "${name}" TEMPLATE "${connection.database}"`);
        createdDatabases.push(name);
    } finally {
        await client.end();
    }
}

async function mutateEvidence(database, scenario) {
    const client = new Client(databaseConfig(database));
    await client.connect();
    try {
        await verifyIdentity(client, database);
        const sample = await client.query(
            `SELECT source_record_id
             FROM public.worker_national_id_verification_evidence
             WHERE source_table = 'kyc_records'
             ORDER BY source_record_id
             LIMIT 1`
        );
        assert.equal(sample.rowCount, 1, "template must contain a KYC verification-evidence row");
        const recordId = sample.rows[0].source_record_id;
        if (scenario === "unsupported-version") {
            await client.query(
                `UPDATE public.kyc_records
                 SET national_id_key_version = 'v99'
                 WHERE kyc_id = $1`,
                [recordId]
            );
            return;
        }

        await client.query(
            "ALTER TABLE public.worker_national_id_verification_evidence DISABLE TRIGGER ALL"
        );
        if (scenario === "missing-evidence") {
            await client.query(
                `DELETE FROM public.worker_national_id_verification_evidence
                 WHERE source_table = 'kyc_records' AND source_record_id = $1`,
                [recordId]
            );
        } else if (scenario === "wrong-record") {
            await client.query(
                `UPDATE public.worker_national_id_verification_evidence
                 SET source_record_id = 'FOREIGN-RECORD'
                 WHERE source_table = 'kyc_records' AND source_record_id = $1`,
                [recordId]
            );
        } else if (scenario === "mismatched-fingerprint") {
            await client.query(
                `UPDATE public.worker_national_id_verification_evidence
                 SET national_id_fingerprint = repeat('0', 64)
                 WHERE source_table = 'kyc_records' AND source_record_id = $1`,
                [recordId]
            );
        } else if (scenario === "mismatched-ciphertext") {
            await client.query(
                `UPDATE public.worker_national_id_verification_evidence
                 SET national_id_ciphertext = decode('ff', 'hex')
                 WHERE source_table = 'kyc_records' AND source_record_id = $1`,
                [recordId]
            );
        } else if (scenario === "mismatched-nonce") {
            await client.query(
                `UPDATE public.worker_national_id_verification_evidence
                 SET national_id_iv = decode(repeat('00', 12), 'hex')
                 WHERE source_table = 'kyc_records' AND source_record_id = $1`,
                [recordId]
            );
        } else if (scenario === "mismatched-tag") {
            await client.query(
                `UPDATE public.worker_national_id_verification_evidence
                 SET national_id_tag = decode(repeat('00', 16), 'hex')
                 WHERE source_table = 'kyc_records' AND source_record_id = $1`,
                [recordId]
            );
        } else {
            throw new Error("Unknown evidence mutation scenario.");
        }
        await client.query(
            "ALTER TABLE public.worker_national_id_verification_evidence ENABLE TRIGGER ALL"
        );
    } finally {
        await client.end();
    }
}

async function applyContract(database) {
    const client = new Client(databaseConfig(database));
    await client.connect();
    try {
        await verifyIdentity(client, database);
        await client.query(contractSql);
        return { success: true };
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        return { success: false, code: error.code };
    } finally {
        await client.end();
    }
}

async function removeClones() {
    if (createdDatabases.length === 0) return;
    const client = new Client(databaseConfig("postgres"));
    await client.connect();
    try {
        await verifyIdentity(client, "postgres");
        for (const name of createdDatabases) {
            assert.ok(name.startsWith(clonePrefix));
            await client.query(`DROP DATABASE "${name}"`);
        }
        createdDatabases.length = 0;
    } finally {
        await client.end();
    }
}

test("isolated contract migration requires exact evidence and redacts only on success", {
    skip: !enabled && "requires explicit disposable local socket/database fields",
}, async () => {
    const base = new Client(databaseConfig(connection.database));
    await base.connect();
    try {
        await verifyIdentity(base, connection.database);
        const baseSnapshot = await snapshot(base);
        assert.ok(baseSnapshot.kyc_count > 0);
        assert.ok(baseSnapshot.pending_count > 0);
        assert.ok(baseSnapshot.evidence_count > 0);
        assert.equal(baseSnapshot.kyc_redacted, 0);
        assert.equal(baseSnapshot.pending_redacted, 0);
    } finally {
        await base.end();
    }

    const scenarios = [
        "missing-evidence",
        "wrong-record",
        "mismatched-fingerprint",
        "mismatched-ciphertext",
        "mismatched-nonce",
        "mismatched-tag",
        "unsupported-version",
    ];
    const successName = `${clonePrefix}success`;
    const failureNames = scenarios.map((scenario, index) => `${clonePrefix}failure_${index}`);

    try {
        await createClone(successName);
        for (const name of failureNames) await createClone(name);

        const success = await applyContract(successName);
        assert.equal(success.success, true);
        const successfulDatabase = new Client(databaseConfig(successName));
        await successfulDatabase.connect();
        try {
            await verifyIdentity(successfulDatabase, successName);
            const result = await snapshot(successfulDatabase);
            assert.equal(result.kyc_redacted, result.kyc_count);
            assert.equal(result.pending_redacted, result.pending_count);
            const defaults = await successfulDatabase.query(
                `SELECT table_name, column_default
                 FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name IN ('kyc_records', 'pending_registrations')
                   AND column_name = 'national_id_key_version'`
            );
            assert.equal(defaults.rowCount, 2);
            assert.ok(defaults.rows.every((row) => row.column_default.includes("'v1'")));
        } finally {
            await successfulDatabase.end();
        }

        for (let index = 0; index < scenarios.length; index += 1) {
            const scenario = scenarios[index];
            const database = failureNames[index];
            await mutateEvidence(database, scenario);
            const client = new Client(databaseConfig(database));
            await client.connect();
            try {
                await verifyIdentity(client, database);
                const before = await snapshot(client);
                const result = await applyContract(database);
                assert.equal(result.success, false, `${scenario} must block contract migration`);
                assert.equal(result.code, "P0001");
                assert.deepEqual(await snapshot(client), before);
                assert.equal(before.kyc_redacted, 0);
                assert.equal(before.pending_redacted, 0);
            } finally {
                await client.end();
            }
        }
    } finally {
        await removeClones();
    }
});
