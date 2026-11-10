BEGIN;

ALTER TABLE contributions
    ADD CONSTRAINT uq_contributions_id_account_transaction
    UNIQUE (contribution_id, account_id, transaction_id);

CREATE TABLE mpesa_payment_attempts (
    attempt_id                 VARCHAR(25) PRIMARY KEY DEFAULT generate_short_id(),
    account_id                 VARCHAR(25) NOT NULL,
    contribution_id            VARCHAR(25) NOT NULL,
    transaction_id             VARCHAR(25) NOT NULL,
    idempotency_key            VARCHAR(128) NOT NULL,
    expected_amount            NUMERIC(12,2) NOT NULL
        CHECK (expected_amount > 0 AND expected_amount = trunc(expected_amount)),
    mpesa_phone                VARCHAR(12) NOT NULL
        CHECK (mpesa_phone ~ '^254[17][0-9]{8}$'),
    attempt_status             VARCHAR(25) NOT NULL DEFAULT 'PENDING'
        CHECK (attempt_status IN (
            'PENDING',
            'PROMPT_ACCEPTED',
            'OUTCOME_UNKNOWN',
            'FAILED',
            'CANCELLED',
            'TIMED_OUT'
        )),
    checkout_request_id        VARCHAR(100),
    merchant_request_id        VARCHAR(100),
    provider_result_code       VARCHAR(30),
    provider_result_description VARCHAR(255),
    created_at                 TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    provider_accepted_at       TIMESTAMP WITH TIME ZONE,
    CONSTRAINT uq_mpesa_payment_attempts_idempotency_key UNIQUE (idempotency_key),
    CONSTRAINT uq_mpesa_payment_attempts_checkout_request_id UNIQUE (checkout_request_id),
    CONSTRAINT uq_mpesa_payment_attempts_merchant_request_id UNIQUE (merchant_request_id),
    CONSTRAINT fk_mpesa_payment_attempts_contribution
        FOREIGN KEY (contribution_id, account_id, transaction_id)
        REFERENCES contributions (contribution_id, account_id, transaction_id)
        ON DELETE CASCADE,
    CONSTRAINT chk_mpesa_payment_attempts_provider_code
        CHECK (provider_result_code IS NULL OR provider_result_code ~ '^-?[0-9]{1,30}$'),
    CONSTRAINT chk_mpesa_payment_attempts_accepted_timestamp
        CHECK (
            attempt_status <> 'PROMPT_ACCEPTED'
            OR (
                checkout_request_id IS NOT NULL
                AND merchant_request_id IS NOT NULL
                AND provider_accepted_at IS NOT NULL
            )
        )
);

CREATE INDEX idx_mpesa_payment_attempts_account_created
    ON mpesa_payment_attempts (account_id, created_at DESC);
CREATE INDEX idx_mpesa_payment_attempts_contribution_created
    ON mpesa_payment_attempts (contribution_id, created_at DESC);
CREATE INDEX idx_mpesa_payment_attempts_transaction
    ON mpesa_payment_attempts (transaction_id);
CREATE INDEX idx_mpesa_payment_attempts_status_created
    ON mpesa_payment_attempts (attempt_status, created_at);

CREATE TRIGGER trg_mpesa_payment_attempts_set_updated_at
    BEFORE UPDATE ON mpesa_payment_attempts
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

COMMIT;
