-- =============================================================================
-- MicoPesa PostgreSQL Schema
--
--
-- Notes on reconciliation between the design docs and this DDL:
--   * The design spec types every primary/foreign key as VARCHAR(25). To keep
--     that width while still guaranteeing globally unique identifiers, this
--     script enables the "uuid-ossp" extension and derives 25-character
--     identifiers from uuid_generate_v4() via generate_short_id().
--   * "DATE" columns that represent point-in-time events (created_at,
--     verified_at, requested_at, etc.) are implemented as
--     TIMESTAMP WITH TIME ZONE for accurate, timezone-safe auditing. Columns
--     that represent a calendar date only (date_of_birth, effective_from/to,
--     period_start/end) remain DATE.
--   * "REAL" monetary columns (balances, contribution/withdrawal amounts,
--     targets) are implemented as NUMERIC(12,2). "REAL" rate/percentage
--     columns (expected_return, percentage) are implemented as NUMERIC(6,2)
--     / NUMERIC(5,2) to avoid floating-point drift.
--   * `updated_at` columns and their maintenance trigger are additions not
--     present in the design doc, added to satisfy row-modification auditing.
--     AUDIT_LOGS is treated as an append-only table and intentionally has no
--     `updated_at` column or trigger.
--   * The WITHDRAWAL_CLAIMS design rule "the user referenced by reviewed_by
--     must be authorized with the FUND_MANAGER role" is enforced with a
--     dedicated trigger (enforce_withdrawal_claim_reviewer_role), in addition
--     to the standard foreign key.
--   * The FUNDS design rule "only FUND_MANAGER users can be assigned as
--     funds.managed_by" is enforced with a dedicated trigger
--     (enforce_fund_manager_role), in addition to the standard foreign key.
--     WORKER, REGULATOR, and ADMIN users are rejected.
--   * The COMPLIANCE_REPORTS design rule "only FUND_MANAGER and REGULATOR
--     users can generate compliance reports" is enforced with a dedicated
--     trigger (enforce_compliance_report_generator_role), in addition to
--     the standard foreign key. WORKER and ADMIN users are rejected.
--   * This script implements the finalized design in full: all 15 entities
--     (including SYSTEM_SETTINGS), NOTIFICATIONS.created_by, and all three
--     role-enforcement triggers are present and in agreement with
--     docs/design/database/database-design.md and the diagrams.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- -----------------------------------------------------------------------------
-- Drop existing objects (reverse dependency order)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS system_settings CASCADE;
DROP TABLE IF EXISTS compliance_reports CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS ussd_sessions CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS fund_allocations CASCADE;
DROP TABLE IF EXISTS withdrawal_claims CASCADE;
DROP TABLE IF EXISTS contributions CASCADE;
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS retirement_projections CASCADE;
DROP TABLE IF EXISTS retirement_plans CASCADE;
DROP TABLE IF EXISTS funds CASCADE;
DROP TABLE IF EXISTS pension_accounts CASCADE;
DROP TABLE IF EXISTS kyc_records CASCADE;
DROP TABLE IF EXISTS users CASCADE;

DROP FUNCTION IF EXISTS enforce_withdrawal_claim_reviewer_role() CASCADE;
DROP FUNCTION IF EXISTS enforce_fund_manager_role() CASCADE;
DROP FUNCTION IF EXISTS enforce_compliance_report_generator_role() CASCADE;
DROP FUNCTION IF EXISTS set_updated_at() CASCADE;
DROP FUNCTION IF EXISTS generate_short_id() CASCADE;

-- -----------------------------------------------------------------------------
-- Helper functions
-- -----------------------------------------------------------------------------

-- Generates a 25-character, uppercase, hex-based identifier derived from a
-- UUIDv4. Keeps primary/foreign keys at the VARCHAR(25) width specified by
-- the design docs while remaining effectively globally unique.
CREATE OR REPLACE FUNCTION generate_short_id()
RETURNS VARCHAR(25) AS $$
BEGIN
    RETURN upper(substr(replace(uuid_generate_v4()::text, '-', ''), 1, 25));
END;
$$ LANGUAGE plpgsql;

-- Generic trigger function that stamps updated_at with the current timestamp
-- on every row modification.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- USERS
-- -----------------------------------------------------------------------------
CREATE TABLE users (
    user_id         VARCHAR(25)  PRIMARY KEY DEFAULT generate_short_id(),
    full_name       VARCHAR(100) NOT NULL,
    phone           VARCHAR(15)  NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    role            VARCHAR(20)  NOT NULL
        CHECK (role IN ('WORKER', 'FUND_MANAGER', 'REGULATOR', 'ADMIN')),
    occupation      VARCHAR(50),
    account_status  VARCHAR(15)  NOT NULL DEFAULT 'ACTIVE'
        CHECK (account_status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT uq_users_phone UNIQUE (phone)
);

CREATE INDEX idx_users_role ON users (role);
CREATE INDEX idx_users_account_status ON users (account_status);

CREATE TRIGGER trg_users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- KYC_RECORDS  (1:1 with USERS)
-- -----------------------------------------------------------------------------
CREATE TABLE kyc_records (
    kyc_id          VARCHAR(25) PRIMARY KEY DEFAULT generate_short_id(),
    user_id         VARCHAR(25) NOT NULL,
    national_id     VARCHAR(25) NOT NULL,
    date_of_birth   DATE        NOT NULL,
    kyc_status      VARCHAR(15) NOT NULL DEFAULT 'PENDING'
        CHECK (kyc_status IN ('PENDING', 'VERIFIED', 'REJECTED')),
    verified_at     TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT uq_kyc_records_user_id UNIQUE (user_id),
    CONSTRAINT uq_kyc_records_national_id UNIQUE (national_id),
    CONSTRAINT fk_kyc_records_user FOREIGN KEY (user_id)
        REFERENCES users (user_id) ON DELETE CASCADE
);

CREATE INDEX idx_kyc_records_kyc_status ON kyc_records (kyc_status);

CREATE TRIGGER trg_kyc_records_set_updated_at
    BEFORE UPDATE ON kyc_records
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- PENSION_ACCOUNTS  (1:1 with USERS)
-- -----------------------------------------------------------------------------
CREATE TABLE pension_accounts (
    account_id      VARCHAR(25)  PRIMARY KEY DEFAULT generate_short_id(),
    user_id         VARCHAR(25)  NOT NULL,
    current_balance NUMERIC(12,2) NOT NULL DEFAULT 0.00
        CHECK (current_balance >= 0),
    retirement_age  INTEGER      NOT NULL CHECK (retirement_age > 0),
    account_status  VARCHAR(15)  NOT NULL DEFAULT 'ACTIVE'
        CHECK (account_status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED', 'CLOSED')),
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT uq_pension_accounts_user_id UNIQUE (user_id),
    CONSTRAINT fk_pension_accounts_user FOREIGN KEY (user_id)
        REFERENCES users (user_id) ON DELETE CASCADE
);

CREATE INDEX idx_pension_accounts_account_status ON pension_accounts (account_status);

CREATE TRIGGER trg_pension_accounts_set_updated_at
    BEFORE UPDATE ON pension_accounts
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- FUNDS
-- -----------------------------------------------------------------------------
CREATE TABLE funds (
    fund_id             VARCHAR(25)  PRIMARY KEY DEFAULT generate_short_id(),
    managed_by          VARCHAR(25)  NOT NULL,
    fund_name           VARCHAR(50)  NOT NULL,
    administrator_name  VARCHAR(50)  NOT NULL,
    risk_level          VARCHAR(15)  NOT NULL
        CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
    expected_return     NUMERIC(6,2) NOT NULL,
    fund_status         VARCHAR(15)  NOT NULL DEFAULT 'ACTIVE'
        CHECK (fund_status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT fk_funds_managed_by FOREIGN KEY (managed_by)
        REFERENCES users (user_id) ON DELETE RESTRICT
);

CREATE INDEX idx_funds_managed_by ON funds (managed_by);
CREATE INDEX idx_funds_fund_status ON funds (fund_status);

CREATE TRIGGER trg_funds_set_updated_at
    BEFORE UPDATE ON funds
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Enforces the design rule: "Only FUND_MANAGER users can be assigned as
-- funds.managed_by." WORKER, REGULATOR, and ADMIN users must be rejected.
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

CREATE TRIGGER trg_funds_enforce_manager_role
    BEFORE INSERT OR UPDATE OF managed_by ON funds
    FOR EACH ROW
    EXECUTE FUNCTION enforce_fund_manager_role();

-- -----------------------------------------------------------------------------
-- RETIREMENT_PLANS
-- -----------------------------------------------------------------------------
CREATE TABLE retirement_plans (
    plan_id                 VARCHAR(25)  PRIMARY KEY DEFAULT generate_short_id(),
    account_id              VARCHAR(25)  NOT NULL,
    target_amount           NUMERIC(12,2) NOT NULL CHECK (target_amount > 0),
    target_age              INTEGER      NOT NULL CHECK (target_age > 0),
    expected_return         NUMERIC(6,2),
    contribution_frequency  VARCHAR(20)  NOT NULL
        CHECK (contribution_frequency IN ('DAILY', 'WEEKLY', 'MONTHLY')),
    plan_status             VARCHAR(15)  NOT NULL DEFAULT 'ACTIVE'
        CHECK (plan_status IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),
    created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT fk_retirement_plans_account FOREIGN KEY (account_id)
        REFERENCES pension_accounts (account_id) ON DELETE CASCADE
);

CREATE INDEX idx_retirement_plans_account_id ON retirement_plans (account_id);
CREATE INDEX idx_retirement_plans_plan_status ON retirement_plans (plan_status);

CREATE TRIGGER trg_retirement_plans_set_updated_at
    BEFORE UPDATE ON retirement_plans
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- RETIREMENT_PROJECTIONS
-- -----------------------------------------------------------------------------
CREATE TABLE retirement_projections (
    projection_id         VARCHAR(25)  PRIMARY KEY DEFAULT generate_short_id(),
    plan_id               VARCHAR(25)  NOT NULL,
    assumed_contribution  NUMERIC(12,2) NOT NULL CHECK (assumed_contribution >= 0),
    assumed_return        NUMERIC(6,2)  NOT NULL,
    projected_amount      NUMERIC(12,2) NOT NULL CHECK (projected_amount >= 0),
    projection_years      INTEGER      NOT NULL CHECK (projection_years > 0),
    projected_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT fk_retirement_projections_plan FOREIGN KEY (plan_id)
        REFERENCES retirement_plans (plan_id) ON DELETE CASCADE
);

CREATE INDEX idx_retirement_projections_plan_id ON retirement_projections (plan_id);

CREATE TRIGGER trg_retirement_projections_set_updated_at
    BEFORE UPDATE ON retirement_projections
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- TRANSACTIONS
-- -----------------------------------------------------------------------------
CREATE TABLE transactions (
    transaction_id        VARCHAR(25)  PRIMARY KEY DEFAULT generate_short_id(),
    transaction_type      VARCHAR(20)  NOT NULL
        CHECK (transaction_type IN ('CONTRIBUTION', 'WITHDRAWAL')),
    amount                NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    mpesa_receipt         VARCHAR(25),
    checkout_request_id   VARCHAR(25),
    transaction_status    VARCHAR(15)  NOT NULL DEFAULT 'PENDING'
        CHECK (transaction_status IN ('PENDING', 'COMPLETED', 'FAILED', 'REVERSED')),
    initiated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    completed_at          TIMESTAMP WITH TIME ZONE,
    updated_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT uq_transactions_mpesa_receipt UNIQUE (mpesa_receipt),
    CONSTRAINT uq_transactions_checkout_request_id UNIQUE (checkout_request_id),
    CONSTRAINT chk_transactions_completed_at CHECK (
        completed_at IS NULL OR completed_at >= initiated_at
    )
);

CREATE INDEX idx_transactions_transaction_status ON transactions (transaction_status);
CREATE INDEX idx_transactions_transaction_type ON transactions (transaction_type);

CREATE TRIGGER trg_transactions_set_updated_at
    BEFORE UPDATE ON transactions
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- CONTRIBUTIONS
-- -----------------------------------------------------------------------------
CREATE TABLE contributions (
    contribution_id       VARCHAR(25)  PRIMARY KEY DEFAULT generate_short_id(),
    account_id            VARCHAR(25)  NOT NULL,
    transaction_id        VARCHAR(25)  NOT NULL,
    amount                NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    channel               VARCHAR(20)  NOT NULL
        CHECK (channel IN ('MPESA', 'BANK', 'USSD')),
    contribution_status   VARCHAR(15)  NOT NULL DEFAULT 'PENDING'
        CHECK (contribution_status IN ('PENDING', 'COMPLETED', 'FAILED')),
    created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT uq_contributions_transaction_id UNIQUE (transaction_id),
    CONSTRAINT fk_contributions_account FOREIGN KEY (account_id)
        REFERENCES pension_accounts (account_id) ON DELETE CASCADE,
    CONSTRAINT fk_contributions_transaction FOREIGN KEY (transaction_id)
        REFERENCES transactions (transaction_id) ON DELETE RESTRICT
);

CREATE INDEX idx_contributions_account_id ON contributions (account_id);
CREATE INDEX idx_contributions_contribution_status ON contributions (contribution_status);

CREATE TRIGGER trg_contributions_set_updated_at
    BEFORE UPDATE ON contributions
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- WITHDRAWAL_CLAIMS
--   PENSION_ACCOUNTS 1 --- 0..* WITHDRAWAL_CLAIMS : submits
--   USERS            0..1 --- 0..* WITHDRAWAL_CLAIMS : reviews (reviewed_by)
--   TRANSACTIONS     1 --- 0..1 WITHDRAWAL_CLAIMS : settles
-- -----------------------------------------------------------------------------
CREATE TABLE withdrawal_claims (
    claim_id            VARCHAR(25)  PRIMARY KEY DEFAULT generate_short_id(),
    account_id          VARCHAR(25)  NOT NULL,
    reviewed_by         VARCHAR(25),
    transaction_id      VARCHAR(25),
    amount_requested    NUMERIC(12,2) NOT NULL CHECK (amount_requested > 0),
    destination_phone   VARCHAR(15)  NOT NULL,
    claim_status        VARCHAR(15)  NOT NULL DEFAULT 'PENDING'
        CHECK (claim_status IN ('PENDING', 'APPROVED', 'REJECTED', 'PAID')),
    requested_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    reviewed_at         TIMESTAMP WITH TIME ZONE,
    processed_at        TIMESTAMP WITH TIME ZONE,
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT uq_withdrawal_claims_transaction_id UNIQUE (transaction_id),
    CONSTRAINT fk_withdrawal_claims_account FOREIGN KEY (account_id)
        REFERENCES pension_accounts (account_id) ON DELETE CASCADE,
    -- Claim can be pending review, so the reviewer is optional; if the
    -- reviewing user is removed, keep the claim but clear the reviewer.
    CONSTRAINT fk_withdrawal_claims_reviewed_by FOREIGN KEY (reviewed_by)
        REFERENCES users (user_id) ON DELETE SET NULL,
    -- A claim only gains a settlement transaction once it is approved and
    -- paid out; if that transaction is removed, clear the link rather than
    -- deleting the claim record.
    CONSTRAINT fk_withdrawal_claims_transaction FOREIGN KEY (transaction_id)
        REFERENCES transactions (transaction_id) ON DELETE SET NULL
);

CREATE INDEX idx_withdrawal_claims_account_id ON withdrawal_claims (account_id);
CREATE INDEX idx_withdrawal_claims_reviewed_by ON withdrawal_claims (reviewed_by);
CREATE INDEX idx_withdrawal_claims_claim_status ON withdrawal_claims (claim_status);

CREATE TRIGGER trg_withdrawal_claims_set_updated_at
    BEFORE UPDATE ON withdrawal_claims
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Enforces the design rule: "The user referenced by reviewed_by must be
-- authorized with the FUND_MANAGER role."
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

CREATE TRIGGER trg_withdrawal_claims_enforce_reviewer_role
    BEFORE INSERT OR UPDATE OF reviewed_by ON withdrawal_claims
    FOR EACH ROW
    EXECUTE FUNCTION enforce_withdrawal_claim_reviewer_role();

-- -----------------------------------------------------------------------------
-- FUND_ALLOCATIONS
-- -----------------------------------------------------------------------------
CREATE TABLE fund_allocations (
    allocation_id   VARCHAR(25)  PRIMARY KEY DEFAULT generate_short_id(),
    account_id      VARCHAR(25)  NOT NULL,
    fund_id         VARCHAR(25)  NOT NULL,
    percentage      NUMERIC(5,2) NOT NULL CHECK (percentage > 0 AND percentage <= 100),
    effective_from  DATE         NOT NULL DEFAULT CURRENT_DATE,
    effective_to    DATE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT fk_fund_allocations_account FOREIGN KEY (account_id)
        REFERENCES pension_accounts (account_id) ON DELETE CASCADE,
    CONSTRAINT fk_fund_allocations_fund FOREIGN KEY (fund_id)
        REFERENCES funds (fund_id) ON DELETE RESTRICT,
    CONSTRAINT chk_fund_allocations_effective_range CHECK (
        effective_to IS NULL OR effective_to >= effective_from
    )
);

CREATE INDEX idx_fund_allocations_account_id ON fund_allocations (account_id);
CREATE INDEX idx_fund_allocations_fund_id ON fund_allocations (fund_id);

CREATE TRIGGER trg_fund_allocations_set_updated_at
    BEFORE UPDATE ON fund_allocations
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- NOTIFICATIONS
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
    notification_id     VARCHAR(25)  PRIMARY KEY DEFAULT generate_short_id(),
    user_id             VARCHAR(25)  NOT NULL,
    created_by          VARCHAR(25),
    notification_type   VARCHAR(20)  NOT NULL
        CHECK (notification_type IN ('SMS', 'EMAIL', 'PUSH', 'USSD')),
    message             VARCHAR(255) NOT NULL,
    delivery_status     VARCHAR(15)  NOT NULL DEFAULT 'PENDING'
        CHECK (delivery_status IN ('PENDING', 'SENT', 'FAILED')),
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    sent_at             TIMESTAMP WITH TIME ZONE,
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT fk_notifications_user FOREIGN KEY (user_id)
        REFERENCES users (user_id) ON DELETE CASCADE,
    -- created_by traces administrative/broadcast notifications back to the
    -- issuing user (typically ADMIN); NULL for system-generated
    -- notifications with no human originator. Kept nullable so the
    -- originator can be removed without deleting the notification.
    CONSTRAINT fk_notifications_created_by FOREIGN KEY (created_by)
        REFERENCES users (user_id) ON DELETE SET NULL
);

CREATE INDEX idx_notifications_user_id ON notifications (user_id);
CREATE INDEX idx_notifications_created_by ON notifications (created_by);
CREATE INDEX idx_notifications_delivery_status ON notifications (delivery_status);

CREATE TRIGGER trg_notifications_set_updated_at
    BEFORE UPDATE ON notifications
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- USSD_SESSIONS
-- -----------------------------------------------------------------------------
CREATE TABLE ussd_sessions (
    session_id      VARCHAR(25)  PRIMARY KEY DEFAULT generate_short_id(),
    user_id         VARCHAR(25)  NOT NULL,
    phone           VARCHAR(15)  NOT NULL,
    session_status  VARCHAR(15)  NOT NULL DEFAULT 'ACTIVE'
        CHECK (session_status IN ('ACTIVE', 'COMPLETED', 'EXPIRED')),
    started_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    ended_at        TIMESTAMP WITH TIME ZONE,
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT fk_ussd_sessions_user FOREIGN KEY (user_id)
        REFERENCES users (user_id) ON DELETE CASCADE
);

CREATE INDEX idx_ussd_sessions_user_id ON ussd_sessions (user_id);
CREATE INDEX idx_ussd_sessions_session_status ON ussd_sessions (session_status);

CREATE TRIGGER trg_ussd_sessions_set_updated_at
    BEFORE UPDATE ON ussd_sessions
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- AUDIT_LOGS  (append-only: no updated_at / update trigger by design)
-- -----------------------------------------------------------------------------
CREATE TABLE audit_logs (
    log_id        VARCHAR(25)  PRIMARY KEY DEFAULT generate_short_id(),
    user_id       VARCHAR(25),
    action_type   VARCHAR(20)  NOT NULL
        CHECK (action_type IN ('CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'APPROVE', 'REJECT')),
    entity_name   VARCHAR(50)  NOT NULL,
    entity_id     VARCHAR(25)  NOT NULL,
    "timestamp"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    -- Audit history must outlive the acting user, so the actor reference is
    -- cleared rather than cascading a delete into the audit trail.
    CONSTRAINT fk_audit_logs_user FOREIGN KEY (user_id)
        REFERENCES users (user_id) ON DELETE SET NULL
);

CREATE INDEX idx_audit_logs_user_id ON audit_logs (user_id);
CREATE INDEX idx_audit_logs_action_type ON audit_logs (action_type);
CREATE INDEX idx_audit_logs_entity ON audit_logs (entity_name, entity_id);

-- -----------------------------------------------------------------------------
-- COMPLIANCE_REPORTS
-- -----------------------------------------------------------------------------
CREATE TABLE compliance_reports (
    report_id       VARCHAR(25) PRIMARY KEY DEFAULT generate_short_id(),
    generated_by    VARCHAR(25) NOT NULL,
    report_type     VARCHAR(20) NOT NULL
        CHECK (report_type IN ('RBA', 'NSSF', 'INTERNAL')),
    period_start    DATE        NOT NULL,
    period_end      DATE        NOT NULL,
    rba_status      VARCHAR(15) NOT NULL DEFAULT 'SUBMITTED'
        CHECK (rba_status IN ('DRAFT', 'SUBMITTED', 'ACCEPTED', 'REJECTED')),
    generated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT fk_compliance_reports_generated_by FOREIGN KEY (generated_by)
        REFERENCES users (user_id) ON DELETE RESTRICT,
    CONSTRAINT chk_compliance_reports_period CHECK (period_end >= period_start)
);

CREATE INDEX idx_compliance_reports_generated_by ON compliance_reports (generated_by);
CREATE INDEX idx_compliance_reports_rba_status ON compliance_reports (rba_status);

CREATE TRIGGER trg_compliance_reports_set_updated_at
    BEFORE UPDATE ON compliance_reports
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Enforces the design rule: "Only FUND_MANAGER and REGULATOR users can
-- generate compliance reports." WORKER and ADMIN users must be rejected.
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

CREATE TRIGGER trg_compliance_reports_enforce_generator_role
    BEFORE INSERT OR UPDATE OF generated_by ON compliance_reports
    FOR EACH ROW
    EXECUTE FUNCTION enforce_compliance_report_generator_role();

-- -----------------------------------------------------------------------------
-- SYSTEM_SETTINGS
--   USERS 0..1 --- 0..* SYSTEM_SETTINGS : updates (typically ADMIN)
-- -----------------------------------------------------------------------------
CREATE TABLE system_settings (
    setting_id      VARCHAR(25)  PRIMARY KEY DEFAULT generate_short_id(),
    setting_key     VARCHAR(100) NOT NULL,
    setting_value   VARCHAR(255) NOT NULL,
    description     VARCHAR(255),
    updated_by      VARCHAR(25),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_system_settings_setting_key UNIQUE (setting_key),
    -- A setting is never lost if the administrator who last touched it is
    -- later removed; the attribution is simply cleared.
    CONSTRAINT fk_system_settings_updated_by FOREIGN KEY (updated_by)
        REFERENCES users (user_id) ON DELETE SET NULL
);

CREATE INDEX idx_system_settings_updated_by ON system_settings (updated_by);

CREATE TRIGGER trg_system_settings_set_updated_at
    BEFORE UPDATE ON system_settings
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
