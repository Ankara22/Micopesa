# Admin onboarding and operational settings

The admin onboarding and settings API requires the additive migration
`database/migration_admin_panel_settings.sql`. Apply it after the finalized
database schema has created `users`, `audit_logs`, and `system_settings`, and
before deploying the API version that reads the new columns and settings.
The migration does not rewrite existing user credentials. Existing accounts
retain `is_temp_password = false`, `force_password_change = false`, and a zero
failed-login counter.

## M-Pesa payment verification and settlement

For an existing database that has not received the payment-attempt and
verification changes, review and apply the M-Pesa migrations in this order:

1. `database/migration_mpesa_stk_push.sql`
2. `database/migration_mpesa_payment_attempts.sql`
3. `database/migration_mpesa_payment_verifications.sql`
4. `database/migration_mpesa_payment_settlement.sql`
5. `database/migration_mpesa_query_only_settlement.sql`
6. `database/migration_mpesa_retry_recovery.sql`

The verification-table migration must precede the settlement-constraint
migration; query-only settlement is the final verification-constraint update.
The retry/recovery migration checks for multiple active attempts on one
contribution before creating its partial unique index. Resolve any reported
duplicates through an approved operational process before retrying the
migration; it does not select or delete attempts automatically. Fresh
databases built from `database/schema.sql` already include the final
definitions and must not run these migrations again. These steps apply only to
existing databases that have not already received the listed changes.

The public `POST /api/mpesa/stkpush` route remains explicitly gated with HTTP
503. Payment orchestration is not enabled through that route. Daraja endpoint,
credentials, and any future authorization to enable initiation remain separate
deployment decisions. Callback verification and administrator reconciliation
settle only after verified evidence and use the atomic settlement workflow.
Mocked tests do not verify live payments.

## Persistent SMS delivery

Before deploying the persistent worker to an existing database with the prior
notifications schema, review and separately apply
`database/migration_sms_persistent_delivery.sql`. Fresh databases created from
the updated canonical `database/schema.sql` must not also apply this migration.
The migration preserves existing notifications and maps legacy `SENT` rows to
`PROVIDER_ACCEPTED`; that status does not mean handset delivery.

By default, the contribution SMS dispatcher uses Africa's Talking and starts
only when `NODE_ENV=production`, `SMS_DISPATCHER_ENABLED=true`,
`AT_ENVIRONMENT=production`, `AT_USERNAME`, and `AT_API_KEY` are configured.
`AT_SENDER_ID` is optional and must be an Africa's Talking-approved sender
identity.

Mobile Sasa SMS for queued notifications is opt-in. Set
`NOTIFICATION_SMS_PROVIDER=MOBILE_SASA`,
`MOBILESASA_SMS_ENABLED=true`, `SMS_DISPATCHER_ENABLED=true`,
`NODE_ENV=production`, `MOBILE_SASA_SMS_API_TOKEN` (a server-side `mbs_` token
with message-send scope), and `MOBILE_SASA_SMS_SENDER_ID` (the exact approved
sender ID). The v2 request uses the notification ID as its stable `trackingId`.
Do not retry an ambiguous timeout or the provider's duplicate-send response
automatically. Only an explicit HTTP 429 rejection is retried with bounded
backoff. The provider's `0200` response means accepted for dispatch, not
handset delivery.

Both providers claim rows transactionally with `SKIP LOCKED`; expired
`PROCESSING` claims become `UNKNOWN` and are never resent automatically. Keep
all credential values on the server. Mobile Sasa SMS delivery reports are
supported by a separate callback inbox, but remain disabled unless
`MOBILESASA_SMS_DLR_ENABLED=true` and `MOBILESASA_WEBHOOK_SECRET` are configured.
Before enabling it, an authorized operator must review and apply
`database/migration_mobilesasa_sms_delivery_reports.sql` after the notification
schema is present, then register
`https://<api-host>/api/integrations/mobilesasa/delivery-reports` in Mobile
Sasa. The endpoint validates the timestamped signature over the raw body,
deduplicates reports, and correlates only by exact provider message reference
or the notification's stable tracking ID. It never uses phone number, amount,
or approximate time for matching. Unmatched reports remain stored for replay;
an administrator can request replay at
`POST /api/integrations/mobilesasa/delivery-reports/replay`. `Sent` means
provider acceptance, while only a confirmed `Delivered` report sets
`DELIVERED`. Keep the flag off until the migration and provider webhook
registration have both been verified. This migration is prepared but has not
been applied by this code change. Establish an evidence-retention policy
before enabling production callback storage.

## Unified administrator notifications

The admin composer supports searching for and selecting up to 100 active
registered users, then composing an announcement over any combination of SMS,
email, and browser push. The preview lists each selected user and the available
registered contact for each chosen channel. A selected channel must be
available for every recipient. Each recipient and channel is recorded
independently. Retrying the identical batch with the same `request_id` does
not create duplicate records; reusing that ID with a different recipient list
is rejected. The backend revalidates active accounts and contacts and never
accepts recipient contact details from the browser.

For an existing database that has already received
`migration_sms_persistent_delivery.sql`, review and separately apply
`database/migration_unified_notifications.sql` before deploying these API
routes. Do not apply it to a fresh database created from the updated canonical
`database/schema.sql`, which already includes these fields and the
`push_subscriptions` table. This migration has not been applied by this code
change.

The email channel defaults to the existing Gmail SMTP service. It requires
`NODE_ENV=production`, `NOTIFICATION_DISPATCHER_ENABLED=true`,
`EMAIL_NOTIFICATIONS_ENABLED=true`, `GMAIL_USER`, and `GMAIL_APP_PASSWORD`.
Administrators may provide both a plain-text body and an optional HTML body.
HTML is sanitized on the server to a small formatting/link allow-list before
submission; the plain-text body is retained for Gmail.

Mobile Sasa email is opt-in. Set `EMAIL_PROVIDER=MOBILE_SASA`,
`NOTIFICATION_DISPATCHER_ENABLED=true`, `EMAIL_NOTIFICATIONS_ENABLED=true`,
`MOBILESASA_EMAIL_ENABLED=true`, `MOBILE_SASA_EMAIL_API_TOKEN` with the
required email scope, and `MOBILE_SASA_EMAIL_FROM` to a sender configured for a
verified Mobile Sasa domain. Set `MOBILE_SASA_EMAIL_DOMAIN_UUID` when required
by the account. This selects the provider only for queued administrator notifications;
authentication and account-recovery email continue to use Gmail SMTP. A
selected provider's delivery failure does not trigger a fallback send through
another provider, avoiding possible duplicate messages. Provider acceptance
is recorded as `PROVIDER_ACCEPTED`; it is not inbox delivery. Email
delivery-report processing is not currently implemented.

Browser push uses standard Web Push and requires
`NODE_ENV=production`, `NOTIFICATION_DISPATCHER_ENABLED=true`,
`WEB_PUSH_ENABLED=true`, `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, and
`WEB_PUSH_SUBJECT`. Generate and protect the VAPID key pair in the deployment
secret manager. Serve the web app and `/service-worker.js` over HTTPS on the
same origin as the API-authorized app. Authenticated users opt in from their
notification screen only after a user gesture and may remove a device
subscription there. Expired
subscriptions are removed when the push provider reports HTTP 404 or 410.
Push provider acceptance is not confirmation that the browser displayed an
alert. No real credentials or provider requests are part of this migration.

## Role-scoped notifications and reports

Fund Managers may notify only active workers currently allocated to active
funds they manage. Regulators may notify workers and Fund Managers in active
funds explicitly assigned to them by an administrator. The API enforces the
role-specific notification categories and scope; notification audit views
mask recipient contact details.

Existing databases must apply
`database/migration_role_notifications_and_reporting.sql` after the SMS and
unified-notification migrations, in that order. The new migration adds
regulator fund assignments, notification categories and append-only
notification audit records, plus report history/download metadata. Do not
apply it to a fresh database built from the canonical `database/schema.sql`.
It is a proposal only and has not been applied.

Reports are authorized by role and current fund scope. CSV, XLSX, and PDF
exports are generated in memory and capped at 5,000 rows. Download requests
rebuild report data and recheck current permissions; report history stores
metadata, not report files. Regulator reporting requires an administrator to
grant the relevant fund assignments before report data is available.

Before enabling any channel, verify production provider accounts, sender
approval where required, dispatcher startup and shutdown, durable database
backups, and monitoring for `PENDING`, `UNKNOWN`, `FAILED`, and stale
`PROCESSING` notifications. Do not enable a dispatcher until the matching
schema migration has been reviewed and applied by an authorized operator.

## Staff onboarding SMS

Configure these variables in the API process environment:

- `AT_ENVIRONMENT=production`
- `AT_USERNAME`
- `AT_API_KEY`
- `SMS_DISPATCHER_ENABLED=true` (required only to start the contribution SMS
  dispatcher)
- `AT_SENDER_ID` (optional; only use a sender identity approved for the
  Africa's Talking account)

`NODE_ENV` must also be `production`. The API uses the Africa's Talking
production endpoint only, rejects the `sandbox` username, and refuses to send
from development and test runtimes. Keep the API key and sender ID exclusively
in the server environment. No sandbox SMS endpoint is enabled by this service.

The API sends a randomly generated temporary password to the supplied Kenyan
phone number. The password itself is never returned by the API or written to
logs. A newly provisioned account remains inactive until Africa's Talking
accepts the SMS. Provider acceptance does not prove delivery to the handset.
If acceptance fails, the account remains inactive and an administrator can use
the retry action in User management to issue a fresh temporary password.
The API accepts Kenyan mobile numbers in local `07...`/`01...` or international
`254...`/`+254...` form and sends them to the provider in `+254...` form. Provider requests have a bounded timeout; a timeout has an
unknown outcome because the provider may have accepted the request, and is not
logged with the recipient or message. Creating an already-existing staff
account does not send another SMS. The explicit resend action issues a new
temporary password and sends a new message.

Worker contribution confirmations are attempted after a contribution has been
verified and settled, through either callback or administrator reconciliation.
The recipient is snapshotted from the worker's server-side account phone, and
the notification is inserted transactionally with settlement. Provider
acceptance is not handset delivery. See Persistent SMS delivery above for
claiming, retries, and recovery behavior.

Staff onboarding messages are currently English; the API does not store a
recipient language preference, so it does not infer a language from the
administrator's browser.

At first sign-in, the API restricts the session to profile retrieval, logout,
and password change. The staff member must choose a new password before other
authenticated routes are available.

The endpoint is `POST /api/v1/admin/staff`; the admin UI also uses
`POST /api/v1/admin/staff/:userId/resend` to retry an incomplete onboarding.

## Operational settings

`GET /api/v1/admin/settings` and `PUT /api/v1/admin/settings` use the existing
`system_settings` table. The write endpoint accepts the complete `settings`
object and validates these ranges:

- `assumed_yearly_growth`: 1–20 percent; default 8.
- `max_failed_login_attempts`: 3–10; default 5.
- `account_lockout_duration_minutes`: 5–60; default 15.
- `require_otp_on_withdrawal`: boolean; default true.

Login failures use the configured attempt count and lockout duration. New
retirement projections use the configured annual growth assumption. Every
changed setting is recorded in the append-only `audit_logs` table with the
actor and old/new values in the JSON `details` column.

## Retirement projection series

Apply `database/migration_retirement_projection_series.sql` after the
canonical schema and before deploying the projection-engine API. It adds
nullable current-age, starting-balance, and yearly-series fields to the
existing `retirement_projections` table. Existing saved projections are not
rewritten; they retain NULL for assumptions that were not recorded and can be
recalculated by the account owner.

The projection API uses `pension_accounts.current_balance` as the credited
starting balance, reads the growth assumption above, and saves each new
year-by-year estimate with its plan. Monthly contributions are modeled at
month-end. Projection estimates are illustrative, are not guaranteed returns,
and do not initiate or settle payments.

The withdrawal OTP setting is persisted and audited for the future payout
dispatch flow. The current application does not dispatch M-Pesa payouts, so
enabling this setting does not create or imply a live verification or payout
operation.
