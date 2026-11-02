# MicoPesa

## Automated tests

The regression suite uses Node's built-in test runner for the Express/PostgreSQL API and Vitest with React Testing Library for the React frontend.

1. Install application dependencies with `npm ci --prefix apps/api` and `npm ci --prefix apps/web`.
2. Provide `TEST_DATABASE_URL` for a dedicated local PostgreSQL database named exactly `micopesa_test` and `TEST_DATABASE_ADMIN_URL` for a different database on that same local server, with permission to create/drop the test database. The committed `.env.test` contains placeholders; provide real local connection details through shell environment variables, not by editing the committed file. The setup rejects non-local hosts and any database name other than `micopesa_test`.
3. Run `npm run db:test:setup` to create/reset the isolated database, apply the application schema and additive migrations, and load fixtures per test.
4. Run `npm test`, or run `npm run test:api`, `npm run test:frontend`, and `npm run test:coverage` as needed. Run `npm run db:test:teardown` to drop only `micopesa_test`.

Daraja values in `.env.test` are placeholders. API tests intercept sandbox and production Daraja hosts and reject all other external network requests. They do not perform real payments.
