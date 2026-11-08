# Static database migration review

This review is based on reading the checked-in canonical schema, migration
files, and existing deployment runbooks only. No SQL was executed and no
database was inspected. It cannot establish which migrations have been applied
to any live or test database.

## Installation paths

### New database

Initialize a new database from `database/schema.sql` only. The canonical schema
already defines the expanded M-Pesa attempt, verification and callback-inbox
tables; contribution fund allocations; SMS/email/push notification fields and
push subscriptions; regulator fund assignments; notification audit events;
report history; and the later compliance workflow objects.

Do not apply additive migrations on top of this schema. Many are intentionally
one-time upgrades and repeat their `ALTER TABLE`, `CREATE TABLE`, index, or
trigger operations without guards.

### Existing database

Before any upgrade, identify the installed schema revision and its completed
migrations from the database owner's deployment records. Take and verify a
backup, review preflight queries, and apply only the path appropriate to that
revision. Filenames alone are not a migration ledger. This review does not
authorize a migration window or determine the state of any database.

`migration_to_final_schema.sql` targets a particular older 14-table baseline.
Its header describes compatibility and data-preservation intent, but it is not
a universal bridge from every historical or current schema. The compliance
runbook specifically warns that it can replace compliance policy and must not
be run after the current canonical schema or workflow migrations.

## Reviewed dependency chains

### M-Pesa payment lifecycle

The deployment runbook's existing order is:

1. `migration_mpesa_stk_push.sql`
2. `migration_mpesa_payment_attempts.sql`
3. `migration_mpesa_payment_verifications.sql`
4. `migration_mpesa_payment_settlement.sql`
5. `migration_mpesa_query_only_settlement.sql`
6. `migration_mpesa_retry_recovery.sql`

The attempt migration depends on the contribution/transaction relationships
and short-ID/update-trigger helpers. Verification depends on attempts;
settlement and query-only settlement successively tighten verification
constraints; retry/recovery depends on both attempts and verifications. The
last migration preflights duplicate active attempts before adding the partial
unique index, then creates the durable callback inbox. It aborts rather than
choosing or deleting duplicate attempts.

The current canonical schema already contains the end-state objects and
constraints. Do not replay this chain against a database initialized from it.
The public initiation endpoint remains disabled independently of the schema.

The callback inbox has no configured expiry or cleanup policy in the current
schema. The payment lifecycle decision document requires an approved retention
period that covers provider retries, unmatched-callback recovery, deduplication,
and applicable audit requirements. Do not delete callback evidence by age
until that period is approved. Enforcing expiry in the database would require a
future migration and a reviewed cleanup process; neither was prepared or
executed in this follow-up.

### Notification delivery and reporting

For the documented pre-expansion notification schema, the order is:

1. `migration_sms_persistent_delivery.sql`
2. `migration_unified_notifications.sql`
3. `migration_role_notifications_and_reporting.sql`

The SMS migration expands delivery states and maps legacy `SENT` rows to
`PROVIDER_ACCEPTED`; that is acceptance, not proof of delivery. The unified
migration adds email/push snapshots and push subscriptions. The role/reporting
migration depends on the expanded notification fields and index, and adds
regulator scopes, immutable notification audit events, and report history.
Fresh canonical installs already include these objects.

These are one-time upgrade scripts, not a general sequence for databases that
already contain some of the changes. In particular, the SMS migration drops
the specifically named legacy status constraint without `IF EXISTS`, and the
unified migration drops a specifically named unique index. Confirm the
expected predecessor state before considering either.

### Compliance workflow

Use exactly one path in
`docs/design/database/compliance-workflow-migration-runbook.md`:

- Pre-workflow database: workflow migration, then enforcement.
- Workflow database missing actor snapshots: actor-snapshot migration, then
  enforcement.
- Actor snapshots present but enforcement absent: enforcement only.
- New database: canonical schema, no compliance migrations.

Do not apply the one-time workflow migration to the current schema, and do not
apply actor-snapshot columns twice. The enforcement migration validates
existing constraints, triggers, and history and aborts on inconsistencies; it
does not repair or fabricate historical data. If a legacy installation also
needs the finalized-schema migration, the runbook requires that to be reviewed
and applied first.

### Other additive upgrades

The deployment documentation identifies several upgrades that are required
only when an existing installation lacks their objects:

- `migration_user_profiles.sql`, then `migration_auth_email_recovery.sql`,
  then `migration_email_login_policy.sql`.
- `migration_retirement_projection_series.sql` after the canonical base and
  before deploying code that reads the new projection fields.
- `migration_admin_panel_settings.sql` after users, audit logs, and system
  settings exist.
- `migration_admin_user_deletion.sql` after the finalized schema; it changes
  manager/generator foreign-key nullability and delete behavior.
- `migration_contribution_fund_allocations.sql` after contributions and funds
  exist. Existing contributions are intentionally left without allocation
  snapshots.
- `migration_withdrawal_pending_unique.sql` after reviewing the preflight
  results; it aborts when duplicate pending claims exist.
- `migration_withdrawal_reason.sql` for installations without the reason
  column.

These scripts are not interchangeable with canonical initialization. Several
are unguarded one-time DDL; do not infer that rerunning is safe from an
additive description.

## Static risks and verification limits

- There is no single migration manifest or version ledger in the reviewed
  repository. Deployment records and schema inspection are necessary to choose
  an upgrade path.
- `migration_to_final_schema.sql` carries a historical “15-table” description
  while the canonical schema now contains many more feature tables. Treat the
  migration as a specific legacy transition, not as the current schema builder.
- Notification and compliance migrations have explicit predecessor
  requirements; applying them out of order can fail or leave application code
  expecting absent columns and constraints.
- Some migrations include conflict preflights, but these only establish the
  conditions they test. They do not prove data integrity for unrelated
  constraints or application invariants.
- The canonical schema contains the feature objects identified above, but this
  static review does not prove that the file executes successfully on a
  particular PostgreSQL version or that an existing database matches it.
- No migration was executed, no schema was changed by this review, and no
  database connection was made.

## Recommended release procedure

1. Have the database owner identify the exact installed baseline and migration
   history without relying on this repository's Git state.
2. Select the corresponding documented migration path and review its
   preconditions against a verified backup and an isolated clone.
3. Run only the approved migration path in the normal controlled change
   window; retain logs and verify constraints, triggers, row counts, and
   application compatibility afterward.
4. For a fresh install, test `database/schema.sql` separately on the supported
   PostgreSQL version, then run schema-level and application integration tests
   against an isolated database.
