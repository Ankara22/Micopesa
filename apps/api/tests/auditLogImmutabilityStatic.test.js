const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const databaseDirectory = path.resolve(__dirname, "../../../database");
const schema = fs.readFileSync(path.join(databaseDirectory, "schema.sql"), "utf8");
const migration = fs.readFileSync(
    path.join(databaseDirectory, "migration_audit_logs_append_only_forward.sql"),
    "utf8"
);

test("fresh schema and forward migration guard audit mutations and preserve actor anonymization", () => {
    for (const source of [schema, migration]) {
        assert.match(source, /CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?prevent_audit_log_mutation/i);
        assert.match(source, /BEFORE UPDATE OR DELETE ON (?:public\.)?audit_logs/i);
        assert.match(source, /pg_trigger_depth\(\)\s*>\s*1/i);
        assert.match(source, /NEW\.user_id IS NULL/i);
        assert.match(source, /to_jsonb\(NEW\)\s*-\s*'user_id'/i);
        assert.match(source, /ENABLE ALWAYS TRIGGER trg_audit_logs_append_only/i);
    }

    assert.match(migration, /ON DELETE SET NULL/i);
    assert.match(migration, /REVOKE UPDATE, DELETE ON TABLE public\.audit_logs FROM PUBLIC/i);
});
