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
const mpesaRetryMigration = fs.readFileSync(
    path.join(databaseDirectory, "migration_mpesa_retry_recovery.sql"),
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
        `CREATE TABLE ${escaped} \\([\\s\\S]*?\\n[ \\t]*\\);`,
        "i"
    ));
    assert.ok(match, `Expected CREATE TABLE ${tableName}`);
    return match[0].replace(/\s+/g, " ").trim().toLowerCase();
}

function extractIndex(source, indexName) {
    const escaped = indexName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = source.match(new RegExp(
        `CREATE (?:UNIQUE )?INDEX ${escaped}[\\s\\S]*?;`,
        "i"
    ));
    assert.ok(match, `Expected CREATE UNIQUE INDEX ${indexName}`);
    return match[0].replace(/\s+/g, " ").trim().toLowerCase();
}

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

    assert.match(notificationEventService, /FROM notification_preferences/);
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
