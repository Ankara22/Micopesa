BEGIN;

CREATE TABLE mpesa_payment_verifications (
    verification_id             BIGSERIAL PRIMARY KEY,
    attempt_id                  VARCHAR(25) NOT NULL
        REFERENCES mpesa_payment_attempts (attempt_id) ON DELETE CASCADE,
    verification_source         VARCHAR(20) NOT NULL
        CHECK (verification_source IN ('CALLBACK', 'RECONCILIATION')),
    callback_fingerprint        CHAR(64) UNIQUE,
    callback_result_code        VARCHAR(30),
    callback_amount_matches     BOOLEAN,
    callback_phone_matches      BOOLEAN,
    callback_receipt            VARCHAR(25),
    provider_result_code        VARCHAR(30),
    provider_result_description VARCHAR(255),
    verification_status         VARCHAR(25) NOT NULL
        CHECK (verification_status IN (
            'PROCESSING',
            'UNVERIFIED',
            'INCONSISTENT',
            'VERIFIED_SUCCESS',
            'VERIFIED_FAILURE'
        )),
    created_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    completed_at                TIMESTAMP WITH TIME ZONE,
    CONSTRAINT chk_mpesa_verifications_callback_fingerprint
        CHECK (
            (verification_source = 'CALLBACK' AND callback_fingerprint IS NOT NULL)
            OR (verification_source = 'RECONCILIATION' AND callback_fingerprint IS NULL)
        ),
    CONSTRAINT chk_mpesa_verifications_callback_code
        CHECK (
            callback_result_code IS NULL
            OR callback_result_code ~ '^-?[0-9]{1,30}$'
        ),
    CONSTRAINT chk_mpesa_verifications_callback_code_required
        CHECK (
            verification_source <> 'CALLBACK'
            OR callback_result_code IS NOT NULL
        ),
    CONSTRAINT chk_mpesa_verifications_provider_code
        CHECK (
            provider_result_code IS NULL
            OR provider_result_code ~ '^-?[0-9]{1,30}$'
        ),
    CONSTRAINT chk_mpesa_verifications_callback_match_flags
        CHECK (
            verification_source <> 'RECONCILIATION'
            OR (callback_amount_matches IS NULL AND callback_phone_matches IS NULL)
        ),
    CONSTRAINT chk_mpesa_verifications_callback_success_metadata
        CHECK (
            verification_source <> 'CALLBACK'
            OR callback_result_code <> '0'
            OR (
                callback_amount_matches IS NOT NULL
                AND callback_phone_matches IS NOT NULL
                AND callback_receipt IS NOT NULL
            )
        ),
    CONSTRAINT chk_mpesa_verifications_callback_receipt
        CHECK (
            callback_receipt IS NULL
            OR callback_receipt ~ '^[A-Za-z0-9]{1,25}$'
        ),
    CONSTRAINT chk_mpesa_verifications_verified_success
        CHECK (
            verification_status <> 'VERIFIED_SUCCESS'
            OR (
                verification_source = 'CALLBACK'
                AND callback_result_code = '0'
                AND callback_amount_matches IS TRUE
                AND callback_phone_matches IS TRUE
                AND callback_receipt IS NOT NULL
                AND provider_result_code = '0'
            )
        ),
    CONSTRAINT chk_mpesa_verifications_verified_failure
        CHECK (
            verification_status <> 'VERIFIED_FAILURE'
            OR (
                provider_result_code IS NOT NULL
                AND provider_result_code <> '0'
            )
        ),
    CONSTRAINT chk_mpesa_verifications_completed_at
        CHECK (
            (verification_status = 'PROCESSING' AND completed_at IS NULL)
            OR (verification_status <> 'PROCESSING' AND completed_at IS NOT NULL)
        )
);

CREATE UNIQUE INDEX uq_mpesa_payment_verifications_processing_attempt
    ON mpesa_payment_verifications (attempt_id)
    WHERE verification_status = 'PROCESSING';
CREATE INDEX idx_mpesa_payment_verifications_attempt_created
    ON mpesa_payment_verifications (attempt_id, created_at DESC);

CREATE TRIGGER trg_mpesa_payment_verifications_set_updated_at
    BEFORE UPDATE ON mpesa_payment_verifications
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

COMMIT;
