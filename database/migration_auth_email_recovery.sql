BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS pending_email VARCHAR(254),
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'users'::regclass
          AND conname = 'chk_users_auth_version_nonnegative'
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT chk_users_auth_version_nonnegative
            CHECK (auth_version >= 0);
    END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_pending_email_lower
    ON users (lower(pending_email))
    WHERE pending_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_tokens (
    auth_token_id BIGSERIAL PRIMARY KEY,
    user_id VARCHAR(25) NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    purpose VARCHAR(30) NOT NULL CHECK (purpose IN ('EMAIL_VERIFICATION', 'PASSWORD_RESET')),
    email_address VARCHAR(254) NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    consumed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_purpose_created
    ON auth_tokens (user_id, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
    scope VARCHAR(20) NOT NULL CHECK (scope IN ('IP', 'EMAIL', 'ACCOUNT')),
    action VARCHAR(30) NOT NULL,
    key_hash CHAR(64) NOT NULL,
    window_started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    request_count INTEGER NOT NULL CHECK (request_count > 0),
    PRIMARY KEY (scope, action, key_hash)
);

COMMIT;
