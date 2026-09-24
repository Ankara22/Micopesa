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
| `FUND_MANAGER` | Login, manage fund performance, audit fund performance & compliance, review and approve withdrawal claims, generate RBA/NSSF and operational reports, view compliance reports, review operational audit logs. |
| `REGULATOR` (RBA Regulator) | Login, view compliance reports, audit fund performance & compliance, review operational audit logs. |
| `ADMIN` (System Administrator) | Login, manage users, manage roles & permissions, manage system configuration (`SYSTEM_SETTINGS`), manage system notifications, monitor system activity, review system audit logs. |

### Role boundaries enforced at the database layer

- `WITHDRAWAL_CLAIMS.reviewed_by` must reference a `USERS` row with
  `role = 'FUND_MANAGER'`. Enforced by the `enforce_withdrawal_claim_reviewer_role`
  trigger. **`ADMIN` can never be a withdrawal-claim reviewer.**
- `FUNDS.managed_by` must reference a `USERS` row with `role = 'FUND_MANAGER'`.
  Enforced by the `enforce_fund_manager_role` trigger (implemented in
  `schema.sql`). **`WORKER`, `REGULATOR`, and `ADMIN` can never manage a
  pension fund.**
- `COMPLIANCE_REPORTS.generated_by` must reference a `USERS` row with
  `role IN ('FUND_MANAGER', 'REGULATOR')`. Enforced by the
  `enforce_compliance_report_generator_role` trigger. **`ADMIN` and `WORKER`
  can never generate a compliance report.**
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

Columns:

- `report_id` - `VARCHAR_25`, primary key
- `generated_by` - `VARCHAR_25`, foreign key
- `report_type` - `VARCHAR_20`
- `period_start` - `DATE`
- `period_end` - `DATE`
- `rba_status` - `VARCHAR_15`
- `generated_at` - `DATE`

Rules:

- The user referenced by `generated_by` must be authorized with the
  `FUND_MANAGER` or `REGULATOR` role. `WORKER` and `ADMIN` users must be
  rejected (enforced by the `enforce_compliance_report_generator_role`
  trigger).

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
- `USERS` 1 to 0..* `COMPLIANCE_REPORTS`: generates (`FUND_MANAGER` or `REGULATOR` only)
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
