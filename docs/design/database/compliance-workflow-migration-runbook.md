# Compliance Workflow Migration Runbook

This runbook is for a **separately approved, manually operated migration**. It
does not authorize applying a migration to a developer, test, or production
database without an approved change window, verified backup, and owner review.
Never use `.env` or `.env.test` values for the isolated migration exercise.

## Choose the migration path

Use exactly one path:

1. **Pre-workflow database:** apply
   `database/migration_compliance_review_workflow.sql`, then
   `database/migration_compliance_workflow_enforcement.sql`.
2. **Database already migrated with the earlier workflow migration and without
   actor snapshots:** apply `database/migration_compliance_actor_snapshots.sql`,
   then `database/migration_compliance_workflow_enforcement.sql`.
3. **Database already migrated with actor snapshots but without database
   transition enforcement:** apply
   `database/migration_compliance_workflow_enforcement.sql`.
4. **New database:** initialize it from the current `database/schema.sql`;
   apply none of these migrations.

If a pre-workflow database separately requires the general-purpose
`database/migration_to_final_schema.sql`, apply it before the workflow
migration and only after confirming that its own baseline checks pass. It is
not part of the canonical-schema test setup: the current canonical schema
already contains its structural additions, and applying it afterward would
replace compliance policy. The legacy migration, workflow migration,
enforcement migration, and optional admin-deletion migration now all enforce
the same active-manager generator policy.
The legacy migration also stops if an existing non-NULL report attribution is
not an active fund manager. It does not rewrite historical attributions; have
the data owner investigate and resolve any reported rows before retrying.

Do not run the workflow migration against a database initialized from the
current canonical schema, and do not run the actor follow-up against a database
that already has the actor snapshot columns.

The workflow enforcement migration is also one-time. It requires the workflow
tables and all four actor snapshot columns. Before making changes, it validates
the required constraint definitions and validation state, foreign-key column
relationships, trigger events and bindings, trigger function behavior, and
existing report/history consistency. It aborts without repairing data when
any preflight check fails. Paired NULL actor snapshots are valid historical
records; asymmetric NULLs, blank names, invalid roles, duplicate decisions,
and inconsistent workflow history are not. Resolve reported anomalies with
the data owner; never delete, fabricate, or rewrite history to make the
migration pass.

## Valid report and history states

- A new non-legacy report starts as `DRAFT`, with no submission or review
  history and no submission timestamps.
- Submitting a draft creates version 1 and moves the report to `SUBMITTED`.
  `submitted_at` records the first submission; `last_submitted_at` matches the
  latest submission's timestamp.
- A regulator may decide only the latest submitted version. Its decision
  creates one review for that submission and sets the report to the same
  decision status.
- `REVISION_REQUESTED` permits manager edits and resubmission. Resubmission
  creates the next contiguous version; the preceding revision-request review
  remains attached to its earlier submission.
- A resubmission must be preceded by a `REVISION_REQUESTED` review of the
  previous version. `ACCEPTED` and `REJECTED` are terminal and cannot be
  submitted again.
- A currently `SUBMITTED` report has no review for its latest version.
  `REVISION_REQUESTED`, `ACCEPTED`, and `REJECTED` reports each have a matching
  latest-version review. Older reviews remain associated with their original
  submissions and are not overwritten.
- Legacy reports remain outside this workflow and must not acquire workflow
  history.

## Expected pre-workflow baseline

The workflow migration is a one-time migration against the application's
pre-workflow PostgreSQL schema. At minimum, the schema must contain:

- `users`: `user_id`, `full_name`, `role`, and `account_status`.
- `funds`: `fund_id` and `managed_by`.
- `audit_logs`: `action_type` and the named
  `audit_logs_action_type_check` constraint.
- `compliance_reports`: `report_id`, `generated_by`, `report_type`,
  `period_start`, `period_end`, `rba_status`, `generated_at`, and `updated_at`.
- `compliance_reports.rba_status` is `VARCHAR(15)`.
- The existing compliance report generator trigger
  `trg_compliance_reports_enforce_generator_role`.
- The original constraints `fk_compliance_reports_generated_by`,
  `chk_compliance_reports_period`, `compliance_reports_report_type_check`,
  and `compliance_reports_rba_status_check`.
- No workflow columns (`fund_id`, `report_content`, `submitted_at`,
  `last_submitted_at`, `is_legacy`) or workflow tables
  (`compliance_report_submissions`, `compliance_report_reviews`).

The expected pre-workflow baseline is reconstructed from
`database/schema.sql` at repository revision `c6114ce` and the migration's
explicit preflight checks. That definition has non-NULL `generated_by`,
`report_type`, `period_start`, and `period_end`.
`compliance_reports.rba_status` is `VARCHAR(15) NOT NULL DEFAULT 'SUBMITTED'`
and allows the original `DRAFT`, `SUBMITTED`, `ACCEPTED`, and `REJECTED`
values. The generator foreign key is named
`fk_compliance_reports_generated_by` and uses `ON DELETE RESTRICT`; report
type and status checks use PostgreSQL's generated names
`compliance_reports_report_type_check` and
`compliance_reports_rba_status_check`; the period check is named
`chk_compliance_reports_period`. The audit action check only allows the
pre-workflow actions. The migration relaxes selected old report fields so the
existing rows can remain legacy records and extends the audit action set.

Do not construct this baseline by copying the current canonical post-workflow
schema and deleting arbitrary objects. For a test fixture, use the historical
schema definition from the selected repository revision and include a legacy
compliance report row before applying the migration.

The actor-snapshot follow-up instead expects the workflow tables, actor ID
columns, and the original workflow role and append-only triggers to exist, but
none of its four actor snapshot columns. It keeps existing IDs and leaves
historical names/roles NULL where they cannot be established.

### Actor snapshot migration trigger compatibility

The actor snapshot follow-up supports either of these pre-snapshot variants:

- The expected `BEFORE TRUNCATE` history-protection triggers are absent; the
  migration adds them.
- An equivalent `BEFORE TRUNCATE` trigger already invokes
  `prevent_compliance_history_mutation()`; the migration preserves it, whether
  it uses the standard name or an equivalent existing name.

If a standard truncate-trigger name exists but does not invoke that function
for a `BEFORE TRUNCATE` event, or the shared mutation function does not contain
the expected append-only rejection, preflight rejects the schema before
changing it. The exact historical pre-snapshot variants are not established by
Git history. Both the missing-trigger and equivalent-existing-trigger cases
have been tested as reconstructed fixtures; this does not prove that every
deployed historical schema matches either fixture.

### Workflow database enforcement

The workflow enforcement migration and canonical schema permit only these
status changes:

- `DRAFT -> SUBMITTED`, with a new submission row in the same transaction.
- `SUBMITTED -> ACCEPTED`, `REJECTED`, or `REVISION_REQUESTED`, with a matching
  review row for the latest submission in the same transaction.
- `REVISION_REQUESTED -> SUBMITTED`, with a new submission version in the same
  transaction.

Same-status report updates remain valid. Legacy reports cannot enter the
workflow. Each submission may have exactly one review; a resubmission is a
new submission and may receive its own decision. Deferred constraint triggers
allow the controller's insert/update sequence within one transaction while
rejecting incomplete history at commit. The controller's report-row lock
continues to serialize API decisions; the database also locks and validates
the report during review insertion.

## Production preflight and backup

1. Obtain database-owner approval, identify the exact database/server/schema,
   schedule a change window, and ensure the application is disconnected or
   otherwise prevented from issuing workflow writes during the migration.
2. Confirm the selected migration path from the deployment/migration history.
   Record the database name, host identity, schema, current migration revision,
   PostgreSQL version, and application database role. Do not copy credentials
   into tickets, shell history, or logs.
3. Take a consistent, restorable backup using the organization's approved
   PostgreSQL backup process. Verify the backup file and perform a restore
   rehearsal to a separate disposable database before the change window.
4. Run these read-only checks with an explicitly selected target connection.
   Do not rely on implicit connection defaults:

```sql
SELECT current_database() AS database_name,
       current_schema() AS schema_name,
       current_user AS connected_role,
       version() AS server_version;

SELECT table_name, column_name, data_type, character_maximum_length
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name IN
      ('users', 'funds', 'audit_logs', 'compliance_reports',
       'compliance_report_submissions', 'compliance_report_reviews')
ORDER BY table_name, ordinal_position;

SELECT c.relname AS table_name, t.tgname AS trigger_name
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = current_schema()
  AND NOT t.tgisinternal
  AND c.relname IN
      ('compliance_reports', 'compliance_report_submissions',
       'compliance_report_reviews')
ORDER BY c.relname, t.tgname;

SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid IN (
    to_regclass('compliance_reports'),
    to_regclass('audit_logs')
)
ORDER BY conrelid::regclass::text, conname;
```

5. Compare the output with the baseline above and the selected migration's
   preflight. Stop if anything is missing, unexpected, or ambiguous. Never
   bypass a preflight by manually dropping a constraint or column.
6. Record legacy compliance report counts and IDs needed for post-migration
   reconciliation before running DDL.

## Isolated PostgreSQL migration exercise

Use only a newly provisioned disposable PostgreSQL instance and storage. Do not
reuse existing containers, volumes, local services, or project-configured
databases. Generate unique container/database/volume names and a loopback-only
port; confirm the names and port are unused before provisioning. Store the
disposable password in a protected temporary file and mount it read-only as a
container secret file. Do not print it or include it in command output.

Before any DDL or test data writes, connect explicitly to the isolated endpoint
and verify `current_database()`, `current_user`, `current_schema()`,
`inet_server_addr()`, `inet_server_port()`, and `version()`. Stop if any
identity value does not match the disposable instance. Reconstruct the
pre-workflow schema from the historical repository revision, not this current
canonical schema, then insert a known legacy report.

For baseline migration testing, run the preflight migration with fail-fast SQL
client behavior. For rerun testing, preserve the successful migrated fixture
and execute it again; confirm the second attempt errors and does not change
the committed schema/data. Test an incompatible fixture separately and confirm
that no workflow DDL survives. Do not test these cases against the real target.

Exercise at least:

- Legacy row count and original values before/after; `is_legacy` true,
  structured content and submission timestamps still NULL.
- Draft creation, valid submission and actor name/role snapshots.
- Review insertion against a submission from a different report (must fail).
- `UPDATE` and `DELETE` against both history tables (must fail).
- `TRUNCATE` against both history tables (must fail).
- Invalid API status transitions and two concurrent decisions from separate
  connections (only one decision can commit).
- Notification and audit insertion failures with status/history rollback.
- Changing user name, role, or status after a workflow action without changing
  the stored actor snapshot.
- Reapplying the migration and running against an incompatible baseline.
- Runtime-role privileges, as described below.

The committed PostgreSQL fixtures are
`database/tests/compliance_workflow_enforcement.sql` and
`database/tests/compliance_workflow_concurrency.sh`. The SQL fixture refuses
to run unless it is connected as `postgres` over a Unix socket to PostgreSQL 18
with data directory `/var/lib/postgresql/18/main`, empty `listen_addresses`,
and a database named `micopesa_compliance_enforcement_<suffix>`. Run the
concurrency script from the authorized WSL distribution as the PostgreSQL OS
user and pass that same disposable database name. These tests are not
application API tests.

The mocked API suite is not a substitute for these database tests. Record the
exact PostgreSQL version and isolated database identity with results, but never
record credentials.

## Execute the approved migration

Only after the baseline and backup are verified, connect to the explicitly
identified target using the approved operator account and run the chosen SQL
file with the SQL client configured to stop on the first error. The migration
contains its own `BEGIN`/`COMMIT`. On any error, stop; disconnecting with the
transaction open rolls it back. Do not manually continue from a partially
executed script or retry until the cause and transaction state are understood.

Example command shape (replace placeholders only after approval; do not put a
password in the command):

```powershell
psql -X -W -v ON_ERROR_STOP=1 -h <approved-host> -p <approved-port> `
  -U <approved-operator> -d <approved-database> `
  -f database/migration_compliance_review_workflow.sql
```

For the actor snapshot follow-up, substitute
`database/migration_compliance_actor_snapshots.sql`. This example is not to be
run against an unspecified connection or the current development database.
For an already-installed workflow, apply
`database/migration_compliance_workflow_enforcement.sql` only after verifying
that all four actor snapshot columns exist. The migration performs the
remaining history and catalog preflight itself and aborts without repair.

## Post-migration verification

Reconnect explicitly and verify server/database identity again. Then run:

```sql
SELECT is_legacy, count(*)
FROM compliance_reports
GROUP BY is_legacy
ORDER BY is_legacy;

SELECT count(*) AS legacy_rows_with_fabricated_submission_data
FROM compliance_reports
WHERE is_legacy
  AND (report_content IS NOT NULL OR submitted_at IS NOT NULL
       OR last_submitted_at IS NOT NULL);

SELECT table_name, column_name, is_nullable, data_type
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name IN ('compliance_report_submissions', 'compliance_report_reviews')
  AND column_name IN ('submitted_by', 'submitted_by_name', 'submitted_by_role',
                      'reviewed_by', 'reviewed_by_name', 'reviewed_by_role')
ORDER BY table_name, ordinal_position;

SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname = 'fk_compliance_report_reviews_submission_report'
   OR conname IN ('uq_compliance_report_submission_id_report',
                  'uq_compliance_report_reviews_submission',
                  'chk_compliance_submission_actor_role',
                  'chk_compliance_review_actor_role');

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = current_schema()
  AND indexname = 'uq_compliance_report_reviews_submission';

SELECT c.relname AS table_name, t.tgname AS trigger_name,
       pg_get_triggerdef(t.oid)
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = current_schema()
  AND NOT t.tgisinternal
  AND t.tgname IN (
      'trg_compliance_report_reviews_submitted_state',
      'trg_compliance_reports_status_transition',
      'trg_compliance_report_submissions_status_at_commit',
      'trg_compliance_report_reviews_status_at_commit'
  )
ORDER BY c.relname, t.tgname;

SELECT c.relname AS table_name, t.tgname AS trigger_name,
       pg_get_triggerdef(t.oid)
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = current_schema()
  AND NOT t.tgisinternal
  AND c.relname IN
      ('compliance_reports', 'compliance_report_submissions',
       'compliance_report_reviews')
ORDER BY c.relname, t.tgname;
```

Reconcile legacy report counts and IDs to the pre-migration record. For the
workflow migration, legacy rows must remain marked legacy with no fabricated
submission content/timestamps. For the actor follow-up, prior history may
retain NULL name/role snapshots; do not backfill guessed identity. Verify
application smoke tests in a controlled environment before reconnecting the
real application.

## Runtime privilege review

The application runtime role must not own the schema/tables, be a superuser,
or have DDL capabilities. Check the actual deployment role explicitly:

```sql
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
       rolbypassrls
FROM pg_roles
WHERE rolname = current_user;

SELECT has_schema_privilege(current_user, current_schema(), 'CREATE')
           AS can_create_in_schema,
       has_table_privilege(current_user, 'compliance_report_submissions', 'TRUNCATE')
           AS can_truncate_submissions,
       has_table_privilege(current_user, 'compliance_report_reviews', 'TRUNCATE')
           AS can_truncate_reviews;
```

Assess DDL ability through schema/object ownership and owner-role membership:

```sql
SELECT n.nspname AS schema_name, pg_get_userbyid(n.nspowner) AS schema_owner,
       pg_has_role(current_user, n.nspowner, 'MEMBER') AS member_of_schema_owner
FROM pg_namespace n
WHERE n.nspname = current_schema();

SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS table_owner,
       pg_has_role(current_user, c.relowner, 'MEMBER') AS member_of_table_owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = current_schema()
  AND c.relname IN ('compliance_report_submissions', 'compliance_report_reviews');
```

A database owner/superuser used by an operator or migration job has broader
powers than the runtime application role and must be assessed separately. Do
not grant the runtime role ownership merely to make migrations convenient.
Verify that the runtime role cannot `TRUNCATE` history and cannot change schema
objects through ownership, owner-role membership, or superuser privileges.

## Rollback and application reconnection

Before `COMMIT`, any migration error must abort the complete transaction. After
`COMMIT`, there is no automatic down migration: removing columns/tables would
destroy reports, submissions, decisions, or auditability. If post-migration
verification fails, keep the application disconnected from workflow writes,
preserve logs and the post-migration database for investigation, and restore
the verified pre-migration backup to a separate database under the approved
recovery plan. Do not try to reverse the migration with ad hoc `DROP` statements.

Reconnect the application only after all of the following are signed off:

- Database/server/schema identity and PostgreSQL version are confirmed.
- Backup restoreability and legacy-row reconciliation are confirmed.
- Expected keys, constraints, indexes, functions, and triggers are present.
- Runtime role has only the required application privileges and cannot truncate
  history or alter schema.
- Isolated PostgreSQL tests and application workflow smoke tests pass.
- The application configuration points to the approved migrated database,
  with secrets handled through the approved secret manager and not printed.
