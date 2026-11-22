BEGIN;

LOCK TABLE
    public.kyc_records,
    public.pending_registrations,
    public.worker_national_id_verification_evidence,
    public.worker_national_id_claims
IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.kyc_records
        WHERE national_id_ciphertext IS NULL
           OR national_id_iv IS NULL
           OR octet_length(national_id_iv) <> 12
           OR national_id_tag IS NULL
           OR octet_length(national_id_tag) <> 16
           OR national_id_key_version IS NULL
           OR national_id_key_version <> 'v1'
           OR national_id_fingerprint IS NULL
           OR national_id_fingerprint !~ '^[0-9a-f]{64}$'
           OR national_id_last_four IS NULL
           OR national_id_last_four !~ '^[0-9]{4}$'
    ) THEN
        RAISE EXCEPTION 'National ID backfill incomplete for kyc_records; plaintext was not redacted';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.pending_registrations
        WHERE national_id_ciphertext IS NULL
           OR national_id_iv IS NULL
           OR octet_length(national_id_iv) <> 12
           OR national_id_tag IS NULL
           OR octet_length(national_id_tag) <> 16
           OR national_id_key_version IS NULL
           OR national_id_key_version <> 'v1'
           OR national_id_fingerprint IS NULL
           OR national_id_fingerprint !~ '^[0-9a-f]{64}$'
           OR national_id_last_four IS NULL
           OR national_id_last_four !~ '^[0-9]{4}$'
    ) THEN
        RAISE EXCEPTION 'National ID backfill incomplete for pending_registrations; plaintext was not redacted';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.kyc_records records
        LEFT JOIN public.worker_national_id_verification_evidence evidence
          ON evidence.source_table = 'kyc_records'
         AND evidence.source_record_id = records.kyc_id
         AND evidence.national_id_fingerprint = records.national_id_fingerprint
         AND evidence.national_id_ciphertext = records.national_id_ciphertext
         AND evidence.national_id_iv = records.national_id_iv
         AND evidence.national_id_tag = records.national_id_tag
         AND evidence.national_id_key_version = records.national_id_key_version
         AND evidence.national_id_last_four = records.national_id_last_four
         AND evidence.verified_plaintext_fingerprint = records.national_id_fingerprint
         AND evidence.plaintext_matched IS TRUE
         AND evidence.verified_by = 'micopesa_national_id_verifier'
        WHERE evidence.source_record_id IS NULL
    ) THEN
        RAISE EXCEPTION 'National ID cryptographic verification evidence is missing or mismatched for kyc_records; plaintext was not redacted';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.pending_registrations records
        LEFT JOIN public.worker_national_id_verification_evidence evidence
          ON evidence.source_table = 'pending_registrations'
         AND evidence.source_record_id = records.pending_registration_id
         AND evidence.national_id_fingerprint = records.national_id_fingerprint
         AND evidence.national_id_ciphertext = records.national_id_ciphertext
         AND evidence.national_id_iv = records.national_id_iv
         AND evidence.national_id_tag = records.national_id_tag
         AND evidence.national_id_key_version = records.national_id_key_version
         AND evidence.national_id_last_four = records.national_id_last_four
         AND evidence.verified_plaintext_fingerprint = records.national_id_fingerprint
         AND evidence.plaintext_matched IS TRUE
         AND evidence.verified_by = 'micopesa_national_id_verifier'
        WHERE evidence.source_record_id IS NULL
    ) THEN
        RAISE EXCEPTION 'National ID cryptographic verification evidence is missing or mismatched for pending_registrations; plaintext was not redacted';
    END IF;

    IF EXISTS (
        WITH source_identities AS (
            SELECT national_id_fingerprint, user_id,
                   NULL::varchar AS pending_registration_id,
                   NULL::timestamptz AS expires_at
            FROM public.kyc_records
            UNION ALL
            SELECT national_id_fingerprint, NULL::varchar,
                   pending_registration_id, expires_at
            FROM public.pending_registrations
        ),
        expected_claims AS (
            SELECT national_id_fingerprint,
                   count(*) AS source_count,
                   max(user_id) AS user_id,
                   max(pending_registration_id) AS pending_registration_id
            FROM source_identities
            GROUP BY national_id_fingerprint
        )
        SELECT 1
        FROM expected_claims expected
        LEFT JOIN public.worker_national_id_claims claims
          ON claims.national_id_fingerprint = expected.national_id_fingerprint
        WHERE claims.national_id_fingerprint IS NULL
           OR expected.source_count > 1
           OR (expected.source_count = 1 AND expected.user_id IS NOT NULL
               AND (claims.claim_status <> 'CLAIMED'
                    OR claims.user_id IS DISTINCT FROM expected.user_id))
           OR (expected.source_count = 1 AND expected.pending_registration_id IS NOT NULL
               AND (claims.claim_status <> 'RESERVED'
                    OR claims.pending_registration_id IS DISTINCT FROM expected.pending_registration_id))
    ) THEN
        RAISE EXCEPTION 'National ID claims are incomplete or inconsistent; plaintext was not redacted';
    END IF;
END;
$$;

DROP INDEX IF EXISTS public.uq_kyc_records_verified_national_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_kyc_records_verified_national_id_fingerprint
    ON public.kyc_records (national_id_fingerprint)
    WHERE kyc_status = 'VERIFIED';

CREATE OR REPLACE FUNCTION public.flag_duplicate_kyc_national_id()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.national_id_fingerprint IS NULL THEN
        RAISE EXCEPTION 'National ID fingerprint is required for KYC records';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(NEW.national_id_fingerprint, 0)
    );
    NEW.duplicate_submission := EXISTS (
        SELECT 1
        FROM public.kyc_records
        WHERE national_id_fingerprint = NEW.national_id_fingerprint
          AND kyc_id IS DISTINCT FROM NEW.kyc_id
    );
    IF NEW.duplicate_submission THEN
        UPDATE public.kyc_records
        SET duplicate_submission = TRUE
        WHERE national_id_fingerprint = NEW.national_id_fingerprint
          AND kyc_id IS DISTINCT FROM NEW.kyc_id
          AND duplicate_submission IS FALSE;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kyc_records_flag_duplicate_national_id
    ON public.kyc_records;
CREATE TRIGGER trg_kyc_records_flag_duplicate_national_id
    BEFORE INSERT OR UPDATE OF national_id_fingerprint, kyc_status
    ON public.kyc_records
    FOR EACH ROW
    EXECUTE FUNCTION public.flag_duplicate_kyc_national_id();

UPDATE public.kyc_records
SET national_id = 'ENCRYPTED'
WHERE national_id <> 'ENCRYPTED';
UPDATE public.pending_registrations
SET national_id = 'ENCRYPTED'
WHERE national_id <> 'ENCRYPTED';

ALTER TABLE public.kyc_records
    ALTER COLUMN national_id_ciphertext SET NOT NULL,
    ALTER COLUMN national_id_iv SET NOT NULL,
    ALTER COLUMN national_id_tag SET NOT NULL,
    ALTER COLUMN national_id_key_version SET NOT NULL,
    ALTER COLUMN national_id_key_version SET DEFAULT 'v1',
    ALTER COLUMN national_id_fingerprint SET NOT NULL,
    ALTER COLUMN national_id_last_four SET NOT NULL,
    ALTER COLUMN national_id SET DEFAULT 'ENCRYPTED';
ALTER TABLE public.kyc_records
    ADD CONSTRAINT ck_kyc_records_national_id_redacted
        CHECK (national_id = 'ENCRYPTED'),
    ADD CONSTRAINT ck_kyc_records_national_id_ciphertext
        CHECK (octet_length(national_id_iv) = 12 AND octet_length(national_id_tag) = 16),
    ADD CONSTRAINT ck_kyc_records_national_id_key_version
        CHECK (national_id_key_version = 'v1'),
    ADD CONSTRAINT ck_kyc_records_national_id_fingerprint
        CHECK (national_id_fingerprint ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT ck_kyc_records_national_id_last_four
        CHECK (national_id_last_four ~ '^[0-9]{4}$');

ALTER TABLE public.pending_registrations
    ALTER COLUMN national_id_ciphertext SET NOT NULL,
    ALTER COLUMN national_id_iv SET NOT NULL,
    ALTER COLUMN national_id_tag SET NOT NULL,
    ALTER COLUMN national_id_key_version SET NOT NULL,
    ALTER COLUMN national_id_key_version SET DEFAULT 'v1',
    ALTER COLUMN national_id_fingerprint SET NOT NULL,
    ALTER COLUMN national_id_last_four SET NOT NULL,
    ALTER COLUMN national_id SET DEFAULT 'ENCRYPTED';
ALTER TABLE public.pending_registrations
    ADD CONSTRAINT ck_pending_registrations_national_id_redacted
        CHECK (national_id = 'ENCRYPTED'),
    ADD CONSTRAINT ck_pending_registrations_national_id_ciphertext
        CHECK (octet_length(national_id_iv) = 12 AND octet_length(national_id_tag) = 16),
    ADD CONSTRAINT ck_pending_registrations_national_id_key_version
        CHECK (national_id_key_version = 'v1'),
    ADD CONSTRAINT ck_pending_registrations_national_id_fingerprint
        CHECK (national_id_fingerprint ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT ck_pending_registrations_national_id_last_four
        CHECK (national_id_last_four ~ '^[0-9]{4}$');

COMMIT;
