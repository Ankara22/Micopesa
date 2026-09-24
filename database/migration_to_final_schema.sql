-- =============================================================================
-- MicoPesa PostgreSQL Migration: Upgrade to Finalized 15-Table Schema
--
-- Purpose
--   Upgrades an EXISTING 14-table MicoPesa database (created from an earlier
--   revision of database/schema.sql) to the finalized 15-entity design
--   described in docs/design/database/database-design.md, WITHOUT dropping,
--   truncating, or deleting any existing table or row.
--
-- This script does NOT:
--   * DROP or TRUNCATE any existing table.
--   * DELETE any existing application data.
--   * Recreate any of the 14 pre-existing tables.
--
-- This script DOES (all guarded so it is safe to run on a database that may
-- already have some of these changes applied):
--   1. Create SYSTEM_SETTINGS if it does not already exist.
--   2. Add notifications.created_by if it does not already exist.
--   3. Ensure enforce_compliance_report_generator_role() and its trigger
--      exist on compliance_reports.
--   4. Ensure enforce_fund_manager_role() and its trigger exist on funds.
--   5. Ensure enforce_withdrawal_claim_reviewer_role() and its trigger exist
--      on withdrawal_claims.
--   6. Drop four redundant (duplicate-of-UNIQUE-constraint) indexes, if
--      present. The UNIQUE constraints themselves - and their automatically
--      created backing indexes - are left untouched.
--
-- Safety mechanism (data preservation)
--   Before creating/replacing any role-enforcement trigger, this script
--   checks existing rows in funds, withdrawal_claims, and compliance_reports
--   for role violations that the new trigger would reject going forward.
--   Triggers only validate future INSERT/UPDATE operations - they do NOT
--   retroactively re-validate rows that already exist. To avoid silently
--   leaving "grandfathered" bad data that would later behave inconsistently
--   (blocked on next UPDATE but not reported now), this script instead
--   ABORTS THE ENTIRE MIGRATION (via RAISE EXCEPTION inside the wrapping
--   transaction, so nothing is committed) if any conflicting row is found,
--   and reports exactly what must be fixed first. See the "PRE-FLIGHT
--   VALIDATION" section below.
--
-- Idempotency
--   Every statement in this script can be re-run safely: CREATE TABLE IF NOT
--   EXISTS, ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, DROP INDEX
--   IF EXISTS, CREATE OR REPLACE FUNCTION, and CREATE OR REPLACE TRIGGER
--   (PostgreSQL 14+) are used throughout. Re-running this script after a
--   successful run is a no-op.
--
-- Usage
--   psql -h <host> -p <port> -U <user> -d Micopesa -v ON_ERROR_STOP=1 \
--        -f database/migration_to_final_schema.sql
--
--   If a conflict is reported, resolve the offending rows (see the
--   diagnostic queries printed in the error message), then re-run this
--   script. Nothing is changed until every check passes and COMMIT is
--   reached.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Helper functions (idempotent; ensures they exist with the expected
--    definition regardless of which schema.sql revision created this
--    database).
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE OR REPLACE FUNCTION generate_short_id()
RETURNS VARCHAR(25) AS $$
BEGIN
    RETURN upper(substr(replace(uuid_generate_v4()::text, '-', ''), 1, 25));
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- 1. PRE-FLIGHT VALIDATION
--    Abort (no changes committed) if any existing row would violate the
--    role-enforcement triggers this migration is about to (re)create.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_bad_funds   INTEGER;
    v_bad_claims  INTEGER;
    v_bad_reports INTEGER;
BEGIN
    SELECT count(*) INTO v_bad_funds
    FROM funds f
    JOIN users u ON u.user_id = f.managed_by
    WHERE u.role <> 'FUND_MANAGER';

    SELECT count(*) INTO v_bad_claims
    FROM withdrawal_claims w
    JOIN users u ON u.user_id = w.reviewed_by
    WHERE w.reviewed_by IS NOT NULL AND u.role <> 'FUND_MANAGER';

    SELECT count(*) INTO v_bad_reports
    FROM compliance_reports c
    JOIN users u ON u.user_id = c.generated_by
    WHERE u.role NOT IN ('FUND_MANAGER', 'REGULATOR');

    IF v_bad_funds > 0 OR v_bad_claims > 0 OR v_bad_reports > 0 THEN
        RAISE EXCEPTION
            E'Migration aborted - no changes were made.\n'
            'Conflicting rows found: % in funds.managed_by, % in withdrawal_claims.reviewed_by, % in compliance_reports.generated_by.\n'
            'Resolve these rows (reassign to a user with the correct role, or set withdrawal_claims.reviewed_by to NULL) and re-run this script. Diagnostic queries:\n'
            '  SELECT f.fund_id, f.managed_by, u.role FROM funds f JOIN users u ON u.user_id = f.managed_by WHERE u.role <> ''FUND_MANAGER'';\n'
            '  SELECT w.claim_id, w.reviewed_by, u.role FROM withdrawal_claims w JOIN users u ON u.user_id = w.reviewed_by WHERE u.role <> ''FUND_MANAGER'';\n'
            '  SELECT c.report_id, c.generated_by, u.role FROM compliance_reports c JOIN users u ON u.user_id = c.generated_by WHERE u.role NOT IN (''FUND_MANAGER'', ''REGULATOR'');',
            v_bad_funds, v_bad_claims, v_bad_reports;
    END IF;

    RAISE NOTICE 'Pre-flight validation passed: no existing funds, withdrawal_claims, or compliance_reports rows conflict with the role-enforcement triggers.';
END $$;

-- -----------------------------------------------------------------------------
-- 2. SYSTEM_SETTINGS (new table; created only if it does not already exist)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_settings (
    setting_id      VARCHAR(25)  PRIMARY KEY DEFAULT generate_short_id(),
    setting_key     VARCHAR(100) NOT NULL,
    setting_value   VARCHAR(255) NOT NULL,
    description     VARCHAR(255),
    updated_by      VARCHAR(25),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_system_settings_setting_key UNIQUE (setting_key),
    CONSTRAINT fk_system_settings_updated_by FOREIGN KEY (updated_by)
        REFERENCES users (user_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_system_settings_updated_by ON system_settings (updated_by);

CREATE OR REPLACE TRIGGER trg_system_settings_set_updated_at
    BEFORE UPDATE ON system_settings
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. NOTIFICATIONS.created_by (new nullable column; existing rows keep NULL)
-- -----------------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS created_by VARCHAR(25);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_notifications_created_by'
    ) THEN
        ALTER TABLE notifications
            ADD CONSTRAINT fk_notifications_created_by FOREIGN KEY (created_by)
            REFERENCES users (user_id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notifications_created_by ON notifications (created_by);

-- -----------------------------------------------------------------------------
-- 4. COMPLIANCE_REPORTS role enforcement
--    Only FUND_MANAGER and REGULATOR may be assigned to generated_by.
--    WORKER and ADMIN are rejected.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_compliance_report_generator_role()
RETURNS TRIGGER AS $$
DECLARE
    generator_role VARCHAR(20);
BEGIN
    SELECT role INTO generator_role FROM users WHERE user_id = NEW.generated_by;

    IF generator_role IS NULL THEN
        RAISE EXCEPTION 'generated_by user % does not exist', NEW.generated_by;
    END IF;

    IF generator_role NOT IN ('FUND_MANAGER', 'REGULATOR') THEN
        RAISE EXCEPTION 'generated_by user % must have role FUND_MANAGER or REGULATOR, found %',
            NEW.generated_by, generator_role;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_compliance_reports_enforce_generator_role
    BEFORE INSERT OR UPDATE OF generated_by ON compliance_reports
    FOR EACH ROW
    EXECUTE FUNCTION enforce_compliance_report_generator_role();

-- -----------------------------------------------------------------------------
-- 5. FUNDS role enforcement
--    Only FUND_MANAGER may be assigned to managed_by.
--    WORKER, REGULATOR, and ADMIN are rejected.
--    (Ensures this exists; safe to re-apply if already present.)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_fund_manager_role()
RETURNS TRIGGER AS $$
DECLARE
    manager_role VARCHAR(20);
BEGIN
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

CREATE OR REPLACE TRIGGER trg_funds_enforce_manager_role
    BEFORE INSERT OR UPDATE OF managed_by ON funds
    FOR EACH ROW
    EXECUTE FUNCTION enforce_fund_manager_role();

-- -----------------------------------------------------------------------------
-- 6. WITHDRAWAL_CLAIMS role enforcement
--    Only FUND_MANAGER may be assigned to reviewed_by (NULL is allowed for
--    claims still pending review).
--    (Ensures this exists; safe to re-apply if already present.)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_withdrawal_claim_reviewer_role()
RETURNS TRIGGER AS $$
DECLARE
    reviewer_role VARCHAR(20);
BEGIN
    IF NEW.reviewed_by IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT role INTO reviewer_role FROM users WHERE user_id = NEW.reviewed_by;

    IF reviewer_role IS NULL THEN
        RAISE EXCEPTION 'reviewed_by user % does not exist', NEW.reviewed_by;
    END IF;

    IF reviewer_role <> 'FUND_MANAGER' THEN
        RAISE EXCEPTION 'reviewed_by user % must have role FUND_MANAGER, found %',
            NEW.reviewed_by, reviewer_role;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_withdrawal_claims_enforce_reviewer_role
    BEFORE INSERT OR UPDATE OF reviewed_by ON withdrawal_claims
    FOR EACH ROW
    EXECUTE FUNCTION enforce_withdrawal_claim_reviewer_role();

-- -----------------------------------------------------------------------------
-- 7. Redundant index cleanup
--    Each of these duplicates the automatic unique index that PostgreSQL
--    already maintains for the corresponding UNIQUE constraint. Dropping
--    them only removes the duplicate plain index; the UNIQUE constraint
--    (uq_kyc_records_user_id, uq_pension_accounts_user_id,
--    uq_contributions_transaction_id, uq_withdrawal_claims_transaction_id)
--    and its backing unique index are untouched, so uniqueness is still
--    fully enforced after this migration.
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_kyc_records_user_id;
DROP INDEX IF EXISTS idx_pension_accounts_user_id;
DROP INDEX IF EXISTS idx_contributions_transaction_id;
DROP INDEX IF EXISTS idx_withdrawal_claims_transaction_id;

-- -----------------------------------------------------------------------------
-- Done.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    RAISE NOTICE 'Migration to finalized 15-table schema completed successfully. No existing rows were modified or deleted.';
END $$;

COMMIT;
