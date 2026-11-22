const { after, test } = require("node:test");
const assert = require("node:assert/strict");
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
    throw new Error("Provide all non-secret isolated National ID security test connection fields.");
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
    throw new Error("National ID security tests accept only the named local disposable socket/database.");
}

const admin = enabled ? new Client(connection) : null;
let adminConnected = false;

after(async () => {
    if (adminConnected) await admin.end();
});

async function expectFailure(client, sql, values, expectedCode, label) {
    await client.query("SAVEPOINT national_id_role_probe");
    await assert.rejects(
        client.query(sql, values),
        (error) => error.code === expectedCode,
        label
    );
    await client.query("ROLLBACK TO SAVEPOINT national_id_role_probe");
    await client.query("RELEASE SAVEPOINT national_id_role_probe");
}

test("isolated PostgreSQL National ID evidence role boundary", {
    skip: !enabled && "requires explicit disposable local socket/database fields",
}, async () => {
    await admin.connect();
    adminConnected = true;
    const identity = await admin.query(
        `SELECT current_database() AS database_name,
                current_user AS database_user,
                inet_server_addr()::text AS server_address,
                current_setting('port') AS server_port,
                current_setting('data_directory') AS data_directory,
                role.rolsuper AS is_superuser
         FROM pg_roles role
         WHERE role.rolname = current_user`
    );
    assert.equal(identity.rows[0]?.database_name, connection.database);
    assert.equal(identity.rows[0]?.database_user, connection.user);
    assert.equal(identity.rows[0]?.server_address, null);
    assert.equal(identity.rows[0]?.server_port, String(connection.port));
    assert.equal(identity.rows[0]?.data_directory, connection.expectedDataDirectory);
    assert.equal(identity.rows[0]?.is_superuser, true);

    const ownership = await admin.query(
        `SELECT pg_get_userbyid(table_class.relowner) AS table_owner,
                pg_get_userbyid(trigger_function.proowner) AS trigger_owner
         FROM pg_class table_class
         JOIN pg_proc trigger_function
           ON trigger_function.oid =
              'public.guard_worker_national_id_verification_evidence()'::regprocedure
         WHERE table_class.oid =
               'public.worker_national_id_verification_evidence'::regclass`
    );
    assert.deepEqual(ownership.rows[0], {
        table_owner: "micopesa_national_id_evidence_owner",
        trigger_owner: "micopesa_national_id_evidence_owner",
    });

    const permissions = await admin.query(
        `SELECT
            EXISTS (
                SELECT 1
                FROM pg_class relation
                CROSS JOIN LATERAL aclexplode(
                    COALESCE(relation.relacl, acldefault('r', relation.relowner))
                ) privilege
                WHERE relation.oid =
                      'public.worker_national_id_verification_evidence'::regclass
                  AND privilege.grantee = 0
                  AND privilege.privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
            ) AS public_can_write_evidence,
            has_table_privilege(
                'micopesa_api_test',
                'public.worker_national_id_verification_evidence',
                'INSERT'
            ) AS api_table_insert,
            has_table_privilege(
                'micopesa_api_test',
                'public.worker_national_id_verification_evidence',
                'UPDATE'
            ) AS api_table_update,
            has_table_privilege(
                'micopesa_api_test',
                'public.worker_national_id_verification_evidence',
                'DELETE'
            ) AS api_table_delete,
            has_column_privilege(
                'micopesa_national_id_verifier',
                'public.worker_national_id_verification_evidence',
                'source_table',
                'INSERT'
            ) AS verifier_can_insert_evidence,
            has_column_privilege(
                'micopesa_national_id_verifier',
                'public.worker_national_id_verification_evidence',
                'verified_by',
                'INSERT'
            ) AS verifier_can_set_verified_by,
            has_table_privilege(
                'micopesa_national_id_verifier',
                'public.worker_national_id_verification_evidence',
                'UPDATE'
            ) AS verifier_table_update,
            has_table_privilege(
                'micopesa_national_id_verifier',
                'public.worker_national_id_verification_evidence',
                'DELETE'
            ) AS verifier_table_delete,
            has_column_privilege(
                'micopesa_national_id_verifier',
                'public.kyc_records',
                'national_id',
                'SELECT'
            ) AS verifier_can_read_legacy_kyc_id,
            has_column_privilege(
                'micopesa_national_id_verifier',
                'public.kyc_records',
                'kyc_status',
                'SELECT'
            ) AS verifier_can_read_unneeded_kyc_status,
            has_column_privilege(
                'micopesa_national_id_verifier',
                'public.kyc_records',
                'national_id_ciphertext',
                'UPDATE'
            ) AS verifier_can_update_ciphertext,
            has_column_privilege(
                'micopesa_national_id_verifier',
                'public.kyc_records',
                'kyc_status',
                'UPDATE'
            ) AS verifier_can_update_kyc_status,
            has_column_privilege(
                'micopesa_national_id_verifier',
                'public.pending_registrations',
                'email',
                'SELECT'
            ) AS verifier_can_read_pending_email,
            has_table_privilege(
                'micopesa_national_id_verifier',
                'public.worker_national_id_claims',
                'UPDATE'
            ) AS verifier_can_update_claims,
            has_schema_privilege(
                'micopesa_national_id_verifier',
                'public',
                'CREATE'
            ) AS verifier_can_create_in_public,
            has_schema_privilege(
                'micopesa_national_id_evidence_owner',
                'public',
                'CREATE'
            ) AS evidence_owner_can_create_in_public,
            pg_has_role(
                'micopesa_api_test',
                'micopesa_national_id_verifier',
                'MEMBER'
            ) AS api_is_verifier_member`
    );
    assert.deepEqual(permissions.rows[0], {
        public_can_write_evidence: false,
        api_table_insert: false,
        api_table_update: false,
        api_table_delete: false,
        verifier_can_insert_evidence: true,
        verifier_can_set_verified_by: false,
        verifier_table_update: false,
        verifier_table_delete: false,
        verifier_can_read_legacy_kyc_id: true,
        verifier_can_read_unneeded_kyc_status: false,
        verifier_can_update_ciphertext: true,
        verifier_can_update_kyc_status: false,
        verifier_can_read_pending_email: false,
        verifier_can_update_claims: false,
        verifier_can_create_in_public: false,
        evidence_owner_can_create_in_public: false,
        api_is_verifier_member: false,
    });

    const apiClient = new Client({ ...connection, user: "micopesa_api_test" });
    await apiClient.connect();
    try {
        const apiIdentity = await apiClient.query(
            "SELECT current_database() AS database_name, session_user AS database_user"
        );
        assert.equal(apiIdentity.rows[0]?.database_name, connection.database);
        assert.equal(apiIdentity.rows[0]?.database_user, "micopesa_api_test");
        await assert.rejects(
            apiClient.query("SET ROLE micopesa_national_id_verifier"),
            (error) => error.code === "42501"
        );
    } finally {
        await apiClient.end();
    }

    const sample = await admin.query(
        `SELECT source_table, source_record_id
         FROM public.worker_national_id_verification_evidence
         LIMIT 1`
    );
    assert.equal(sample.rows.length, 1, "run this test after the isolated backfill rehearsal");

    await admin.query("BEGIN");
    try {
        await admin.query("SET LOCAL ROLE micopesa_api_test");
        await expectFailure(
            admin,
            `INSERT INTO public.worker_national_id_verification_evidence (
                 source_table, source_record_id, national_id_fingerprint,
                 national_id_ciphertext, national_id_iv, national_id_tag,
                 national_id_key_version, national_id_last_four,
                 verified_plaintext_fingerprint, plaintext_matched
             ) VALUES ('kyc_records', 'api-probe', repeat('0', 64),
                       decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
                       decode(repeat('00', 16), 'hex'), 'v1', '0000',
                       repeat('0', 64), TRUE)`,
            [],
            "42501",
            "API role must not insert evidence"
        );
        await expectFailure(
            admin,
            `UPDATE public.worker_national_id_verification_evidence
             SET national_id_last_four = '9999'
             WHERE source_table = $1 AND source_record_id = $2`,
            [sample.rows[0].source_table, sample.rows[0].source_record_id],
            "42501",
            "API role must not update evidence"
        );
        await expectFailure(
            admin,
            `DELETE FROM public.worker_national_id_verification_evidence
             WHERE source_table = $1 AND source_record_id = $2`,
            [sample.rows[0].source_table, sample.rows[0].source_record_id],
            "42501",
            "API role must not delete evidence"
        );
        await admin.query("ROLLBACK");
    } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
    }

    await admin.query("BEGIN");
    try {
        await expectFailure(
            admin,
            `INSERT INTO public.worker_national_id_verification_evidence (
                 source_table, source_record_id, national_id_fingerprint,
                 national_id_ciphertext, national_id_iv, national_id_tag,
                 national_id_key_version, national_id_last_four,
                 verified_plaintext_fingerprint, plaintext_matched
             ) VALUES ('kyc_records', 'non-verifier-probe', repeat('0', 64),
                       decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
                       decode(repeat('00', 16), 'hex'), 'v1', '0000',
                       repeat('0', 64), TRUE)`,
            [],
            "P0001",
            "Non-verifier session must be rejected by the evidence trigger"
        );
        await expectFailure(
            admin,
            `UPDATE public.worker_national_id_verification_evidence
             SET national_id_last_four = '9999'
             WHERE source_table = $1 AND source_record_id = $2`,
            [sample.rows[0].source_table, sample.rows[0].source_record_id],
            "P0001",
            "Evidence trigger must reject updates"
        );
        await expectFailure(
            admin,
            `DELETE FROM public.worker_national_id_verification_evidence
             WHERE source_table = $1 AND source_record_id = $2`,
            [sample.rows[0].source_table, sample.rows[0].source_record_id],
            "P0001",
            "Evidence trigger must reject deletes"
        );
        await admin.query("ROLLBACK");
    } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
    }

    const verifierClient = new Client({
        ...connection,
        user: "micopesa_national_id_verifier",
    });
    await verifierClient.connect();
    try {
        const verifierIdentity = await verifierClient.query(
            "SELECT current_database() AS database_name, session_user AS database_user"
        );
        assert.equal(verifierIdentity.rows[0]?.database_name, connection.database);
        assert.equal(verifierIdentity.rows[0]?.database_user, "micopesa_national_id_verifier");
        await verifierClient.query("BEGIN");
        try {
            const inserted = await verifierClient.query(
                `INSERT INTO public.worker_national_id_verification_evidence (
                     source_table, source_record_id, national_id_fingerprint,
                     national_id_ciphertext, national_id_iv, national_id_tag,
                     national_id_key_version, national_id_last_four,
                     verified_plaintext_fingerprint, plaintext_matched
                 ) VALUES ('kyc_records', 'verifier-probe', repeat('0', 64),
                           decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
                           decode(repeat('00', 16), 'hex'), 'v1', '0000',
                           repeat('0', 64), TRUE)
                 RETURNING verified_by`
            );
            assert.equal(inserted.rows[0]?.verified_by, "micopesa_national_id_verifier");
            await expectFailure(
                verifierClient,
                `INSERT INTO public.worker_national_id_verification_evidence (
                     source_table, source_record_id, national_id_fingerprint,
                     national_id_ciphertext, national_id_iv, national_id_tag,
                     national_id_key_version, national_id_last_four,
                     verified_plaintext_fingerprint, plaintext_matched
                 ) VALUES ('kyc_records', 'unsupported-version-probe', repeat('0', 64),
                           decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
                           decode(repeat('00', 16), 'hex'), 'v99', '0000',
                           repeat('0', 64), TRUE)`,
                [],
                "23514",
                "Evidence must reject unsupported encryption key versions"
            );
            await expectFailure(
                verifierClient,
                `UPDATE public.worker_national_id_verification_evidence
                 SET national_id_last_four = '9999'
                 WHERE source_table = 'kyc_records' AND source_record_id = 'verifier-probe'`,
                [],
                "42501",
                "Verifier must not update evidence"
            );
            await expectFailure(
                verifierClient,
                `DELETE FROM public.worker_national_id_verification_evidence
                 WHERE source_table = 'kyc_records' AND source_record_id = 'verifier-probe'`,
                [],
                "42501",
                "Verifier must not delete evidence"
            );
            await verifierClient.query("ROLLBACK");
        } catch (error) {
            await verifierClient.query("ROLLBACK");
            throw error;
        }
    } finally {
        await verifierClient.end();
    }
});
