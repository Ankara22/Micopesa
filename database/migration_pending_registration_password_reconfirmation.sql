BEGIN;

ALTER TABLE pending_registrations
    ALTER COLUMN password_hash DROP NOT NULL;

UPDATE pending_registrations
SET password_hash = NULL
WHERE password_hash IS NOT NULL;

COMMIT;
