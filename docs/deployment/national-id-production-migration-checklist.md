# National ID production migration checklist

> **Authorization gate:** This runbook is operational guidance only. It does
> not authorize a production migration, backfill, maintenance pause, or database
> write. Obtain separate explicit authorization for each.

Use this checklist only for an existing installation. `database/schema.sql` is
for fresh installs; it drops existing objects and must not be applied to an
existing production database.

## 1. Pre-deployment checks

- [ ] Confirm the target database name, PostgreSQL version, schema state, and
  migration ledger. Reconstruct the exact deployed predecessor and rehearse
  that schema and migration sequence in an isolated environment. The previous
  rehearsal used the committed predecessor plus
  `database/migration_pension_account_ledger.sql` and
  `database/migration_withdrawal_payout_otp_authorization_forward.sql`; do not
  replay either if the production migration ledger shows it is already applied.
- [ ] Take a recoverable database backup and verify a restore rehearsal in an
  isolated environment. Confirm both encryption keys are available from the
  approved secret manager before accepting the backup as recoverable.
- [ ] Identify the actual API database login through the deployment’s approved
  configuration and database role catalog. Do not print or copy its
  connection string. Confirm it is not either National ID security role, has
  no evidence-table write privileges, and cannot inherit or assume verifier
  privileges.
- [ ] Provision and verify the separate roles before migration:
  - `micopesa_national_id_evidence_owner`: `NOLOGIN`, `NOINHERIT`, no elevated
    attributes or memberships. It owns the evidence table and trigger function.
  - `micopesa_national_id_verifier`: `LOGIN`, `NOINHERIT`, no elevated
    attributes or memberships. Provision its credential separately through
    the approved secret manager or client-certificate mechanism. Never use it
    as the API login.
- [ ] Confirm the migration operator is separately trusted. Schema installation
  and expansion require a trusted superuser for ownership transfer; contract
  requires source-table ownership or superuser privileges.
- [ ] Provision distinct `NATIONAL_ID_ENCRYPTION_KEY` and
  `NATIONAL_ID_FINGERPRINT_KEY` values as canonical base64 encodings of
  separate 32-byte keys. Back them up, access-control them, and verify
  recovery without displaying or logging values. This migration supports only
  key version `v1`; do not rotate keys during the rollout.
- [ ] Approve and communicate a write pause for worker registration,
  National ID/KYC submissions, approvals, and writes to `kyc_records` and
  `pending_registrations`. Drain in-flight writes and keep the pause through
  contract completion and application verification.

## 2. Migration sequence

Record the target name, schema/migration revision, operators, timestamps,
reports, and approval references in the deployment record. Do not place
credentials, keys, or National ID values in that record.

1. **Back up and preflight.** Complete all checks above. Use the approved
   deployment migration mechanism; no complete SQL-migration wrapper command
   is defined in this repository. Where that mechanism invokes `psql`, use the
   documented stop-on-error option `psql -v ON_ERROR_STOP=1`. Apply only the
   exact migration file named at each step.
2. **Expand.** Apply
   `database/migration_worker_identity_expand_forward.sql` with the trusted
   migration operator. Do not use the API login. Confirm the transaction
   completed successfully before proceeding.
3. **Dry-run.** From the repository root, run:

   ```text
   node apps/api/scripts/backfillNationalIdEncryption.js
   ```

   Dry-run is the default and does not write. It uses the normal application
   database configuration (`DATABASE_URL`); verify by approved means that it
   targets the intended database without exposing the connection string.
4. **Review dry-run findings.** Review counts and non-PII record references.
   Require zero malformed IDs, invalid ciphertext, duplicate fingerprints,
   missing claims, and claim conflicts. Resolve every finding before apply.
5. **Controlled apply.** Only after separate authorization, provide the
   one-shot process with `NATIONAL_ID_BACKFILL_DATABASE_URL` through the
   approved secret mechanism. It must connect as
   `micopesa_national_id_verifier`. From the repository root, run:

   ```text
   node apps/api/scripts/backfillNationalIdEncryption.js --apply --confirm-database <exact_database_name>
   ```

   The database-name argument must exactly match the target. The utility
   rejects a database-name or login mismatch. Do not put credentials in the
   command line or shell history.
6. **Verify before redaction.** Require a successful apply report with
   `complete: true` and `contractReady: true`, and zero malformed IDs,
   invalid ciphertext/evidence, duplicate fingerprints, missing claims, or
   conflicts. Then rerun the dry-run while plaintext is still present. Require
   successful AES-GCM decryption/authentication, normalized plaintext match,
   fingerprint and last-four verification for every applicable record. The
   apply records evidence transactionally; PostgreSQL itself does not verify
   AES-GCM.
7. **Contract.** Only after the preceding gate passes, apply
   `database/migration_worker_identity_contract_forward.sql` with a trusted
   source-table owner or superuser. It locks source, claims, and evidence
   tables, checks evidence against each exact record and envelope, and
   redacts plaintext within one transaction. Do not proceed if it fails.
8. **Post-migration checks.** Confirm the schema, constraints, indexes,
   ownership, grants, key-version defaults, and application compatibility.
   Disable the verifier login immediately after successful contract:

   ```sql
   ALTER ROLE micopesa_national_id_verifier NOLOGIN;
   ```

   Remove its short-lived authentication material. Keep verification evidence
   for audit and preserve the write pause until the checks in section 5 pass.

## 3. Stop conditions

Stop the rollout and do not run the next step if any of the following occurs:

- The target PostgreSQL version, schema predecessor, migration history, or
  role ownership/privileges differ from the rehearsed and approved state.
- Backup creation, restore testing, key recovery, or the write-pause plan is
  incomplete.
- A National ID is missing where a source record requires one, malformed, or
  duplicated; a fingerprint is duplicated; or claims are missing/conflicting.
- Encryption, decryption, authentication-tag verification, plaintext match,
  fingerprint, last-four, or supported key-version validation fails.
- Evidence is absent, belongs to another record, or does not exactly match the
  record’s ciphertext envelope, version, and fingerprint.
- Either key is unavailable, the verifier uses the wrong login, or an API
  login can write evidence or inherit verifier privileges.
- The utility exits nonzero, its report is incomplete, or dry-run and apply
  results have any unexplained discrepancy.
- A migration errors, times out, or its commit state is uncertain. Do not
  blindly rerun it.

## 4. Recovery

- **Expansion:** The migration is transactional. If it errors, stop and
  establish whether PostgreSQL committed or rolled back before any retry.
  Inspect state using the approved deployment procedure; do not apply a
  destructive down migration or remove added objects by hand.
- **Backfill:** Each source-row update and evidence insert is one transaction.
  On interruption, committed rows remain encrypted with their evidence and
  uncommitted row work rolls back. Preserve the same keys and verifier
  identity, rerun dry-run, investigate any discrepancy, then resume with the
  exact confirmed database name. Never redact plaintext manually.
- **Contract:** It is transactional and locks the relevant tables. A failed
  preflight rolls back without contract redaction. Preserve the database state,
  resolve the reported issue through an approved procedure, rerun backfill
  where appropriate, and retry only after review. If the connection is lost
  around commit, determine commit state before taking action.
- **After contract:** Older application code cannot read the `ENCRYPTED`
  sentinel. There is no routine down migration. Restoring plaintext requires
  a separately reviewed and authorized recovery procedure that decrypts and
  authenticates every record, checks fingerprints and last-four values, and
  verifies row counts before any older code is deployed. Do not restore or roll
  back historical data until transaction and backup state have been assessed.

## 5. Post-migration verification

- [ ] Confirm no `kyc_records` or `pending_registrations` rows contain
  plaintext: the legacy column is the documented `ENCRYPTED` sentinel, while
  encrypted fields, fingerprint, last-four, and `v1` version are populated.
- [ ] Retain the pre-contract utility report proving every applicable record
  decrypted/authenticated and matched its normalized plaintext. Contract SQL
  validates evidence structure and binding, not AES-GCM. The backfill utility
  is not a post-contract decryption check because it cannot compare the
  `ENCRYPTED` sentinel to the original plaintext. If a post-contract
  decryption test is required, use a separately approved application-side
  procedure that does not disclose National IDs.
- [ ] Confirm the evidence table and trigger function are owned by
  `micopesa_national_id_evidence_owner`; PUBLIC and the API login cannot
  insert, update, or delete evidence; the API cannot inherit verifier
  privileges.
- [ ] Confirm the verifier had only its intended column-level reads, envelope
  updates, and claim/evidence reads/inserts during apply; its login is now
  disabled and its temporary credential removed.
- [ ] Compare approved pre/post counts or integrity checks for users, account
  statuses, KYC, financial transactions, pension accounts/ledger, and audit
  history. Investigate every unexplained change.
- [ ] Run approved application smoke checks for phone registration, pending
  worker access restrictions, Admin approval/rejection, and ordinary masked
  National ID responses. Confirm no change to payment, ledger, or audit
  behavior.

## 6. Authorization boundary

This checklist does not authorize production execution. Production migration,
backfill, verifier credential provisioning, and any maintenance/write pause
each require separate explicit authorization. Isolated rehearsals and passing
tests are not production authorization.
