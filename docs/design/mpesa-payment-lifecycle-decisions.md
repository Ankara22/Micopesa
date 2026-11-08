# M-Pesa payment retry and recovery foundation

The retry and recovery foundation keeps one contribution and transaction as the savings obligation, with distinct payment attempts linked to it. STK initiation remains disabled by the API's HTTP 503 gate; the orchestration service is not connected to that route.

## Attempt and obligation states

- Definitive provider failure terminalizes only the attempt. Its contribution and transaction remain pending and eligible for a later attempt.
- Retries use the same contribution and transaction, validate the original amount and worker ownership, and create no contribution, transaction, or allocation rows.
- `PENDING`, `OUTCOME_UNKNOWN`, and `PROMPT_ACCEPTED` attempts block another active attempt. A partial unique index enforces this per contribution.
- Only verified settlement completes the transaction and contribution and credits the account atomically. Cancellation and expiry remain separate operations.

## Idempotency and provider acceptance

- The client persists an unpredictable key before submitting and can look up the resulting attempt by that key after reload. The API scopes that lookup to the authenticated worker.
- The key is bound to the worker, contribution, amount, and normalized phone snapshot. Reuse with changed request data is rejected.
- A retry after definitive failure gets a new key and a new attempt on the existing contribution.
- Once the provider returns identifiers, the orchestration service retries only the persistence write for transient database errors, using the same response. It never repeats STK initiation as a persistence recovery action.
- If all persistence retries fail, the dispatched attempt remains `OUTCOME_UNKNOWN`. Exactly-once provider initiation is not guaranteed.

## Callback inbox and recovery limits

- Valid callbacks are durably stored and deduplicated before the callback endpoint acknowledges them. The inbox retains the exact provider identifiers and only the fields needed for verification.
- Callback ingress accepts JSON bodies up to 32 KiB and applies a process-local limit of 120 requests per minute per socket peer address. It deliberately does not use `X-Forwarded-For` or other caller-supplied forwarding headers. Rate-limit or capacity overload returns HTTP 503 with `Retry-After`, so the provider can retry; oversized bodies receive HTTP 413.
- Operators must define and monitor an approved callback-inbox retention period that covers the provider retry horizon, unmatched-callback recovery, and applicable audit requirements. Do not remove unmatched or correlated callbacks, verification evidence, or deduplication fingerprints while recovery or duplicate delivery is still possible. Any cleanup must preserve the required deduplication horizon and be coordinated with the applicable records-retention policy.
- The ingress limiter is in-memory and applies independently in each API process. Multi-process or multi-instance deployments need an equivalent bounded shared or edge-level limit and must configure proxy trust explicitly; forwarded-address headers must not be trusted unless supplied by a specifically trusted proxy.
- Unmatched callbacks can be replayed by an administrator. Correlation requires an exact checkout and merchant identifier match; phone, amount, and time are never used as correlation keys.
- An unmatched or merely correlated callback cannot settle a contribution. Provider query verification and the existing atomic settlement checks remain authoritative.
- If provider acceptance identifiers were never persisted and no exact identifier can later be recovered, automatic callback correlation is intentionally impossible. The attempt remains unknown pending a safe operational recovery process.

The new migration `database/migration_mpesa_retry_recovery.sql` adds the active-attempt index and callback inbox. It preflights existing duplicate active attempts and aborts rather than guessing which attempt to change. The migration has not been run.
