# Authentication email and account recovery

## Database deployment

For an existing database, apply `database/migration_user_profiles.sql` if `users.email` and `users.profile_photo_ref` are not already present, then `database/migration_auth_email_recovery.sql`, then `database/migration_email_login_policy.sql` before deploying API code that requires the `login_method` column. The recovery and login-policy migrations depend on the existing `users` table; the application also depends on the profile migration's email and photo columns. All migrations use transactions, and the auth-version and login-method constraints are safe to encounter on an already-updated schema or when rerunning their migrations.

For a new database, use `database/schema.sql` instead of running the incremental migrations; it defines the profile, recovery, and login-policy columns and tables. Do not run the schema setup script over an existing production database.

The recovery migration adds `pending_email`, `email_verified` (defaulting to `FALSE`), `auth_version`, one-time authentication tokens, and hashed rate-limit keys. Existing email addresses are not marked verified.

The login-policy migration adds `login_method` with `PHONE` as the default, preserving the existing login policy for all rows already in the database. New public registrations explicitly receive `EMAIL` from the backend. Do not bulk-change existing users to `EMAIL`. The sign-in page presents phone first and email as an alternative. A verified registered phone can identify an account regardless of its original `login_method`; legacy `PHONE`-policy accounts retain their existing phone-login behavior. Email identifiers remain restricted to verified email addresses.

The migration has not been run as part of this implementation. Back up the target database and follow the deployment's normal reviewed migration procedure. Do not enable the new API against a database where the migration has not been applied.

## Permanent admin user deletion

The admin deletion endpoint requires the reviewed migration `database/migration_admin_user_deletion.sql` on existing databases. Apply it only after the finalized schema is in place and after taking a verified backup, using the normal reviewed migration procedure. This implementation does not execute migrations. The migration makes the shared `funds.managed_by` and `compliance_reports.generated_by` links nullable and changes their foreign keys to `ON DELETE SET NULL`; role-enforcement triggers continue requiring an active fund manager for non-null compliance report attribution while allowing deletion to clear historical attribution.

The deletion transaction removes the user and cascades KYC, notifications addressed to that user, USSD sessions, the pension account, contributions, fund allocations, retirement plans/projections, withdrawal claims, and authentication tokens. It also removes transaction rows formerly linked only to that user's contributions/claims when no remaining contribution or claim refers to them. Shared fund definitions remain, with the manager link cleared and the administrator label replaced by `Unassigned`; compliance reports remain with their generator cleared. Audit rows remain for history, actor references are cleared by the existing foreign key, and audit entity IDs that referred to prior role/status changes are redacted. Account and current/pending-email rate-limit hashes are removed; the rate-limit table contains no reversible email mapping. A user's profile-photo file is removed after the database commit.

Do not treat retained fund definitions, compliance reports, or audit rows as a complete financial/regulatory ledger: the schema does not define a separate immutable financial retention ledger. The migration and deletion behavior preserve the shared report/fund records while removing their direct user attribution and deleting user-owned contribution/withdrawal records. Obtain any additional regulatory retention requirements from the deployment's compliance owner before enabling permanent deletion.

## Gmail SMTP delivery configuration

Configure these API environment variables through the deployment's secret/configuration manager:

- `GMAIL_USER`: the Gmail account used to authenticate and as the sender.
- `GMAIL_APP_PASSWORD`: an app password for that account (not the Gmail account password).
- `FRONTEND_BASE_URL`: trusted public frontend origin used for verification and reset links. Production must use HTTPS.

Both registration verification and Admin Notifications use the shared Gmail SMTP transport at `smtp.gmail.com:465` with implicit TLS. The normalized `GMAIL_USER` is both the authenticated account and the sender; whitespace is removed from the app password. These settings must be available to the API process, not only to a frontend build. The API and diagnostic script load `apps/api/.env` explicitly, independent of the current working directory. Do not add these secrets to frontend environment variables or source control.

Before delivery, enable 2-Step Verification for the Gmail account and create an app password if Google Workspace/account policy permits it. The authenticated Gmail account is the sender; do not configure a different sender address. Gmail accepting a message is not proof of inbox delivery.

Run the diagnostic from the repository root to verify required settings and SMTP authentication without sending an email:

```powershell
npm --prefix apps/api run email:diagnostic
```

Only when deliberately testing one address you own, request one message explicitly:

```powershell
npm --prefix apps/api run email:diagnostic -- --send your-own-address@gmail.com
```

The send option accepts one recipient and sends one message. The script reports SMTP acceptance separately from inbox delivery; check the recipient inbox, spam folder, and the sender's Gmail Sent folder. Never use the send option in automated tests or for bulk mail.

Registration returns an account-created response with `verificationEmailSent` to the registering client. If it is false, the account remains unverified and the page offers a resend action; the user must not register again. Public resend and password-reset responses remain generic to avoid revealing whether an address has an account. Successful SMTP acceptance is recorded with a message ID when available; failures log only sanitized SMTP diagnostics. Do not log complete verification/reset links, tokens, credentials, or full recipient addresses.

Admin Notifications are independently queued and dispatched. In production, enable `NOTIFICATION_DISPATCHER_ENABLED=true` and `EMAIL_NOTIFICATIONS_ENABLED=true`; in local development, use the explicit communications email switch and a non-empty tester-controlled email allowlist. Admin email targets only active users with verified registered email addresses. A queued status is not SMTP acceptance; the notification history reports the later dispatch result. SMTP acceptance does not confirm inbox delivery.

The frontend builds can optionally set `VITE_SUPPORT_CONTACT_URL` to the official recovery contact published by the deployment. Supported link protocols are HTTPS, `mailto:`, and `tel:`. Do not set this value to an unapproved or undocumented channel. If it is absent or invalid, the recovery page does not offer a contact link and states that manual recovery is unavailable through the page.

Never put provider credentials in frontend variables, source control, or logs. Email delivery must be verified in the target environment before release; unit tests mock Nodemailer and do not contact Gmail.

## Existing users and verified email

Existing users retain their existing phone/password login policy. An email is not trusted for login or password reset until the user signs in and completes the email-verification flow from their profile. Incorrect passwords and unknown identifiers receive the same generic response; account-state details are disclosed only after the password is correct. Password-reset requests return the same public response whether or not an eligible account exists. Reset and verification tokens are single-use, expire after 30 minutes, and are stored as hashes.

## Manual recovery when verified email is unavailable

Recovery is a controlled process outside the application. This repository does not implement a support ticket system, an Admin password-reset action, or a mechanism for operators to view or choose a user's password. Do not add an unrestricted reset control to the Admin dashboard.

Before production release, the deployment administrator must publish an authorized official support channel using `VITE_SUPPORT_CONTACT_URL` (or otherwise make that official channel available to users) and approve a written identity-verification procedure. Do not invent a contact address, phone number, support organization, or identity-check policy. If no authorized channel and approved procedure are configured, manual recovery must not be offered through an undocumented channel.

Authorized support personnel must:

1. Receive requests through the configured official channel and create a reference number.
2. Verify identity using approved evidence obtained independently of the account being recovered. Information visible in the application, such as a name, phone number, or account details, is not sufficient by itself. Apply additional verification or a second authorized reviewer for high-risk cases as required by the approved policy.
3. Record the verification outcome and any required approval without putting passwords, reset tokens, or unnecessary sensitive identity documents in application logs.
4. Stop the request if verification fails; do not change the account or its recovery channel.
5. After approval, use the deployment's established secure mechanism to initiate a single-use, time-limited password reset and deliver instructions only through an appropriately verified channel. Never ask for an existing password, send a password in plain text, or allow an operator to view or choose a permanent password.
6. Notify the user through an appropriate previously verified channel after recovery, and record the operator, approval, timestamps, and outcome in the approved audit trail.

If a user has neither access to verified email nor another verified recovery channel, the approved identity-verification process must be completed before changing the recovery channel or initiating a reset. An unverified email alone must never authorize account recovery.
