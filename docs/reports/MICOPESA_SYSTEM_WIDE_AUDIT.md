# MicoPesa System-Wide Audit

**Repository:** `D:\Users\jumab\MicoPesa`
**Branch:** `fix/ci-notification-preferences`
**Mode:** Read-only audit; this report is the only file created for the audit.

## 1. Executive summary

MicoPesa has a broad, actively tested application surface: worker registration and account flows, role-scoped management, fund allocation, retirement projections, compliance workflows, notifications, and payment orchestration are present. The normal API unit and frontend suites, lint, and production build passed during this audit.

**Production readiness: NO-GO.** The most important confirmed blocker is a source/SQL conflict in M-Pesa settlement: [`settleVerifiedPayment`](../../apps/api/src/services/mpesaPaymentAttemptRepository.js) directly updates the account balance, while [`migration_pension_account_ledger.sql`](../../database/migration_pension_account_ledger.sql) rejects direct balance changes and permits balance projection only from a ledger-movement trigger. On a schema-only installation, the movement table is absent; after the ledger migration, the direct update conflicts with the projection guard. The mocked settlement tests do not model that PostgreSQL trigger. No PostgreSQL test, migration, live provider, or production configuration was exercised in this audit.

Across the 17 requested business modules, the implementation is **substantial but not release-complete**: 8 are implemented with automated test coverage, 8 are partial, and 1 is not implemented. This is a source/test assessment, not production certification. One partial module (payment settlement) has a confirmed static defect. There are no confirmed critical-severity findings; one high, six medium, and four low findings are detailed below.

## 2. Overall completion assessment

The project is suitable for continued development and controlled isolated testing. Its key role boundaries, validation, transaction patterns, idempotency checks, synthetic-data disclosures, and error/loading states are stronger than a page-only prototype. Automated checks also cover many edge cases.

It cannot yet be considered complete for production use because:

- Payment settlement conflicts with the canonical ledger projection guard (High).
- Payout execution is intentionally disabled; OTP verification authorizes but does not execute a payout.
- Bank/USSD payment execution, USSD service integration, and locked savings are absent.
- Daraja, SMS, email, web-push, PostgreSQL, storage, TLS, backups, and monitoring are not production-verified.
- Database-backed concurrency, migration, and role tests were not run as part of this audit.
- Retention requirements for permanent user deletion need an explicit business/compliance-owner decision.

No percentage is assigned: the breadth of implemented workflows is not a reliable proxy for the outstanding financial-integrity and deployment gates.

## 3. Module-by-module implementation status

“Implemented” below means present in source and covered by automated tests where indicated. It does **not** mean verified against production providers, a production database, or a live deployment.

| # | Module | Status and evidence |
|---|---|---|
| 1 | Worker registration and authentication | **Implemented; unit-verified.** Registration, identity checks, password authentication, role/status checks, and recovery flows are present in `workerRegistrationService`, `authController.login`, and `authMiddleware.requireAuth`; API tests ran. SMS and deployment configuration remain unverified. |
| 2 | Phone OTP verification and password creation | **Implemented; unit-verified.** Registration/recovery OTP services and the temporary-password flow exist; tests cover OTP and recovery behavior. Provider delivery was not tested. |
| 3 | Admin worker approval and rejection | **Implemented; unit-verified.** Approval/rejection controllers and routes enforce administrator access, record decisions, and constrain worker access until approval. No production role/account checks were made. |
| 4 | Worker profile and account management | **Implemented; unit/UI-tested.** Profile editing, verified-email flow, masked National ID, and authenticated profile-photo handling exist. Production photo-volume configuration and backups are not verified. See the documentation inconsistency in Finding L3. |
| 5 | Contributions and simulated M-Pesa payments | **Partial.** The simulator explicitly labels outcomes synthetic and states that no real money moves. Daraja STK code is present but gated by configuration/readiness. The general contribution record flow is not evidence that a bank or USSD payment was processed. |
| 6 | Payment callbacks, settlement, and reconciliation | **Partial; settlement is statically broken against the ledger migration.** Callback ingress, verification, reconciliation, idempotency, and receipt checks exist. `mpesaPaymentAttemptRepository.settleVerifiedPayment` conflicts with the ledger projection trigger (Finding H1). No PostgreSQL integration test ran. |
| 7 | Pension funds and worker allocations | **Implemented; unit-verified.** Fund ownership and regulator scope are checked in backend queries; allocation logic and fund-management tests ran. Production data and migration state are unverified. |
| 8 | Savings targets and locked savings | **Not implemented.** A retirement plan/projection target is not a savings account, locked balance, or withdrawal restriction. No dedicated locked-savings workflow was found. |
| 9 | Retirement projections and forecasting | **Implemented; unit/UI-tested.** The projection flow and plan form exist. Results are estimates, not guaranteed returns or independently validated actuarial advice. |
| 10 | Withdrawal requests and approvals | **Partial.** Eligibility, pending-request control, approval/rejection, and reserved-balance checks exist. Approval does not transfer funds or complete a payout. |
| 11 | Payout-officer OTP authorization | **Partial.** The payout-officer queue can initiate/resend OTP; a worker can verify it. The UI and API explicitly report verified authorizations as unpaid; there is no payout executor. |
| 12 | Admin management and system settings | **Implemented; unit/UI-tested.** User/role and operational-settings workflows exist. Permanent deletion can remove user-linked financial history in eligible cases; retention policy needs owner sign-off (Finding M5). |
| 13 | Fund Manager dashboards and fund management | **Implemented; unit/UI-tested.** Manager-owned fund and report scoping is enforced in API queries and routes. Live database scope was not tested. |
| 14 | Regulator dashboards, compliance, and reporting | **Partial.** Assigned-fund scope, report history, review decisions, and synthetic-demo classification/disclosures exist. The workflow is internal; no external regulatory filing/submission integration was found. |
| 15 | Notifications and delivery history | **Partial.** Transactional event queues, preferences, SMS/email dispatch, push support, and delivery tracking are present. Provider acceptance is not proof of handset/inbox delivery; provider and delivery-report configuration were not tested. |
| 16 | Audit trails and security monitoring | **Partial.** Application audit writes and role-scoped read endpoints exist. The general `audit_logs` table has no schema-level mutation guard, and deployed privileges/central monitoring are unknown (Finding M4). |
| 17 | PWA and feature-phone/USSD readiness | **Partial.** A web manifest and push service worker exist. No offline app-shell caching or USSD endpoint/provider workflow was found. USSD readiness is **not implemented**. |

## 4. Frontend findings

### Positive evidence

- Role-aware routes and navigation exist in `AppRoutes.jsx` and `roleRoutes.js`; server-side authorization remains authoritative.
- Common loading, refreshing, error, retry, and empty states are used in audited data pages. `useApi` exposes error state rather than treating failed requests as successful data.
- The shared `Modal` implements standard, wide, and review sizes, a 90-`dvh` maximum with a viewport fallback, a flex-column layout, an independently scrolling body, and a persistent header/footer. The compliance review and report history use the larger review treatment. Modal tests ran with the frontend suite.
- Compliance-report screens preserve synthetic classifications and disclosures; backend validation also prevents removing required synthetic-demo markers.
- Forms use regular document scrolling when they are standalone pages; no general fixed-height page-form pattern was identified in the inspected routes and components.

### Findings and limits

- **LOW — large production bundle.** `npm run build` passed, but Vite reported a minified main chunk of approximately **916.58 kB**. This may affect load time on slower mobile connections. Review code splitting and route-level lazy loading.
- **LOW — transient session restoration clears a stored token.** `AuthProvider.restoreSession` clears the client token on any `/api/auth/me` failure, not only an expired/invalid-token response. A temporary network/server error can therefore require a fresh sign-in. Preserve the token on transient failures and clear it on confirmed authentication failure.
- No manual browser, keyboard-only, screen-reader, 100%-zoom, tablet, or mobile-device verification was performed. Automated modal tests do not establish visual behavior across browsers or viewport/browser-chrome combinations.
- Static inspection did not establish that every workflow was visually usable with real production-length content. Compliance histories and other long records should receive manual responsive review before release.

## 5. Backend and API findings

### Positive evidence

- Routes generally apply authentication and role middleware at the API boundary, with resource ownership and assigned-fund checks in the corresponding controller/service queries.
- Audited input paths use validation and parameterized SQL for values. Sensitive National ID handling uses the encryption/fingerprint service and masking rather than exposing the full identifier in profile output.
- Payment initiation and settlement use idempotency keys, receipt uniqueness, linked account/contribution/transaction checks, and transactional writes. These controls are present in code but are not a substitute for the failed database-backed verification noted in H1.
- Withdrawal and compliance workflows use row locking and status checks for state transitions. No provider calls were made during this audit.

### Findings

- **MEDIUM — login has no request/IP rate limiter.** `authRoutes.js` mounts `/login` directly on `authController.login`. The controller has per-account failed-login lockout, but unlike recovery/verification paths it does not call the request limiter. Add a shared, distributed login/IP limiter and monitor lockout abuse.
- **MEDIUM — API CORS has no origin allowlist.** `server.js` calls `cors()` with exposed headers but no `origin` restriction. Configure explicit production origins and verify preflight behavior.
- **MEDIUM — logout does not revoke the JWT.** `authController.logout` writes a logout audit event and relies on the client to discard the token; the controller comment confirms the server does not revoke it. Middleware checks `auth_version`, but logout does not change it. Consider short token expiry plus a revocation/session mechanism for immediate logout.
- **MEDIUM — OTP delivery occurs inside a database transaction.** `withdrawalPayoutOtpService.issueOtp` persists a pending authorization, calls the SMS provider while the transaction is open, then commits. If the provider accepts the SMS but a later database commit fails, the worker may receive a code whose authorization row rolled back. Use an outbox/after-commit delivery design and reconcile unknown outcomes.

## 6. Database and financial integrity findings

### High finding H1 — M-Pesa settlement conflicts with the ledger projection

[`mpesaPaymentAttemptRepository.js`](../../apps/api/src/services/mpesaPaymentAttemptRepository.js) — `settleVerifiedPayment` directly executes `UPDATE pension_accounts SET current_balance = current_balance + ...`, then inserts a `CONTRIBUTION_SETTLEMENT` row into `pension_account_movements`.

[`migration_pension_account_ledger.sql`](../../database/migration_pension_account_ledger.sql) — `pension_ledger_guard_balance_projection` rejects any direct `current_balance` change when `pg_trigger_depth() < 2`. The intended projection update is performed by `pension_ledger_apply_balance` after a ledger movement insert, which is nested and therefore passes the guard. The application’s earlier direct update is at trigger depth 1 and is rejected; the transaction rolls back before the movement can establish the balance. In the canonical [`schema.sql`](../../database/schema.sql), the pension movement/ledger structures are not present until the separate ledger migration is applied.

The unit test [`mpesaPaymentSettlement.test.js`](../../apps/api/tests/mpesaPaymentSettlement.test.js) uses a query mock that simulates the direct account update and does not run PostgreSQL triggers. Thus, the API unit suite passing does not verify this path. This is a **static source/SQL contradiction**, not a database-reproduced failure in this audit.

**Required action:** reconcile settlement so the ledger movement is the sole balance-changing write; add a PostgreSQL regression test that applies the real ledger trigger and verifies rollback/idempotency and the final balance. Do not enable production payments until that test and the migration-state preflight pass.

### Other integrity observations

- The schema and migration artifacts define uniqueness and foreign-key relationships for payment receipts, attempts, account/contribution associations, and ledger movements. The API also checks linked source records and uses transactions. These are positive controls, but no DB constraints, concurrency behavior, balances, or reconciliation results were queried in this audit.
- The pension ledger is a separate forward migration and requires activation/cutover. `MPESA_LEDGER_ENFORCEMENT_ENABLED` defaults to false in source; the production value and deployed migration state are unknown. Never infer that the ledger is active from the existence of source files.
- The withdrawal flow tracks approvals and reservations; it does not create a completed payout transaction. A verified OTP remains an authorization state, not payment settlement.
- Permanent admin deletion can remove eligible user-linked contribution/withdrawal history. Existing deployment documentation acknowledges that this is not a complete financial/regulatory ledger. A data-retention owner must approve the deletion/retention policy before production use (Finding M5).
- **MEDIUM — general audit history is not database-enforced append-only.** `schema.sql` describes `audit_logs` as append-only by design, but no trigger blocks `UPDATE`/`DELETE`; API endpoints are read-only and application code writes audit events. The deployed API-role grants were not inspected, so actual write/delete capability is **NOT VERIFIED**. Enforce least privilege and append-only protection or forward events to a separately controlled audit store.

## 7. Security and privacy findings

Severity is based on source evidence and potential impact, not on a claim that a live exploit was tested.

| ID | Severity | Finding, evidence, and recommended action |
|---|---|---|
| H1 | **HIGH** | Settlement/ledger projection conflict described in §6. This is a financial-integrity and payment-release blocker. Add real PostgreSQL regression coverage before enabling payments. |
| M1 | **MEDIUM** | Public login lacks request/IP throttling; per-account lockout alone is insufficient abuse control. Add a distributed limiter and alerting. |
| M2 | **MEDIUM** | CORS is not origin-restricted in `server.js`. Restrict production origins. |
| M3 | **MEDIUM** | Logout is client-side token disposal, not server-side revocation. Establish the accepted exposure window and add revocation/short-lived session controls if immediate invalidation is required. |
| M4 | **MEDIUM** | General audit-log immutability and deployed role grants are unproven. Add schema/privilege enforcement and independently protected retention. |
| M5 | **MEDIUM** | Admin deletion can remove eligible financial history. Obtain retention-policy approval and ensure financial records are preserved/anonymized when required. |
| M6 | **MEDIUM** | Payout OTP SMS is sent before its database transaction commits. Use an outbox or equivalent durable post-commit delivery path. |
| L1 | **LOW** | M-Pesa callback and MobileSasa delivery-report ingress use in-process `Map` rate-limit state keyed by the socket peer address. Limits are not shared across instances/restarts and may see a reverse proxy rather than the client/provider. Use edge/shared limiting and verify proxy topology. |
| L2 | **LOW** | `AuthProvider.restoreSession` clears the token for transient API failures as well as invalid sessions. Preserve recoverable sessions during network/server outages. |
| L3 | **LOW** | `docs/deployment/profile-photo-storage.md` says there is no email verification/delivery workflow, while `authController`/`authEmailService` implement email verification and recovery and `docs/deployment/auth-email-recovery.md` documents it. Correct the stale statement. |
| L4 | **LOW** | The production build emits the large-bundle warning described in §4. Split rarely used routes/features where practical. |

### Positive security controls observed

Password verification uses bcrypt with a dummy hash for unknown users; OTP values are short-lived and hashed in the payout authorization flow; auth middleware re-reads account state and `auth_version`; KYC and worker approval gate financial actions; profile National ID output is masked; profile photos are size/type/dimension validated and stored outside the static web root; Daraja callback evidence is reconciled before settlement; report exports and role/fund scopes have validation and tests. These are code-level observations, not a penetration test or deployment verification.

No confirmed SQL injection, role-escalation, or plaintext National ID exposure path was established in the inspected source. This does not certify the full system or deployed privileges.

## 8. External integration status

| Integration | Status | Evidence and verification boundary |
|---|---|---|
| Safaricom Daraja / M-Pesa | **Implemented, awaiting credentials/configuration and database readiness.** OAuth, STK Push, and STK query code exist in `mpesaService`; provider mode is gated. No request was sent. Settlement is blocked by H1. |
| M-Pesa simulator | **Simulated.** Explicit synthetic descriptions and no-real-money behavior exist; it must not be presented as a live payment. |
| Mobile Sasa SMS | **Implemented, awaiting credentials/configuration.** SMS dispatch and delivery-report ingress exist. No SMS or webhook was sent/received. Provider acceptance is not handset delivery. |
| Gmail SMTP | **Implemented, awaiting credentials/configuration.** Email verification/recovery paths exist. No email was sent; credentials and deliverability are unverified. |
| Web Push | **Partially implemented / configuration-blocked.** VAPID configuration and production-only dispatch are enforced in source. Browser subscription and live push behavior were not tested. |
| PostgreSQL | **Implemented; deployment not verified.** Schema and forward migrations exist. PostgreSQL version, actual migration history, role grants, TLS, backups, and production data were not inspected. |
| IPRS identity verification | **Not implemented / not found in inspected source.** No external identity request was made. |
| Feature-phone USSD | **Not implemented.** No USSD endpoint/provider flow was found; `ussd_sessions` alone is not a USSD integration. |
| Profile-photo storage | **Implemented, deployment-config dependent.** Production requires a persistent private `PROFILE_PHOTO_STORAGE_DIR`; storage-volume sharing and backup were not verified. |

## 9. Testing and quality results

Executed during this audit:

| Check | Result |
|---|---|
| `npm run test:unit` | **805 passed; 0 failed.** The documented unit runner mocks PostgreSQL/provider access. |
| `npm run test:web` | **61 test files passed; 377 tests passed.** JSDOM emitted navigation-not-implemented notices; they did not fail tests. |
| `npm run lint` | **Passed.** |
| `npm run build` | **Passed.** Vite warned that the minified main chunk is approximately 916.58 kB. |
| `git diff --check` | **Passed.** Git emitted line-ending conversion warnings for pre-existing edited files; no whitespace errors were reported. |

Not executed:

- PostgreSQL integration, concurrency, migration, ledger-trigger, National ID role, and contract-migration tests.
- Any database migration/backfill, database connection, or production state check.
- Daraja, SMS, email, web-push, or other provider transactions.
- Browser/manual accessibility, visual, 100%-zoom, mobile, or feature-phone tests.
- Dependency vulnerability scanning or production infrastructure checks.

Do not treat the passing mocked settlement tests as evidence that H1 passes against PostgreSQL.

## 10. Deployment readiness

**Not ready for production financial operation.** Before deployment, the owner must establish (without relying on this audit) the production PostgreSQL version and migration history, tested backup/recovery, least-privilege API/verifier/operator roles, required ledger migration and activation state, secure key/credential provisioning, provider sandbox and production setup, HTTPS/TLS, explicit CORS origins, persistent profile-photo storage and backup, monitoring/alerting, and a controlled maintenance/write-pause plan.

The repository includes deployment documentation for Daraja, Mobile Sasa, email recovery, profile-photo storage, and National ID migration. These documents describe prerequisites; they do not prove that the production environment satisfies them. The real API database login, verifier login, database grants, environment values, TLS configuration, and applied migration versions are **NOT VERIFIED**. No secrets or `.env` values were read.

Production schema/migration order must be reconciled against the actual deployed history. The presence of a migration file—including an untracked forward migration—is not evidence that it is reviewed, applied, or safe for a particular database.

## 11. Critical and high-priority blockers

- **H1 — High: M-Pesa settlement is incompatible with the pension-ledger balance-projection trigger.** Fix and prove with a PostgreSQL regression test before enabling payment initiation or settlement.
- **Payout limitation:** Payout processing is intentionally disabled. If production scope includes paying approved withdrawals, an authorized payout executor, reconciliation, idempotency, and failure handling are prerequisites; OTP verification is not a substitute.
- **Environment gate:** Production database migration state, roles, keys, provider credentials, HTTPS/TLS, storage persistence, backups, and operational monitoring cannot be verified without authorized production access.

## 12. Medium- and low-priority improvements

**Medium:** add login abuse throttling; restrict CORS; decide/review token revocation semantics; enforce audit-log immutability and least privilege; obtain a financial-record retention decision for admin deletion; move payout OTP delivery outside the open database transaction.

**Low:** use shared/edge ingress rate limiting; avoid clearing sessions on transient restore errors; correct stale email documentation; reduce the initial JavaScript bundle.

## 13. Features not implemented

- Locked savings / savings-account restrictions.
- USSD or another feature-phone service integration.
- Payout execution and funds transfer after withdrawal approval/OTP.
- IPRS identity verification.
- External regulator filing/submission integration (the current compliance workflow is internal).
- Offline PWA app-shell operation.

## 14. Features requiring manual verification

- Production PostgreSQL version, schema/migration history, migration order, grants, ownership, TLS, and ledger activation.
- Backup restoration and financial reconciliation against approved source records.
- Live provider configuration and end-to-end status/callback/delivery behavior, using an explicitly authorized sandbox first.
- Persistent profile-photo volume, multi-instance sharing, access control, and backup recovery.
- HTTPS, CORS allowlist, secrets/key management, logging redaction, alerting, and incident response.
- Browser keyboard/focus behavior, assistive-technology labels, 100%-zoom readability, long report/history scrolling, and mobile layouts.
- Worker registration/approval, KYC, fund assignment, notification preference, contribution, withdrawal authorization, and account-deletion behavior against a controlled staging environment.
- Retention and anonymization policy for user-linked financial/audit history.

No legal, regulatory, or ODPC compliance determination is made.

## 15. Recommended implementation order

- **P0:** Correct the M-Pesa settlement/ledger conflict; add a real PostgreSQL regression test for successful settlement, rollback, duplicate callbacks, and exact ledger/balance consistency. Keep payment dispatch disabled until this passes on an isolated database.
- **P1:** Complete a controlled deployment rehearsal against the actual predecessor schema; verify migration/ledger activation, roles, backups/recovery, keys, HTTPS/TLS, explicit CORS, persistent storage, provider configuration, and monitoring. Obtain a retention-policy decision. If payouts are in production scope, implement and test the executor before enabling withdrawals.
- **P2:** Add distributed login/ingress rate limits, formal audit-log protection, robust server-side session revocation, and post-commit/outbox delivery for payout OTP. Add database-backed coverage for critical concurrent financial paths.
- **P3:** Correct stale deployment documentation, reduce the initial bundle, and separately scope USSD, locked savings, and offline PWA capability if required by product plans.

## 16. Final go/no-go assessment

**NO-GO for production financial operation.** The main blocker is the confirmed settlement/ledger contradiction; the payout executor is also intentionally absent. Passing API/frontend unit suites and a successful build establish useful development confidence but do not validate PostgreSQL triggers, migrations, production roles, provider behavior, or live operational controls. Production data and services were not accessed or changed, and this report does not authorize migration or provider activation.

## Remediation follow-up

See [MICOPESA_AUDIT_REMEDIATION_REPORT.md](./MICOPESA_AUDIT_REMEDIATION_REPORT.md) for the finding-by-finding remediation status, actual verification results, and remaining production gates. The findings and evidence above are preserved as the original audit snapshot.
