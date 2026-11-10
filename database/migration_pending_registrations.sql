BEGIN;

CREATE TABLE IF NOT EXISTS pending_registrations (
    pending_registration_id VARCHAR(25) PRIMARY KEY DEFAULT generate_short_id(),
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(254) NOT NULL,
    phone VARCHAR(15) NOT NULL,
    password_hash VARCHAR(255),
    occupation VARCHAR(50) NOT NULL,
    national_id VARCHAR(25) NOT NULL,
    date_of_birth DATE NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_registrations_expiry
    ON pending_registrations (expires_at);

COMMIT;
