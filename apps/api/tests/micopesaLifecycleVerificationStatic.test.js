const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const verification = fs.readFileSync(
    path.resolve(__dirname, "../../../database/micopesa_audit_post_migration_verification.sql"),
    "utf8"
);
const migration = fs.readFileSync(
    path.resolve(__dirname, "../../../database/migration_micopesa_integrations_forward.sql"),
    "utf8"
);

function normalizeDefinition(definition) {
    return definition
        .toLowerCase()
        .replace(/::(pg_catalog\.)?(character varying|text|integer)(\[\])?/g, "")
        .replace(/\s/g, "");
}

function extractCheckExpression(source, constraintDeclaration) {
    const declarationIndex = source.toLowerCase().indexOf(constraintDeclaration.toLowerCase());
    assert.notEqual(declarationIndex, -1, `Expected ${constraintDeclaration}`);

    const openingIndex = source.indexOf("(", declarationIndex + constraintDeclaration.length);
    assert.notEqual(openingIndex, -1, `Expected CHECK expression for ${constraintDeclaration}`);

    let depth = 0;
    for (let index = openingIndex; index < source.length; index += 1) {
        if (source[index] === "(") {
            depth += 1;
        } else if (source[index] === ")") {
            depth -= 1;
            if (depth === 0) {
                return source.slice(openingIndex, index + 1);
            }
        }
    }

    assert.fail(`Unclosed CHECK expression for ${constraintDeclaration}`);
}

test("post-migration audit compares both complete lifecycle CHECK definitions", () => {
    const verificationBlock = verification.match(
        /DO \$required_lifecycle_definitions\$([\s\S]*?)\$required_lifecycle_definitions\$;/i
    )?.[1];
    assert.ok(verificationBlock, "Expected lifecycle-definition verification block");

    for (const [tableName, constraintName, expectedTable, expectedConstraint] of [
        [
            "mpesa_callback_inbox",
            "ck_mpesa_callback_lifecycle",
            "micopesa_expected_mpesa_callback_lifecycle",
            "expected_mpesa_callback_lifecycle",
        ],
        [
            "mobilesasa_sms_delivery_callbacks",
            "ck_mobilesasa_callback_lifecycle",
            "micopesa_expected_mobilesasa_callback_lifecycle",
            "expected_mobilesasa_callback_lifecycle",
        ],
    ]) {
        assert.match(verificationBlock, new RegExp(
            `'${tableName}'\\s*,\\s*'${constraintName}'\\s*,\\s*'${expectedTable}'`,
            "i"
        ));
        assert.match(verificationBlock, new RegExp(
            `format\\('public\\.%I',[\\s\\S]*?expected_lifecycle\\.table_name\\)[\\s\\S]*?expected_lifecycle\\.constraint_name`,
            "i"
        ));
        assert.match(verificationBlock, new RegExp(
            `format\\('pg_temp\\.%I',[\\s\\S]*?expected_lifecycle\\.expected_table_name\\)[\\s\\S]*?expected_lifecycle\\.expected_constraint_name`,
            "i"
        ));
        const migrationExpression = extractCheckExpression(
            migration,
            `CONSTRAINT ${constraintName} CHECK`
        );
        const expectedExpression = extractCheckExpression(
            verification,
            `ADD CONSTRAINT ${expectedConstraint} CHECK`
        );
        assert.equal(
            normalizeDefinition(expectedExpression),
            normalizeDefinition(migrationExpression),
            `${constraintName} expected definition must match the forward migration`
        );
    }

    assert.match(verification, /CREATE TEMP TABLE micopesa_expected_mpesa_callback_lifecycle[\s\S]*?FROM public\.mpesa_callback_inbox\s+WITH NO DATA;/i);
    assert.match(verification, /ADD CONSTRAINT expected_mpesa_callback_lifecycle CHECK\s*\([\s\S]*?callback_status = 'VERIFIED'[\s\S]*?callback_status = 'REJECTED'[\s\S]*?\n\);/i);
    assert.match(verification, /CREATE TEMP TABLE micopesa_expected_mobilesasa_callback_lifecycle[\s\S]*?FROM public\.mobilesasa_sms_delivery_callbacks\s+WITH NO DATA;/i);
    assert.match(verification, /ADD CONSTRAINT expected_mobilesasa_callback_lifecycle CHECK\s*\([\s\S]*?processing_status IN \('APPLIED', 'IGNORED'\)[\s\S]*?processing_status = 'REJECTED'[\s\S]*?\n\);/i);

    assert.match(verificationBlock, /pg_get_constraintdef\(constraint_data\.oid\)/i);
    assert.match(verificationBlock, /normalized_actual_definition IS DISTINCT FROM\s+normalized_expected_definition/i);
    assert.match(verificationBlock, /'\[\[:space:\]\]'/i);
    assert.doesNotMatch(verificationBlock, /'\[\(\)\[:space:\]\]'/i);
    assert.match(migration, /normalized_expected_mobilesasa_lifecycle := regexp_replace/i);
    assert.match(migration, /normalized_mobilesasa_constraint IS DISTINCT FROM\s+normalized_expected_mobilesasa_lifecycle/i);
});

test("post-migration audit validates identity before session-scoped comparator setup", () => {
    const identityCheck = verification.indexOf("DO $preflight$");
    const mpesaComparator = verification.indexOf(
        "CREATE TEMP TABLE micopesa_expected_mpesa_callback_lifecycle"
    );
    const mobilesasaComparator = verification.indexOf(
        "CREATE TEMP TABLE micopesa_expected_mobilesasa_callback_lifecycle"
    );
    const readOnlyTransactionMatch = /BEGIN;\s*SET TRANSACTION READ ONLY;/i.exec(verification);
    const readOnlyTransaction = readOnlyTransactionMatch?.index ?? -1;
    const requiredRelations = verification.indexOf("DO $required_relations$");
    const lifecycleChecks = verification.indexOf("DO $required_lifecycle_definitions$");
    const dataCounts = verification.indexOf("pre_migration_rows");

    assert.ok(identityCheck >= 0);
    assert.ok(mpesaComparator > identityCheck);
    assert.ok(mobilesasaComparator > mpesaComparator);
    assert.ok(readOnlyTransaction > mobilesasaComparator);
    assert.ok(requiredRelations > readOnlyTransaction);
    assert.ok(lifecycleChecks > readOnlyTransaction);
    assert.ok(dataCounts > readOnlyTransaction);
    assert.equal(
        (verification.match(/CREATE TEMP TABLE micopesa_expected_(?:mpesa|mobilesasa)_callback_lifecycle/gi) ?? []).length,
        2
    );
    assert.equal(
        (verification.match(/ALTER TABLE pg_temp\.micopesa_expected_(?:mpesa|mobilesasa)_callback_lifecycle/gi) ?? []).length,
        2
    );
    assert.doesNotMatch(verification, /ON COMMIT DROP/i);
    assert.match(verification, /BEGIN;\s*SET TRANSACTION READ ONLY;/i);
    assert.match(verification, /current_database\(\) <> 'Micopesa_migration_audit'/i);
    assert.match(verification, /server_address <<= inet '127\.0\.0\.0\/8'/i);
    assert.match(verification, /server_address <<= inet '::1\/128'/i);
    assert.match(verification, /inet_server_port\(\) <> 5433/i);
    assert.match(verification.trimEnd(), /ROLLBACK;$/i);

    const ddlStatements = verification
        .split(";")
        .map(statement => statement.trim())
        .filter(statement => /^(?:CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE)\b/i.test(statement));
    assert.equal(ddlStatements.length, 4);
    assert.ok(
        ddlStatements.every(statement => statement.startsWith("CREATE TEMP TABLE") ||
            statement.startsWith("ALTER TABLE pg_temp.")),
        "The only DDL must create the temporary comparator tables and their temporary constraints"
    );
    assert.equal(
        ddlStatements.filter(statement =>
            /^CREATE TEMP TABLE micopesa_expected_(?:mpesa|mobilesasa)_callback_lifecycle\s+AS[\s\S]*WITH NO DATA$/i.test(statement)
        ).length,
        2
    );
    assert.equal(
        ddlStatements.filter(statement =>
            /^ALTER TABLE pg_temp\.micopesa_expected_(?:mpesa|mobilesasa)_callback_lifecycle\s+ADD CONSTRAINT expected_(?:mpesa|mobilesasa)_callback_lifecycle CHECK\s*\([\s\S]*\)$/i.test(statement)
        ).length,
        2
    );
});

test("lifecycle normalization preserves parentheses and boolean grouping", () => {
    const verificationBlock = verification.match(
        /DO \$required_lifecycle_definitions\$([\s\S]*?)\$required_lifecycle_definitions\$;/i
    )?.[1];
    assert.ok(verificationBlock, "Expected lifecycle-definition verification block");
    assert.match(verificationBlock, /normalized_actual_definition := regexp_replace\([\s\S]*?'\[\[:space:\]\]'/i);
    assert.doesNotMatch(verificationBlock, /'\[\(\)\[:space:\]\]'/i);

    const expected =
        "CHECK (((processing_status = 'CORRELATED') AND ((notification_id IS NOT NULL) OR (original_notification_id IS NOT NULL)) AND (correlated_at IS NOT NULL)))";
    const differentlyGrouped =
        "CHECK ((((processing_status = 'CORRELATED') AND (notification_id IS NOT NULL)) OR ((original_notification_id IS NOT NULL) AND (correlated_at IS NOT NULL))))";

    assert.notEqual(normalizeDefinition(expected), normalizeDefinition(differentlyGrouped));
    assert.match(normalizeDefinition(expected), /[()]/);
});

test("lifecycle verification rejects changed status-literal casing", () => {
    const verificationBlock = verification.match(
        /DO \$required_lifecycle_definitions\$([\s\S]*?)\$required_lifecycle_definitions\$;/i
    )?.[1];
    assert.ok(verificationBlock, "Expected lifecycle-definition verification block");
    assert.match(
        verificationBlock,
        /regexp_matches\(actual_definition,\s*'''[^;]+''',\s*'g'\)/i
    );
    assert.match(verificationBlock, /actual_literals IS DISTINCT FROM expected_lifecycle\.expected_literals/i);

    const expectedStatuses = ["CORRELATED", "REJECTED", "UNMATCHED", "VERIFIED"];
    const wrongCaseStatuses = ["correlated", "REJECTED", "UNMATCHED", "VERIFIED"];
    assert.notDeepEqual(wrongCaseStatuses, expectedStatuses);
    assert.match(
        verificationBlock,
        /ARRAY\['CORRELATED', 'REJECTED', 'UNMATCHED', 'VERIFIED'\]::TEXT\[\]/i
    );
    assert.match(
        verificationBlock,
        /ARRAY\['APPLIED', 'CORRELATED', 'IGNORED', 'REJECTED', 'UNMATCHED'\]::TEXT\[\]/i
    );
});

test("lifecycle verification fails on missing, non-CHECK, or unvalidated constraints", () => {
    const verificationBlock = verification.match(
        /DO \$required_lifecycle_definitions\$([\s\S]*?)\$required_lifecycle_definitions\$;/i
    )?.[1];
    assert.ok(verificationBlock, "Expected lifecycle-definition verification block");
    assert.equal(
        (verificationBlock.match(/constraint_data\.contype = 'c'\s+AND constraint_data\.convalidated/gi) ?? []).length,
        2,
        "Both the catalog and generated expected constraints must be CHECK constraints and validated"
    );
    assert.match(verificationBlock, /IF NOT FOUND THEN\s+RAISE EXCEPTION\s+'Missing or unvalidated lifecycle CHECK constraint/i);
    assert.match(verificationBlock, /IF NOT FOUND THEN\s+RAISE EXCEPTION\s+'Could not generate expected lifecycle CHECK definition/i);
});
