-- Add manager-owned compliance submissions and a durable regulator review history.
-- Existing report rows are preserved as legacy records; they remain readable
-- with a NULL fund_id/content and no fabricated submission history.
-- One-time migration: apply only to the pre-workflow schema described in
-- docs/design/database/database-design.md. Do not apply to schema.sql's
-- post-workflow schema or to a database where this migration already ran.
BEGIN;

DO $$
DECLARE
    required_column RECORD;
BEGIN
    IF to_regclass('compliance_reports') IS NULL
       OR to_regclass('users') IS NULL
       OR to_regclass('funds') IS NULL
       OR to_regclass('audit_logs') IS NULL THEN
        RAISE EXCEPTION
            'Incompatible schema: expected pre-workflow compliance_reports, users, funds, and audit_logs tables';
    END IF;

    FOR required_column IN
        SELECT * FROM (VALUES
            ('compliance_reports', 'report_id'),
            ('compliance_reports', 'generated_by'),
            ('compliance_reports', 'report_type'),
            ('compliance_reports', 'period_start'),
            ('compliance_reports', 'period_end'),
            ('compliance_reports', 'rba_status'),
            ('compliance_reports', 'generated_at'),
            ('compliance_reports', 'updated_at'),
            ('users', 'user_id'),
            ('users', 'role'),
            ('users', 'full_name'),
            ('users', 'account_status'),
            ('funds', 'fund_id'),
            ('funds', 'managed_by'),
            ('audit_logs', 'action_type')
        ) AS expected(table_name, column_name)
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = required_column.table_name
              AND column_name = required_column.column_name
        ) THEN
            RAISE EXCEPTION 'Incompatible schema: missing %.%',
                required_column.table_name, required_column.column_name;
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'compliance_reports'
          AND column_name = 'rba_status'
          AND (
              data_type IS DISTINCT FROM 'character varying'
              OR character_maximum_length IS DISTINCT FROM 15
          )
    ) THEN
        RAISE EXCEPTION
            'Incompatible schema: expected compliance_reports.rba_status VARCHAR(15) from the pre-workflow schema';
    END IF;

    IF to_regclass('compliance_report_submissions') IS NOT NULL
       OR to_regclass('compliance_report_reviews') IS NOT NULL THEN
        RAISE EXCEPTION
            'Compliance workflow tables already exist; do not rerun this one-time migration';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'compliance_reports'
          AND column_name IN ('fund_id', 'report_content', 'submitted_at',
                              'last_submitted_at', 'is_legacy')
    ) THEN
        RAISE EXCEPTION
            'Compliance workflow columns already exist; expected the pre-workflow schema';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = to_regclass('compliance_reports')
          AND tgname = 'trg_compliance_reports_enforce_generator_role'
          AND NOT tgisinternal
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('compliance_reports')
          AND conname = 'fk_compliance_reports_generated_by'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('compliance_reports')
          AND conname = 'chk_compliance_reports_period'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('compliance_reports')
          AND conname = 'compliance_reports_report_type_check'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('compliance_reports')
          AND conname = 'compliance_reports_rba_status_check'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('audit_logs')
          AND conname = 'audit_logs_action_type_check'
    ) THEN
        RAISE EXCEPTION
            'Incompatible pre-workflow schema: expected the established compliance generator trigger and named foreign-key/audit constraints';
    END IF;
END $$;

ALTER TABLE compliance_reports
    ALTER COLUMN generated_by DROP NOT NULL,
    ALTER COLUMN report_type DROP NOT NULL,
    ALTER COLUMN period_start DROP NOT NULL,
    ALTER COLUMN period_end DROP NOT NULL,
    ALTER COLUMN rba_status TYPE VARCHAR(25),
    ALTER COLUMN rba_status SET DEFAULT 'DRAFT',
    ADD COLUMN fund_id VARCHAR(25),
    ADD COLUMN report_content JSONB,
    ADD COLUMN submitted_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN last_submitted_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN is_legacy BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE compliance_reports
    ALTER COLUMN is_legacy SET DEFAULT FALSE;

ALTER TABLE compliance_reports
    DROP CONSTRAINT fk_compliance_reports_generated_by,
    ADD CONSTRAINT fk_compliance_reports_generated_by
        FOREIGN KEY (generated_by) REFERENCES users (user_id) ON DELETE SET NULL,
    ADD CONSTRAINT fk_compliance_reports_fund
        FOREIGN KEY (fund_id) REFERENCES funds (fund_id) ON DELETE RESTRICT;

ALTER TABLE compliance_reports
    DROP CONSTRAINT compliance_reports_report_type_check,
    DROP CONSTRAINT chk_compliance_reports_period,
    DROP CONSTRAINT compliance_reports_rba_status_check;

ALTER TABLE compliance_reports
    ADD CONSTRAINT chk_compliance_reports_report_type
        CHECK (report_type IS NULL OR report_type IN ('RBA', 'NSSF', 'INTERNAL')),
    ADD CONSTRAINT chk_compliance_reports_period
        CHECK (period_start IS NULL OR period_end IS NULL OR period_end >= period_start),
    ADD CONSTRAINT chk_compliance_reports_status
        CHECK (rba_status IN ('DRAFT', 'SUBMITTED', 'REVISION_REQUESTED', 'ACCEPTED', 'REJECTED'));

CREATE INDEX idx_compliance_reports_fund ON compliance_reports (fund_id);
CREATE INDEX idx_compliance_reports_submitted ON compliance_reports (rba_status, submitted_at DESC);

CREATE TABLE compliance_report_submissions (
    submission_id VARCHAR(25) PRIMARY KEY DEFAULT generate_short_id(),
    report_id VARCHAR(25) NOT NULL
        REFERENCES compliance_reports (report_id) ON DELETE RESTRICT,
    version INTEGER NOT NULL CHECK (version > 0),
    submitted_by VARCHAR(25) NOT NULL,
    submitted_by_name VARCHAR(100) NOT NULL,
    submitted_by_role VARCHAR(20) NOT NULL
        CHECK (submitted_by_role = 'FUND_MANAGER'),
    report_content JSONB NOT NULL,
    report_type VARCHAR(20) NOT NULL
        CHECK (report_type IN ('RBA', 'NSSF', 'INTERNAL')),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    submitted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT uq_compliance_report_submission_version UNIQUE (report_id, version),
    CONSTRAINT uq_compliance_report_submission_id_report UNIQUE (submission_id, report_id),
    CONSTRAINT chk_compliance_report_submission_period CHECK (period_end >= period_start)
);

CREATE INDEX idx_compliance_report_submissions_report
    ON compliance_report_submissions (report_id, version DESC);

CREATE TABLE compliance_report_reviews (
    review_id VARCHAR(25) PRIMARY KEY DEFAULT generate_short_id(),
    report_id VARCHAR(25) NOT NULL,
    submission_id VARCHAR(25) NOT NULL,
    reviewed_by VARCHAR(25) NOT NULL,
    reviewed_by_name VARCHAR(100) NOT NULL,
    reviewed_by_role VARCHAR(20) NOT NULL
        CHECK (reviewed_by_role = 'REGULATOR'),
    decision VARCHAR(25) NOT NULL
        CHECK (decision IN ('ACCEPTED', 'REJECTED', 'REVISION_REQUESTED')),
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT fk_compliance_report_reviews_submission_report
        FOREIGN KEY (submission_id, report_id)
        REFERENCES compliance_report_submissions (submission_id, report_id)
        ON DELETE RESTRICT,
    CONSTRAINT chk_compliance_report_review_reason
        CHECK (decision = 'ACCEPTED' OR (reason IS NOT NULL AND length(trim(reason)) >= 10))
);

CREATE INDEX idx_compliance_report_reviews_report
    ON compliance_report_reviews (report_id, created_at DESC);
CREATE INDEX idx_compliance_report_reviews_submission
    ON compliance_report_reviews (submission_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_compliance_history_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = format('%I history is append-only', TG_TABLE_NAME);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_compliance_report_submissions_immutable
    BEFORE UPDATE OR DELETE ON compliance_report_submissions
    FOR EACH ROW
    EXECUTE FUNCTION prevent_compliance_history_mutation();

CREATE TRIGGER trg_compliance_report_reviews_immutable
    BEFORE UPDATE OR DELETE ON compliance_report_reviews
    FOR EACH ROW
    EXECUTE FUNCTION prevent_compliance_history_mutation();

CREATE TRIGGER trg_compliance_report_submissions_no_truncate
    BEFORE TRUNCATE ON compliance_report_submissions
    FOR EACH STATEMENT
    EXECUTE FUNCTION prevent_compliance_history_mutation();

CREATE TRIGGER trg_compliance_report_reviews_no_truncate
    BEFORE TRUNCATE ON compliance_report_reviews
    FOR EACH STATEMENT
    EXECUTE FUNCTION prevent_compliance_history_mutation();

CREATE OR REPLACE FUNCTION enforce_compliance_report_fund_owner()
RETURNS TRIGGER AS $$
DECLARE
    fund_manager VARCHAR(25);
BEGIN
    IF TG_OP = 'INSERT'
       AND (
           NEW.rba_status IS DISTINCT FROM 'DRAFT'
           OR NEW.is_legacy IS DISTINCT FROM FALSE
           OR NEW.submitted_at IS NOT NULL
           OR NEW.last_submitted_at IS NOT NULL
       ) THEN
        RAISE EXCEPTION
            'new compliance reports must begin as non-legacy DRAFT records without submission timestamps';
    END IF;
    IF TG_OP = 'INSERT' AND (NEW.fund_id IS NULL OR NEW.generated_by IS NULL) THEN
        RAISE EXCEPTION 'new compliance reports require a fund and submitting fund manager';
    END IF;
    IF NEW.fund_id IS NULL OR NEW.generated_by IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT managed_by INTO fund_manager FROM funds WHERE fund_id = NEW.fund_id;
    IF fund_manager IS NULL OR fund_manager <> NEW.generated_by THEN
        RAISE EXCEPTION 'compliance report fund must be managed by its submitting fund manager';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_compliance_reports_fund_owner
    BEFORE INSERT OR UPDATE OF fund_id, generated_by ON compliance_reports
    FOR EACH ROW
    EXECUTE FUNCTION enforce_compliance_report_fund_owner();

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
    IF actor_role IS DISTINCT FROM 'FUND_MANAGER' OR actor_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'compliance report submissions must be made by a FUND_MANAGER';
    END IF;
    IF NEW.submitted_by_name IS DISTINCT FROM actor_name
       OR NEW.submitted_by_role IS DISTINCT FROM actor_role THEN
        RAISE EXCEPTION 'compliance report submission identity must match the database user';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_compliance_report_submissions_manager
    BEFORE INSERT OR UPDATE OF submitted_by, submitted_by_name, submitted_by_role
    ON compliance_report_submissions
    FOR EACH ROW
    EXECUTE FUNCTION enforce_compliance_report_submission_role();

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
    IF actor_role IS DISTINCT FROM 'REGULATOR' OR actor_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'compliance report reviews must be made by a REGULATOR';
    END IF;
    IF NEW.reviewed_by_name IS DISTINCT FROM actor_name
       OR NEW.reviewed_by_role IS DISTINCT FROM actor_role THEN
        RAISE EXCEPTION 'compliance report review identity must match the database user';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_compliance_report_reviews_regulator
    BEFORE INSERT OR UPDATE OF reviewed_by, reviewed_by_name, reviewed_by_role
    ON compliance_report_reviews
    FOR EACH ROW
    EXECUTE FUNCTION enforce_compliance_report_review_role();

ALTER TABLE audit_logs
    DROP CONSTRAINT audit_logs_action_type_check;
ALTER TABLE audit_logs
    ADD CONSTRAINT chk_audit_logs_action_type
        CHECK (action_type IN (
            'CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'APPROVE', 'REJECT',
            'SUBMIT', 'RESUBMIT', 'REQUEST_REVISION'
        ));

-- New compliance report records must be generated by fund managers only.
-- Existing report attribution is preserved; this validates new/changed values.
CREATE OR REPLACE FUNCTION enforce_compliance_report_generator_role()
RETURNS TRIGGER AS $$
DECLARE
    generator_role VARCHAR(20);
    generator_status VARCHAR(15);
BEGIN
    IF TG_OP = 'INSERT' AND NEW.generated_by IS NULL THEN
        RAISE EXCEPTION 'new compliance reports require a submitting fund manager';
    END IF;
    IF NEW.generated_by IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT role, account_status
    INTO generator_role, generator_status
    FROM users
    WHERE user_id = NEW.generated_by;
    IF generator_role IS DISTINCT FROM 'FUND_MANAGER'
       OR generator_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION
            'generated_by user % must be an active FUND_MANAGER (found role %, status %)',
            NEW.generated_by, generator_role, generator_status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER trg_compliance_reports_enforce_generator_role ON compliance_reports;
CREATE TRIGGER trg_compliance_reports_enforce_generator_role
    BEFORE INSERT OR UPDATE OF generated_by ON compliance_reports
    FOR EACH ROW
    EXECUTE FUNCTION enforce_compliance_report_generator_role();

COMMIT;
