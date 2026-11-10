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
