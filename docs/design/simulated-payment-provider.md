# Simulated payment provider

The simulator exercises the existing worker contribution, payment-attempt,
verification, settlement, balance, and reporting flow without contacting
Safaricom or transferring money. Its records and references are explicitly
marked `SIMULATED`, and successful attempts use the terminal `SETTLED` state.
Successful simulated contributions enqueue an in-app confirmation and an
essential email confirmation for verified email addresses, even when optional
email preference is off. The email clearly states that no real money was
transferred. Simulated events never enqueue SMS.

Before deploying code that writes typed notification events or relies on the
`SETTLED` attempt status, inspect the existing schema and migration history,
take a verified restorable backup, and obtain database-owner approval. For an
existing notification schema that needs the guarded correction, apply
`migration_notification_event_classification_repair_forward.sql` after the
transactional and role/reporting notification prerequisites. Use it instead
of the older `migration_notification_event_classification.sql` for this
repair state; do not run the older name-based drop first.

Apply `migration_mpesa_attempt_status_settled_forward.sql` only when its exact
legacy status and accepted-timestamp preconditions pass. It depends on the
M-Pesa attempt foundation and must be applied before application code relies on
the replacement status constraint. It aborts if the canonical constraint is
already present or the legacy definition differs. Neither corrective
migration activates the pension ledger. The ledger migration
`migration_pension_account_ledger.sql` and then
`migration_pension_ledger_mpesa_dispatch_guard.sql` remain subject to their own
preconditions. Keep the ledger in `PREPARING` until independently reconciled
and separately approved for cutover; activation is not part of these repairs.
The ledger migration classifies only the two evidence-complete legacy
simulator successes and fails closed if that exact evidence set is not present.

Enable it only in a local development or demo process by setting all of:

- `NODE_ENV=development` or `NODE_ENV=demo`
- `MPESA_PAYMENT_PROVIDER=SIMULATOR`
- `MPESA_SIMULATOR_ENABLED=true`
- `MPESA_SIMULATOR_OUTCOME=SUCCESS`, `PENDING`, `FAILED`, or `UNKNOWN`

The simulator is disabled unless both the provider and enable flag are
explicitly configured. The server rejects it in production. The worker payment
request must also specify `provider: "SIMULATOR"`, which must match the server
configuration. The authenticated worker UI reads this server-selected provider,
labels the journey as simulated, and uses the simulator endpoint; it does not
let the browser switch a production payment to the simulator. Outcomes are
selected only on the server and cannot be supplied by the worker. `PENDING`
and `UNKNOWN` outcomes can be explicitly re-confirmed against the existing
attempt from the UI; neither is shown as success until verified settlement
completes. A definitive result is protected by the existing verification and
atomic settlement logic.

Contribution history, statements, and reports identify simulator records and
display the synthetic reference instead of presenting it as a Safaricom receipt.
The email remains subject to global email-dispatch configuration; keep external
dispatch disabled during isolated verification.

The simulator only reports itself available, initiates attempts, or confirms
outcomes when the pension ledger is `ACTIVE`. This is required even when
`MPESA_LEDGER_ENFORCEMENT_ENABLED` is unset or false: the database settlement
trigger rejects financial movements unless the ledger is active.
The application readiness guard also defaults to enabled. An exact `false` is
accepted only outside production and can never bypass the settlement's active
ledger check. Do not turn off enforcement or activate the ledger just to make
a demo available; complete and review the ledger cutover prerequisites first.

The public `/api/mpesa/stkpush` endpoint is governed separately by Daraja
configuration and dispatch safeguards: it returns HTTP 503 when dispatch is
disabled or its selected environment is not fully configured. Sandbox dispatch
requires explicit sandbox opt-ins, and production additionally requires the
live-payment opt-in. Enabling the simulator does not enable Daraja dispatch.
Daraja callbacks and query reconciliation remain separate from the simulator.
The simulator confirmation route uses an internal provider-specific
verification path and never posts a synthetic callback to the public callback
endpoint.

The current payment schema stores the synthetic provider IDs, verification
evidence, and payment reference in the existing payment tables. Synthetic
references start with `SIM` and fit the existing receipt column. No payment
schema migration is required. A successful simulation posts through the same
ledger settlement path as a verified contribution and changes the local
account projection only; it does not represent a cash transfer or a genuine
M-Pesa deposit.
