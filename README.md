# MicoPesa

## Automated tests

`npm test` runs mocked API unit tests and the frontend suite. Unit tests run in `NODE_ENV=test`, skip `.env` loading, and block PostgreSQL access and external `fetch` calls. They do not initialize or reset a database.

Use `npm run test:unit` for API unit tests and `npm run test:web` for frontend tests. The database-backed regression and PostgreSQL concurrency tests are excluded from the normal test command.

Database-backed tests are explicit and require `NODE_ENV=test`, `TEST_DATABASE_URL` for `127.0.0.1:5544/micopesa_registration_test`, and a successful `current_database()`/loopback identity check before tests run. Run a selected test without resetting the schema with:

```powershell
npm run test:integration -- apps/api/tests/regression.test.js
```

To reset the dedicated database before running selected tests, also set `ALLOW_DESTRUCTIVE_TEST_DB_SETUP=1` and provide `TEST_DATABASE_ADMIN_URL` for `127.0.0.1:5544/postgres`, then run:

```powershell
npm run test:db -- apps/api/tests/regression.test.js
```

The setup refuses missing databases rather than creating or redirecting them. It applies the canonical schema and listed migrations, which drop/recreate application tables; use only the disposable `micopesa_registration_test` database at the exact target above. `db:test:setup` has the same safeguards. Database teardown is separate and requires `NODE_ENV=test` and `ALLOW_DESTRUCTIVE_TEST_DB_TEARDOWN=1` in addition to the verified local database URLs.

Connection details must be supplied through shell environment variables; test commands do not load `.env` files. Database-backed tests can mutate the dedicated test database. Mocked tests do not establish PostgreSQL concurrency behavior, and no test command initiates M-Pesa payments or contacts a provider.

## Payment and notification integrations

Daraja configuration, sandbox preparation, production activation safeguards, and verification limits are documented in [docs/deployment/daraja-mpesa-integration.md](./docs/deployment/daraja-mpesa-integration.md). MobileSasa SMS/email configuration and delivery-report requirements are documented in [docs/deployment/mobilesasa-integration.md](./docs/deployment/mobilesasa-integration.md). Integration migrations are reviewed artifacts only and must be applied through an authorized deployment process.
