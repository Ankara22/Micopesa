BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM mpesa_payment_attempts
        WHERE attempt_status IN ('PENDING', 'OUTCOME_UNKNOWN', 'PROMPT_ACCEPTED')
        GROUP BY contribution_id
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'Cannot enable single-active-attempt protection: duplicate active attempts exist.';
    END IF;
END $$;

CREATE UNIQUE INDEX uq_mpesa_payment_attempts_one_active_per_contribution
    ON mpesa_payment_attempts (contribution_id)
    WHERE attempt_status IN ('PENDING', 'OUTCOME_UNKNOWN', 'PROMPT_ACCEPTED');

CREATE TABLE mpesa_callback_inbox (
    callback_id                 BIGSERIAL PRIMARY KEY,
    callback_fingerprint        CHAR(64) NOT NULL UNIQUE
        CHECK (callback_fingerprint ~ '^[a-f0-9]{64}$'),
    checkout_request_id         VARCHAR(100) NOT NULL
        CHECK (checkout_request_id ~ '^[A-Za-z0-9_-]{1,100}$'),
    merchant_request_id         VARCHAR(100) NOT NULL
        CHECK (merchant_request_id ~ '^[A-Za-z0-9_-]{1,100}$'),
    callback_result_code        VARCHAR(30) NOT NULL
        CHECK (callback_result_code ~ '^-?[0-9]{1,30}$'),
    callback_amount             NUMERIC(12,2),
    callback_phone              VARCHAR(12)
        CHECK (callback_phone IS NULL OR callback_phone ~ '^254[17][0-9]{8}$'),
    callback_receipt            VARCHAR(25)
        CHECK (callback_receipt IS NULL OR callback_receipt ~ '^[A-Za-z0-9]{1,25}$'),
    callback_status             VARCHAR(20) NOT NULL DEFAULT 'UNMATCHED'
        CHECK (callback_status IN ('UNMATCHED', 'CORRELATED', 'VERIFIED', 'REJECTED')),
    attempt_id                  VARCHAR(25)
        REFERENCES mpesa_payment_attempts (attempt_id) ON DELETE RESTRICT,
    verification_id             BIGINT
        REFERENCES mpesa_payment_verifications (verification_id) ON DELETE RESTRICT,
    rejection_code              VARCHAR(64),
    duplicate_count             INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
    received_at                 TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    correlated_at               TIMESTAMP WITH TIME ZONE,
    verified_at                 TIMESTAMP WITH TIME ZONE,
    updated_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT ck_mpesa_callback_success_metadata CHECK (
        callback_result_code <> '0'
        OR (
            callback_amount IS NOT NULL
            AND callback_amount > 0
            AND callback_amount = trunc(callback_amount)
            AND callback_phone IS NOT NULL
            AND callback_receipt IS NOT NULL
        )
    ),
    CONSTRAINT ck_mpesa_callback_lifecycle CHECK (
        (callback_status = 'UNMATCHED'
            AND attempt_id IS NULL
            AND verification_id IS NULL
            AND rejection_code IS NULL)
        OR (callback_status = 'CORRELATED'
            AND attempt_id IS NOT NULL
            AND verification_id IS NULL
            AND correlated_at IS NOT NULL
            AND rejection_code IS NULL)
        OR (callback_status = 'VERIFIED'
            AND attempt_id IS NOT NULL
            AND verification_id IS NOT NULL
            AND correlated_at IS NOT NULL
            AND verified_at IS NOT NULL
            AND rejection_code IS NULL)
        OR (callback_status = 'REJECTED'
            AND rejection_code IS NOT NULL)
    )
);

CREATE INDEX idx_mpesa_callback_inbox_status_received
    ON mpesa_callback_inbox (callback_status, received_at);
CREATE INDEX idx_mpesa_callback_inbox_provider_ids
    ON mpesa_callback_inbox (checkout_request_id, merchant_request_id);
CREATE INDEX idx_mpesa_callback_inbox_attempt
    ON mpesa_callback_inbox (attempt_id)
    WHERE attempt_id IS NOT NULL;

CREATE TRIGGER trg_mpesa_callback_inbox_set_updated_at
    BEFORE UPDATE ON mpesa_callback_inbox
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

COMMIT;
