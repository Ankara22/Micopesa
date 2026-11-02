# Admin onboarding and operational settings

The admin onboarding and settings API requires the additive migration
`database/migration_admin_panel_settings.sql`. Apply it after the finalized
database schema has created `users`, `audit_logs`, and `system_settings`, and
before deploying the API version that reads the new columns and settings.
The migration does not rewrite existing user credentials. Existing accounts
retain `is_temp_password = false`, `force_password_change = false`, and a zero
failed-login counter.

## Staff onboarding SMS

Configure these variables in the API process environment:

- `AT_USERNAME`
- `AT_API_KEY`
- `AT_SENDER_ID` (optional; only use a sender identity approved for the
  Africa's Talking account)

The API sends a randomly generated temporary password to the supplied Kenyan
phone number. The password itself is never returned by the API or written to
logs. A newly provisioned account remains inactive until Africa's Talking
accepts the SMS. Provider acceptance does not prove delivery to the handset.
If acceptance fails, the account remains inactive and an administrator can use
the retry action in User management to issue a fresh temporary password.

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
