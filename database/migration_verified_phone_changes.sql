BEGIN;

-- This migration only adds verification state. It does not update existing
-- user IDs, password hashes, roles, permissions, account status, or phone values.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ NULL;

-- Normalize accepted Kenyan forms identically for duplicate detection and the
-- unique index. NULL and whitespace-only phone values normalize to NULL, so
-- PostgreSQL's normal multiple-NULL unique-index behavior applies to both.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM users
        WHERE NULLIF(
            regexp_replace(COALESCE(phone, ''), '[[:space:]()-]', '', 'g'),
            ''
        ) IS NOT NULL
        GROUP BY CASE
            WHEN regexp_replace(COALESCE(phone, ''), '[[:space:]()-]', '', 'g')
                ~ '^0[17][0-9]{8}$'
                THEN '+254' || substring(
                    regexp_replace(COALESCE(phone, ''), '[[:space:]()-]', '', 'g')
                    FROM 2
                )
            WHEN regexp_replace(COALESCE(phone, ''), '[[:space:]()-]', '', 'g')
                ~ '^[+]?254[17][0-9]{8}$'
                THEN '+' || regexp_replace(
                    regexp_replace(COALESCE(phone, ''), '[[:space:]()-]', '', 'g'),
                    '^[+]',
                    ''
                )
            ELSE NULLIF(
                regexp_replace(COALESCE(phone, ''), '[[:space:]()-]', '', 'g'),
                ''
            )
        END
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION
            'Cannot enforce normalized phone uniqueness: existing accounts contain duplicate phone numbers';
    END IF;
END;
$$;

-- Replace the earlier proposed index definition if this file is rerun after
-- review; the drop and recreation are atomic within this transaction.
DROP INDEX IF EXISTS uq_users_phone_normalized;
CREATE UNIQUE INDEX uq_users_phone_normalized
    ON users (
        CASE
            WHEN regexp_replace(COALESCE(phone, ''), '[[:space:]()-]', '', 'g')
                ~ '^0[17][0-9]{8}$'
                THEN '+254' || substring(
                    regexp_replace(COALESCE(phone, ''), '[[:space:]()-]', '', 'g')
                    FROM 2
                )
            WHEN regexp_replace(COALESCE(phone, ''), '[[:space:]()-]', '', 'g')
                ~ '^[+]?254[17][0-9]{8}$'
                THEN '+' || regexp_replace(
                    regexp_replace(COALESCE(phone, ''), '[[:space:]()-]', '', 'g'),
                    '^[+]',
                    ''
                )
            ELSE NULLIF(
                regexp_replace(COALESCE(phone, ''), '[[:space:]()-]', '', 'g'),
                ''
            )
        END
    );

CREATE TABLE IF NOT EXISTS phone_change_verifications (
    user_id VARCHAR(25) PRIMARY KEY
        REFERENCES users (user_id) ON DELETE CASCADE,
    pending_phone VARCHAR(15),
    code_hash BYTEA,
    code_salt BYTEA,
    expires_at TIMESTAMPTZ,
    send_count INTEGER NOT NULL DEFAULT 0
        CHECK (send_count BETWEEN 0 AND 3),
    window_started_at TIMESTAMPTZ,
    last_sent_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count BETWEEN 0 AND 5),
    attempt_window_started_at TIMESTAMPTZ,
    locked_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_phone_change_pending_phone_e164 CHECK (
        pending_phone IS NULL OR pending_phone ~ '^[+]254[17][0-9]{8}$'
    ),
    CONSTRAINT chk_phone_change_code_state CHECK (
        (
            pending_phone IS NULL
            AND code_hash IS NULL
            AND code_salt IS NULL
            AND expires_at IS NULL
        )
        OR
        (
            pending_phone IS NOT NULL
            AND code_hash IS NOT NULL
            AND code_salt IS NOT NULL
            AND octet_length(code_hash) = 32
            AND octet_length(code_salt) = 16
            AND expires_at IS NOT NULL
        )
    )
);

-- Ensure these constraints are also installed if the table was created by an
-- earlier draft of this proposed migration.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_phone_change_pending_phone_e164'
          AND conrelid = 'phone_change_verifications'::regclass
    ) THEN
        ALTER TABLE phone_change_verifications
            ADD CONSTRAINT chk_phone_change_pending_phone_e164 CHECK (
                pending_phone IS NULL OR pending_phone ~ '^[+]254[17][0-9]{8}$'
            );
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_phone_change_code_state'
          AND conrelid = 'phone_change_verifications'::regclass
    ) THEN
        ALTER TABLE phone_change_verifications
            ADD CONSTRAINT chk_phone_change_code_state CHECK (
                (
                    pending_phone IS NULL
                    AND code_hash IS NULL
                    AND code_salt IS NULL
                    AND expires_at IS NULL
                )
                OR
                (
                    pending_phone IS NOT NULL
                    AND code_hash IS NOT NULL
                    AND code_salt IS NOT NULL
                    AND octet_length(code_hash) = 32
                    AND octet_length(code_salt) = 16
                    AND expires_at IS NOT NULL
                )
            );
    END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_phone_change_pending_phone
    ON phone_change_verifications (pending_phone)
    WHERE pending_phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_phone_change_verifications_expiry
    ON phone_change_verifications (expires_at)
    WHERE pending_phone IS NOT NULL;

COMMIT;
