-- Allow permanent user deletion while preserving shared funds and regulatory
-- reports without retaining a link to the deleted manager/report generator.
-- Apply after the finalized schema migration. This migration does not delete
-- or rewrite existing rows.
BEGIN;

ALTER TABLE funds
    ALTER COLUMN managed_by DROP NOT NULL;
ALTER TABLE funds
    DROP CONSTRAINT IF EXISTS fk_funds_managed_by;
ALTER TABLE funds
    ADD CONSTRAINT fk_funds_managed_by
    FOREIGN KEY (managed_by) REFERENCES users (user_id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION enforce_fund_manager_role()
RETURNS TRIGGER AS $$
DECLARE
    manager_role VARCHAR(20);
BEGIN
    IF NEW.managed_by IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT role INTO manager_role FROM users WHERE user_id = NEW.managed_by;
    IF manager_role IS NULL THEN
        RAISE EXCEPTION 'managed_by user % does not exist', NEW.managed_by;
    END IF;
    IF manager_role <> 'FUND_MANAGER' THEN
        RAISE EXCEPTION 'managed_by user % must have role FUND_MANAGER, found %',
            NEW.managed_by, manager_role;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE compliance_reports
    ALTER COLUMN generated_by DROP NOT NULL;
ALTER TABLE compliance_reports
    DROP CONSTRAINT IF EXISTS fk_compliance_reports_generated_by;
ALTER TABLE compliance_reports
    ADD CONSTRAINT fk_compliance_reports_generated_by
    FOREIGN KEY (generated_by) REFERENCES users (user_id) ON DELETE SET NULL;

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

COMMIT;
