# Verified Phone Number Changes

## Database prerequisite

Before deploying the phone-change API, apply `database/migration_verified_phone_changes.sql` through the normal reviewed deployment process. The migration adds `users.phone_verified_at`, a normalized-phone uniqueness index, and `phone_change_verifications` for salted code hashes, expiry, attempt counters, send limits, and lockout state. It does not change existing phone numbers or account roles.

The migration stops if existing phone values normalize to duplicate Kenyan numbers. Resolve those account conflicts before retrying it. Do not deploy the code against a database that has not applied the migration.

## SMS configuration

The phone verification flow calls the existing Mobile Sasa adapter directly; it does not start or enable the general notification dispatcher.

- Production: enable `MOBILESASA_SMS_ENABLED=true` and provide `MOBILE_SASA_SMS_API_TOKEN` and `MOBILE_SASA_SMS_SENDER_ID`.
- Local development: set `MOBILESASA_TEST_SMS_ENABLED=true`, keep `MOBILESASA_SMS_ENABLED=false`, and provide the same Mobile Sasa SMS token and sender ID. This enables only an explicitly confirmed phone verification request; the general SMS dispatcher remains disabled.

Development phone verification can send a real SMS when the user explicitly confirms a change. Automated tests use mocked provider calls.

## Verification behavior

The signed-in user must enter their current password, a Kenyan mobile number, and explicitly confirm sending a code. A user with an unverified registered phone may verify that same number without changing its stored value; a verified current number cannot be needlessly re-verified. A different number remains pending and the registered number is unchanged until the six-digit code is verified. Codes are salted scrypt hashes in the database, expire after 10 minutes, allow at most five guesses per challenge, and are limited to three sends per hour with at least 60 seconds between sends. Five failed guesses lock verification for 15 minutes; after the lock expires, the user may request a new code within the hourly send limit.

The API reports provider acceptance, not confirmed handset delivery. A pending number is not used for login. After verification, the new number is stored in canonical `+254...` form and can identify the same account with the existing password; verified email login remains available.
