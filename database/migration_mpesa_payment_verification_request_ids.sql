BEGIN;

ALTER TABLE public.mpesa_payment_verifications
    ADD COLUMN checkout_request_id VARCHAR(100),
    ADD COLUMN merchant_request_id VARCHAR(100);

COMMIT;
