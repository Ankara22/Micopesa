# MicoPesa Database Design

This document records the database model represented in `../diagrams/micopesa-diagrams.xml`.
It is a design specification only; SQL implementation belongs in `../../../database/schema.sql`.

## Roles

`USERS.role` is a single shared field with exactly four valid values. There is
one `USERS` table for every role - roles are **not** modeled as separate
tables.

| Role | Responsibilities |
|---|---|
| `WORKER` | Register/login, make contributions, view balance and contribution history, create/update a retirement plan, view retirement projections, access financial literacy content, submit withdrawal claims, receive notifications. |
| `FUND_MANAGER` | Login, manage funds, review withdrawal claims, create and submit compliance reports for managed funds, respond to revision requests, and review operational audit logs. |
| `REGULATOR` (RBA Regulator) | Login, review submitted compliance reports, accept/reject/request revisions, audit fund performance & compliance, review operational audit logs. |
| `ADMIN` (System Administrator) | Login, manage users, manage roles & permissions, manage system configuration (`SYSTEM_SETTINGS`), manage system notifications, monitor system activity, review system audit logs. |

### Role boundaries enforced at the database layer

- `WITHDRAWAL_CLAIMS.reviewed_by` must reference a `USERS` row with
  `role = 'FUND_MANAGER'`. Enforced by the `enforce_withdrawal_claim_reviewer_role`
  trigger. **`ADMIN` can never be a withdrawal-claim reviewer.**
- `FUNDS.managed_by` must reference a `USERS` row with `role = 'FUND_MANAGER'`.
  Enforced by the `enforce_fund_manager_role` trigger (implemented in
  `schema.sql`). **`WORKER`, `REGULATOR`, and `ADMIN` can never manage a
  pension fund.**
- New `COMPLIANCE_REPORTS` rows must be created by an active `FUND_MANAGER`
  and name a fund. Updates may clear `generated_by` to preserve historical
  reports when a manager is deleted. Enforced by the
  `enforce_compliance_report_generator_role` and
  `enforce_compliance_report_fund_owner` triggers. Existing pre-workflow rows
  are preserved as legacy records and are not rewritten to satisfy these new
  rules.
- `ADMIN` is not a withdrawal approver, not a fund manager, and not the
  responsible regulatory actor for generating regulatory/compliance reports;
  its responsibility is managing the application/platform (users, roles,
  system configuration, and system-wide notifications/audit visibility).

## Tables

### USERS

Primary key:

- `user_id`

Columns:

- `user_id` - `VARCHAR_25`, primary key
- `full_name` - `VARCHAR_100`
- `phone` - `VARCHAR_15`, unique
- `password_hash` - `VARCHAR_255`
- `role` - `VARCHAR_20`, one of `WORKER`, `FUND_MANAGER`, `REGULATOR`, `ADMIN` (see [Roles](#roles))
- `occupation` - `VARCHAR_50`
- `account_status` - `VARCHAR_15`
- `created_at` - `DATE`

### KYC_RECORDS

Primary key:

- `kyc_id`

Foreign keys:

- `user_id` references `USERS.user_id`, unique

Columns:

- `kyc_id` - `VARCHAR_25`, primary key
- `user_id` - `VARCHAR_25`, foreign key, unique
- `national_id` - `VARCHAR_25`, unique
- `date_of_birth` - `DATE`
- `kyc_status` - `VARCHAR_15`
- `verified_at` - `DATE`

### PENSION_ACCOUNTS

Primary key:

- `account_id`

Foreign keys:

- `user_id` references `USERS.user_id`, unique

Columns:

- `account_id` - `VARCHAR_25`, primary key
- `user_id` - `VARCHAR_25`, foreign key, unique
- `current_balance` - `REAL`
- `retirement_age` - `INTEGER`
- `account_status` - `VARCHAR_15`
- `created_at` - `DATE`

### FUNDS

Primary key:

- `fund_id`

Foreign keys:

- `managed_by` references `USERS.user_id`

Columns:

- `fund_id` - `VARCHAR_25`, primary key
- `managed_by` - `VARCHAR_25`, foreign key
- `fund_name` - `VARCHAR_50`
- `administrator_name` - `VARCHAR_50`
- `risk_level` - `VARCHAR_15`
- `expected_return` - `REAL`
- `fund_status` - `VARCHAR_15`

Rules:

- The user referenced by `managed_by` must be authorized with the
  `FUND_MANAGER` role. `WORKER`, `REGULATOR`, and `ADMIN` users must be
  rejected (enforced by the `enforce_fund_manager_role` trigger).

### RETIREMENT_PLANS

Primary key:

- `plan_id`

Foreign keys:

- `account_id` references `PENSION_ACCOUNTS.account_id`

Columns:

- `plan_id` - `VARCHAR_25`, primary key
- `account_id` - `VARCHAR_25`, foreign key
- `target_amount` - `REAL`
- `target_age` - `INTEGER`
- `expected_return` - `REAL`
- `contribution_frequency` - `VARCHAR_20`
- `plan_status` - `VARCHAR_15`

### RETIREMENT_PROJECTIONS

Primary key:

- `projection_id`

Foreign keys:

- `plan_id` references `RETIREMENT_PLANS.plan_id`

Columns:

- `projection_id` - `VARCHAR_25`, primary key
- `plan_id` - `VARCHAR_25`, foreign key
- `assumed_contribution` - `REAL`
- `assumed_return` - `REAL`
- `projected_amount` - `REAL`
- `projection_years` - `INTEGER`
- `projected_at` - `DATE`

### CONTRIBUTIONS

Primary key:

- `contribution_id`

Foreign keys:

- `account_id` references `PENSION_ACCOUNTS.account_id`
- `transaction_id` references `TRANSACTIONS.transaction_id`, unique

Columns:

- `contribution_id` - `VARCHAR_25`, primary key
- `account_id` - `VARCHAR_25`, foreign key
- `transaction_id` - `VARCHAR_25`, foreign key, unique
- `amount` - `REAL`
- `channel` - `VARCHAR_20`
- `contribution_status` - `VARCHAR_15`
- `created_at` - `DATE`

### TRANSACTIONS

Primary key:

- `transaction_id`

Columns:

- `transaction_id` - `VARCHAR_25`, primary key
- `transaction_type` - `VARCHAR_20`
- `amount` - `REAL`
- `mpesa_receipt` - `VARCHAR_25`, unique
- `checkout_request_id` - `VARCHAR_25`, unique
- `transaction_status` - `VARCHAR_15`
- `initiated_at` - `DATE`
- `completed_at` - `DATE`

### WITHDRAWAL_CLAIMS

Primary key:

- `claim_id`

Foreign keys:

- `account_id` references `PENSION_ACCOUNTS.account_id`
- `reviewed_by` references `USERS.user_id`, nullable
- `transaction_id` references `TRANSACTIONS.transaction_id`, nullable, unique

Columns:

- `claim_id` - `VARCHAR_25`, primary key
- `account_id` - `VARCHAR_25`, foreign key
- `reviewed_by` - `VARCHAR_25`, nullable foreign key
- `transaction_id` - `VARCHAR_25`, nullable foreign key, unique
- `amount_requested` - `REAL`
- `destination_phone` - `VARCHAR_15`
- `claim_status` - `VARCHAR_15`
- `requested_at` - `DATE`
- `reviewed_at` - `DATE`
- `processed_at` - `DATE`

Rules:

- A pending claim may have `reviewed_by = NULL`.
- A pending or rejected claim may have `transaction_id = NULL`.
- After approval and payout, `transaction_id` stores the payout transaction.
- The user referenced by `reviewed_by` must be authorized with the `FUND_MANAGER` role.

### FUND_ALLOCATIONS

Primary key:

- `allocation_id`

Foreign keys:

- `account_id` references `PENSION_ACCOUNTS.account_id`
- `fund_id` references `FUNDS.fund_id`

Columns:

- `allocation_id` - `VARCHAR_25`, primary key
- `account_id` - `VARCHAR_25`, foreign key
- `fund_id` - `VARCHAR_25`, foreign key
- `percentage` - `REAL`
- `effective_from` - `DATE`
- `effective_to` - `DATE`

### NOTIFICATIONS

Primary key:

- `notification_id`

Foreign keys:

- `user_id` references `USERS.user_id` (the recipient)
- `created_by` references `USERS.user_id`, nullable (the originator, for
  administrative/broadcast notifications; `NULL` for system-generated
  notifications with no human originator)

Columns:

- `notification_id` - `VARCHAR_25`, primary key
- `user_id` - `VARCHAR_25`, foreign key (recipient)
- `created_by` - `VARCHAR_25`, nullable foreign key (originator, typically an `ADMIN`)
- `notification_type` - `VARCHAR_20`
- `message` - `VARCHAR_255`
- `delivery_status` - `VARCHAR_15`
- `created_at` - `DATE`
- `sent_at` - `DATE`

### USSD_SESSIONS

Primary key:

- `session_id`

Foreign keys:

- `user_id` references `USERS.user_id`

Columns:

- `session_id` - `VARCHAR_25`, primary key
- `user_id` - `VARCHAR_25`, foreign key
- `phone` - `VARCHAR_15`
- `session_status` - `VARCHAR_15`
- `started_at` - `DATE`
- `ended_at` - `DATE`

### AUDIT_LOGS

Primary key:

- `log_id`

Foreign keys:

- `user_id` references `USERS.user_id`

Columns:

- `log_id` - `VARCHAR_25`, primary key
- `user_id` - `VARCHAR_25`, foreign key
- `action_type` - `VARCHAR_20`
- `entity_name` - `VARCHAR_50`
- `entity_id` - `VARCHAR_25`
- `timestamp` - `DATE`

### COMPLIANCE_REPORTS

Primary key:

- `report_id`

Foreign keys:

- `generated_by` references `USERS.user_id`
- `fund_id` references `FUNDS.fund_id`

Columns:

- `report_id` - `VARCHAR_25`, primary key
- `generated_by` - `VARCHAR_25`, foreign key
- `fund_id` - `VARCHAR_25`, nullable foreign key for preserved legacy reports
- `report_type` - `VARCHAR_20`
- `period_start` - `DATE`
- `period_end` - `DATE`
- `report_content` - nullable `JSONB`, structured report sections; NULL for
  pre-workflow rows whose content was not recorded
- `is_legacy` - `BOOLEAN`, marks pre-workflow rows as historical/read-only
- `rba_status` - `VARCHAR_25`
- `generated_at` - `TIMESTAMP WITH TIME ZONE`
- `submitted_at`, `last_submitted_at` - submission timestamps

Rules:

- For active reports, authorization follows the fund's current
  `funds.managed_by` value, not `generated_by`. The manager who originally
  created the report remains attributed by `generated_by` where available;
  each immutable submission records the actual submitting manager. A manager
  who no longer manages the fund cannot read, edit, or resubmit its reports.
- New reports require an associated fund managed by their creating fund
  manager. Drafts may have incomplete period/type fields; submitted snapshots
  require a supported type and valid period.
- `rba_status` follows `DRAFT`, `SUBMITTED`, `REVISION_REQUESTED`, `ACCEPTED`,
  and `REJECTED`. Accepted and rejected reports are final. The API enforces
  transitions; database checks constrain the allowed values.
- `is_legacy` is true for every row present when the workflow migration runs.
  Legacy rows are preserved without fabricated content or snapshots; regulators can
  inspect them as historical records, but they cannot be reviewed or submitted
  through the active workflow. Unassigned legacy rows are not listed for
  managers.
- `compliance_report_submissions` stores append-only content snapshots for
  each submission/resubmission, including the submitting manager ID, name,
  and role captured from the active database user in the submission transaction.
  `compliance_report_reviews` is append-only (including protection against
  row update/delete and table truncate) and records the regulator ID,
  name, and role captured from the active database user in the decision
  transaction, along with decision, required reason for rejection/revision,
  and timestamp. Actor IDs are retained without user foreign keys so user
  deletion does not rewrite historical attribution. Names and roles are
  snapshots and are not rewritten when a user's profile, role, or status later
  changes. Historical rows created before actor snapshots were deployed retain
  NULL name/role snapshots; those identities are not fabricated. Review
  submission/report pairing is enforced by a composite foreign key.
- Workflow audit metadata records the acting user ID and role as well as the
  status transition. The audit table's user foreign key may be nulled by
  permanent user deletion, but the actor ID in the workflow audit details and
  submission/review history remains available.
- Only `FUND_MANAGER` can create/submit reports. `REGULATOR` can review
  submitted versions; the API enforces role, fund ownership, and transitions.
  PostgreSQL also enforces one review per submission and the status transitions
  `DRAFT -> SUBMITTED`, `SUBMITTED -> ACCEPTED | REJECTED | REVISION_REQUESTED`,
  and `REVISION_REQUESTED -> SUBMITTED`. A submission or decision must be
  written in the same transaction as its report status change.
- A resubmission is a new contiguous submission version and is allowed only
  after a regulator requests revisions. That review remains attached to the
  earlier version; accepted and rejected reports are terminal. The current
  report status must agree with the latest submission and its review, while
  earlier reviews remain unchanged.
- Supporting evidence is represented by structured text fields. There is no
  secure document-evidence storage service in this application.

### Applying the compliance workflow migration

`database/migration_compliance_review_workflow.sql` is a one-time migration
for an existing database initialized from the pre-workflow schema (the
finalized schema before compliance workflow columns/tables were added). It
expects the original `compliance_reports` columns, a `VARCHAR(15)` status
column, the named report type/period/status checks and generator trigger, and
the original audit action constraint. It also requires `users.user_id`,
`full_name`, `role`, and `account_status`, `funds.fund_id` and `managed_by`,
and `audit_logs.action_type`. The migration performs transactional preflight
checks and aborts on an incompatible or already-migrated schema.

Before applying manually, inspect the target database's `information_schema`
and `pg_catalog` to confirm that:

1. The pre-workflow tables and required columns/constraints are present.
2. None of `fund_id`, `report_content`, `submitted_at`, `last_submitted_at`,
   `is_legacy`, `compliance_report_submissions`, or
   `compliance_report_reviews` already exist.
3. The target was not initialized from the current `database/schema.sql`,
   which already includes the workflow schema. Do not apply the migration to
   that database.
4. The migration was not previously applied. A prior successful application
   is not rerunnable; use the canonical schema for new databases and migration
   history for existing ones.

Review the migration's preflight output with the database owner, apply it
manually in the intended environment, and verify constraints, triggers,
legacy-row counts, and transactional workflow behavior using an isolated
PostgreSQL database before enabling the feature. Mocked controller tests do
not verify PostgreSQL lock behavior, migration syntax on the target version,
or rollback behavior.

Use [the compliance workflow migration runbook](./compliance-workflow-migration-runbook.md)
for the exact starting-schema checks, backup steps, execution, verification
queries, and rollback limitations.

If the earlier compliance workflow migration has already been applied without
actor-name/role columns, do not rerun or replace it. Apply
`database/migration_compliance_actor_snapshots.sql` as a separate one-time
follow-up after confirming its preflight. Existing submissions and reviews keep
their actor IDs, but unavailable historical names/roles remain NULL. For a
database still at the original pre-workflow baseline, use the updated
`migration_compliance_review_workflow.sql` instead; do not apply both
migrations. New databases should use the current canonical `schema.sql`.

After the workflow schema and actor snapshots are installed, apply
`database/migration_compliance_workflow_enforcement.sql` to add the unique
decision-per-submission index and database-enforced workflow transitions.
Its preflight validates existing data and the actual constraints, triggers,
and trigger functions before making changes; it stops rather than deleting,
repairing, or rewriting history.
Use the compliance migration runbook for the complete migration order and
isolated PostgreSQL verification steps.

### SYSTEM_SETTINGS

Primary key:

- `setting_id`

Foreign keys:

- `updated_by` references `USERS.user_id`, nullable

Columns:

- `setting_id` - `VARCHAR_25`, primary key
- `setting_key` - `VARCHAR_100`, unique
- `setting_value` - `VARCHAR_255`
- `description` - `VARCHAR_255`
- `updated_by` - `VARCHAR_25`, nullable foreign key (the administrator who last changed the setting)
- `updated_at` - `DATE`

Rules:

- Represents persisted system configuration and administrative platform
  settings (e.g. feature toggles, contribution/withdrawal limits, contact
  details shown in the app). Intended to be managed exclusively by `ADMIN`
  users, though this is an application-layer rule (no reviewer-style
  database trigger restricts `updated_by` to `ADMIN`, since a setting may
  also be seeded/initialized outside the admin console).
- `updated_by` is nullable and `ON DELETE SET NULL` so a setting is never
  lost if the administrator who last touched it is later removed.

## Relationships

- `USERS` 1 to 0..1 `KYC_RECORDS`: verifies
- `USERS` 1 to 0..1 `PENSION_ACCOUNTS`: owns
- `USERS` 1 to 0..* `FUNDS`: manages
- `USERS` 1 to 0..* `NOTIFICATIONS`: receives (`user_id`)
- `USERS` 0..1 to 0..* `NOTIFICATIONS`: creates (`created_by`)
- `USERS` 1 to 0..* `USSD_SESSIONS`: performs
- `USERS` 1 to 0..* `AUDIT_LOGS`: generates
- `USERS` 1 to 0..* `COMPLIANCE_REPORTS`: submits (`FUND_MANAGER` only)
- `FUNDS` 1 to 0..* `COMPLIANCE_REPORTS`: is reported on
- `COMPLIANCE_REPORTS` 1 to 0..* `COMPLIANCE_REPORT_SUBMISSIONS`: preserves versions
- `COMPLIANCE_REPORTS` 1 to 0..* `COMPLIANCE_REPORT_REVIEWS`: records decisions
- `USERS` 0..1 to 0..* `WITHDRAWAL_CLAIMS`: reviews (`FUND_MANAGER` only)
- `USERS` 0..1 to 0..* `SYSTEM_SETTINGS`: updates (typically `ADMIN`)
- `PENSION_ACCOUNTS` 1 to 0..* `RETIREMENT_PLANS`: has
- `RETIREMENT_PLANS` 1 to 0..* `RETIREMENT_PROJECTIONS`: generates
- `PENSION_ACCOUNTS` 1 to 0..* `CONTRIBUTIONS`: receives
- `PENSION_ACCOUNTS` 1 to 0..* `WITHDRAWAL_CLAIMS`: submits
- `PENSION_ACCOUNTS` 1 to 0..* `FUND_ALLOCATIONS`: allocated in
- `FUNDS` 1 to 0..* `FUND_ALLOCATIONS`: allocates
- `TRANSACTIONS` 1 to 0..1 `CONTRIBUTIONS`: settles
- `TRANSACTIONS` 1 to 0..1 `WITHDRAWAL_CLAIMS`: settles

## Withdrawal claim workflow

1. A worker's pension account submits a withdrawal claim.
2. The claim starts as pending, with no reviewer and no payout transaction.
3. A fund manager reviews the claim and is stored in `WITHDRAWAL_CLAIMS.reviewed_by`.
4. If the claim is approved and paid out, the payout transaction is stored in `WITHDRAWAL_CLAIMS.transaction_id`.
