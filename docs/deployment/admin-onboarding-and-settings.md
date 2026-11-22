# Admin onboarding and operational settings

## Development-only SMS and email delivery

General notification delivery in development is disabled by default. It
requires `NODE_ENV` to be unset or `development`,
`COMMUNICATIONS_DEV_DELIVERY_ENABLED=true`, the relevant channel switch
(`COMMUNICATIONS_DEV_SMS_ENABLED=true` or
`COMMUNICATIONS_DEV_EMAIL_ENABLED=true`), and the corresponding provider
configuration. Development SMS additionally requires
`MOBILESASA_NOTIFICATION_SMS_ENABLED=true`. Keep
`MOBILESASA_SMS_ENABLED=false` in development so the separate phone-verification
test-SMS path remains available. Recipients are selected from active registered user profiles;
SMS requires a verified phone and email requires a verified email address.
Notification preferences and role-based recipient scopes continue to apply.

Development SMS uses the configured Mobile Sasa adapter; development email
uses the configured SMTP transport. These switches do not start the production
notification dispatcher. Keep all development switches false unless an
operator has explicitly approved delivery. When enabled, a queued notification
can reach its selected registered recipient through the configured provider;
automated tests must use mocked transports and never send real messages.
Development SMS uses the live Mobile Sasa send endpoint, not a provider
sandbox. Do not enable it for real user profiles unless each delivery is
explicitly authorized; use mocked transports for local validation.

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

The public `POST /api/mpesa/stkpush` route returns HTTP 503 unless Daraja is
selected, its environment and required configuration are valid, dispatch is
explicitly enabled, and the selected environment's own opt-in is enabled.
Sandbox initiation requires both `MPESA_PROVIDER_DISPATCH_ENABLED=true` and
`MPESA_SANDBOX_ENABLED=true` with `DARAJA_ENV=sandbox` (or its documented
alias). Production additionally requires
`MPESA_LIVE_PAYMENTS_ENABLED=true` and `DARAJA_ENV=production`; these settings
must remain off until a separately authorized production release. The service
uses the corresponding Safaricom API host and validates the callback as an
HTTPS URL without credentials or a fragment; the deployment operator must
register the correct callback with the matching sandbox or production Daraja
application. Missing or conflicting settings produce an unavailable response.
Callback verification and administrator reconciliation settle only after
verified evidence and use the atomic settlement workflow. Mocked tests do not
verify live payments.

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
`database/migration_mobilesasa_sms_delivery_reports.sql` after both the
persistent SMS and unified-notification migrations, then register
`https://<api-host>/api/integrations/mobilesasa/delivery-reports` in Mobile
Sasa. The endpoint validates the timestamped signature over the raw body,
deduplicates reports, and correlates only by exact provider message reference
or the notification's stable tracking ID. It never uses phone number, amount,
or approximate time for matching. Unmatched reports remain stored for replay;
an administrator can request replay at
`POST /api/integrations/mobilesasa/delivery-reports/replay`. `Sent` means
provider acceptance, while only a confirmed `Delivered` report sets
`DELIVERED`. Keep the flag off until the migration and provider webhook
registration have both been verified. The canonical fresh-install schema
already includes the callback inbox; do not apply the additive inbox migration
to that schema. The migration is for eligible existing installations only and
has not been applied by this code change. Establish an evidence-retention
policy before enabling production callback storage.

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

SMS and email notification preferences are explicit opt-ins and default to
false, including for accounts created by staff onboarding. Users can change
their own choices from their notification settings; SMS and email delivery
still require verified contacts. Browser push consent is represented by a
subscription registered by the signed-in user and can be removed per device.
The settings screen reports verification and subscription state without
displaying the contact values.

Business events currently emitted by the application are classified centrally
as essential transactional notifications: `CONTRIBUTION_CONFIRMED`,
`KYC_VERIFIED`, `KYC_REJECTED`, and `RETIREMENT_PLAN_SAVED`. These events do not
depend on optional SMS/email preferences, but still require an active account
and a current, valid, verified destination at enqueue and immediately before
dispatch. Role-composed operational categories
(`ACCOUNT_SERVICE`, `CONTRIBUTION_REMINDER`, `SCHEME_UPDATE`,
`REGULATORY_ADVISORY`, `COMPLIANCE_NOTICE`, and `DEADLINE_REMINDER`) follow the
same preference-independent rule while retaining contact verification and
role/fund scope checks. General announcements and worker education remain
optional and require per-user opt-in. Simulated contribution settlement queues
only an in-app confirmation and never queues external email or SMS.
Failed-contribution and withdrawal event types are not currently emitted and
are not inferred by this policy.

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

### Fresh installation versus existing database upgrade

`database/schema.sql` is the authoritative complete schema for a fresh
installation only. Its preamble drops existing tables with `CASCADE`; never
run it against an existing installation or as an upgrade. It defines the
notification table and its delivery fields,
`notification_preferences`, `push_subscriptions`, the
`uq_notifications_user_channel_event_key` index, role-scoped notification
audit, regulator assignments, report generation/download history, compliance
submission/review history, and the MobileSasa callback inbox. Do not replay
upgrade migrations over a database created from this schema.

For an existing database, first compare its actual migration ledger and schema
with the migration preconditions; the repository does not have a single
automatic migration runner or a universal starting version. The dependency
graph from the SQL is:

```text
pre-persistent notifications
  -> migration_sms_persistent_delivery
  -> migration_unified_notifications
       -> migration_transactional_notifications
       -> migration_role_notifications_and_reporting
            -> migration_notification_event_classification_repair_forward
       -> migration_external_recipient_sms (optional)
       -> migration_mobilesasa_sms_delivery_reports (optional; also needs persistent SMS fields)
```

The transactional and role/reporting migrations are independent of each other
after the unified migration. The transactional migration creates
`notification_preferences` and `uq_notifications_user_channel_event_key`.
The role/reporting migration creates `notification_category` and replaces the
unified migration's administrator-request index. The external-recipient
migration requires the unified migration's channel-snapshot constraint and
request/contact columns. The MobileSasa delivery-report migration requires
`delivery_result` from the unified migration and persistent delivery columns.

`notificationEventService.js` inserts `notification_category` and
`deduplication_key` and `notification_event_type`, and reads
`notification_preferences`; therefore the
application service requires the persistent, unified, transactional, and
role/reporting migrations, followed by the guarded event-classification
repair, not merely the migration that creates preferences.
`smsNotificationRepository.js` also uses persistent delivery fields,
unified channel snapshots, transactional preferences, and the event
classification column. A safe recommended
application/API rollout is:

1. `database/migration_sms_persistent_delivery.sql` — delivery state and
   stable notification tracking fields. It drops a constraint named
   `notifications_delivery_status_check` and expects the pre-persistent table
   shape; it is a one-time migration, not an idempotent script. The canonical
   `schema.sql` instead defines `ck_notifications_delivery_status` and already
   contains the persistent fields, so this migration cannot be applied to the
   canonical schema. The repository does not preserve a separate historical
   pre-persistent schema snapshot; confirm that the actual target has the
   exact constraint name and columns used by this migration before approving
   an upgrade.
2. `database/migration_unified_notifications.sql` — email/push snapshots and
   browser push subscriptions; it expects the prior migration's columns.
3. `database/migration_role_notifications_and_reporting.sql` — creates
   notification categories/scopes and audit, regulator assignments, and
   report generation/download history. It expects the unified migration's
   administrator-request index.
4. `database/migration_transactional_notifications.sql` — in-app event type,
   event idempotency index, and opt-in preferences. It requires persistent
   delivery's `deduplication_key`; the documented position also ensures the
   role category exists before deploying `notificationEventService.js`.
5. `database/migration_notification_event_classification_repair_forward.sql`
   — guarded correction for the nullable event-classification column. It
   removes the historical event CHECK only when its definition and referenced
   column match a verified historical form; otherwise it aborts. For an
   existing database needing this correction, use it in place of the older
   `database/migration_notification_event_classification.sql`. Do not run the
   older name-based drop first. Apply this after both the transactional and
   role/reporting prerequisites and before deploying code that writes or
   queries `notification_event_type`.
6. `database/migration_external_recipient_sms.sql` only if that feature is
   authorized and the target schema has the unified-notification channel
   snapshot constraint. Its preflight rejects absent prerequisites and
   already-present external-recipient objects rather than silently accepting
   an incompatible partial schema.
7. `database/migration_mobilesasa_sms_delivery_reports.sql` only if the
   callback inbox feature is authorized; it requires both persistent
   delivery fields and the unified migration's `delivery_result` column.

The transactional migration explicitly rejects an already-present
preferences table or event-key index rather than silently accepting a
partially/freshly upgraded schema. Those definitions are intentionally present
both in the canonical fresh schema and in the upgrade migration; only one path
is used for a given database. These steps preserve existing notification rows
and preferences, but they must not be repeated on a database where the
corresponding migration already ran.

These scripts are safe only when the target has exactly the expected starting
schema and migration history. In particular, the persistent, unified, and
role/reporting migrations use one-time `ALTER`, `DROP INDEX`, and `CREATE`
statements without a universal compatibility preflight. Any partially
applied, manually modified, or differently versioned schema must be reviewed
against each SQL statement before proceeding; do not rely on filenames or
comments as proof of compatibility.

Before either event-classification migration, obtain database-owner approval
and a verified restorable backup. The guarded correction preserves existing
notification rows and unrelated checks, but it does not activate or otherwise
change the pension ledger. Ledger activation still requires independent
financial reconciliation and separate formal cutover approval.

Compliance workflow upgrades are a separate one-time chain for databases
still on the pre-workflow compliance schema:
`migration_compliance_review_workflow.sql`,
`migration_compliance_actor_snapshots.sql`, then
`migration_compliance_workflow_enforcement.sql`. The first migration validates
the expected pre-workflow columns and refuses to run against the finalized
schema. Do not apply any of these to a fresh database built from
`database/schema.sql`; that schema already contains the final reporting,
regulator, and compliance objects. Never infer that a migration is needed
without checking the target's migration ledger and preconditions.

No migration has been applied as part of this source review.

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

The withdrawal OTP setting is enforced for the approved-claim authorization
workflow. A payout officer can request or resend an OTP to the worker's
currently verified phone; the worker must verify it against their own approved
withdrawal. Codes expire after five minutes, allow five attempts, and are
limited to three SMS sends per withdrawal per hour with a 60-second cooldown.
OTP settings or SMS configuration failures block authorization rather than
bypassing verification.

### Withdrawal payout OTP migration deployment and recovery

The repository has no central migration-version table or migration runner.
Use the database owner's deployment records together with the target database
schema; a filename or this source tree alone does not establish whether a
migration has run.

**Fresh installation:** initialize a new, empty database using
`database/schema.sql` only. It already contains the `PAYOUT_OFFICER` role,
OTP authorization and delivery-event tables, supporting indexes, checks,
foreign keys, and invalidation triggers. Do not also apply
`database/migration_withdrawal_payout_otp_authorization_forward.sql`.
`schema.sql` drops existing objects and is never an upgrade script.

**Existing installation:** take and verify a restorable backup, rehearse on an
isolated clone, and confirm the database's migration history before selecting
this path. Apply
`database/migration_withdrawal_payout_otp_authorization_forward.sql` exactly
once, only after the finalized base schema is present and before deploying API
code that uses these tables. It accepts only the supported pre-feature state:
the required public tables/columns, the validated four-role `users_role_check`
(`WORKER`, `FUND_MANAGER`, `REGULATOR`, `ADMIN`), and no OTP feature objects.
It stops before DDL if the role check is different, `PAYOUT_OFFICER` is already
allowed, or OTP objects are present. Do not work around a failed preflight;
identify the actual schema revision and obtain a reviewed migration for that
state.

If the approved existing-database path also includes
`database/migration_pension_account_ledger.sql`, apply that ledger migration
first. It already supplies unique keys for
`pension_accounts(account_id, user_id)` and
`withdrawal_claims(claim_id, account_id)`. The OTP migration detects and reuses
valid equivalent unique indexes/constraints; it creates a supporting index
only when no equivalent exists. On a fresh canonical installation, the ledger
migration similarly adopts the canonical OTP indexes as its unique
constraints. This avoids redundant indexes without weakening either
composite foreign key. Keep the separately documented ledger/M-Pesa guard
migrations in their approved order. The OTP migration does not replace or
disable those protections.

Run the migration in the controlled deployment window with the standard
stop-on-error setting (for example, `psql -v ON_ERROR_STOP=1`). It is
transactional and serializes concurrent attempts with a transaction-scoped
advisory lock. Record the successful filename/revision in the deployment's
external migration ledger. If it errors, stop immediately: PostgreSQL will
roll back the transaction; if the session remains open in an aborted
transaction, issue `ROLLBACK` or close the session before inspecting state.
Do not rerun until the database owner confirms the preflight state again.

After commit, deploy the API separately and verify the resulting schema with
read-only catalog queries. At minimum, verify:

```sql
SELECT to_regclass('public.withdrawal_payout_otp_authorizations'),
       to_regclass('public.withdrawal_payout_otp_delivery_events');

SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.users'::regclass
  AND conname = 'users_role_check';

SELECT indexrelid::regclass AS index_name,
       indrelid::regclass AS table_name,
       indisunique, indisvalid, indisready,
       pg_get_indexdef(indexrelid)
FROM pg_index
WHERE indrelid IN (
    'public.withdrawal_claims'::regclass,
    'public.pension_accounts'::regclass,
    'public.withdrawal_payout_otp_authorizations'::regclass,
    'public.withdrawal_payout_otp_delivery_events'::regclass
);

SELECT tgrelid::regclass AS table_name, tgname, tgenabled
FROM pg_trigger
WHERE NOT tgisinternal
  AND tgname IN (
      'trg_withdrawal_claims_invalidate_payout_otp',
      'trg_users_invalidate_payout_otp',
      'trg_pension_accounts_invalidate_payout_otp',
      'trg_00_disable_payout_attempts',
      'trg_00_disable_payout_verifications',
      'trg_mpesa_attempt_requires_active_ledger',
      'trg_pension_ledger_block_unsettled_mpesa_attempts'
  )
ORDER BY tgname;
```

Compare the catalog output, key financial row counts, and the ledger/M-Pesa
guard state to the recorded pre-deployment baseline. A missing payout guard
because its prerequisite migration was never installed is not evidence that
this OTP migration enabled or disabled it; stop and follow the relevant
ledger runbook.

The migration is forward-only. If application deployment fails after the
database commit, keep the schema and authorization/delivery history, and use
an application rollback only if that application version tolerates the
additive schema. Otherwise keep the feature unavailable and prepare a reviewed
forward repair. Dropping OTP tables is not a routine rollback: once records
exist, it destroys authorization, delivery-rate-limit, and audit evidence;
it can also invalidate outstanding references and hinder incident recovery.
Never delete or rewrite historical withdrawal, payment, pension-ledger, or
audit records as part of this deployment.

This workflow records authorization only. The application still has no payout
executor: successful OTP verification does not create a transaction, change a
claim to paid, or initiate M-Pesa.
