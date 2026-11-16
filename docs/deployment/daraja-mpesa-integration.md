# Daraja M-Pesa contributions

MicoPesa uses its existing payment-attempt, verification, reconciliation, and
settlement flow. An STK initiation response is only an acknowledgement; it
does not credit the pension account. A contribution is credited only after
the provider result is correlated with the stored attempt and the existing
settlement transaction confirms the payment.

The worker-facing flow uses the worker's verified profile phone and requires
the worker to confirm it before requesting an STK prompt. The API independently
validates the authenticated worker, verified phone, amount, and active-payment
rules. A pending or outcome-unknown attempt must be checked by its existing
status/idempotency reference; do not start a second request because of a
timeout.

## Configuration

Daraja configuration is server-side only. Never put credentials in the
frontend, browser storage, logs, or repository.

Required variable names:

- `DARAJA_ENV`: `sandbox` or `production`.
- `DARAJA_CONSUMER_KEY`
- `DARAJA_CONSUMER_SECRET`
- `DARAJA_BUSINESS_SHORTCODE`
- `DARAJA_PASSKEY`
- `DARAJA_CALLBACK_URL`
- `DARAJA_TRANSACTION_TYPE`: `CustomerPayBillOnline` or
  `CustomerBuyGoodsOnline`.

Compatibility aliases are also accepted:

- `MPESA_ENVIRONMENT` and the older `MPESA_DARAJA_ENVIRONMENT` alias
  `DARAJA_ENV`.
- `MPESA_CONSUMER_KEY` aliases `DARAJA_CONSUMER_KEY`.
- `MPESA_CONSUMER_SECRET` aliases `DARAJA_CONSUMER_SECRET`.
- `MPESA_SHORTCODE` and `MPESA_BUSINESS_SHORTCODE` alias
  `DARAJA_BUSINESS_SHORTCODE`.
- `MPESA_PASSKEY` aliases `DARAJA_PASSKEY`.
- `MPESA_CALLBACK_URL` aliases `DARAJA_CALLBACK_URL`.
- `MPESA_TRANSACTION_TYPE` aliases `DARAJA_TRANSACTION_TYPE`.

The exact legacy mapping is `MPESA_ENVIRONMENT` and
`MPESA_DARAJA_ENVIRONMENT` → `DARAJA_ENV`;
`MPESA_CONSUMER_KEY` → `DARAJA_CONSUMER_KEY`;
`MPESA_CONSUMER_SECRET` → `DARAJA_CONSUMER_SECRET`;
`MPESA_SHORTCODE` and `MPESA_BUSINESS_SHORTCODE` →
`DARAJA_BUSINESS_SHORTCODE`; `MPESA_PASSKEY` → `DARAJA_PASSKEY`;
`MPESA_CALLBACK_URL` → `DARAJA_CALLBACK_URL`; and
`MPESA_TRANSACTION_TYPE` → `DARAJA_TRANSACTION_TYPE`.

If a canonical name and one or more aliases are set, all non-empty values must
match. Conflicts block payment configuration without logging the values.
Sandbox and live enablement flags cannot both be true and must match the
selected `DARAJA_ENV`. The service cannot determine which environment issued a
credential from its opaque value; deployment must select credentials from the
environment-specific secret bundle and never reuse a production bundle for
sandbox (or vice versa).

`DARAJA_CALLBACK_URL` must be a syntactically valid HTTPS URL with no embedded
credentials or fragment. The selected environment determines the Safaricom API
host; the callback itself is an application URL and must be registered with
the corresponding sandbox or production Daraja application by the operator.
No automatic inference from the callback hostname can prove which Daraja app
registered it.

Provider dispatch is disabled unless `MPESA_PROVIDER_DISPATCH_ENABLED=true`.
Sandbox dispatch additionally requires `MPESA_SANDBOX_ENABLED=true`.
Production dispatch additionally requires `MPESA_LIVE_PAYMENTS_ENABLED=true`.
Leave live-payment activation unset or false by default. Production requires
production configuration and an HTTPS callback URL; there is no implicit
sandbox fallback. The provider-status endpoint reports only a provider,
environment, enablement boolean, and non-sensitive status code.

Do not enable payment dispatch until the Safaricom account, shortcode,
transaction type, callback URL, and environment-specific credentials have
been verified by an authorized operator. The official
[Safaricom Daraja APIs portal](https://developer.safaricom.co.ke/apis) was
reachable during implementation, but its accessible page exposed only a
general overview; the detailed OAuth/STK/query reference was not available for
independent verification. Confirm current endpoint and callback requirements
with Safaricom before any production activation.

### Supported sandbox settings

The server-side sandbox configuration uses these variables:

- `DARAJA_ENV=sandbox`
- `DARAJA_CONSUMER_KEY`
- `DARAJA_CONSUMER_SECRET`
- `DARAJA_BUSINESS_SHORTCODE`
- `DARAJA_PASSKEY`
- `DARAJA_CALLBACK_URL`
- `DARAJA_TRANSACTION_TYPE` (`CustomerPayBillOnline` for a PayBill shortcode,
  or `CustomerBuyGoodsOnline` for Buy Goods)
- `MPESA_PROVIDER_DISPATCH_ENABLED=true`
- `MPESA_SANDBOX_ENABLED=true`
- `MPESA_LIVE_PAYMENTS_ENABLED=false`

The compatibility aliases listed above remain supported. If both a canonical
variable and an alias are non-empty, their values must match. Do not copy
credential values into this document, the frontend, or source control.

## Safe sandbox preparation

1. Obtain authorized Daraja sandbox credentials through the Safaricom
   developer portal; keep them in the deployment secret manager.
2. Set `DARAJA_ENV=sandbox`, configure all required Daraja values, set
   `MPESA_PROVIDER_DISPATCH_ENABLED=true` and `MPESA_SANDBOX_ENABLED=true`,
   and keep `MPESA_LIVE_PAYMENTS_ENABLED=false`.
3. Register the configured callback URL with the sandbox application and
   confirm it is reachable over HTTPS.
4. Verify the provider status reports sandbox and enabled before an authorized
   manual sandbox test. Automated tests use mocked provider clients and do not
   initiate STK requests.
5. Disable sandbox dispatch after testing unless it is intentionally needed.

This repository change did not send a sandbox or production request.

## Independent receipt reconciliation

The existing STK Query flow uses the `CheckoutRequestID` and
`MerchantRequestID` stored after initiation. Those are request-correlation
identifiers, not an independently verified payment receipt. The callback's
`MpesaReceiptNumber` is initially untrusted evidence. It is copied to
`transactions.mpesa_receipt` only after it has been durably stored, correlated
to the attempt, matched against the amount and phone snapshot, and confirmed
by the provider status query. A query-only success has no receipt unless
independently verified callback evidence is available.

A separate Transaction Status workflow could be added only after the current
Safaricom Transaction Status API contract is confirmed for the target
shortcode and account:

1. Keep the payment attempt as the authoritative local record, including its
   environment, shortcode, expected amount, normalized phone, STK request
   identifiers, and any callback receipt candidate.
2. Treat a callback receipt as a query candidate, never as proof. Submit the
   official status query using the documented transaction identifier and
   party/shortcode fields, the account-authorized initiator and its
   security credential, and registered result/timeout callback URLs. Confirm
   with Safaricom whether a receipt candidate is accepted for this query and
   the exact required request fields; the STK checkout identifiers must not
   be assumed interchangeable with a transaction receipt.
3. Persist each status-query attempt and bind it to the payment attempt using
   provider-issued query correlation identifiers only after their names and
   semantics are verified from the account's official callback contract.
   Do not assume a callback signature, source-IP guarantee, or response field.
   Require the documented provider authentication mechanism; if none is
   available, treat the callback as untrusted input and do not settle from it.
4. Validate the authenticated result against the same attempt: terminal
   success, receipt, amount, phone, shortcode/party, and environment must all
   match the immutable request snapshot under the provider's documented
   response schema. Missing or conflicting values remain unresolved and
   cannot credit the account.
5. Make result processing idempotent by query correlation ID and a unique
   verification record. An identical duplicate is a no-op; an unknown,
   unsuccessful, or timed-out result creates no ledger credit. Conflicting
   results are retained as inconsistent evidence for controlled review.
   Retry status lookup with bounded backoff; never issue another STK request
   merely because a status query or callback timed out.

The workflow requires Safaricom to authorize the Transaction Status API for
the shortcode, provision an approved initiator and corresponding
security-credential material, and register/approve both result and timeout
callback URLs. Confirm the exact permission, identifier types, callback
authentication, retry semantics, and response fields with Safaricom before
implementation. The repository currently has no Transaction Status request,
callback, or independent receipt-verification path, and must not report a
callback receipt as independently verified.

## Production activation

Production activation is a separate operator action after Safaricom onboarding,
credential provisioning, callback verification, operational monitoring, and
end-to-end testing in an authorized environment. Set `DARAJA_ENV=production`,
use only production credentials, set `MPESA_PROVIDER_DISPATCH_ENABLED=true`
and `MPESA_LIVE_PAYMENTS_ENABLED=true`, and leave sandbox activation false.
The deployment should not claim live processing is ready until an authorized
production verification has succeeded. No production credentials were
provided or tested as part of this implementation.

Payment-attempt and callback-inbox schema changes have separate migrations in
the repository. No migration was applied and no database was accessed as part
of this work. Confirm the target's migration history and schema before an
authorized upgrade.

## Database setup and upgrade prerequisites

The previously proposed combined forward migration is not present in this
repository. Do not attempt to apply a combined upgrade script. The actual
migrations are separate, feature-specific files; the correct path depends on
the target database's schema and migration history.

### Fresh database

1. Create a new, empty database. `database/schema.sql` is the canonical fresh
   schema and its preamble drops existing tables; never run it on an existing
   or valuable database.
2. The canonical schema already includes the base M-Pesa attempt, verification,
   and callback-inbox definitions, and the notification and delivery-report
   tables. Do not replay additive feature migrations over those definitions.
3. If deploying ledger-backed settlement, apply
   `database/migration_pension_account_ledger.sql` after the canonical schema
   and before loading operational account balances where possible. On an
   existing database it classifies only the reviewed evidence-complete legacy
   simulator records; zero such records is valid, while an unexpected number
   aborts the migration. It creates
   the pension ledger, balance projection triggers, and immutable movement
   evidence used by settlement. Keep the ledger in `PREPARING` until
   reconciliation is complete, then activate it only through the separately
   approved `SELECT pension_ledger_activate()` operation.

### Existing database

Do not use `schema.sql` as an upgrade. First take and verify a restorable
backup, inspect the target's actual schema and migration ledger, and compare
each migration's preconditions with that state. There is no universal
upgrade-from-any-version script. If the database is the earlier 14-table
schema specifically described by `database/migration_to_final_schema.sql`,
review and apply that migration first; do not assume its preconditions match
other installations.

For a compatible database missing the STK payment-attempt foundation, the
M-Pesa dependency order is:

1. `database/migration_mpesa_stk_push.sql`
2. `database/migration_mpesa_payment_attempts.sql`
3. `database/migration_mpesa_payment_verifications.sql`
4. `database/migration_mpesa_payment_settlement.sql`
5. `database/migration_mpesa_query_only_settlement.sql`
6. `database/migration_mpesa_retry_recovery.sql`
7. `database/migration_pension_account_ledger.sql`

The first six files establish the transaction fields, attempts, verification
evidence, query-only verification rules, and callback inbox needed by the
ledger migration. Do not also run
`database/migration_mpesa_payment_verification_request_ids.sql` or
`database/migration_mpesa_payment_verification_query_success.sql` in this
sequence: they are overlapping historical variants of changes covered by the
settlement and query-only settlement migrations. Confirm the exact starting
state before applying any subset; never rerun a migration simply because its
filename is absent from an operator's notes.

Notification upgrades are a separate dependency track. For a database that
has the expected pre-persistent notification schema, the documented order is
`migration_sms_persistent_delivery.sql`, then
`migration_unified_notifications.sql`, followed by
`migration_role_notifications_and_reporting.sql` and
`migration_transactional_notifications.sql`. Apply
`migration_mobilesasa_sms_delivery_reports.sql` only when that feature is
authorized and its prerequisites are present. These are one-time upgrades,
not replacements for reviewing the actual schema. Fresh canonical-schema
databases already contain their final definitions and must not receive these
overlapping upgrades.

Before any existing-database migration, take and verify a restorable backup.
For a pension-ledger cutover, schedule a maintenance window, freeze/drain
legacy financial writers as required by
`migration_pension_account_ledger.sql`, and reconcile account balances and
financial records against their authoritative sources. Resolve discrepancies
through the approved financial process before proceeding. After the ledger
migration, independently reconcile every opening-balance movement to its
account balance and verify there are no missing or mismatched movements.
Keep the ledger `PREPARING` until application compatibility and financial
reconciliation are signed off; only then may the authorized operator activate
it. Do not run any migration or activation merely as a diagnostic step.

## M-Pesa pension-ledger readiness gate

`MPESA_LEDGER_ENFORCEMENT_ENABLED` controls an opt-in, request-time readiness
check. It defaults to disabled when unset. When set to the exact string `true`,
new contribution attempts and retries require the single `pension_ledger` row
to have status `ACTIVE` before an attempt is created or an STK request is
dispatched. The repository repeats the check inside the attempt-creation
transaction and checks again inside a successful settlement transaction before
financial writes. Missing ledger tables or rows, any non-`ACTIVE` status,
invalid flag values, and database errors fail closed with a service-unavailable
error. The check is not run at application startup, so it does not prevent
unrelated legacy routes from starting.

The forward-only
`database/migration_pension_ledger_mpesa_dispatch_guard.sql` must be applied
after `database/migration_pension_account_ledger.sql` and after the base M-Pesa
attempt table exists. It serializes new attempt insertion with ledger closure,
requires an `ACTIVE` ledger for new attempts at the database layer, and blocks
closure while a `PENDING`, `OUTCOME_UNKNOWN`, or `PROMPT_ACCEPTED` attempt has
no contribution-settlement movement. Settled accepted/unknown attempts no
longer block closure. A transaction-scoped advisory lock serializes readiness,
attempt insertion, settlement, and closure; the application holds it only
through its database transaction, never while waiting for the provider.

An unset or exact `false` value preserves the previous no-preflight behavior;
it is not a safe cutover setting while payment dispatch is enabled. For a
ledger migration rollout, deploy with provider dispatch disabled, explicitly
set `MPESA_LEDGER_ENFORCEMENT_ENABLED=true` before the migration window, and
keep it enabled while the ledger is absent or `PREPARING`. Payment initiation
and retries then remain blocked without preventing unrelated application
features from operating. Apply the dispatch-guard migration after the ledger
migration and before enabling provider dispatch. After the approved
reconciliation and separate ledger activation are complete, verify the ledger
is `ACTIVE` before enabling provider dispatch. On an unmigrated legacy
database, the opt-in application gate remains off by default for compatibility;
after the dispatch-guard migration, the database attempt trigger still rejects
new attempts unless the ledger is `ACTIVE`. Do not disable the gate to bypass a
readiness failure.

## Verification

Use the isolated unit suite:

```powershell
npm run test:unit
npm run test:web
```

The API unit harness blocks PostgreSQL access and external network requests.
Do not use database-backed tests as evidence of live provider readiness.
