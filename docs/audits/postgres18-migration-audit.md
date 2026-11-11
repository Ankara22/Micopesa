# PostgreSQL 18 migration audit checkpoint

## Scope and status

- Migration: `database/migration_micopesa_integrations_forward.sql`
- PostgreSQL target reported by the project owner: 18.6
- Audit database target reported by the project owner: `Micopesa_migration_audit`
- Runtime status: **not verified**. No authenticated PostgreSQL catalog query or migration execution completed in this run.

## Reported failure

The reported migration error is:

`Incompatible mobilesasa_sms_delivery_callbacks: constraint ck_mobilesasa_callback_lifecycle has an unexpected definition`

The error was reported from the normalized CHECK-definition comparison. The actual catalog definition and normalized output could not be queried, so the exact database-side mismatch remains unknown. The previously added constraint uses uppercase lifecycle literals, but case alone is not established as the cause: the migration normalizes both definitions with `lower(...)`.

The owner also reported PostgreSQL's truncated constraint identifier as:

`mobilesasa_sms_delivery_callba_provider_message_reference_check`

Both references in the migration source use that spelling; a static regression test checks it.

## Source changes in this checkpoint

- Added case-sensitive comparisons of quoted literals for the MobileSasa unmatched partial-index predicate.
- Added case-sensitive comparisons of quoted literals for all three checks of the M-Pesa active-attempt partial-index predicate (existing-index detection, named-index compatibility, and conditional creation guard).
- Added static regression coverage for these literal checks.

These are source-level safeguards only; PostgreSQL 18 parsing and catalog formatting remain unverified.

## Validation

- `node --test apps/api/tests/databaseSchemaStatic.test.js`: 14 passed, 0 failed.
- `node --test apps/api/tests/micopesaValidationDatabase.test.js`: 3 passed, 0 failed.
- `node --test apps/api/tests/mobileSasaDlrRepository.test.js apps/api/tests/notificationEventService.test.js`: 20 passed, 0 failed.
- `npm test`: API unit tests 585 passed, 0 failed; web tests 48 files and 266 tests passed.
- JavaScript syntax checks: passed.
- `git diff --check`: passed; Git emitted only line-ending warnings for unrelated pre-existing web files.

## Database validation blocker

A read-only `psql` identity query was started for `::1:5433`, database `Micopesa_migration_audit`, with `-W`. The shell bridge waited for password input but could not provide an interactive terminal for the owner to enter it. The process was stopped before authentication; no SQL ran and no database was modified.

Consequently, the initial migration execution, idempotency run, catalog inspection, existing-record preservation, and `delivery_report_records` non-interference have not been runtime-verified. Do not treat this checkpoint as a successful PostgreSQL migration.
