BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email VARCHAR(254),
    ADD COLUMN IF NOT EXISTS profile_photo_ref VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower
    ON users (lower(email))
    WHERE email IS NOT NULL;

COMMIT;
