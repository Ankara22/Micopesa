const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const databaseDirectory = path.resolve(__dirname, "../../../database");
const schema = fs.readFileSync(path.join(databaseDirectory, "schema.sql"), "utf8");
const persistentSmsMigration = fs.readFileSync(
    path.join(databaseDirectory, "migration_sms_persistent_delivery.sql"),
    "utf8"
);
const transactionalMigration = fs.readFileSync(
    path.join(databaseDirectory, "migration_transactional_notifications.sql"),
    "utf8"
);
const unifiedMigration = fs.readFileSync(
    path.join(databaseDirectory, "migration_unified_notifications.sql"),
    "utf8"
);
const roleMigration = fs.readFileSync(
    path.join(databaseDirectory, "migration_role_notifications_and_reporting.sql"),
    "utf8"
);
const complianceMigration = fs.readFileSync(
    path.join(databaseDirectory, "migration_compliance_review_workflow.sql"),
    "utf8"
);
const complianceEnforcementMigration = fs.readFileSync(
    path.join(databaseDirectory, "migration_compliance_workflow_enforcement.sql"),
    "utf8"
);
const dlrMigration = fs.readFileSync(
    path.join(databaseDirectory, "migration_mobilesasa_sms_delivery_reports.sql"),
    "utf8"
);
const externalSmsMigration = fs.readFileSync(
    path.join(databaseDirectory, "migration_external_recipient_sms.sql"),
    "utf8"
);
const forwardIntegrationMigration = fs.readFileSync(
    path.join(databaseDirectory, "migration_micopesa_integrations_forward.sql"),
    "utf8"
);
const postMigrationVerification = fs.readFileSync(
    path.join(databaseDirectory, "micopesa_audit_post_migration_verification.sql"),
    "utf8"
);
const mpesaRetryMigration = fs.readFileSync(
    path.join(databaseDirectory, "migration_mpesa_retry_recovery.sql"),
    "utf8"
);
const simulatorLedgerMigration = fs.readFileSync(
    path.join(databaseDirectory, "migration_simulator_ledger_scoped_forward.sql"),
    "utf8"
);
const withdrawalOtpMigration = fs.readFileSync(
    path.join(databaseDirectory, "migration_withdrawal_payout_otp_authorization_forward.sql"),
    "utf8"
);
const workerIdentityExpandMigration = fs.readFileSync(
    path.join(databaseDirectory, "migration_worker_identity_expand_forward.sql"),
    "utf8"
);
const workerIdentityContractMigration = fs.readFileSync(
    path.join(databaseDirectory, "migration_worker_identity_contract_forward.sql"),
    "utf8"
);
const workerApprovalMigration = fs.readFileSync(
    path.join(databaseDirectory, "migration_users_approval_status_forward.sql"),
    "utf8"
);
const workerIdentityBackfill = fs.readFileSync(
    path.resolve(__dirname, "../scripts/backfillNationalIdEncryption.js"),
    "utf8"
);
const applicationDatabaseConfiguration = fs.readFileSync(
    path.resolve(__dirname, "../src/db/database.js"),
    "utf8"
);
const pensionAccountLedgerMigration = fs.readFileSync(
    path.join(databaseDirectory, "migration_pension_account_ledger.sql"),
    "utf8"
);
const notificationEventService = fs.readFileSync(
    path.resolve(__dirname, "../src/services/notificationEventService.js"),
    "utf8"
);
const smsNotificationRepository = fs.readFileSync(
    path.resolve(__dirname, "../src/services/smsNotificationRepository.js"),
    "utf8"
);
const deploymentDocumentation = fs.readFileSync(
    path.resolve(__dirname, "../../../docs/deployment/admin-onboarding-and-settings.md"),
    "utf8"
);

function extractTable(source, tableName) {
    const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = source.match(new RegExp(
        `CREATE TABLE (?:IF NOT EXISTS )?(?:public\\.)?${escaped} \\([\\s\\S]*?\\n[ \\t]*\\);`,
        "i"
    ));
    assert.ok(match, `Expected CREATE TABLE ${tableName}`);
    return match[0]
        .replace(/\bpublic\./gi, "")
        .replace(/\bIF NOT EXISTS\b/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function extractIndex(source, indexName) {
    const escaped = indexName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = source.match(new RegExp(
        `CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?${escaped}[\\s\\S]*?;`,
        "i"
    ));
    assert.ok(match, `Expected CREATE UNIQUE INDEX ${indexName}`);
    return match[0]
        .replace(/\bpublic\./gi, "")
        .replace(/\bIF NOT EXISTS\b/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function extractFunction(source, functionName) {
    const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = source.match(new RegExp(
        `CREATE OR REPLACE FUNCTION (?:public\\.)?${escaped}\\([\\s\\S]*?\\$\\$ LANGUAGE plpgsql;`,
        "i"
    ));
    assert.ok(match, `Expected CREATE OR REPLACE FUNCTION ${functionName}`);
    return match[0]
        .replace(/\bpublic\./gi, "")
        .replace(/\s*([(),])\s*/g, "$1")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function extractTrigger(source, triggerName) {
    const escaped = triggerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = source.match(new RegExp(
        `CREATE TRIGGER ${escaped}[\\s\\S]*?;`,
        "i"
    ));
    assert.ok(match, `Expected CREATE TRIGGER ${triggerName}`);
    return match[0].replace(/\bpublic\./gi, "").replace(/\s+/g, " ").trim().toLowerCase();
}

test("simulator ledger migration limits existing-table DDL and preserves opening balances", () => {
    const alteredTables = [...simulatorLedgerMigration.matchAll(
        /\bALTER\s+TABLE\s+(?:ONLY\s+)?([a-z_][a-z0-9_.]*)/gi
    )].map((match) => match[1].toLowerCase());
    assert.deepEqual(
        [...new Set(alteredTables)],
        ["public.mpesa_payment_attempts"]
    );

    const createdTables = [...simulatorLedgerMigration.matchAll(
        /\bCREATE\s+TABLE\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi
    )].map((match) => match[1].toLowerCase());
    assert.deepEqual(
        [...new Set(createdTables)].sort(),
        [
            "pension_account_movements",
            "pension_ledger",
            "pension_ledger_cutover_batches",
            "simulator_payment_confirmations",
        ].sort()
    );

    const indexTargets = [...simulatorLedgerMigration.matchAll(
        /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+[a-z_][a-z0-9_]*\s+ON\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi
    )].map((match) => match[1].toLowerCase());
    assert.deepEqual(
        [...new Set(indexTargets)].sort(),
        ["pension_account_movements", "simulator_payment_confirmations"].sort()
    );
    assert.doesNotMatch(simulatorLedgerMigration, /\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\b/i);

    const insertedTables = [...simulatorLedgerMigration.matchAll(
        /\bINSERT\s+INTO\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi
    )].map((match) => match[1].toLowerCase());
    assert.deepEqual(
        [...new Set(insertedTables)].sort(),
        [
            "pension_account_movements",
            "pension_ledger",
            "pension_ledger_cutover_batches",
        ].sort()
    );
    assert.doesNotMatch(
        simulatorLedgerMigration,
        /\b(?:UPDATE\s+(?:public\.)?pension_accounts|DELETE\s+FROM\s+(?:public\.)?(?:pension_accounts|mpesa_payment_attempts|transactions|contributions|mpesa_payment_verifications|mpesa_callback_inbox))\b/i
    );
    assert.match(simulatorLedgerMigration, /p\.current_balance/);
    assert.match(simulatorLedgerMigration, /(?:FROM|CROSS JOIN) public\.pension_accounts p/);
    assert.match(simulatorLedgerMigration, /'PREPARING'/);
});

test("fresh and upgrade notification preference and event-key definitions agree", () => {
    assert.equal(
        extractTable(schema, "notification_preferences"),
        extractTable(transactionalMigration, "notification_preferences")
    );
    assert.equal(
        extractIndex(schema, "uq_notifications_user_channel_event_key"),
        extractIndex(transactionalMigration, "uq_notifications_user_channel_event_key")
    );
    assert.match(transactionalMigration, /migration_sms_persistent_delivery\.sql/i);
    assert.match(transactionalMigration, /migration_unified_notifications\.sql/i);
    assert.match(transactionalMigration, /already exist; do not reapply/i);
    assert.match(unifiedMigration, /migration_sms_persistent_delivery\.sql/i);
    assert.equal(
        extractTable(schema, "push_subscriptions"),
        extractTable(unifiedMigration, "push_subscriptions")
    );
});

test("canonical schema includes reporting, regulator, compliance, and DLR tables", () => {
    for (const tableName of [
        "notification_preferences",
        "push_subscriptions",
        "notification_audit_events",
        "regulator_fund_assignments",
        "report_generation_history",
        "report_download_events",
        "compliance_report_submissions",
        "compliance_report_reviews",
        "mobilesasa_sms_delivery_callbacks",
    ]) {
        assert.match(schema, new RegExp(`CREATE TABLE ${tableName}\\s*\\(`, "i"));
    }

    for (const tableName of [
        "regulator_fund_assignments",
        "report_generation_history",
        "report_download_events",
    ]) {
        assert.equal(
            extractTable(schema, tableName),
            extractTable(roleMigration, tableName)
        );
    }
    assert.equal(
        extractTable(schema, "compliance_report_submissions"),
        extractTable(complianceMigration, "compliance_report_submissions")
    );
    const schemaReviewTableDefinition = extractTable(schema, "compliance_report_reviews");
    const schemaReviewTable = schemaReviewTableDefinition
        .replace("constraint uq_compliance_report_reviews_submission unique (submission_id), ", "");
    assert.equal(
        schemaReviewTable,
        extractTable(complianceMigration, "compliance_report_reviews")
    );

    for (const [tableName, indexName, migration] of [
        ["regulator_fund_assignments", "idx_regulator_fund_assignments_active", roleMigration],
        ["report_generation_history", "idx_report_generation_history_user_created", roleMigration],
        ["report_download_events", "idx_report_download_events_report", roleMigration],
        ["compliance_report_submissions", "idx_compliance_report_submissions_report", complianceMigration],
        ["compliance_report_reviews", "idx_compliance_report_reviews_report", complianceMigration],
        ["compliance_report_reviews", "idx_compliance_report_reviews_submission", complianceMigration],
    ]) {
        assert.equal(
            extractIndex(schema, indexName),
            extractIndex(migration, indexName),
            `${tableName}.${indexName} differs between schema and migration`
        );
    }
    assert.match(
        complianceEnforcementMigration,
        /CREATE UNIQUE INDEX uq_compliance_report_reviews_submission\s+ON compliance_report_reviews \(submission_id\)/i
    );
    assert.match(
        schemaReviewTableDefinition,
        /unique \(submission_id\)/
    );
});

test("MobileSasa callback inbox schema matches its additive table migration", () => {
    assert.equal(
        extractTable(schema, "mobilesasa_sms_delivery_callbacks"),
        extractTable(dlrMigration, "mobilesasa_sms_delivery_callbacks")
    );
    assert.match(dlrMigration, /delivery_result/);
    assert.match(dlrMigration, /provider_message_id/);
    assert.match(dlrMigration, /already exists; do not reapply/i);
});

test("notification upgrade migrations reject missing prerequisites and existing objects", () => {
    assert.match(externalSmsMigration, /ck_notifications_admin_channel_snapshot/);
    assert.match(externalSmsMigration, /external-recipient SMS objects already exist/i);
    assert.doesNotMatch(externalSmsMigration, /ADD COLUMN IF NOT EXISTS/i);
});

test("migration dependency graph matches the SQL and notification service queries", () => {
    assert.match(persistentSmsMigration, /ADD COLUMN deduplication_key/);
    assert.match(persistentSmsMigration, /ADD COLUMN provider_message_id/);
    assert.match(persistentSmsMigration, /DROP CONSTRAINT notifications_delivery_status_check/);
    assert.match(schema, /CONSTRAINT ck_notifications_delivery_status/);
    assert.match(deploymentDocumentation, /does not preserve a separate historical/);

    assert.match(unifiedMigration, /ADD COLUMN admin_request_key/);
    assert.match(unifiedMigration, /ADD COLUMN delivery_result/);
    assert.match(unifiedMigration, /CREATE UNIQUE INDEX uq_notifications_admin_request_channel/);

    assert.match(transactionalMigration, /column_name = 'deduplication_key'/);
    assert.match(transactionalMigration, /CREATE UNIQUE INDEX uq_notifications_user_channel_event_key/);
    assert.match(transactionalMigration, /CREATE TABLE notification_preferences/);
    assert.doesNotMatch(transactionalMigration, /notification_category/);

    assert.match(roleMigration, /ADD COLUMN notification_category/);
    assert.match(roleMigration, /DROP INDEX uq_notifications_admin_request_channel/);
    assert.doesNotMatch(roleMigration, /notification_preferences|uq_notifications_user_channel_event_key/);

    assert.match(externalSmsMigration, /ck_notifications_admin_channel_snapshot/);
    assert.match(externalSmsMigration, /admin_request_key/);
    assert.match(dlrMigration, /'delivery_result'/);
    assert.match(dlrMigration, /'provider_message_id'/);

    assert.match(
        notificationEventService,
        /LEFT JOIN notification_preferences\s+np ON np\.user_id = u\.user_id/
    );
    assert.match(notificationEventService, /notification_category, deduplication_key/);
    assert.match(smsNotificationRepository, /notification_preferences/);
    assert.match(smsNotificationRepository, /delivery_status = 'PENDING'/);

    assert.match(deploymentDocumentation, /migration_sms_persistent_delivery\.sql/);
    assert.match(deploymentDocumentation, /migration_unified_notifications\.sql/);
    assert.match(deploymentDocumentation, /migration_transactional_notifications\.sql/);
    assert.match(deploymentDocumentation, /migration_role_notifications_and_reporting\.sql/);
    assert.match(deploymentDocumentation, /notificationEventService/);
});

test("Micopesa forward migration matches canonical inbox and preference definitions", () => {
    assert.equal(
        extractTable(schema, "notification_preferences"),
        extractTable(forwardIntegrationMigration, "notification_preferences")
    );
    assert.equal(
        extractTable(schema, "mpesa_callback_inbox"),
        extractTable(forwardIntegrationMigration, "mpesa_callback_inbox")
    );
    assert.equal(
        extractTable(mpesaRetryMigration, "mpesa_callback_inbox"),
        extractTable(forwardIntegrationMigration, "mpesa_callback_inbox")
    );
    assert.equal(
        extractTable(schema, "mobilesasa_sms_delivery_callbacks"),
        extractTable(forwardIntegrationMigration, "mobilesasa_sms_delivery_callbacks")
    );
    assert.equal(
        extractTable(dlrMigration, "mobilesasa_sms_delivery_callbacks"),
        extractTable(forwardIntegrationMigration, "mobilesasa_sms_delivery_callbacks")
    );
    assert.match(forwardIntegrationMigration, /CREATE FUNCTION preserve_mobilesasa_callback_notification_reference/i);
    assert.match(forwardIntegrationMigration, /uq_mobilesasa_callback_provider_reference_status/);
    assert.match(forwardIntegrationMigration, /idx_mobilesasa_callbacks_unmatched/);
    assert.match(forwardIntegrationMigration, /idx_mpesa_callback_inbox_provider_ids/);
});

test("Micopesa forward migration preflights unique-index data and fails closed on schema drift", () => {
    for (const objectName of [
        "mpesa_callback_inbox",
        "mobilesasa_sms_delivery_callbacks",
    ]) {
        assert.match(
            forwardIntegrationMigration,
            new RegExp(`to_regclass\\('${objectName}'\\) IS NOT NULL`, "i")
        );
    }

    assert.match(forwardIntegrationMigration, /GROUP BY user_id, notification_type, deduplication_key\s+HAVING COUNT\(\*\) > 1/i);
    assert.match(forwardIntegrationMigration, /GROUP BY contribution_id\s+HAVING COUNT\(\*\) > 1/i);
    assert.match(forwardIntegrationMigration, /GROUP BY admin_request_key, user_id, notification_type\s+HAVING COUNT\(\*\) > 1/i);
    assert.match(forwardIntegrationMigration, /GROUP BY provider_message_id\s+HAVING COUNT\(\*\) > 1/i);
    assert.match(forwardIntegrationMigration, /ck_notifications_delivery_status has an unexpected definition/i);
    assert.match(forwardIntegrationMigration, /refusing to replace an unrecognized constraint/i);
    assert.match(forwardIntegrationMigration, /Conflicting object uq_notifications_user_channel_event_key/i);
    assert.match(forwardIntegrationMigration, /Conflicting object uq_notifications_admin_request_channel/i);
    assert.match(forwardIntegrationMigration, /Conflicting object uq_notifications_provider_message_id/i);
    assert.match(forwardIntegrationMigration, /scope_fund_id must reference funds\(fund_id\) ON DELETE SET NULL/i);
    assert.match(forwardIntegrationMigration, /ck_notifications_delivery_status has unexpected logic/i);
    assert.match(forwardIntegrationMigration, /expected a single-value-list check/i);
    assert.match(forwardIntegrationMigration, /indnullsnotdistinct/i);
    assert.match(forwardIntegrationMigration, /indnatts = i\.indnkeyatts/i);
    assert.match(forwardIntegrationMigration, /access_method\.amname = 'btree'/i);
    assert.match(forwardIntegrationMigration, /attempt_status=anyarray\[''pending'',''outcome_unknown'',''prompt_accepted''\]/i);
    assert.doesNotMatch(forwardIntegrationMigration, /pg_get_expr\(i\.indpred, i\.indrelid\) LIKE '%(?:PENDING|OUTCOME_UNKNOWN|PROMPT_ACCEPTED)%'/i);
    assert.match(forwardIntegrationMigration, /BEGIN;\s*DO \$preflight\$/i);
    assert.match(forwardIntegrationMigration, /COMMIT;\s*$/i);
    assert.doesNotMatch(forwardIntegrationMigration, /CREATE TABLE IF NOT EXISTS/i);

    const executableSql = forwardIntegrationMigration.replace(
        /--.*$|\/\*[\s\S]*?\*\//gm,
        ""
    );
    assert.doesNotMatch(executableSql, /\bDROP\s+TABLE\b|\bDELETE\s+FROM\b|\bTRUNCATE\b/i);
    assert.doesNotMatch(executableSql, /\bUPDATE\s+(?:notifications|notification_preferences|mpesa_payment_attempts)\s+SET\b/i);
});

test("Micopesa forward migration reuses notification preferences only when compatible", () => {
    const preferencePreflight = forwardIntegrationMigration.match(
        /IF to_regclass\('notification_preferences'\) IS NOT NULL THEN([\s\S]*?)\n    IF to_regclass\('mpesa_callback_inbox'\)/i
    )?.[1];
    assert.ok(preferencePreflight, "Expected notification preference compatibility preflight");
    for (const column of ["user_id", "sms_enabled", "email_enabled", "created_at", "updated_at"]) {
        assert.match(
            preferencePreflight,
            new RegExp(`\\('${column}',`, "i"),
            `Expected compatibility validation for ${column}`
        );
    }
    assert.match(preferencePreflight, /column_info\.data_type/i);
    assert.match(preferencePreflight, /column_info\.character_maximum_length/i);
    assert.match(preferencePreflight, /column_info\.is_nullable/i);
    assert.match(preferencePreflight, /expected exactly 5 columns/i);
    assert.match(preferencePreflight, /is_identity/i);
    assert.match(preferencePreflight, /is_generated/i);
    assert.match(preferencePreflight, /unexpected default/i);
    assert.match(preferencePreflight, /primary key must contain only user_id/i);
    assert.match(
        preferencePreflight,
        /user_id must reference users\(user_id\) ON DELETE CASCADE/i
    );
    assert.match(preferencePreflight, /contype::TEXT = 'n'/i);
    assert.match(preferencePreflight, /a required PostgreSQL NOT NULL constraint is missing/i);
    assert.doesNotMatch(preferencePreflight, /expected exactly .* constraints/i);
    assert.match(preferencePreflight, /notification_preferences_user_id_fkey/i);
    assert.match(preferencePreflight, /local_column\.atttypid = referenced_column\.atttypid/i);
    assert.match(preferencePreflight, /local_column\.atttypmod = referenced_column\.atttypmod/i);
    assert.match(preferencePreflight, /trigger trg_notification_preferences_set_updated_at has an unexpected definition/i);
    assert.doesNotMatch(preferencePreflight, /notification_preferences already exists/i);

    const preferenceCreation = forwardIntegrationMigration.match(
        /DO \$notification_objects\$([\s\S]*?)\$notification_objects\$;/i
    )?.[1];
    assert.ok(preferenceCreation, "Expected conditional notification object creation");
    assert.match(
        preferenceCreation,
        /IF to_regclass\('notification_preferences'\) IS NULL THEN\s+CREATE TABLE notification_preferences/i
    );
    assert.doesNotMatch(
        preferenceCreation,
        /ELSE[\s\S]*?(?:ALTER TABLE notification_preferences|DROP TABLE notification_preferences|CREATE TABLE notification_preferences)/i
    );
    assert.match(
        preferenceCreation,
        /CREATE TABLE notification_preferences\s*\([\s\S]*?sms_enabled BOOLEAN NOT NULL DEFAULT FALSE[\s\S]*?email_enabled BOOLEAN NOT NULL DEFAULT FALSE[\s\S]*?created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now\(\)[\s\S]*?updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now\(\)/i
    );
    assert.match(preferenceCreation, /IF NOT EXISTS \([\s\S]*?trg_notification_preferences_set_updated_at/i);
});

test("Micopesa forward migration reuses only a compatible Daraja callback inbox", () => {
    const callbackPreflight = forwardIntegrationMigration.match(
        /IF to_regclass\('mpesa_callback_inbox'\) IS NOT NULL THEN([\s\S]*?)IF to_regclass\('mobilesasa_sms_delivery_callbacks'\)/i
    )?.[1];
    assert.ok(callbackPreflight, "Expected Daraja callback inbox compatibility preflight");
    for (const column of [
        "callback_id",
        "callback_fingerprint",
        "checkout_request_id",
        "merchant_request_id",
        "callback_result_code",
        "callback_status",
        "callback_amount",
        "callback_phone",
        "callback_receipt",
        "attempt_id",
        "verification_id",
        "correlated_at",
        "verified_at",
        "rejection_code",
        "duplicate_count",
        "received_at",
        "updated_at",
    ]) {
        assert.match(
            callbackPreflight,
            new RegExp(`\\('${column}',`, "i"),
            `Expected compatibility validation for ${column}`
        );
    }
    assert.match(callbackPreflight, /expected a regular table/i);
    assert.match(callbackPreflight, /expected exactly 17 columns/i);
    assert.match(callbackPreflight, /numeric_precision/i);
    assert.match(callbackPreflight, /numeric_scale/i);
    assert.match(
        callbackPreflight,
        /expected_callback_column\.data_type = 'numeric'[\s\S]*?actual_callback_numeric_precision IS DISTINCT FROM expected_callback_column\.numeric_precision[\s\S]*?actual_callback_numeric_scale IS DISTINCT FROM expected_callback_column\.numeric_scale/i
    );
    assert.match(
        callbackPreflight,
        /\('callback_id', 'bigint', NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, 'NO', 'sequence'\)/i
    );
    assert.match(callbackPreflight, /actual_callback_default NOT LIKE 'nextval\(%'/i);
    assert.match(callbackPreflight, /character_maximum_length/i);
    assert.match(callbackPreflight, /is_identity/i);
    assert.match(callbackPreflight, /is_generated/i);
    assert.match(callbackPreflight, /sequence-backed default/i);
    assert.match(callbackPreflight, /sequence_ownership/i);
    assert.match(callbackPreflight, /FROM pg_sequence sequence_definition/i);
    assert.match(callbackPreflight, /callback_id sequence is missing, unowned, or not used by its default/i);
    assert.match(callbackPreflight, /contype::TEXT = 'n'/i);
    assert.match(callbackPreflight, /a required PostgreSQL NOT NULL constraint is missing/i);
    assert.doesNotMatch(callbackPreflight, /expected exactly .* constraints/i);
    assert.doesNotMatch(callbackPreflight, /structural_constraint_count\s*<>/i);
    assert.match(callbackPreflight, /unexpected case-sensitive literals/i);
    assert.match(callbackPreflight, /ARRAY\['CORRELATED', 'REJECTED', 'UNMATCHED', 'VERIFIED'\]/i);
    assert.doesNotMatch(
        callbackPreflight,
        /SELECT count\(\*\)::INTEGER\s+INTO callback_structural_constraint_count\s+FROM pg_constraint\s+WHERE conrelid = to_regclass\('mpesa_callback_inbox'\);/i
    );
    assert.match(callbackPreflight, /condeferrable/i);
    assert.match(callbackPreflight, /checkcallback_status=anyarray\[''unmatched'',''correlated'',''verified'',''rejected''\]/i);
    assert.match(callbackPreflight, /constraint % has an unexpected definition/i);
    assert.match(callbackPreflight, /attempt_id must reference mpesa_payment_attempts\(attempt_id\) ON DELETE RESTRICT/i);
    assert.match(callbackPreflight, /verification_id must reference mpesa_payment_verifications\(verification_id\) ON DELETE RESTRICT/i);
    assert.match(callbackPreflight, /confmatchtype = 's'/i);
    assert.match(callbackPreflight, /local_column\.atttypid = referenced_column\.atttypid/i);
    assert.match(callbackPreflight, /local_column\.atttypmod = referenced_column\.atttypmod/i);
    assert.match(callbackPreflight, /index name % is used by a different relation/i);
    assert.match(callbackPreflight, /access_method\.amname/i);
    assert.match(callbackPreflight, /indisready/i);
    assert.match(callbackPreflight, /indislive/i);
    assert.match(callbackPreflight, /indexprs IS NOT NULL/i);
    assert.match(callbackPreflight, /trigger trg_mpesa_callback_inbox_set_updated_at has an unexpected definition/i);
    assert.match(
        callbackPreflight,
        /expected_callback_index\.predicate IS NULL\s+AND pg_get_expr\([\s\S]*?\) IS NOT NULL/i
    );
    assert.match(
        callbackPreflight,
        /expected_callback_index\.predicate IS NOT NULL\s+AND regexp_replace\([\s\S]*?\) IS DISTINCT FROM expected_callback_index\.predicate/i
    );
    assert.doesNotMatch(callbackPreflight, /OR CASE\s+WHEN expected_callback_index\.predicate/i);
    assert.match(callbackPreflight, /END IF;\s*END LOOP;\s*SELECT count\(\*\) FILTER/i);

    const callbackCreation = forwardIntegrationMigration.match(
        /DO \$mpesa_callback_inbox_objects\$([\s\S]*?)\$mpesa_callback_inbox_objects\$;/i
    )?.[1];
    assert.ok(callbackCreation, "Expected conditional Daraja callback inbox object creation");
    assert.match(
        callbackCreation,
        /IF to_regclass\('mpesa_callback_inbox'\) IS NULL THEN\s+CREATE TABLE mpesa_callback_inbox/i
    );
    assert.match(callbackCreation, /CREATE INDEX idx_mpesa_callback_inbox_status_received/i);
    assert.match(callbackCreation, /CREATE INDEX idx_mpesa_callback_inbox_provider_ids/i);
    assert.match(callbackCreation, /CREATE INDEX idx_mpesa_callback_inbox_attempt/i);
    assert.match(callbackCreation, /CREATE TRIGGER trg_mpesa_callback_inbox_set_updated_at/i);
    assert.match(callbackCreation, /END IF;\s*END\s*$/i);
    assert.doesNotMatch(callbackCreation, /ELSE[\s\S]*?(?:ALTER TABLE|DROP TABLE)/i);
});

test("PostgreSQL 18 NOT NULL constraints are checked separately from structural constraints", () => {
    const callbackPreflight = forwardIntegrationMigration.match(
        /IF to_regclass\('mpesa_callback_inbox'\) IS NOT NULL THEN([\s\S]*?)IF to_regclass\('mobilesasa_sms_delivery_callbacks'\)/i
    )?.[1];
    assert.ok(callbackPreflight, "Expected callback inbox preflight");
    assert.match(callbackPreflight, /constraint_data\.contype::TEXT = 'n'/i);
    assert.match(callbackPreflight, /a required PostgreSQL NOT NULL constraint is missing/i);
    assert.match(callbackPreflight, /expected_callback_constraint/);
    assert.doesNotMatch(callbackPreflight, /structural_constraint_count\s*<>/i);
    assert.doesNotMatch(callbackPreflight, /NOT NULL constraint_count\s*<>/i);
});

test("Micopesa forward migration validates and safely reuses MobileSasa callback objects", () => {
    const mobilesasaPreflight = forwardIntegrationMigration.match(
        /IF to_regclass\('mobilesasa_sms_delivery_callbacks'\) IS NOT NULL THEN([\s\S]*?)SELECT pg_get_constraintdef\(oid\)/i
    )?.[1];
    assert.ok(mobilesasaPreflight, "Expected MobileSasa callback compatibility preflight");
    for (const column of [
        "callback_id", "provider", "provider_message_reference", "tracking_id",
        "provider_dispatch_reference", "delivery_status", "delivery_description",
        "delivery_code", "gateway", "provider_delivery_time", "provider_delivered_at",
        "provider_reported_at", "notification_id", "original_notification_id",
        "processing_status", "rejection_code", "duplicate_count",
        "signature_verified_at", "received_at", "correlated_at", "processed_at",
        "updated_at",
    ]) {
        assert.match(mobilesasaPreflight, new RegExp(`\\('${column}',`, "i"));
    }
    assert.match(mobilesasaPreflight, /callback_id sequence is missing, unowned, or not used by its default/i);
    assert.match(mobilesasaPreflight, /FROM pg_sequence sequence_definition/i);
    assert.match(mobilesasaPreflight, /contype::TEXT = 'n'/i);
    assert.match(mobilesasaPreflight, /expected_mobilesasa_constraint/);
    assert.match(mobilesasaPreflight, /pg_get_constraintdef\(actual_mobilesasa_constraint\.oid\)/i);
    assert.match(mobilesasaPreflight, /unexpected case-sensitive literals/i);
    assert.match(mobilesasaPreflight, /ARRAY\['APPLIED', 'CORRELATED', 'IGNORED', 'REJECTED', 'UNMATCHED'\]/i);
    assert.match(mobilesasaPreflight, /expected_mobilesasa_index\.expected_literals/i);
    assert.match(mobilesasaPreflight, /ARRAY\['UNMATCHED'\]::TEXT\[\]/i);
    assert.match(
        mobilesasaPreflight,
        /regexp_matches\([\s\S]*?pg_get_expr\([\s\S]*?ORDER BY captures\[1\]/i
    );
    assert.equal(
        (mobilesasaPreflight.match(/mobilesasa_sms_delivery_callba_provider_message_reference_check/g) ?? []).length,
        2
    );
    assert.equal(
        (mobilesasaPreflight.match(/mobilesasa_sms_delivery_callbacks_provider_message_reference_check/g) ?? []).length,
        0
    );
    assert.match(mobilesasaPreflight, /constraint_data\.convalidated/i);
    assert.match(mobilesasaPreflight, /actual_mobilesasa_constraint\.condeferrable/i);
    assert.match(mobilesasaPreflight, /confdeltype <> 'n'/i);
    assert.match(mobilesasaPreflight, /indisready/i);
    assert.match(mobilesasaPreflight, /indislive/i);
    assert.match(mobilesasaPreflight, /indoption/);
    assert.match(mobilesasaPreflight, /pg_get_expr\(/i);
    assert.match(mobilesasaPreflight, /tgtype = 23/i);
    assert.match(mobilesasaPreflight, /tgtype = 19/i);
    assert.match(mobilesasaPreflight, /prosrc/);
    assert.doesNotMatch(mobilesasaPreflight, /expected exactly .* constraints/i);
    assert.doesNotMatch(mobilesasaPreflight, /constraint_count\s*<>/i);

    const tableCreation = forwardIntegrationMigration.match(
        /DO \$mobilesasa_callback_table\$([\s\S]*?)\$mobilesasa_callback_table\$;/i
    )?.[1];
    const functionCreation = forwardIntegrationMigration.match(
        /DO \$mobilesasa_callback_function\$([\s\S]*?)\$mobilesasa_callback_function\$;/i
    )?.[1];
    const objectCreation = forwardIntegrationMigration.match(
        /DO \$mobilesasa_callback_objects\$([\s\S]*?)\$mobilesasa_callback_objects\$;/i
    )?.[1];
    assert.match(tableCreation ?? "", /IF to_regclass\('mobilesasa_sms_delivery_callbacks'\) IS NULL THEN/i);
    assert.match(functionCreation ?? "", /IF to_regprocedure\('preserve_mobilesasa_callback_notification_reference\(\)'\) IS NULL THEN/i);
    assert.match(objectCreation ?? "", /IF to_regclass\('idx_mobilesasa_callbacks_unmatched'\) IS NULL THEN/i);
    assert.match(objectCreation ?? "", /trg_mobilesasa_callbacks_preserve_notification_reference/i);
    assert.match(objectCreation ?? "", /trg_mobilesasa_callbacks_set_updated_at/i);
});

test("MobileSasa orphan-index guard is scoped and allows compatible inbox reuse", () => {
    const orphanGuard = forwardIntegrationMigration.match(
        /IF NOT EXISTS \(\s*SELECT 1\s+FROM pg_class callback_table([\s\S]*?)MobileSasa callback index names exist without their inbox table/i
    )?.[0];
    assert.ok(orphanGuard, "Expected a catalog-scoped orphan-index guard");
    assert.match(
        orphanGuard,
        /^IF NOT EXISTS \([\s\S]*?\)\s+AND EXISTS \([\s\S]*?\) THEN/i,
        "The guard must reject only when the callback table is absent and a named index exists"
    );
    assert.match(orphanGuard, /callback_schema\.nspname = current_schema\(\)/i);
    assert.match(orphanGuard, /callback_table\.relname =\s*'mobilesasa_sms_delivery_callbacks'/i);
    assert.match(orphanGuard, /callback_table\.relkind IN \('r', 'p'\)/i);
    assert.match(orphanGuard, /callback_index\.relkind IN \('i', 'I'\)/i);
    for (const indexName of [
        "idx_mobilesasa_callbacks_unmatched",
        "idx_mobilesasa_callbacks_notification",
        "idx_mobilesasa_callbacks_original_notification",
        "idx_mobilesasa_callbacks_tracking_id",
        "idx_mobilesasa_callbacks_dispatch_reference",
    ]) {
        assert.match(orphanGuard, new RegExp(indexName));
    }

    assert.doesNotMatch(
        forwardIntegrationMigration,
        /IF to_regclass\('idx_mobilesasa_callbacks_unmatched'\) IS NOT NULL[\s\S]{0,600}?Mobile Sasa callback objects exist without their inbox table/i,
        "A second unconditional guard must not reject indexes on a valid existing callback inbox"
    );
    assert.match(
        forwardIntegrationMigration,
        /IF to_regclass\('mobilesasa_sms_delivery_callbacks'\) IS NULL THEN\s+CREATE TABLE mobilesasa_sms_delivery_callbacks/i,
        "The callback inbox remains conditionally created only when absent"
    );
});

test("MobileSasa lifecycle compatibility comparison preserves boolean grouping", () => {
    const mobilesasaPreflight = forwardIntegrationMigration.match(
        /IF to_regclass\('mobilesasa_sms_delivery_callbacks'\) IS NOT NULL THEN([\s\S]*?)SELECT pg_get_constraintdef\(oid\)/i
    )?.[1];
    assert.ok(mobilesasaPreflight, "Expected MobileSasa callback compatibility preflight");

    const lifecycleComparison = mobilesasaPreflight.match(
        /IF expected_mobilesasa_constraint\.name =\s*'ck_mobilesasa_callback_lifecycle' THEN([\s\S]*?)ELSE\s+normalized_mobilesasa_constraint :=/i
    )?.[1];
    assert.ok(lifecycleComparison, "Expected a dedicated lifecycle definition comparison");
    assert.match(lifecycleComparison, /CREATE TEMP TABLE %I ON COMMIT DROP AS/i);
    assert.match(
        lifecycleComparison,
        /SELECT processing_status,\s*notification_id,\s*original_notification_id,\s*correlated_at,\s*processed_at,\s*rejection_code[\s\S]*?WITH NO DATA/i
    );
    assert.match(lifecycleComparison, /ADD CONSTRAINT expected_lifecycle CHECK/i);
    assert.match(lifecycleComparison, /pg_get_constraintdef\(constraint_data\.oid\)/i);
    assert.match(lifecycleComparison, /pg_get_constraintdef\(\s*actual_mobilesasa_constraint\.oid\s*\)/i);
    assert.match(lifecycleComparison, /normalized_expected_mobilesasa_lifecycle/i);
    assert.equal(
        (lifecycleComparison.match(/'\[\[:space:\]\]'/g) ?? []).length,
        2,
        "Actual and PostgreSQL-generated expected definitions must use the same whitespace-only normalization"
    );
    assert.doesNotMatch(lifecycleComparison, /'\[\(\)\[:space:\]\]'/);
    assert.match(lifecycleComparison, /unexpected definition/i);

    const normalizeGeneratedDefinition = definition => definition
        .toLowerCase()
        .replace(/::(pg_catalog\.)?(character varying|text|integer)(\[\])?/g, "")
        .replace(/\s/g, "");
    const diagnosticActual =
        "CHECK ((processing_status = 'CORRELATED') AND ((notification_id IS NOT NULL) OR (original_notification_id IS NOT NULL)) AND (correlated_at IS NOT NULL))";
    const generatedExpected = diagnosticActual;
    const legacyExpected =
        "checkprocessing_status='correlated'and(notification_idisnotnullororiginal_notification_idisnotnull)andcorrelated_atisnotnull";
    const differentlyGrouped =
        "CHECK (((processing_status = 'CORRELATED') AND (notification_id IS NOT NULL)) OR ((original_notification_id IS NOT NULL) AND (correlated_at IS NOT NULL)))";

    assert.notEqual(
        normalizeGeneratedDefinition(diagnosticActual).replace(/[()]/g, ""),
        legacyExpected,
        "The former actual-vs-handwritten comparison must reproduce the catalog formatting mismatch"
    );
    assert.equal(
        normalizeGeneratedDefinition(diagnosticActual),
        normalizeGeneratedDefinition(generatedExpected),
        "The actual diagnostic expression should match PostgreSQL's deparsed expected expression"
    );
    assert.notEqual(
        normalizeGeneratedDefinition(diagnosticActual),
        normalizeGeneratedDefinition(differentlyGrouped),
        "A changed AND/OR grouping must not normalize to the expected lifecycle rule"
    );
});

test("Post-migration audit uses pre-transaction temporary comparators and read-only verification", () => {
    const identityCheck = postMigrationVerification.indexOf("DO $preflight$");
    const firstComparator = postMigrationVerification.indexOf(
        "CREATE TEMP TABLE micopesa_expected_mpesa_callback_lifecycle"
    );
    const secondComparator = postMigrationVerification.indexOf(
        "CREATE TEMP TABLE micopesa_expected_mobilesasa_callback_lifecycle"
    );
    const readOnlyTransaction = postMigrationVerification.search(
        /BEGIN;\s*SET TRANSACTION READ ONLY;/i
    );
    assert.ok(identityCheck >= 0);
    assert.ok(firstComparator > identityCheck);
    assert.ok(secondComparator > firstComparator);
    assert.ok(readOnlyTransaction > secondComparator);
    assert.match(postMigrationVerification, /BEGIN;\s*SET TRANSACTION READ ONLY;/i);
    assert.match(postMigrationVerification, /current_database\(\) <> 'Micopesa_migration_audit'/i);
    assert.match(postMigrationVerification, /server_address <<= inet '127\.0\.0\.0\/8'/i);
    assert.match(postMigrationVerification, /server_address <<= inet '::1\/128'/i);
    assert.match(postMigrationVerification, /inet_server_port\(\) <> 5433/i);
    assert.match(postMigrationVerification.trimEnd(), /ROLLBACK;$/i);
    assert.doesNotMatch(postMigrationVerification, /ON COMMIT DROP/i);
    const auditDdlStatements = postMigrationVerification
        .split(";")
        .map(statement => statement.trim())
        .filter(statement => /^(?:CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE)\b/i.test(statement));
    assert.equal(auditDdlStatements.length, 4);
    assert.equal(
        auditDdlStatements.filter(statement =>
            /^CREATE TEMP TABLE micopesa_expected_(?:mpesa|mobilesasa)_callback_lifecycle\s+AS[\s\S]*WITH NO DATA$/i.test(statement)
        ).length,
        2,
        "Only session-scoped temporary expected-definition tables may be created"
    );
    assert.equal(
        auditDdlStatements.filter(statement =>
            /^ALTER TABLE pg_temp\.micopesa_expected_(?:mpesa|mobilesasa)_callback_lifecycle\s+ADD CONSTRAINT expected_(?:mpesa|mobilesasa)_callback_lifecycle CHECK\s*\([\s\S]*\)$/i.test(statement)
        ).length,
        2,
        "Only lifecycle constraints on the temporary expected-definition tables may be added"
    );
});

test("Post-migration audit lifecycle count subqueries close before their aliases", () => {
    const darajaLifecycleQuery = postMigrationVerification.match(
        /\(SELECT count\(\*\)\s+FROM public\.mpesa_callback_inbox[\s\S]*?AS invalid_daraja_lifecycle_rows/i
    )?.[0];
    const mobileSasaLifecycleQuery = postMigrationVerification.match(
        /\(SELECT count\(\*\)\s+FROM public\.mobilesasa_sms_delivery_callbacks[\s\S]*?AS invalid_mobilesasa_lifecycle_rows/i
    )?.[0];

    assert.ok(darajaLifecycleQuery, "Expected Daraja lifecycle count expression");
    assert.ok(mobileSasaLifecycleQuery, "Expected MobileSasa lifecycle count expression");
    assert.match(
        darajaLifecycleQuery,
        /\)\s+IS TRUE\)\)\s+AS invalid_daraja_lifecycle_rows$/i,
        "The scalar SELECT and NOT(...) expression both need closing parentheses before the alias"
    );
    assert.match(
        mobileSasaLifecycleQuery,
        /\)\s+IS TRUE\)\)\s+AS invalid_mobilesasa_lifecycle_rows$/i,
        "The scalar SELECT and NOT(...) expression both need closing parentheses before the alias"
    );
});

test("Post-migration audit covers migrated indexes, constraints, triggers, sequences, and data counts", () => {
    for (const requiredObject of [
        "notification_preferences_user_id_fkey",
        "mpesa_callback_inbox_callback_fingerprint_check",
        "ck_mpesa_callback_lifecycle",
        "mobilesasa_sms_delivery_callba_provider_message_reference_check",
        "ck_mobilesasa_callback_lifecycle",
        "uq_notifications_user_channel_event_key",
        "uq_notifications_admin_request_channel",
        "uq_notifications_provider_message_id",
        "uq_mpesa_payment_attempts_one_active_per_contribution",
        "idx_mpesa_callback_inbox_status_received",
        "idx_mpesa_callback_inbox_provider_ids",
        "idx_mpesa_callback_inbox_attempt",
        "idx_mobilesasa_callbacks_unmatched",
        "idx_mobilesasa_callbacks_notification",
        "idx_mobilesasa_callbacks_original_notification",
        "idx_mobilesasa_callbacks_tracking_id",
        "idx_mobilesasa_callbacks_dispatch_reference",
        "trg_notification_preferences_set_updated_at",
        "trg_mpesa_callback_inbox_set_updated_at",
        "trg_mobilesasa_callbacks_preserve_notification_reference",
        "trg_mobilesasa_callbacks_set_updated_at",
        "pg_get_serial_sequence",
        "pre_migration_rows",
        "invalid_daraja_lifecycle_rows",
        "invalid_mobilesasa_lifecycle_rows",
        "duplicate_notification_event_key_groups",
        "broken_mobilesasa_notification_references",
    ]) {
        assert.ok(
            postMigrationVerification.includes(requiredObject),
            `Expected post-migration audit coverage for ${requiredObject}`
        );
    }

    assert.match(postMigrationVerification, /'notifications', 1::BIGINT/i);
    assert.match(postMigrationVerification, /'mpesa_callback_inbox', 0::BIGINT/i);
    assert.match(postMigrationVerification, /'mobilesasa_sms_delivery_callbacks', 0::BIGINT/i);
    assert.match(postMigrationVerification, /constraint_data\.convalidated/i);
    assert.match(postMigrationVerification, /index_data\.indisvalid/i);
    assert.match(postMigrationVerification, /index_data\.indisready/i);
    assert.match(postMigrationVerification, /index_data\.indislive/i);
    assert.match(postMigrationVerification, /pg_get_constraintdef/i);
    assert.match(postMigrationVerification, /pg_get_indexdef/i);
    assert.match(postMigrationVerification, /pg_get_triggerdef/i);
});

test("partial index predicates preserve case-sensitive status literals", () => {
    assert.equal(
        (forwardIntegrationMigration.match(
            /ARRAY\['OUTCOME_UNKNOWN', 'PENDING', 'PROMPT_ACCEPTED'\]::TEXT\[\]/g
        ) ?? []).length,
        3
    );
    assert.match(
        forwardIntegrationMigration,
        /regexp_matches\(\s*pg_get_expr\(i\.indpred, i\.indrelid\)/i
    );
});

test("Micopesa forward migration has balanced PL/pgSQL dollar-quoted block boundaries", () => {
    const delimiterCounts = new Map();
    for (const match of forwardIntegrationMigration.matchAll(/\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$/g)) {
        delimiterCounts.set(match[0], (delimiterCounts.get(match[0]) ?? 0) + 1);
    }

    assert.ok(delimiterCounts.size > 0, "Expected dollar-quoted PL/pgSQL blocks");
    for (const [delimiter, count] of delimiterCounts) {
        assert.equal(count, 2, `Expected exactly one opening and closing ${delimiter}`);
    }
    assert.match(forwardIntegrationMigration, /\$preflight\$;\s*-- Add application notification fields/i);
    assert.match(forwardIntegrationMigration, /\$notification_columns\$;\s*-- Preserve the prior notification type domain/i);
    assert.match(forwardIntegrationMigration, /\$notification_objects\$;\s*DO \$payment_indexes\$/i);
    assert.match(forwardIntegrationMigration, /\$payment_indexes\$;\s*DO \$mpesa_callback_inbox_objects\$/i);
    assert.match(forwardIntegrationMigration, /\$mpesa_callback_inbox_objects\$;\s*DO \$mobilesasa_callback_table\$/i);
    assert.match(forwardIntegrationMigration, /\$mobilesasa_callback_table\$;\s*DO \$mobilesasa_callback_function\$/i);
    assert.match(forwardIntegrationMigration, /\$mobilesasa_callback_function\$;\s*DO \$mobilesasa_callback_objects\$/i);
    const executableSql = forwardIntegrationMigration.replace(
        /--.*$|\/\*[\s\S]*?\*\//gm,
        ""
    );
    assert.doesNotMatch(executableSql, /\bDROP\s+TABLE\b|\bDROP\s+SEQUENCE\b|\bDELETE\s+FROM\b|\bTRUNCATE\b/i);
    assert.doesNotMatch(executableSql, /\bUPDATE\s+(?:notifications|notification_preferences|mpesa_callback_inbox)\s+SET\b/i);
});

test("admin channel snapshot constraint is preserved outside general channel migration", () => {
    const typeConstraintPreflight = forwardIntegrationMigration.match(
        /FOR type_constraint IN([\s\S]*?)END LOOP;/i
    )?.[1];
    const typeConstraintMigration = forwardIntegrationMigration.match(
        /DO \$notification_type_constraint\$([\s\S]*?)\$notification_type_constraint\$;/i
    )?.[1];

    assert.ok(typeConstraintPreflight, "Expected general notification_type preflight");
    assert.ok(typeConstraintMigration, "Expected general notification_type migration");
    assert.match(
        typeConstraintPreflight,
        /conname NOT IN \(\s*'ck_notifications_admin_channel_snapshot',\s*'ck_notifications_external_recipient'/i
    );
    assert.match(
        typeConstraintMigration,
        /conname NOT IN \(\s*'ck_notifications_admin_channel_snapshot',\s*'ck_notifications_external_recipient'/i
    );
    assert.match(
        typeConstraintPreflight,
        /conname NOT IN \([\s\S]*?type_constraint\.conname IN \([\s\S]*?'notifications_notification_type_check'[\s\S]*?type_literals IS DISTINCT FROM ARRAY\['EMAIL', 'PUSH', 'SMS', 'USSD'\]/i
    );
    assert.match(
        typeConstraintMigration,
        /conname = 'notifications_notification_type_check'[\s\S]*?type_literals IS DISTINCT FROM ARRAY\['EMAIL', 'PUSH', 'SMS', 'USSD'\]/i
    );
    assert.doesNotMatch(
        forwardIntegrationMigration,
        /DROP CONSTRAINT\s+(?:IF EXISTS\s+)?ck_notifications_admin_channel_snapshot/i
    );
    assert.doesNotMatch(
        typeConstraintMigration,
        /notification_type IN \([^)]*'IN_APP'[^)]*\)[\s\S]*?admin_request_key/i
    );

    const adminSnapshotConstraint = schema.match(
        /CONSTRAINT ck_notifications_admin_channel_snapshot CHECK \([\s\S]*?\n    \),/i
    )?.[0];
    assert.ok(adminSnapshotConstraint, "Expected canonical admin snapshot constraint");
    assert.match(adminSnapshotConstraint, /notification_type IN \('SMS', 'EMAIL', 'PUSH'\)/i);
    assert.doesNotMatch(adminSnapshotConstraint, /'IN_APP'/i);
});

test("withdrawal OTP migration admits only the supported pre-feature schema", () => {
    const preflight = withdrawalOtpMigration.match(
        /DO \$withdrawal_otp_preflight\$([\s\S]*?)\$withdrawal_otp_preflight\$;/i
    )?.[1];
    assert.ok(preflight, "Expected a transactional OTP schema preflight");
    assert.ok(
        withdrawalOtpMigration.indexOf("$withdrawal_otp_preflight$;") <
            withdrawalOtpMigration.indexOf("ALTER TABLE public.users"),
        "The preflight must finish before the first schema change"
    );

    for (const tableName of [
        "users",
        "withdrawal_claims",
        "pension_accounts",
        "audit_logs",
    ]) {
        assert.match(preflight, new RegExp(`public\\.${tableName}`, "i"));
    }
    assert.match(preflight, /format_type\(attribute\.atttypid, attribute\.atttypmod\)/i);
    assert.match(preflight, /checkrole=anyarray\[''worker'',''fund_manager'',''regulator'',''admin''\]/i);
    assert.match(preflight, /PAYOUT_OFFICER is already allowed/i);
    assert.match(preflight, /supported four-role predecessor/i);
    assert.match(preflight, /already exist or are partially installed/i);
    assert.match(preflight, /withdrawal_payout_otp_authorizations/);
    assert.match(preflight, /withdrawal_payout_otp_delivery_events/);
    assert.match(preflight, /invalidate_withdrawal_payout_otp/);
    assert.match(preflight, /trg_withdrawal_claims_invalidate_payout_otp/);
    assert.match(preflight, /trg_users_invalidate_payout_otp/);
    assert.match(preflight, /trg_pension_accounts_invalidate_payout_otp/);
    assert.match(withdrawalOtpMigration, /DROP CONSTRAINT users_role_check;/i);
    assert.doesNotMatch(withdrawalOtpMigration, /DROP CONSTRAINT IF EXISTS users_role_check/i);
    assert.match(
        withdrawalOtpMigration,
        /CHECK \(role IN \(\s*'WORKER', 'FUND_MANAGER', 'REGULATOR', 'ADMIN', 'PAYOUT_OFFICER'/i
    );
    assert.match(
        schema,
        /role\s+VARCHAR\(20\)[\s\S]*?CHECK \(role IN \('WORKER', 'FUND_MANAGER', 'REGULATOR', 'ADMIN', 'PAYOUT_OFFICER'\)\)/i
    );
});

test("withdrawal OTP migration rejects already-featured and partial targets before DDL", () => {
    const preflightEnd = withdrawalOtpMigration.indexOf("$withdrawal_otp_preflight$;");
    const firstDdl = withdrawalOtpMigration.indexOf("ALTER TABLE public.users");
    const preflight = withdrawalOtpMigration.slice(
        withdrawalOtpMigration.indexOf("DO $withdrawal_otp_preflight$"),
        preflightEnd
    );
    assert.ok(preflightEnd >= 0 && preflightEnd < firstDdl);
    assert.match(preflight, /PAYOUT_OFFICER is already allowed/i);
    assert.match(preflight, /already exist or are partially installed/i);
    for (const featureObject of [
        "withdrawal_payout_otp_authorizations",
        "withdrawal_payout_otp_delivery_events",
        "uq_withdrawal_payout_otp_one_active_per_claim",
        "idx_withdrawal_payout_otp_claim_history",
        "idx_withdrawal_payout_otp_delivery_rate_limit",
        "invalidate_withdrawal_payout_otp",
    ]) {
        assert.ok(preflight.includes(featureObject), `Expected conflict check for ${featureObject}`);
    }
});

test("withdrawal OTP migration reuses equivalent ledger uniqueness instead of duplicating indexes", () => {
    assert.match(
        extractIndex(schema, "uq_withdrawal_claims_claim_account_otp"),
        /on withdrawal_claims \(claim_id, account_id\)/i
    );
    assert.match(
        extractIndex(schema, "uq_pension_accounts_account_user_otp"),
        /on pension_accounts \(account_id, user_id\)/i
    );
    assert.match(
        pensionAccountLedgerMigration,
        /ADD CONSTRAINT uq_pension_accounts_id_user\s+UNIQUE \(account_id, user_id\)/i
    );
    assert.match(
        pensionAccountLedgerMigration,
        /ADD CONSTRAINT uq_withdrawal_claim_account\s+UNIQUE \(claim_id, account_id\)/i
    );

    const parentIndexBlock = withdrawalOtpMigration.match(
        /DO \$withdrawal_otp_parent_indexes\$([\s\S]*?)\$withdrawal_otp_parent_indexes\$;/i
    )?.[1];
    assert.ok(parentIndexBlock, "Expected conditional parent-key index creation");
    assert.match(parentIndexBlock, /indrelid = 'public\.withdrawal_claims'::regclass/i);
    assert.match(parentIndexBlock, /indkey\[0\] = claim_attnum/i);
    assert.match(parentIndexBlock, /indkey\[1\] = claim_account_attnum/i);
    assert.match(parentIndexBlock, /indrelid = 'public\.pension_accounts'::regclass/i);
    assert.match(parentIndexBlock, /indkey\[0\] = pension_account_attnum/i);
    assert.match(parentIndexBlock, /indkey\[1\] = pension_user_attnum/i);
    assert.match(parentIndexBlock, /indisunique[\s\S]*?indisvalid[\s\S]*?indisready/i);
    assert.match(parentIndexBlock, /indpred IS NULL[\s\S]*?indexprs IS NULL/i);
    assert.match(parentIndexBlock, /access_method\.amname = 'btree'/i);
    assert.match(parentIndexBlock, /IF NOT EXISTS \([\s\S]*?pg_index/i);
    assert.match(parentIndexBlock, /CREATE UNIQUE INDEX uq_withdrawal_claims_claim_account_otp/i);
    assert.match(parentIndexBlock, /CREATE UNIQUE INDEX uq_pension_accounts_account_user_otp/i);
    assert.doesNotMatch(
        withdrawalOtpMigration,
        /CREATE UNIQUE INDEX IF NOT EXISTS uq_(?:withdrawal_claims_claim_account_otp|pension_accounts_account_user_otp)/i
    );
});

test("withdrawal OTP migration objects match the canonical feature schema", () => {
    for (const tableName of [
        "withdrawal_payout_otp_authorizations",
        "withdrawal_payout_otp_delivery_events",
    ]) {
        assert.equal(
            extractTable(schema, tableName),
            extractTable(withdrawalOtpMigration, tableName),
            `${tableName} differs between schema.sql and the forward migration`
        );
    }

    for (const indexName of [
        "uq_withdrawal_payout_otp_one_active_per_claim",
        "idx_withdrawal_payout_otp_claim_history",
        "idx_withdrawal_payout_otp_delivery_rate_limit",
    ]) {
        assert.equal(
            extractIndex(schema, indexName),
            extractIndex(withdrawalOtpMigration, indexName),
            `${indexName} differs between schema.sql and the forward migration`
        );
    }

    assert.equal(
        extractFunction(schema, "invalidate_withdrawal_payout_otp"),
        extractFunction(withdrawalOtpMigration, "invalidate_withdrawal_payout_otp")
    );
    for (const triggerName of [
        "trg_withdrawal_claims_invalidate_payout_otp",
        "trg_users_invalidate_payout_otp",
        "trg_pension_accounts_invalidate_payout_otp",
    ]) {
        assert.equal(
            extractTrigger(schema, triggerName),
            extractTrigger(withdrawalOtpMigration, triggerName),
            `${triggerName} differs between schema.sql and the forward migration`
        );
    }
});

test("withdrawal OTP migration leaves payout and ledger protections untouched", () => {
    assert.match(pensionAccountLedgerMigration, /pension_ledger_future_payout_disabled/i);
    assert.match(pensionAccountLedgerMigration, /Payout settlement is disabled pending reviewed implementation/i);
    assert.match(pensionAccountLedgerMigration, /trg_00_disable_payout_attempts/i);
    assert.match(pensionAccountLedgerMigration, /trg_00_disable_payout_verifications/i);
    assert.match(
        withdrawalOtpMigration,
        /payout execution remains disabled/i
    );
    assert.doesNotMatch(
        withdrawalOtpMigration,
        /\b(?:INSERT\s+INTO\s+(?:public\.)?(?:transactions|pension_account_movements|withdrawal_payout_attempts)|UPDATE\s+withdrawal_claims\s+SET\s+claim_status)\b/i
    );
    assert.doesNotMatch(withdrawalOtpMigration, /\bDROP\s+TABLE\b|\bDELETE\s+FROM\b|\bTRUNCATE\b/i);
});

test("withdrawal OTP deployment guide documents one-time install and recovery paths", () => {
    assert.match(deploymentDocumentation, /Fresh installation:[\s\S]*?schema\.sql` only/i);
    assert.match(deploymentDocumentation, /Existing installation:[\s\S]*?exactly\s+once/i);
    assert.match(deploymentDocumentation, /validated four-role `users_role_check`/i);
    assert.match(deploymentDocumentation, /read-only catalog queries/i);
    assert.match(deploymentDocumentation, /ON_ERROR_STOP=1/i);
    assert.match(deploymentDocumentation, /issue `ROLLBACK`/i);
    assert.match(deploymentDocumentation, /Dropping OTP tables is not a routine rollback/i);
    assert.match(deploymentDocumentation, /no payout\s+executor/i);
});

test("worker identity expansion tables and indexes match the canonical schema", () => {
    for (const tableName of [
        "worker_registration_challenges",
        "worker_password_reset_challenges",
        "worker_national_id_claims",
        "worker_national_id_verification_evidence",
        "worker_approval_reviews",
    ]) {
        assert.equal(
            extractTable(schema, tableName),
            extractTable(workerIdentityExpandMigration, tableName),
            `${tableName} differs between schema.sql and the expansion migration`
        );
    }

    for (const indexName of [
        "idx_users_worker_approval_status",
        "idx_worker_registration_challenges_expiry",
        "uq_worker_password_reset_pending_user",
        "idx_worker_password_reset_expiry",
        "idx_worker_national_id_claims_expiry",
        "idx_worker_approval_reviews_worker_created",
    ]) {
        assert.equal(
            extractIndex(schema, indexName),
            extractIndex(workerIdentityExpandMigration, indexName),
            `${indexName} differs between schema.sql and the expansion migration`
        );
    }

    assert.match(schema, /approval_status VARCHAR\(15\) NOT NULL DEFAULT 'APPROVED'[\s\S]*?CHECK \(approval_status IN \('PENDING', 'APPROVED', 'REJECTED'\)\)/i);
    assert.match(workerIdentityExpandMigration, /ADD COLUMN IF NOT EXISTS approval_status VARCHAR\(15\) NOT NULL DEFAULT 'APPROVED'/i);
    assert.match(workerIdentityExpandMigration, /CHECK \(approval_status IN \('PENDING', 'APPROVED', 'REJECTED'\)\)/i);
    for (const tableName of ["kyc_records", "pending_registrations"]) {
        const alterBlock = workerIdentityExpandMigration.match(
            new RegExp(`ALTER TABLE public\\.${tableName}([\\s\\S]*?);`, "i")
        )?.[1];
        assert.ok(alterBlock, `Expected additive encrypted ID columns on ${tableName}`);
        for (const column of [
            "national_id_ciphertext BYTEA",
            "national_id_iv BYTEA",
            "national_id_tag BYTEA",
            "national_id_key_version VARCHAR(10)",
            "national_id_fingerprint VARCHAR(64)",
            "national_id_last_four CHAR(4)",
        ]) {
            const escapedColumn = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            assert.match(alterBlock, new RegExp(`ADD COLUMN IF NOT EXISTS ${escapedColumn}`, "i"));
        }
    }
    assert.match(workerIdentityExpandMigration, /auth_rate_limits_scope_check[\s\S]*?CHECK \(scope IN \('IP', 'EMAIL', 'ACCOUNT', 'PHONE'\)\)/i);
    assert.match(workerIdentityExpandMigration, /audit_logs_action_type_check[\s\S]*?'VIEW'/i);
    assert.equal(
        extractFunction(schema, "guard_worker_national_id_verification_evidence"),
        extractFunction(workerIdentityExpandMigration, "guard_worker_national_id_verification_evidence")
    );
    assert.equal(
        extractTrigger(schema, "trg_worker_national_id_verification_evidence_guard"),
        extractTrigger(workerIdentityExpandMigration, "trg_worker_national_id_verification_evidence_guard")
    );
    for (const source of [schema, workerIdentityExpandMigration]) {
        assert.match(source, /micopesa_national_id_evidence_owner/);
        assert.match(source, /micopesa_national_id_verifier/);
        assert.match(source, /rolinherit OR rolcreaterole OR rolcreatedb/);
        assert.match(source, /pg_auth_members[\s\S]*?::regrole/);
        assert.match(source, /ALTER TABLE (?:public\.)?worker_national_id_verification_evidence[\s\S]*?OWNER TO micopesa_national_id_evidence_owner/i);
        assert.match(source, /REVOKE ALL ON TABLE (?:public\.)?worker_national_id_verification_evidence FROM PUBLIC/i);
        assert.match(source, /REVOKE CREATE ON SCHEMA public FROM micopesa_national_id_evidence_owner/i);
        assert.match(source, /session_user <> 'micopesa_national_id_verifier'/i);
        assert.doesNotMatch(
            source,
            /GRANT SELECT ON TABLE (?:public\.)?kyc_records, (?:public\.)?pending_registrations/i
        );
    }
    assert.match(workerIdentityExpandMigration, /GRANT UPDATE \([\s\S]*?national_id_fingerprint[\s\S]*?\) ON TABLE public\.kyc_records/i);
    assert.doesNotMatch(
        workerIdentityExpandMigration,
        /GRANT (?:UPDATE|DELETE) ON TABLE public\.worker_national_id_verification_evidence/i
    );
    assert.match(applicationDatabaseConfiguration, /connectionString:\s*process\.env\.DATABASE_URL/);
    assert.doesNotMatch(applicationDatabaseConfiguration, /NATIONAL_ID_BACKFILL_DATABASE_URL/);
    assert.match(workerIdentityBackfill, /process\.env\.NATIONAL_ID_BACKFILL_DATABASE_URL/);
    assert.match(workerIdentityBackfill, /database_user !== VERIFIER_ROLE/);
});

test("worker identity contract rejects missing or mismatched verification evidence before redaction", () => {
    const tableLock = workerIdentityContractMigration.search(
        /LOCK TABLE[\s\S]*?IN SHARE ROW EXCLUSIVE MODE/i
    );
    const firstPlaintextUpdate = workerIdentityContractMigration.search(
        /UPDATE public\.kyc_records\s+SET national_id = 'ENCRYPTED'/i
    );
    const kycPreflight = workerIdentityContractMigration.search(
        /National ID backfill incomplete for kyc_records/i
    );
    assert.ok(tableLock >= 0 && tableLock < firstPlaintextUpdate);
    for (const tableName of [
        "kyc_records",
        "pending_registrations",
        "worker_national_id_verification_evidence",
        "worker_national_id_claims",
    ]) {
        assert.match(
            workerIdentityContractMigration,
            new RegExp(`LOCK TABLE[\\s\\S]*?public\\.${tableName}`, "i")
        );
    }
    const pendingPreflight = workerIdentityContractMigration.search(
        /National ID backfill incomplete for pending_registrations/i
    );
    const evidencePreflight = workerIdentityContractMigration.search(
        /National ID cryptographic verification evidence is missing or mismatched/i
    );
    assert.ok(kycPreflight >= 0 && kycPreflight < firstPlaintextUpdate);
    assert.ok(pendingPreflight >= 0 && pendingPreflight < firstPlaintextUpdate);
    assert.ok(evidencePreflight >= 0 && evidencePreflight < firstPlaintextUpdate);
    for (const sourceId of ["kyc_id", "pending_registration_id"]) {
        assert.match(
            workerIdentityContractMigration,
            new RegExp(`evidence\\.source_record_id = records\\.${sourceId}`, "i")
        );
        for (const field of [
            "national_id_fingerprint",
            "national_id_ciphertext",
            "national_id_iv",
            "national_id_tag",
            "national_id_key_version",
            "national_id_last_four",
        ]) {
            assert.match(
                workerIdentityContractMigration,
                new RegExp(`evidence\\.${field} = records\\.${field}`, "i")
            );
        }
    }
    assert.match(workerIdentityContractMigration, /evidence\.verified_plaintext_fingerprint = records\.national_id_fingerprint/i);
    assert.match(workerIdentityContractMigration, /evidence\.plaintext_matched IS TRUE/i);
    assert.match(workerIdentityContractMigration, /evidence\.verified_by = 'micopesa_national_id_verifier'/i);
    assert.match(workerIdentityContractMigration, /expected\.source_count > 1/i);
    assert.match(workerIdentityContractMigration, /claims\.user_id IS DISTINCT FROM expected\.user_id/i);
    assert.match(workerIdentityContractMigration, /claims\.pending_registration_id IS DISTINCT FROM expected\.pending_registration_id/i);
    assert.equal(
        [...workerIdentityContractMigration.matchAll(/ALTER COLUMN national_id_key_version SET DEFAULT 'v1'/gi)].length,
        2
    );

    assert.equal(
        extractIndex(schema, "uq_kyc_records_verified_national_id_fingerprint"),
        extractIndex(workerIdentityContractMigration, "uq_kyc_records_verified_national_id_fingerprint")
    );
    assert.equal(
        extractFunction(schema, "flag_duplicate_kyc_national_id"),
        extractFunction(workerIdentityContractMigration, "flag_duplicate_kyc_national_id")
    );
    assert.equal(
        extractTrigger(schema, "trg_kyc_records_flag_duplicate_national_id"),
        extractTrigger(workerIdentityContractMigration, "trg_kyc_records_flag_duplicate_national_id")
    );
    for (const constraint of [
        "ck_kyc_records_national_id_redacted",
        "ck_kyc_records_national_id_ciphertext",
        "ck_kyc_records_national_id_key_version",
        "ck_kyc_records_national_id_fingerprint",
        "ck_kyc_records_national_id_last_four",
        "ck_pending_registrations_national_id_redacted",
        "ck_pending_registrations_national_id_ciphertext",
        "ck_pending_registrations_national_id_key_version",
        "ck_pending_registrations_national_id_fingerprint",
        "ck_pending_registrations_national_id_last_four",
    ]) {
        assert.match(workerIdentityContractMigration, new RegExp(constraint, "i"));
        assert.match(schema, new RegExp(`CONSTRAINT ${constraint}\\s+CHECK`, "i"));
    }

    const executableSql = workerIdentityContractMigration.replace(
        /--.*$|\/\*[\s\S]*?\*\//gm,
        ""
    );
    assert.doesNotMatch(executableSql, /\bDROP\s+TABLE\b|\bDELETE\s+FROM\b|\bTRUNCATE\b/i);
    assert.match(executableSql, /UPDATE public\.kyc_records\s+SET national_id = 'ENCRYPTED'/i);
    assert.match(executableSql, /UPDATE public\.pending_registrations\s+SET national_id = 'ENCRYPTED'/i);
});

test("worker National ID deployment guide documents key custody and explicit backfill gates", () => {
    const guide = fs.readFileSync(
        path.resolve(__dirname, "../../../docs/deployment/worker-phone-registration-and-national-id.md"),
        "utf8"
    );
    assert.match(guide, /migration_worker_identity_expand_forward\.sql/);
    assert.match(guide, /migration_worker_identity_contract_forward\.sql/);
    assert.match(guide, /NATIONAL_ID_ENCRYPTION_KEY/);
    assert.match(guide, /NATIONAL_ID_FINGERPRINT_KEY/);
    assert.match(guide, /micopesa_national_id_verifier/);
    assert.match(guide, /PostgreSQL does\s+not decrypt AES-GCM/i);
    assert.match(guide, /NATIONAL_ID_BACKFILL_DATABASE_URL/);
    assert.match(guide, /dry-run is the default/i);
    assert.match(guide, /requires both `--apply` and\s+`--confirm-database/);
    assert.match(guide, /does not add payout execution/i);
});

test("worker identity migration has key versions and does not backfill unrelated existing users", () => {
    assert.match(schema, /national_id_key_version VARCHAR\(10\) NOT NULL DEFAULT 'v1'/i);
    assert.match(workerIdentityExpandMigration, /ADD COLUMN IF NOT EXISTS national_id_key_version VARCHAR\(10\)/i);
    assert.match(workerIdentityContractMigration, /national_id_key_version IS NULL[\s\S]*?national_id_key_version <> 'v1'/i);
    assert.match(workerIdentityContractMigration, /expected\.source_count > 1/i);

    assert.match(workerIdentityExpandMigration, /ADD COLUMN IF NOT EXISTS approval_status VARCHAR\(15\) NOT NULL DEFAULT 'APPROVED'/i);
    assert.doesNotMatch(workerIdentityExpandMigration, /UPDATE public\.users[\s\S]*?(?:national_id|kyc)/i);
    assert.doesNotMatch(workerIdentityExpandMigration, /ALTER TABLE public\.users[\s\S]*?ALTER COLUMN account_status/i);
});

test("approval-status repair migration is additive, repeatable, and preserves existing users", () => {
    const workerIdentityGuide = fs.readFileSync(
        path.resolve(__dirname, "../../../docs/deployment/worker-phone-registration-and-national-id.md"),
        "utf8"
    );
    assert.match(workerApprovalMigration, /^\s*BEGIN\s*;/i);
    assert.match(workerApprovalMigration, /ADD COLUMN IF NOT EXISTS approval_status VARCHAR\(15\) NOT NULL DEFAULT 'APPROVED'/i);
    assert.match(workerApprovalMigration, /ADD CONSTRAINT ck_users_approval_status[\s\S]*?CHECK \(approval_status IN \('PENDING', 'APPROVED', 'REJECTED'\)\)/i);
    assert.match(workerApprovalMigration, /CREATE INDEX IF NOT EXISTS idx_users_worker_approval_status[\s\S]*?WHERE role = 'WORKER'/i);
    assert.match(workerApprovalMigration, /COMMIT\s*;\s*$/i);
    assert.doesNotMatch(workerApprovalMigration, /\b(?:UPDATE|DELETE FROM|TRUNCATE)\s+(?:public\.)?users\b/i);
    assert.doesNotMatch(workerApprovalMigration, /\bDROP\s+(?:TABLE|COLUMN|CONSTRAINT)\b/i);
    assert.match(workerIdentityGuide, /migration_users_approval_status_forward\.sql/);
    assert.match(workerIdentityGuide, /without rewriting existing rows/i);
    assert.match(workerIdentityGuide, /current authentication and registration code\s+does not depend on the column/i);
});
