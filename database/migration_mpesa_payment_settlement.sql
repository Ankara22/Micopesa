BEGIN;

ALTER TABLE mpesa_payment_verifications
    ADD COLUMN checkout_request_id VARCHAR(100),
    ADD COLUMN merchant_request_id VARCHAR(100);

UPDATE mpesa_payment_verifications v
SET checkout_request_id = a.checkout_request_id,
    merchant_request_id = a.merchant_request_id
FROM mpesa_payment_attempts a
WHERE a.attempt_id = v.attempt_id;

UPDATE mpesa_payment_verifications
SET verification_status = 'INCONSISTENT',
    completed_at = COALESCE(completed_at, now()),
    updated_at = now()
WHERE verification_status = 'VERIFIED_SUCCESS'
  AND (
      callback_receipt IS NULL
      OR callback_amount_matches IS NOT TRUE
      OR callback_phone_matches IS NOT TRUE
      OR provider_result_code IS DISTINCT FROM '0'
      OR checkout_request_id IS NULL
      OR merchant_request_id IS NULL
  );

ALTER TABLE mpesa_payment_verifications
    ADD CONSTRAINT chk_mpesa_verifications_checkout_id
        CHECK (
            checkout_request_id IS NULL
            OR checkout_request_id ~ '^[A-Za-z0-9_-]{1,100}$'
        ),
    ADD CONSTRAINT chk_mpesa_verifications_merchant_id
        CHECK (
            merchant_request_id IS NULL
            OR merchant_request_id ~ '^[A-Za-z0-9_-]{1,100}$'
        ),
    DROP CONSTRAINT chk_mpesa_verifications_callback_success_metadata,
    ADD CONSTRAINT chk_mpesa_verifications_callback_success_metadata
        CHECK (
            verification_source <> 'CALLBACK'
            OR callback_result_code <> '0'
            OR (
                callback_amount_matches IS NOT NULL
                AND callback_phone_matches IS NOT NULL
                AND callback_receipt IS NOT NULL
            )
        ),
    DROP CONSTRAINT chk_mpesa_verifications_verified_success,
    ADD CONSTRAINT chk_mpesa_verifications_verified_success
        CHECK (
            verification_status <> 'VERIFIED_SUCCESS'
            OR (
                verification_source = 'CALLBACK'
                AND callback_result_code = '0'
                AND callback_amount_matches IS TRUE
                AND callback_phone_matches IS TRUE
                AND callback_receipt IS NOT NULL
                AND checkout_request_id IS NOT NULL
                AND merchant_request_id IS NOT NULL
                AND provider_result_code = '0'
            )
        );

CREATE INDEX idx_mpesa_payment_verifications_provider_ids
    ON mpesa_payment_verifications (checkout_request_id, merchant_request_id);

COMMIT;
