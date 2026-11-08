BEGIN;

ALTER TABLE public.mpesa_payment_verifications
    DROP CONSTRAINT chk_mpesa_verifications_verified_success,
    ADD CONSTRAINT chk_mpesa_verifications_verified_success
        CHECK (
            verification_status <> 'VERIFIED_SUCCESS'
            OR provider_result_code = '0'
            AND (
                (
                    verification_source = 'CALLBACK'
                    AND callback_result_code = '0'
                    AND callback_amount_matches IS TRUE
                    AND callback_phone_matches IS TRUE
                    AND callback_receipt IS NOT NULL
                )
                OR (
                    verification_source = 'RECONCILIATION'
                    AND callback_result_code IS NULL
                    AND callback_amount_matches IS NULL
                    AND callback_phone_matches IS NULL
                    AND callback_receipt IS NULL
                )
            )
        );

COMMIT;
