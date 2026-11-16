# Verified Phone Number Changes

## Database prerequisite

Before deploying the phone-change API, apply `database/migration_verified_phone_changes.sql` through the normal reviewed deployment process. The migration adds `users.phone_verified_at`, a normalized-phone uniqueness index, and `phone_change_verifications` for salted code hashes, expiry, attempt counters, send limits, and lockout state. It does not change existing phone numbers or account roles.

The migration stops if existing phone values normalize to duplicate Kenyan numbers. Resolve those account conflicts before retrying it. Do not deploy the code against a database that has not applied the migration.

## SMS configuration

The phone verification flow selects its provider before checking availability and uses the same selector for dispatch. It does not start or enable the general notification dispatcher.

- Production: set `NODE_ENV=production` and `TRANSACTIONAL_SMS_PROVIDER` to `AFRICAS_TALKING` or `MOBILE_SASA`. Africa's Talking requires `AT_ENVIRONMENT=production`, `AT_USERNAME`, and `AT_API_KEY`. Mobile Sasa requires `MOBILESASA_SMS_ENABLED=true`, `MOBILE_SASA_SMS_API_TOKEN`, and `MOBILE_SASA_SMS_SENDER_ID`.
- Local development: set `NODE_ENV=development` and `MOBILESASA_TEST_SMS_ENABLED=true`, keep `MOBILESASA_SMS_ENABLED` unset or set to `false`, and provide the Mobile Sasa SMS token and sender ID. Enabling normal Mobile Sasa SMS at the same time is treated as a configuration conflict. This enables only an explicitly confirmed phone verification request; the general SMS dispatcher remains disabled unless its separate notification delivery switch is explicitly enabled.

Development Admin Notifications use a separate
`MOBILESASA_NOTIFICATION_SMS_ENABLED=true` switch. This does not change the
phone-verification test-SMS path, which continues to require
`MOBILESASA_SMS_ENABLED` unset or false. The notification switch uses the live
Mobile Sasa SMS endpoint, not a sandbox, and must remain off unless delivery to
the selected registered recipients is explicitly authorized.

Development phone verification can send a real SMS when the user explicitly confirms a change. Automated tests use mocked provider calls.

Configuration failures, provider rejections, and uncertain provider outcomes are reported separately. Server diagnostics include only safe provider/error codes and missing or invalid variable names; credentials, OTPs, messages, and recipient details are not logged.

## Verification behavior

The signed-in user must enter their current password, a Kenyan mobile number, and explicitly confirm sending a code. A user with an unverified registered phone may verify that same number without changing its stored value; a verified current number cannot be needlessly re-verified. A different number remains pending and the registered number is unchanged until the six-digit code is verified. Codes are salted scrypt hashes in the database, expire after 10 minutes, allow at most five guesses per challenge, and are limited to three sends per hour with at least 60 seconds between sends. Five failed guesses lock verification for 15 minutes; after the lock expires, the user may request a new code within the hourly send limit.

The API reports provider acceptance, not confirmed handset delivery. A pending number is not used for login. After verification, the new number is stored in canonical `+254...` form and can identify the same account with the existing password; verified email login remains available.
