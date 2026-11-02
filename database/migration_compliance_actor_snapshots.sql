-- Add immutable database-backed actor identity to an already-installed
-- compliance workflow. Existing history is preserved without fabricated names.
-- One-time follow-up for databases migrated with the earlier workflow migration.
BEGIN;

DO $$
DECLARE
    expected RECORD;
    existing_trigger RECORD;
    mutation_function REGPROCEDURE;
BEGIN
    IF to_regclass('compliance_report_submissions') IS NULL
       OR to_regclass('compliance_report_reviews') IS NULL
       OR to_regclass('users') IS NULL THEN
        RAISE EXCEPTION
            'Incompatible schema: expected an installed compliance workflow and users table';
    END IF;

    FOR expected IN
        SELECT * FROM (VALUES
            ('users', 'user_id'),
            ('users', 'full_name'),
            ('users', 'role'),
            ('users', 'account_status'),
            ('compliance_report_submissions', 'submitted_by'),
            ('compliance_report_reviews', 'reviewed_by')
        ) AS required(table_name, column_name)
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = expected.table_name
              AND column_name = expected.column_name
        ) THEN
            RAISE EXCEPTION 'Incompatible schema: missing %.%',
                expected.table_name, expected.column_name;
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (
              (table_name = 'compliance_report_submissions'
               AND column_name IN ('submitted_by_name', 'submitted_by_role'))
              OR
              (table_name = 'compliance_report_reviews'
               AND column_name IN ('reviewed_by_name', 'reviewed_by_role'))
          )
    ) THEN
        RAISE EXCEPTION
            'Actor snapshot columns already exist; do not rerun this one-time migration';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass('compliance_report_submissions')
          AND tgname = 'trg_compliance_report_submissions_manager'
          AND NOT tgisinternal
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass('compliance_report_reviews')
          AND tgname = 'trg_compliance_report_reviews_regulator'
          AND NOT tgisinternal
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass('compliance_report_submissions')
          AND tgname = 'trg_compliance_report_submissions_immutable'
          AND NOT tgisinternal
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass('compliance_report_reviews')
          AND tgname = 'trg_compliance_report_reviews_immutable'
          AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION
            'Incompatible workflow schema: expected existing role and append-only history triggers';
    END IF;

    mutation_function := to_regprocedure('prevent_compliance_history_mutation()');
    IF mutation_function IS NULL
       OR position('RAISE EXCEPTION' IN pg_get_functiondef(mutation_function)) = 0
       OR position('append-only' IN pg_get_functiondef(mutation_function)) = 0 THEN
        RAISE EXCEPTION
            'Incompatible workflow schema: expected prevent_compliance_history_mutation() to reject history changes';
    END IF;

    FOR expected IN
        SELECT * FROM (VALUES
            ('compliance_report_submissions', 'trg_compliance_report_submissions_no_truncate'),
            ('compliance_report_reviews', 'trg_compliance_report_reviews_no_truncate')
        ) AS required(table_name, trigger_name)
    LOOP
        SELECT tgtype, tgfoid
        INTO existing_trigger
        FROM pg_trigger
        WHERE tgrelid = to_regclass(expected.table_name)
          AND tgname = expected.trigger_name
          AND NOT tgisinternal;

        IF FOUND
           AND (
               existing_trigger.tgtype <> 34
               OR existing_trigger.tgfoid <> mutation_function::oid
           ) THEN
            RAISE EXCEPTION
                'Incompatible workflow schema: trigger % exists but is not the expected BEFORE TRUNCATE append-only protection',
                expected.trigger_name;
        END IF;
    END LOOP;
END $$;

ALTER TABLE compliance_report_submissions
    ADD COLUMN submitted_by_name VARCHAR(100),
    ADD COLUMN submitted_by_role VARCHAR(20),
    ADD CONSTRAINT chk_compliance_submission_actor_role
        CHECK (submitted_by_role IS NULL OR submitted_by_role = 'FUND_MANAGER');

ALTER TABLE compliance_report_reviews
    ADD COLUMN reviewed_by_name VARCHAR(100),
    ADD COLUMN reviewed_by_role VARCHAR(20),
    ADD CONSTRAINT chk_compliance_review_actor_role
        CHECK (reviewed_by_role IS NULL OR reviewed_by_role = 'REGULATOR');

CREATE OR REPLACE FUNCTION enforce_compliance_report_submission_role()
RETURNS TRIGGER AS $$
DECLARE
    actor_role VARCHAR(20);
    actor_name VARCHAR(100);
    actor_status VARCHAR(15);
BEGIN
    SELECT role, full_name, account_status
    INTO actor_role, actor_name, actor_status
    FROM users WHERE user_id = NEW.submitted_by;
    IF actor_role IS DISTINCT FROM 'FUND_MANAGER'
       OR actor_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'compliance report submissions must be made by an active FUND_MANAGER';
    END IF;
    IF NEW.submitted_by_name IS DISTINCT FROM actor_name
       OR NEW.submitted_by_role IS DISTINCT FROM actor_role THEN
        RAISE EXCEPTION 'compliance report submission identity must match the database user';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER trg_compliance_report_submissions_manager
    ON compliance_report_submissions;
CREATE TRIGGER trg_compliance_report_submissions_manager
    BEFORE INSERT OR UPDATE OF submitted_by, submitted_by_name, submitted_by_role
    ON compliance_report_submissions
    FOR EACH ROW
    EXECUTE FUNCTION enforce_compliance_report_submission_role();

DO $$
DECLARE
    mutation_function REGPROCEDURE := to_regprocedure('prevent_compliance_history_mutation()');
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass('compliance_report_submissions')
          AND tgtype = 34
          AND tgfoid = mutation_function::oid
          AND NOT tgisinternal
    ) THEN
        CREATE TRIGGER trg_compliance_report_submissions_no_truncate
            BEFORE TRUNCATE ON compliance_report_submissions
            FOR EACH STATEMENT
            EXECUTE FUNCTION prevent_compliance_history_mutation();
    END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_compliance_report_review_role()
RETURNS TRIGGER AS $$
DECLARE
    actor_role VARCHAR(20);
    actor_name VARCHAR(100);
    actor_status VARCHAR(15);
BEGIN
    SELECT role, full_name, account_status
    INTO actor_role, actor_name, actor_status
    FROM users WHERE user_id = NEW.reviewed_by;
    IF actor_role IS DISTINCT FROM 'REGULATOR'
       OR actor_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'compliance report reviews must be made by an active REGULATOR';
    END IF;
    IF NEW.reviewed_by_name IS DISTINCT FROM actor_name
       OR NEW.reviewed_by_role IS DISTINCT FROM actor_role THEN
        RAISE EXCEPTION 'compliance report review identity must match the database user';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER trg_compliance_report_reviews_regulator
    ON compliance_report_reviews;
CREATE TRIGGER trg_compliance_report_reviews_regulator
    BEFORE INSERT OR UPDATE OF reviewed_by, reviewed_by_name, reviewed_by_role
    ON compliance_report_reviews
    FOR EACH ROW
    EXECUTE FUNCTION enforce_compliance_report_review_role();

DO $$
DECLARE
    mutation_function REGPROCEDURE := to_regprocedure('prevent_compliance_history_mutation()');
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass('compliance_report_reviews')
          AND tgtype = 34
          AND tgfoid = mutation_function::oid
          AND NOT tgisinternal
    ) THEN
        CREATE TRIGGER trg_compliance_report_reviews_no_truncate
            BEFORE TRUNCATE ON compliance_report_reviews
            FOR EACH STATEMENT
            EXECUTE FUNCTION prevent_compliance_history_mutation();
    END IF;
END $$;

COMMIT;
