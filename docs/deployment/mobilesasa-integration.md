# Mobile Sasa notifications

Mobile Sasa SMS and email are independently opt-in. The selected provider is
used for a delivery attempt without automatic fallback to another provider.
A timeout or other ambiguous response remains unknown; it is not treated as a
definitive rejection and must not trigger a second send.

## SMS provider coverage

Outbound SMS call paths use explicit provider selection:

| Flow | Selection setting | Default |
|---|---|---|
| Queued worker and administrator notifications | `NOTIFICATION_SMS_PROVIDER` | `AFRICAS_TALKING` |
| Staff onboarding and onboarding resend | `TRANSACTIONAL_SMS_PROVIDER` | `AFRICAS_TALKING` |

Set the applicable value to `MOBILE_SASA` to select Mobile Sasa, or
`AFRICAS_TALKING` to retain Africa's Talking. The settings are separate so a
provider change for notification dispatch does not silently change staff
onboarding. SMS provider credentials are also separate.

Mobile Sasa SMS requires:

- `NODE_ENV=production`
- `MOBILESASA_SMS_ENABLED=true`
- `MOBILE_SASA_SMS_API_TOKEN`
- `MOBILE_SASA_SMS_SENDER_ID` (approved for the Mobile Sasa account)

The SMS v2 API receives a stable per-send `trackingId`. Staff onboarding also
records the selected provider, tracking ID, and provider message reference in
the onboarding audit evidence when acceptance is recorded. Queued notifications
persist their provider tracking ID and provider reference with notification
delivery evidence. Provider acceptance is not handset delivery. The response
`cost` is saved as SMS-part count, not money. Ambiguous timeouts and
possible-duplicate responses are not retried automatically; only explicit
rate-limit rejections are eligible for bounded retry.

All current outbound SMS paths are the queued notification dispatcher and
staff-onboarding create/resend flows. No SMS flow is configured to fan out to
both providers. Africa's Talking remains the default; Mobile Sasa is not
selected unless configured.

## Email provider coverage

`EMAIL_PROVIDER` selects the shared authentication and transactional email
provider. It defaults to `GMAIL`; set it to `MOBILE_SASA` to select Mobile Sasa
for supported flows. Gmail SMTP remains available as the explicit alternative
by setting `EMAIL_PROVIDER=GMAIL`.

The shared selection covers:

- Email verification and email-change verification.
- Password reset and related account-recovery email.
- Administrator notification email.

Authentication and administrator templates retain their existing subjects
and plain-text content. Mobile Sasa receives both plain text and escaped or
sanitized HTML. Authentication and password-reset flows fail through their
existing error handling if the selected provider is unavailable, suppressed,
or has an unknown outcome. They do not automatically resend through Gmail.
Provider acceptance is not proof of inbox delivery.

For Mobile Sasa email, set:

- `MOBILESASA_EMAIL_ENABLED=true`
- `MOBILE_SASA_EMAIL_API_TOKEN` (an `mbs_` token with email scope)
- `MOBILE_SASA_EMAIL_FROM` (a sender on a verified domain)
- `MOBILE_SASA_EMAIL_DOMAIN_UUID` when required by the account

The Mobile Sasa email feature flag is off unless explicitly enabled. Admin
email dispatch also requires `EMAIL_NOTIFICATIONS_ENABLED=true`.

## Delivery reports

The callback route is disabled unless `MOBILESASA_SMS_DLR_ENABLED=true`. It
also requires `NODE_ENV=production` and the server-side
`MOBILESASA_WEBHOOK_SECRET`. The endpoint accepts at most an 8 KB JSON body,
verifies the exact raw-body HMAC signature with constant-time comparison, and
checks the signed timestamp against a five-minute default replay window. It
does not log report bodies or recipient details.

The callback route applies a bounded, process-local limit of 1,200 requests per
connection IP per minute, with at most 4,096 tracked IPs. Excess traffic receives
`503` and `Retry-After` so the provider can retry later. This in-process limit
is not shared across API instances and is not sufficient as the only production
control for a multi-instance deployment; configure an appropriately bounded
shared edge or distributed limiter without weakening callback signature
verification or legitimate provider retries.

The canonical callback deduplication key is the required provider message
reference plus delivery status, scoped by provider. Optional app tracking IDs
and provider dispatch references are kept separately and used only for exact
notification correlation. A valid callback with no current match remains
`UNMATCHED`; missing or malformed provider message references are rejected.
Unmatched callbacks can later be replayed by an authenticated administrator at
`POST /api/integrations/mobilesasa/delivery-reports/replay`. Phone number,
amount, and approximate time are never used for correlation.

Provider callback timestamps are kept distinct. An event's DLR-reported time
does not set or replace `provider_accepted_at` or `sent_at`. A validated
provider-reported delivery time is stored independently; when it is absent, the
system does not fabricate one. `Sent` is interim provider acceptance, not
handset delivery. Only `Delivered` confirms delivery; failure statuses remain
non-delivery outcomes.

## Proposed migration and production prerequisites

The proposed
`database/migration_mobilesasa_sms_delivery_reports.sql` is additive and has
not been applied. It requires the existing `notifications` table,
`notifications.notification_id`, and the `set_updated_at()` trigger function.
It creates the callback inbox with a unique provider/reference/status
constraint and lifecycle checks for unmatched, correlated, processed, and
rejected records. Matched callback records cascade with deletion of their
associated notification; unmatched evidence has no notification dependency.
An authorized operator must review the SQL, confirm those prerequisites and
the intended database, and approve and apply the migration before enabling the
DLR route. Do not apply it through application startup.

Before production enablement, operators must separately provision and verify
the Mobile Sasa credentials, approved SMS sender ID and verified email sender
domain, secure the webhook secret, configure the HTTPS callback URL, approve a
callback evidence-retention period and cleanup procedure, and arrange shared
rate limiting when running multiple API instances. Confirm monitoring and
provider retry behavior in an approved test environment. Credentials and
provider enablement are intentionally not configured by this change.

The callback table currently has no automated retention or purge job.
Provider acceptance identifiers that were never persisted after an ambiguous
provider response cannot be recovered automatically from a later callback
unless the provider reference can be correlated by the exact stable tracking
identifier or by a separately persisted provider dispatch reference. Do not
resend solely because a callback is unmatched or a provider outcome is
ambiguous.
