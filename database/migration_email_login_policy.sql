BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS login_method VARCHAR(10) NOT NULL DEFAULT 'PHONE';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'users'::regclass
          AND conname = 'chk_users_login_method'
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT chk_users_login_method
            CHECK (login_method IN ('EMAIL', 'PHONE'));
    END IF;
END;
$$;

COMMIT;
