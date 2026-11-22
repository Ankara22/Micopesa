BEGIN;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS approval_status VARCHAR(15) NOT NULL DEFAULT 'APPROVED';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.users'::regclass
          AND conname = 'ck_users_approval_status'
    ) THEN
        ALTER TABLE public.users
            ADD CONSTRAINT ck_users_approval_status
            CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED'));
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_users_worker_approval_status
    ON public.users (approval_status, created_at)
    WHERE role = 'WORKER';

COMMIT;
