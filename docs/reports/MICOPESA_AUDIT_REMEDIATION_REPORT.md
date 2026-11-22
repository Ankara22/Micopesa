# MicoPesa Audit Remediation Report

**Repository:** `D:\Users\jumab\MicoPesa`
**Branch:** `fix/ci-notification-preferences`
**Scope:** Remediation of the findings in [MICOPESA_SYSTEM_WIDE_AUDIT.md](./MICOPESA_SYSTEM_WIDE_AUDIT.md). Existing modified and untracked work was preserved.

## Executive result

| Status | Findings |
|---|---:|
| Resolved in source and covered by relevant tests/checks | 5 |
| Partially resolved; verification, policy, or operational work remains | 6 |
| Blocked | 0 |
| Not applicable | 0 |

No finding is marked fully resolved where the requested production or PostgreSQL verification was not performed. **Production readiness remains NO-GO**, especially for payment operation: the settlement correction has unit/static regression coverage but has not been exercised against the actual PostgreSQL ledger triggers on an isolated database. Payout execution remains intentionally disabled.

## Finding-by-finding disposition

### H1 — HIGH: M-Pesa settlement and ledger projection

**Status: Partially resolved.** `settleVerifiedPayment` no longer writes `pension_accounts.current_balance` directly. The ledger movement is the sole balance-changing write; settlement takes the ledger dispatch lock, requires an active ledger before financial writes, validates provider evidence, and retains idempotent settled-replay handling. Ledger readiness defaults to enforced, and production cannot disable it.

**Evidence:** `apps/api/src/services/mpesaPaymentAttemptRepository.js` (`settleVerifiedPayment`); `apps/api/src/services/mpesaLedgerReadiness.js`; `apps/api/tests/mpesaPaymentSettlement.test.js`; `apps/api/tests/mpesaLedgerReadiness.test.js`. The API unit suite passed. The mock regression tests assert that the ledger movement—not a separate application balance update—projects the balance.

**Remaining:** Run an isolated PostgreSQL regression against the real ledger migration/triggers, covering settlement, rollback, duplicate callbacks, and exact ledger/balance consistency. Confirm migration and activation state in a separately authorized deployment rehearsal. Neither was done here; do not enable production payments until they pass.

### M1 — MEDIUM: Login request throttling and abuse monitoring

**Status: Partially resolved.** Login now uses the shared database-backed request-limit service with an IP-scoped limit, in addition to the existing per-account failed-password controls. Regression coverage was updated in `apps/api/tests/authRecovery.test.js`, `apps/api/tests/authSecurity.test.js`, `apps/api/tests/adminRoleLogin.test.js`, and `apps/api/tests/authOperationalSettings.test.js`.

**Remaining:** Central alerting and operational review of throttling/lockout events are not established in repository code or verified in deployment.

### M2 — MEDIUM: Unrestricted API CORS

**Status: Resolved in source.** `apps/api/src/config/corsConfiguration.js` now enforces exact allowed origins, requires valid HTTPS origins and explicit configuration in production, and uses localhost-only defaults outside production. `apps/api/src/server.js` applies the policy. Tests are in `apps/api/tests/corsConfiguration.test.js`; operator setup and webhook-proxy guidance is in `docs/deployment/api-cors-origin-allowlist.md`.

**Remaining:** Production origins and deployment behavior require authorized environment verification.

### M3 — MEDIUM: Logout did not revoke JWTs

**Status: Resolved in source.** `authController.logout` increments the account's `auth_version` and writes the logout audit event within one transaction. This revokes all tokens for the account; audit failure rolls back revocation. Regression tests are in `apps/api/tests/authAudit.test.js` and `apps/api/tests/authRecovery.test.js`.

### M4 — MEDIUM: Audit-log immutability and database privileges

**Status: Partially resolved.** `database/schema.sql` now installs an append-only guard, and `database/migration_audit_logs_append_only_forward.sql` prepares the corresponding forward-only migration. The guard allows only the nested actor-reference nulling needed for the existing `ON DELETE SET NULL` relationship; it rejects other updates/deletes and revokes those operations from `PUBLIC`. `apps/api/tests/auditLogImmutabilityStatic.test.js` and the API unit suite cover static migration/schema expectations.

**Remaining:** The migration was not executed. Actual database ownership, API/verifier/operator role grants, superuser access, and independent audit retention remain unverified and require deployment-owner review.

### M5 — MEDIUM: Admin deletion could remove financial history

**Status: Partially resolved.** `apps/api/src/controllers/adminUserController.js` detects protected references and anonymizes/suspends the account while preserving its original identifier and historical records, revoking authentication and removing contact details. Eligible accounts without protected history may still be permanently deleted. `apps/api/tests/adminUserDeletion.test.js` now verifies retained pension/account, contribution, payment, ledger, KYC, compliance, audit, and session history, including audit references without a user foreign key.

**Remaining:** A data-retention owner must approve the deletion/retention policy for production. This repository change is not a legal or regulatory determination.

### M6 — MEDIUM: Payout OTP SMS sent inside an open transaction

**Status: Partially resolved.** `apps/api/src/services/withdrawalPayoutOtpService.js` now commits a `DELIVERY_PENDING` authorization before dispatching SMS, then records provider acceptance/failure in a follow-up transaction. Unconfirmed delivery cannot authorize a payout; stale pending attempts are invalidated. `apps/api/tests/withdrawalPayoutOtp.test.js` covers post-commit dispatch, failure outcomes, and non-authorization.

**Remaining:** This is an after-commit inline dispatch, not a durable outbox/worker. A process failure between commit and dispatch/finalization can leave pending state until expiry/reconciliation. Add a durable delivery worker/outbox before relying on this path for production availability. No real SMS was sent.

### L1 — LOW: Per-process callback and delivery-report limits

**Status: Partially resolved.** The current repository continues to use bounded per-process ingress counters. `docs/deployment/api-cors-origin-allowlist.md` now explicitly requires shared rate limiting at a trusted ingress/load balancer and warns against trusting client-supplied forwarding headers.

**Remaining:** Shared edge limits and trusted-proxy topology are infrastructure work and were not configured or verified.

### L2 — LOW: Session cleared on transient restoration errors

**Status: Resolved in source.** `apps/web/src/context/AuthContext.jsx` preserves the stored token on transient `/api/auth/me` failures, exposes a retry, and clears the token only for confirmed 401/403 responses. `apps/web/src/pages/auth/Login.jsx` and the English/Swahili locale files provide retry messaging. Regression tests are in `apps/web/src/context/AuthContext.test.jsx`. The restore call is deferred safely from the React effect body.

### L3 — LOW: Stale email-verification deployment documentation

**Status: Resolved.** `docs/deployment/profile-photo-storage.md` was corrected to align with the email verification/recovery implementation and `docs/deployment/auth-email-recovery.md`.

### L4 — LOW: Large initial frontend bundle

**Status: Resolved for the reported build warning.** `apps/web/src/routes/AppRoutes.jsx` now lazy-loads route pages with a loading state; `apps/web/src/routes/AppRoutes.test.jsx` covers the async route behavior. The final production build completed without the prior oversized-chunk warning. Largest emitted JavaScript chunks were approximately 338 kB (charts), 290 kB (entry), and 192 kB (translations), before gzip.

**Remaining:** Real-device and slow-network performance were not measured.

## Tests and checks actually run

| Check | Result |
|---|---|
| `npm --prefix apps/api run test:unit` | **815 passed, 0 failed.** Includes the API unit/static tests. |
| `npm --prefix apps/web run test` | **61 files passed; 379 tests passed.** JSDOM emitted navigation-not-implemented notices; they did not fail tests. |
| `npm --prefix apps/web run lint` | **Passed.** |
| `npm --prefix apps/web run build` | **Passed.** No oversized-chunk warning. |
| `git diff --check` | **Passed.** Git emitted line-ending conversion warnings; no whitespace errors. |

Not run: PostgreSQL integration or migration tests, database migrations/backfills, production database inspection, provider requests, service restarts, browser/device accessibility testing, or production infrastructure checks. No primary or persistent database was accessed or written. No M-Pesa, SMS, or email request was sent.

## Prepared migrations; none executed

The following forward/proposed migration files are present in the worktree and were not executed as part of this remediation:

- `database/migration_audit_logs_append_only_forward.sql`
- `database/migration_mpesa_attempt_status_settled_forward.sql`
- `database/migration_notification_event_classification_repair_forward.sql`
- `database/migration_pension_ledger_activation_guard_forward.sql`
- `database/migration_simulator_ledger_scoped_forward.sql`
- `database/migration_withdrawal_payout_otp_authorization_forward.sql`
- `database/migration_worker_identity_expand_forward.sql`
- `database/migration_worker_identity_contract_forward.sql`
- `database/proposed_migration_mpesa_settlement_prerequisites_forward.sql` (proposed)

The worktree also contains diagnostic/rehearsal SQL artifacts; they are not production migrations and were not executed. Their presence does not imply review, authorization, or application to any database.

## Outstanding actions, prioritized

### P0 — Before any payment-enabled production operation

1. Prove M-Pesa settlement against the real pension-ledger triggers in a disposable isolated PostgreSQL database, including successful settlement, rollback, duplicate callback, and exact balance/movement consistency.
2. Rehearse the reviewed migration order against the correct predecessor schema. Keep provider dispatch/payment operation disabled until the rehearsal and readiness checks pass.

### P1 — Before production deployment

1. Review and authorize all pending migrations; verify production schema history, ownership, API/verifier/operator privileges, keys, backups/recovery, TLS, storage, CORS origins, and monitoring without assuming repository configuration is deployed.
2. Obtain data-retention owner approval for account deletion/anonymization.
3. Keep payout execution disabled. OTP authorization is not payout execution; no payout executor or provider transfer was introduced.

### P2 — Reliability and security operations

1. Configure shared ingress limits for callbacks and delivery reports, and verify trusted proxy handling.
2. Add centralized alerting for login abuse and a durable outbox/worker for payout OTP dispatch.
3. Verify audit-trigger behavior and least-privilege grants in an isolated database and authorized deployment rehearsal.

### P3 — Product verification

1. Measure route-load performance on representative mobile/slow-network devices and manually verify 100%-zoom, keyboard, screen-reader, and long-record modal behavior.
2. Scope separately any decision to implement the intentionally absent payout execution, locked savings, USSD, offline PWA, or external regulatory submission features.

## Production verdict

**NO-GO for production financial operation.** The source-level settlement defect is corrected and the unit suite passes, but the critical PostgreSQL trigger path remains unverified. Database roles/migration state, backup recovery, provider configuration, shared ingress controls, and operational monitoring also require authorized verification. Payout execution remains intentionally disabled. No report or code change authorizes production execution.

No files were staged, committed, pushed, or merged. Existing unrelated changes and untracked files were preserved.

## Immediate authentication and notification repair follow-up

This follow-up records the subsequent phone-first authentication and notification-delivery repair. The original findings and their dispositions above remain unchanged.

### Authentication

**Status: Updated by the account-approval removal follow-up below.** Valid, unlocked sign-ins no longer load operational settings on the successful-password path. Worker phone registration still requires OTP verification and keeps email optional; current registration activates the account immediately after password creation while retaining `PENDING` KYC. Legacy approval values no longer gate login or protected routes.

`apps/api/tests/authRegistrationPolicy.test.js` exercises the actual login controller and auth middleware for pending/rejected workers, confirms approved-worker phone login, and asserts successful login does not query operational settings. The existing API and frontend tests cover registration, OTP completion/expiry/reuse, password creation, optional email, legacy login, email verification, session restoration and logout. The complete frontend suite passed; no frontend authentication source change was needed.

### Notifications and financial event notices

**Status: Resolved in source for the defects identified here; live provider delivery remains unverified.**

- `apps/api/src/services/notificationEventPolicy.js` classifies `CONTRIBUTION_SUBMITTED` as an essential financial event.
- `apps/api/src/services/mpesaPaymentOrchestrationService.js` enqueues the submitted notice for a newly created contribution attempt. Replay/idempotency behavior remains covered; the message states that submission is not payment confirmation.
- `apps/api/src/services/notificationEventService.js` loads only the matching pending M-Pesa contribution for submission notices and includes its amount/reference. Confirmed contribution details now include the authoritative completion timestamp alongside amount, receipt/reference and projected account balance. Each channel queue insert uses a transaction savepoint so a failed insert for one channel does not discard successfully queued notices for other channels; partial queue failures are reported with sanitized codes.
- `apps/api/src/services/smsDeliveryDispatcher.js` retries definitive temporary SMTP 4xx rejections using the existing bounded exponential delay. `apps/api/src/services/mobileSasaService.js` classifies explicit HTTP 408/425/429 rejections as retryable for the relevant Mobile Sasa request. Ambiguous timeout/network outcomes remain `UNKNOWN` and are not resent automatically, avoiding duplicate delivery where provider acceptance cannot be determined.
- SMS and email continue as independent channels. This work did not disable or remove Mobile Sasa, Gmail SMTP, the notification dispatcher, or delivery jobs, and introduced no global notification pause/disable switch. Provider acceptance remains distinct from confirmed delivery.
- Withdrawal OTP authorization was inspected but not changed in this follow-up. `apps/api/src/services/withdrawalPayoutOtpService.js` commits a pending authorization before SMS dispatch and only issues/verifies a code after the delivery outcome is confirmed. `apps/api/tests/withdrawalPayoutOtp.test.js` covers this lifecycle. The pre-existing limitation remains: inline after-commit delivery is not a durable outbox, so a process failure can leave an authorization pending for reconciliation/expiry.

### Follow-up files

Implementation files:

- `apps/api/src/services/notificationEventPolicy.js`
- `apps/api/src/services/notificationEventService.js`
- `apps/api/src/services/mpesaPaymentOrchestrationService.js`
- `apps/api/src/services/smsDeliveryDispatcher.js`
- `apps/api/src/services/mobileSasaService.js`

Regression tests:

- `apps/api/tests/authRegistrationPolicy.test.js`
- `apps/api/tests/notificationEventService.test.js`
- `apps/api/tests/mpesaPaymentOrchestrationService.test.js`
- `apps/api/tests/smsDeliveryDispatcher.test.js`
- `apps/api/tests/mobileSasaService.test.js`
- `apps/api/tests/smsNotificationRepository.test.js`

No migration was prepared or executed for the notification-delivery follow-up. A later sign-in schema mismatch and its prepared migration are recorded below.

### Follow-up verification

| Check | Result |
|---|---|
| Focused API authentication regressions after sign-in fix | **45 passed, 0 failed.** |
| Focused API authentication/notification regressions for delivery changes | **93 passed, 0 failed.** |
| Focused approval-removal/deletion API regression batch | **48 passed, 0 failed** with `NODE_ENV=test`. |
| Focused administrator deletion and tombstone regressions | **11 passed, 0 failed.** |
| Complete API unit suite (`apps/api`: `npm run test:unit`) | **825 passed, 0 failed** after the approval-removal and deletion regressions were added. |
| Focused frontend registration, profile and User Management tests | **64 passed, 0 failed.** |
| Complete frontend suite (`apps/web`: `npm test`) | **61 files passed; 378 tests passed.** JSDOM emitted non-failing navigation notices. |
| Frontend lint (`apps/web`: `npm run lint`) | **Passed.** |
| Frontend production build (`apps/web`: `npm run build`) | **Passed.** |
| `git diff --check` | **Passed.** |

Real Mobile Sasa/Gmail delivery, production credentials/configuration, notification outbox durability, and integration with running services were not tested. No live SMS/email, payment request, database query/migration, or service restart was performed. The existing worktree remains unsaved/uncommitted; no changes were staged, committed, pushed, or merged.

### Practical manual verification sequence

1. Register a worker with name, National ID, phone, and no email. Verify that a real SMS provider is configured before testing and explicitly authorize any live SMS; do not use production personal data for a test.
2. Enter the received OTP and confirm the registration page accepts it once, rejects an invalid/expired/reused code, then allows password creation.
3. Confirm the new worker can sign in immediately with the registered phone and password, while the profile still shows KYC as pending.
4. Confirm financial services that require verified identity remain unavailable until the separate KYC review is complete. Legacy pending/rejected approval values do not block sign-in.
5. Refresh the authenticated session, verify session restoration, then log out and confirm the revoked session cannot restore.
6. Add an email address in profile, complete email verification, and test email/password recovery only with a controlled mailbox.
7. Review notification preferences and verify that optional preference changes affect ordinary messages but do not suppress required verified-channel financial notices.
8. In a non-production environment, exercise a mocked provider acceptance, explicit temporary rejection, permanent rejection and ambiguous timeout independently for SMS and email. Confirm retries/statuses are accurate, queueing is not reported as delivery, and no duplicate message is sent. A genuine provider delivery test requires explicit authorization and must not be inferred from these automated tests.

## Sign-in schema mismatch follow-up

The running API log confirmed the direct cause of the reported sign-in error: `users.approval_status` did not exist in the database, while the then-running login and session-restoration queries selected it. The canonical `database/schema.sql` and full worker identity expansion migration define this legacy column, but the running database had not received the compatible schema expansion.

**Status: Prepared, not applied.** `database/migration_users_approval_status_forward.sql` remains an additive, idempotent compatibility migration for older application versions. The current authentication and registration code no longer depends on the column, so this migration is not required by the current release. It has not been executed against any database.

`apps/api/tests/databaseSchemaStatic.test.js` checks the migration's additive/idempotent contract and the deployment guide's compatibility warning. No SQL was executed against the local, primary, or any persistent database.

## Worker approval removal and user deletion follow-up

The separate administrator approval gate and User Management application-review section were removed. New workers still require phone OTP before password creation, can sign in immediately after successful registration, and remain `ACTIVE` with KYC `PENDING`. Legacy pending/rejected approval values no longer block login, session restoration, or protected routes. The National ID encryption/fingerprint flow and KYC review/history schema remain intact; no approval column or historical record was dropped or rewritten.

### User deletion root cause and correction

The Admin user list selected `users.approval_status`; the API terminal had already confirmed that the connected database does not have this column. That made `/api/admin/users` fail before the list rendered, so an administrator could not reach the row-level delete action. The column was also selected in authentication, profile, and notification queries. These live code paths no longer depend on it, and the approval field remains only in legacy schema/migration/history code.

The delete transaction also issued unconditional SQL against optional worker-registration, recovery, phone-change, notification, push and USSD tables. On deployments that have not installed those optional tables, those statements could fail and roll back deletion. Deletion now checks table presence before optional-table operations; unexpected query errors still fail the transaction and are reported. Eligibility checks preserve any financial/KYC/audit history by anonymizing and suspending the account, removing its contact and authentication credentials, and incrementing `auth_version`. Self-deletion, final active administrator deletion, unsupported system roles and repeat deletion of an anonymized account are rejected. Anonymized history-retaining accounts remain visibly marked as deleted and cannot be reactivated or deleted again through User Management.

The current schema has no per-user system-account marker or repository-defined protected system-account IDs. Unknown roles are rejected, and the final active administrator is protected. If an operator designates a normal-role account as a protected system account, that identity still needs an explicitly authorized marker/configuration before deletion; no IDs were guessed.

### Files and regression coverage

- `apps/api/src/controllers/authController.js`, `apps/api/src/middleware/authMiddleware.js`, `apps/api/src/controllers/profileController.js`, `apps/api/src/services/workerRegistrationService.js`, `apps/api/src/controllers/workerRegistrationController.js`, and `apps/api/src/services/notificationEventService.js`: removed active approval-column dependencies; registration now returns an active account with pending KYC.
- `apps/api/src/controllers/adminUserController.js`: removed the approval-column dependency from user listing, guarded optional relations, protected unsupported system roles and anonymized tombstones, and retained transactional/audited deletion behavior.
- `apps/api/src/routes/adminUserRoutes.js`, `apps/web/src/services/adminService.js`, `apps/web/src/pages/admin/UserManagement.jsx`, and `apps/web/src/components/ProfileCard.jsx`: removed worker approval/rejection UI/API wiring; the deletion dialog and meaningful success/failure messages remain.
- `apps/web/src/pages/auth/Register.jsx` and `apps/web/src/pages/auth/Login.jsx`: sign in immediately after OTP/password registration; provide a sign-in fallback if automatic login fails.
- `apps/web/src/i18n/locales/en.json`, `apps/web/src/i18n/locales/sw.json`, and `docs/deployment/worker-phone-registration-and-national-id.md`: updated the registration and compatibility documentation.
- Regression tests cover OTP registration, active account creation with pending KYC, pending/rejected legacy sign-in and protected access, inactive/suspended restrictions, no worker-approval UI, Admin list compatibility without `approval_status`, deletion with absent optional tables, financial-history preservation, authorization, nonexistent/self/final-admin/system-account protections, and tombstone reactivation prevention.

No migrations were executed. Existing approval columns and approval-history tables remain untouched. SMS/email integrations, KYC review, National ID protection, financial validation, and all external delivery behavior remain enabled and unchanged.
