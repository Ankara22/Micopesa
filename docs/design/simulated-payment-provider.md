# Simulated payment provider

The simulator exercises the existing worker contribution, payment-attempt,
verification, settlement, balance, and reporting flow without contacting
Safaricom or transferring money. Its records and references are explicitly
marked `SIMULATED`; simulated settlement also suppresses outbound SMS.

Enable it only in a local development or demo process by setting all of:

- `NODE_ENV=development` or `NODE_ENV=demo`
- `MPESA_PAYMENT_PROVIDER=SIMULATOR`
- `MPESA_SIMULATOR_ENABLED=true`
- `MPESA_SIMULATOR_OUTCOME=SUCCESS`, `PENDING`, `FAILED`, or `UNKNOWN`

The simulator is disabled unless both the provider and enable flag are
explicitly configured. The server rejects it in production. The worker payment
request must also specify `provider: "SIMULATOR"`, which must match the server
configuration. Outcomes are selected only on the server and cannot be supplied
by the worker. Repeated reconciliation is safe; an unresolved attempt may be
retried, while a definitive result is protected by the existing verification
and atomic settlement logic.

The public `/api/mpesa/stkpush` endpoint remains HTTP 503. Daraja configuration,
callbacks, and query reconciliation remain separate from the simulator. The
simulator confirmation route uses an internal provider-specific verification
path and never posts a synthetic callback to the public callback endpoint.

The current schema already stores the synthetic provider IDs, verification
evidence, and payment reference in the existing payment tables. Synthetic
references start with `SIM` and fit the existing receipt column. No migration
is required. Simulation uses the existing pension balance projection only; it
does not represent a cash transfer or a real M-Pesa deposit.
