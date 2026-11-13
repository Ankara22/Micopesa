# API integration tests

The KYC uniqueness integration test is intentionally separate from the mocked
API suite. Run it only against a disposable, loopback PostgreSQL database whose
name starts with `micopesa_` and includes `test`, `testing`, or `disposable`.
It rejects port 5433, creates a uniquely named temporary schema, applies the
KYC uniqueness migration inside that schema, and drops the schema afterward.

Set `MICOPESA_TEST_DATABASE_URL` in the shell (not an environment file), then
run `npm run test:integration:kyc` from `apps/api`. The test never falls back
to `DATABASE_URL` or `TEST_DATABASE_URL`. It is excluded from the normal API
unit-test runner.

## Micopesa integration feature tests

The PostgreSQL-backed preference, transactional notification, Daraja callback
inbox, MobileSasa delivery-report, and schema-integrity tests use a separate
runner pinned to `Micopesa_migration_validation` on loopback port `5433`. The
runner requires all five `MICOPESA_VALIDATION_DB_*` variables, does not load
environment files, verifies database name/server address/server port before
starting tests, and never falls back to application database settings. Each
test's writes run in a transaction that is rolled back. The tests call
repositories only; they do not send email/SMS or make M-Pesa requests.

From the repository root, set `MICOPESA_VALIDATION_DB_HOST` (`127.0.0.1` or
`::1`), `MICOPESA_VALIDATION_DB_PORT` (`5433`),
`MICOPESA_VALIDATION_DB_NAME` (`Micopesa_migration_validation`),
`MICOPESA_VALIDATION_DB_USER`, and `MICOPESA_VALIDATION_DB_PASSWORD` explicitly
in the shell, then run:

```powershell
npm run test:integration:micopesa
```
