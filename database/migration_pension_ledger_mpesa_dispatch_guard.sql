BEGIN;

-- This lock key must match the repository transaction check.
CREATE OR REPLACE FUNCTION pension_ledger_block_close_with_unsettled_mpesa_attempts()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status = 'CLOSED' AND OLD.status IS DISTINCT FROM NEW.status THEN
        PERFORM pg_advisory_xact_lock(1296917328, 1280265540);

        IF EXISTS (
            SELECT 1
            FROM mpesa_payment_attempts a
            WHERE a.attempt_status IN ('PENDING', 'OUTCOME_UNKNOWN', 'PROMPT_ACCEPTED')
              AND NOT EXISTS (
                  SELECT 1
                  FROM pension_account_movements m
                  WHERE m.payment_attempt_id = a.attempt_id
                    AND m.movement_type = 'CONTRIBUTION_SETTLEMENT'
              )
        ) THEN
            RAISE EXCEPTION 'Cannot close the pension ledger while M-Pesa attempts remain unsettled'
                USING ERRCODE = '55000',
                      CONSTRAINT = 'chk_pension_ledger_no_unsettled_mpesa_attempts';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pension_ledger_block_unsettled_mpesa_attempts ON pension_ledger;
CREATE TRIGGER trg_pension_ledger_block_unsettled_mpesa_attempts
    BEFORE UPDATE OF status ON pension_ledger
    FOR EACH ROW
    EXECUTE FUNCTION pension_ledger_block_close_with_unsettled_mpesa_attempts();

CREATE OR REPLACE FUNCTION pension_ledger_require_active_for_new_mpesa_attempt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    ledger_status VARCHAR(15);
BEGIN
    PERFORM pg_advisory_xact_lock_shared(1296917328, 1280265540);

    SELECT status
    INTO ledger_status
    FROM pension_ledger
    WHERE singleton_key IS TRUE;

    IF NOT FOUND OR ledger_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'New M-Pesa attempts require an active pension ledger'
            USING ERRCODE = '55000',
                  CONSTRAINT = 'chk_mpesa_attempts_require_active_ledger';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mpesa_attempt_requires_active_ledger ON mpesa_payment_attempts;
CREATE TRIGGER trg_mpesa_attempt_requires_active_ledger
    BEFORE INSERT ON mpesa_payment_attempts
    FOR EACH ROW
    EXECUTE FUNCTION pension_ledger_require_active_for_new_mpesa_attempt();

COMMIT;
