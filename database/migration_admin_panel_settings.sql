-- Add secure staff onboarding and validated operational admin settings.
-- Existing accounts retain normal password behavior and have no lockouts.
BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_temp_password BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP WITH TIME ZONE;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_users_failed_login_attempts_nonnegative'
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT chk_users_failed_login_attempts_nonnegative
            CHECK (failed_login_attempts >= 0);
    END IF;
END;
$$;

ALTER TABLE audit_logs
    ADD COLUMN IF NOT EXISTS details JSONB;

INSERT INTO system_settings (setting_key, setting_value, description) VALUES
    ('assumed_yearly_growth', '8', 'Annual growth assumption used by retirement projections (percent).'),
    ('max_failed_login_attempts', '5', 'Failed login attempts before a temporary account lockout.'),
    ('account_lockout_duration_minutes', '15', 'Duration of a temporary account lockout (minutes).'),
    ('require_otp_on_withdrawal', 'true', 'Require OTP verification before future payout dispatch. M-Pesa payout dispatch is currently disabled.')
ON CONFLICT (setting_key) DO NOTHING;

COMMIT;
