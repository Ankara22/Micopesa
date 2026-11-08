# One-time external-recipient SMS

The Admin Notifications page can send one SMS to a Kenyan mobile number that
is not a MicoPesa account. It uses the existing Mobile Sasa adapter and
notification row, status, callback-correlation, and audit systems. External
recipients have `notifications.user_id = NULL`; the number is not attributed to
the administrator or another registered account.

## Approval and configuration

The feature is unavailable unless all of these conditions are met:

- Mobile Sasa has approved full production SMS sending access for the account
  and sender ID. Trial restrictions must not be bypassed.
- The additive schema migration
  [`migration_external_recipient_sms.sql`](../../database/migration_external_recipient_sms.sql)
  has been reviewed and applied through the authorized deployment process.
- Production configuration explicitly sets
  `MOBILESASA_EXTERNAL_RECIPIENTS_ENABLED=true` and
  `MOBILESASA_SMS_ENABLED=true`.
- The existing `MOBILE_SASA_SMS_API_TOKEN` and
  `MOBILE_SASA_SMS_SENDER_ID` settings are correctly configured.

Keep `MOBILESASA_EXTERNAL_RECIPIENTS_ENABLED=false` (or unset) until provider
approval and sending access have been independently confirmed. The feature
cannot be enabled in development. It does not enable or start the general SMS
dispatcher.

## Sending and delivery behavior

An administrator enters one E.164 Kenyan mobile number and a demonstration
message, confirms the recipient agreed to receive it, reviews the complete
preview, and explicitly confirms the send. The endpoint accepts only one
recipient and a message of at most 255 characters. A database-backed advisory
lock and notification history limit each administrator to one new external
SMS request per 15 minutes. A request UUID makes confirmations idempotent.

External notifications are stored with the registered-recipient foreign key
unset. The database constraint permits a null `user_id` only for a valid
external SMS with a canonical number, idempotency key, and consent timestamp.
The complete recipient and consent time are retained on that notification;
the existing immutable notification audit event links to its notification ID
and records the administrator, request, channel, and authorization outcome.
The notification ID is sent as the Mobile Sasa tracking ID, allowing the
existing delivery-report inbox to update the notification from provider
acceptance to confirmed delivery or failure.

The general notification dispatcher explicitly excludes external rows from
both claim and expired-claim handling. The dedicated endpoint sends through
Mobile Sasa only. Definitive provider rejection is recorded as `FAILED`;
timeouts, malformed responses, and other ambiguous outcomes are recorded as
`UNKNOWN`. A repeated confirmation returns the existing status and never
automatically resends. A new request remains subject to the 15-minute limit.

Provider acceptance is not handset delivery. `DELIVERED` is shown only after a
valid delivery report updates the persisted notification.

## Schema and rollback

The proposed migration allows `notifications.user_id` to be NULL only for an
external SMS row and adds consent metadata and an external-request idempotency
index. It does not alter `notification_audit_events`, so the existing audit
page does not gain a dependency on this migration; audit records link to the
recipient and consent snapshot through their notification IDs. It does not
create a MicoPesa account or change registered-user notification behavior.
Fresh-install definitions are mirrored in `database/schema.sql`.

The external recipient number and message are personal data. Apply the
organization's existing notification/audit retention policy and restrict
access to administrator notification history and audit logs. Before rollback,
export or retain any required evidence. Deleting the external rows or dropping
their audit columns discards idempotency, consent, recipient, and delivery
evidence; restoring `notifications.user_id NOT NULL` is not possible while
external notification rows remain.

No migration has been applied as part of this change.
