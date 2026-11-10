BEGIN;

ALTER TABLE kyc_records
    DROP CONSTRAINT IF EXISTS uq_kyc_records_national_id;

ALTER TABLE kyc_records
    ADD COLUMN IF NOT EXISTS duplicate_submission BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_kyc_records_verified_national_id
    ON kyc_records (national_id)
    WHERE kyc_status = 'VERIFIED';

CREATE INDEX IF NOT EXISTS idx_kyc_records_duplicate_pending
    ON kyc_records (created_at, kyc_id)
    WHERE duplicate_submission IS TRUE AND kyc_status = 'PENDING';

CREATE OR REPLACE FUNCTION flag_duplicate_kyc_national_id()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.national_id, 0));
    NEW.duplicate_submission := EXISTS (
        SELECT 1
        FROM kyc_records
        WHERE national_id = NEW.national_id
          AND kyc_id IS DISTINCT FROM NEW.kyc_id
    );
    IF NEW.duplicate_submission THEN
        UPDATE kyc_records
        SET duplicate_submission = TRUE
        WHERE national_id = NEW.national_id
          AND kyc_id IS DISTINCT FROM NEW.kyc_id
          AND duplicate_submission IS FALSE;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kyc_records_flag_duplicate_national_id ON kyc_records;
CREATE TRIGGER trg_kyc_records_flag_duplicate_national_id
    BEFORE INSERT OR UPDATE OF national_id, kyc_status ON kyc_records
    FOR EACH ROW
    EXECUTE FUNCTION flag_duplicate_kyc_national_id();

COMMIT;
