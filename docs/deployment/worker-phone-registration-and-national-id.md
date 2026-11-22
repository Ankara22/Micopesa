# Worker phone registration and National ID protection

Worker registration verifies phone numbers by one-time code and activates the
account after password creation; a separate administrator approval is no
longer required. KYC remains an independent identity review and is not
automatically verified by registration. National IDs are stored as AES-256-GCM
ciphertext with a separate keyed uniqueness fingerprint. This does not change
financial ledgers, transfer account history, or authorize payout execution.

The encrypted envelope stores `national_id_key_version = 'v1'` alongside the
nonce, authentication tag, ciphertext, keyed fingerprint and last-four value.
The key version prevents a future rotation from silently mixing incompatible
key generations. Only `v1` is accepted by the Stage 1 migration and utility.

## Database rollout

Do not edit or rerun historical migrations. The API pool in
`apps/api/src/db/database.js` reads `DATABASE_URL`; it does not use the
backfill verifier connection. The API login must not be the verifier, an
evidence-table owner, or a member (directly or transitively) of either
National ID security role. The deployed API role cannot be identified from
source code alone; verify it in the target environment's deployment
configuration and role catalog without exposing its credentials.

Before either a fresh schema install or an existing-schema expansion, a
privileged database administrator must provision these separate roles:

- `micopesa_national_id_evidence_owner`: `NOLOGIN`, `NOINHERIT`, and no
  superuser, database-creation, role-creation, replication, or RLS-bypass
  attributes. It owns the evidence table and trigger function. It has no role
  memberships. The migration temporarily grants schema `CREATE` to transfer
  ownership, then revokes it.
- `micopesa_national_id_verifier`: a dedicated `LOGIN NOINHERIT` role with no
  elevated attributes and no role memberships. Provision its authentication
  through the approved secret manager or client-certificate mechanism. Never
  place its credential in source control or the API's `DATABASE_URL`.

The schema and expansion migration fail closed if either role is absent,
misconfigured, or has role memberships. Run role provisioning and ownership
DDL with a separately controlled database-administration identity—not the API
login. Because the evidence owner has no role memberships, schema installation
and expansion must run as a trusted superuser to transfer evidence ownership.
This is a privileged, separately authorized operation. The contract migration
must run as a trusted owner of the source tables (or superuser), because it
locks those tables and changes their constraints, indexes and triggers. The
verifier receives only `USAGE` on `public`; column-level reads of
the National ID fields and required IDs; updates to the six encrypted-envelope
columns; claim reads/inserts; and evidence reads/inserts. It cannot update or
delete evidence, insert the trigger-owned `verified_by` field, or create
objects in `public`. PUBLIC receives no evidence-table privileges. The
evidence owner is distinct from the verifier and the application.

Older API versions select `users.approval_status` during login and can fail if
that legacy column is absent. The current authentication and registration code
does not depend on the column. If an older API version must remain deployed,
`database/migration_users_approval_status_forward.sql` is an optional,
idempotent compatibility repair that adds the legacy field, constraint and
index without rewriting existing rows. It is not required by the current
release and must only be applied through the authorized database-change
process. Do not drop the column or historical approval records.

For an existing supported schema, prepare the rollout in this exact order:

1. Reconstruct the genuine predecessor from the repository history and
   rehearse the supported migration chain against it. Use the actual committed
   predecessor schema and required preceding migrations; do not make a
   simplified or hand-edited substitute. Preserve the selected commit and
   migration list in the rehearsal report.
2. Pause worker registration, National ID/KYC submissions and other
   writes to `kyc_records` and `pending_registrations`. Drain in-flight writes
   and keep the pause through contract completion. During this interval, an
   application-created encrypted row may not have backfill verification
   evidence, and plaintext-free rows cannot be retroactively verified against
   their original value. Do not treat the `ENCRYPTED` sentinel as plaintext.
3. Review and apply `database/migration_worker_identity_expand_forward.sql`.
   It adds the optional legacy approval field, encrypted-ID columns,
   challenge/claim/review tables, append-only cryptographic-verification
   evidence, and required constraints. The approval field is retained for
   historical compatibility but is not an account-access gate. Existing
   account statuses are unchanged; new legacy-column values default to
   `APPROVED`. The evidence table and trigger function are owned by the
   non-login owner role, not the migration or API login.
4. Set `NATIONAL_ID_ENCRYPTION_KEY` and
   `NATIONAL_ID_FINGERPRINT_KEY` in the deployment secret manager. Each must
   be a different canonical base64 encoding of 32 random bytes. Keep durable,
   access-controlled backups of both keys. Losing either key prevents
   decryption or identity matching; rotating them requires a separately
   reviewed re-encryption and re-fingerprinting procedure.
5. Run the utility's dry-run (no writes; dry-run is the default):

   ```text
   node apps/api/scripts/backfillNationalIdEncryption.js
   ```

   Review its counts and non-PII record references. The script reads
   `kyc_records` and `pending_registrations` in bounded, ordered batches. It
   verifies existing ciphertext by AES-GCM decryption/authentication,
   fingerprint and last-four checks; new ciphertext is decrypted and verified
   against the normalized plaintext. It never logs National ID values.
6. Only after a separate approval for that target, make
   `NATIONAL_ID_BACKFILL_DATABASE_URL` available to the one-shot backfill
   process through the approved secret mechanism and run:

   ```text
   node apps/api/scripts/backfillNationalIdEncryption.js --apply --confirm-database <exact_database_name>
   ```

   Apply mode requires both `--apply` and `--confirm-database <exact_database_name>`
   and rejects a database-name or login mismatch. Each source update and
   evidence insert is in one row transaction. If interrupted, committed
   rows remain encrypted with matching evidence; rerunning the utility
   authenticates those rows and records any missing evidence before continuing.
   It reports malformed rows, invalid ciphertext/evidence, duplicate
   fingerprints, missing claims, and claim conflicts without merging records.
   Unresolved rows remain unredacted and block the contract migration.
7. After the apply report is complete and all claims are consistent, review
   and apply `database/migration_worker_identity_contract_forward.sql`. It
   locks the source, claim and evidence tables against concurrent writes, then
   matches evidence to each exact source table, row ID, envelope, version and
   fingerprint before replacing any plaintext with `ENCRYPTED`. A failed
   preflight rolls back the transaction without redaction. Resume by resolving
   the reported issue, rerunning the backfill, and retrying the contract.
8. Disable the verifier login immediately after successful contract migration
   (`ALTER ROLE micopesa_national_id_verifier NOLOGIN`) and remove its
   short-lived authentication material. Keep the evidence records for audit.
   The API must never use this login.

For a fresh installation, pre-provision and verify the same roles, then apply
`database/schema.sql` only. Do not apply either forward migration to a fresh
schema.

The evidence mechanism trusts the segregated verifier credential and reviewed
application utility. The trigger stamps `verified_by` from `session_user`,
rejects non-verifier inserts, and rejects every update/delete. PostgreSQL does
not decrypt AES-GCM or validate its authentication tag; the application
utility performs decryption and authentication-tag verification and records
the result transactionally with the envelope it verified. Contract SQL checks
that this immutable evidence exactly matches the source row, but it does not
re-perform cryptography. Evidence is therefore durable audit evidence under
the assumption that the verifier credential and utility were not compromised.
PostgreSQL owners and superusers remain trusted: they can change
ownership/privileges, disable triggers, or forge evidence. Recheck role
memberships, ownership and grants after role-management changes. A copied
fingerprint or structurally populated ciphertext without matching verifier
evidence cannot pass contract preflight.

The backfill writes are intentionally separate from SQL migration execution.
Neither migrations nor backfill are executed by application startup.
Production execution requires a separate explicit authorization after a
successful rehearsal against the actual predecessor schema and target role
configuration. Automated tests and disposable rehearsal do not authorize a
production migration.

## Recovery and rollback

Before the contract migration, application code can be rolled back while
plaintext remains available; leave the added columns and tables in place.
Backfill itself is idempotent and can resume after interruption. Do not clear
an encrypted field or its fingerprint during rollback.

After contract migration, older code cannot read the `ENCRYPTED` sentinel.
Returning to an older application therefore requires a separately reviewed
restore utility that decrypts each record, checks its fingerprint and
last-four value, restores plaintext, and verifies the row counts before old
code is deployed. If any row fails authentication, stop; do not partially
roll back. Keep encrypted data and identity-claim records until a retention
and rollback decision is approved. There is no destructive down migration.

## Authentication paths

- `POST /api/auth/register` requests a phone code; phone verification and
  password submission complete registration in a separate request, after
  which an active account may sign in immediately.
- `POST /api/auth/login` and `requireAuth` check the existing account status
  and authentication version; inactive and suspended accounts remain blocked.
  Legacy approval values do not gate sign-in or protected routes.
- Existing verified-email login, email password recovery, profile email
  verification, and staff onboarding remain supported.
- Phone password recovery uses a separate one-time-code challenge and
  invalidates old JWTs by advancing `auth_version`.
- Registration and phone verification do not verify KYC. Financial services
  continue to enforce their independent KYC requirements, and existing KYC
  review history is preserved.
- Full National ID disclosure is restricted to a dedicated Admin endpoint
  requiring a reason; the audit event contains no National ID value. Ordinary
  APIs expose only the last four digits.

Financial event notices are queued after the corresponding transaction
commits. SMS and email remain separate,
preference-aware channels. No payout-completed event is emitted because this
change does not add payout execution.
