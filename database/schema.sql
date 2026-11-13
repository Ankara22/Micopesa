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
--     non-null funds.managed_by" is enforced with a dedicated trigger
--     (enforce_fund_manager_role), in addition to the standard foreign key.
--     WORKER, REGULATOR, and ADMIN users are rejected.
--   * Only active FUND_MANAGER users can generate compliance reports;
--     REGULATOR users independently review submitted versions in the review tables.
--   * This script implements the finalized design in full, including the
--     compliance submission/review history tables and role-enforcement triggers,
--     in agreement with
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
DROP TABLE IF EXISTS report_download_events CASCADE;
DROP TABLE IF EXISTS report_generation_history CASCADE;
DROP TABLE IF EXISTS notification_audit_events CASCADE;
DROP TABLE IF EXISTS notification_preferences CASCADE;
DROP TABLE IF EXISTS regulator_fund_assignments CASCADE;
DROP TABLE IF EXISTS compliance_reports CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS ussd_sessions CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS contribution_fund_allocations CASCADE;
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
    phone_verified_at TIMESTAMP WITH TIME ZONE,
    email           VARCHAR(254),
    pending_email   VARCHAR(254),
    email_verified  BOOLEAN      NOT NULL DEFAULT FALSE,
    password_hash   VARCHAR(255) NOT NULL,
    is_temp_password BOOLEAN    NOT NULL DEFAULT FALSE,
    force_password_change BOOLEAN NOT NULL DEFAULT FALSE,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0
        CONSTRAINT chk_users_failed_login_attempts_nonnegative CHECK (failed_login_attempts >= 0),
    locked_until    TIMESTAMP WITH TIME ZONE,
    auth_version    INTEGER      NOT NULL DEFAULT 0
        CONSTRAINT chk_users_auth_version_nonnegative CHECK (auth_version >= 0),
    login_method    VARCHAR(10)  NOT NULL DEFAULT 'PHONE'
        CONSTRAINT chk_users_login_method CHECK (login_method IN ('EMAIL', 'PHONE')),
    profile_photo_ref VARCHAR(64),
    role            VARCHAR(20)  NOT NULL
        CHECK (role IN ('WORKER', 'FUND_MANAGER', 'REGULATOR', 'ADMIN')),
    occupation      VARCHAR(50),
    account_status  VARCHAR(15)  NOT NULL DEFAULT 'ACTIVE'
        CHECK (account_status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT uq_users_phone UNIQUE (phone)
);

CREATE UNIQUE INDEX uq_users_email_lower
    ON users (lower(email))
    WHERE email IS NOT NULL;

CREATE UNIQUE INDEX uq_users_pending_email_lower
    ON users (lower(pending_email))
    WHERE pending_email IS NOT NULL;

CREATE UNIQUE INDEX uq_users_phone_normalized
    ON users ((
        CASE
            WHEN regexp_replace(COALESCE(phone, ''), '[[:space:]()-]', '', 'g')
                ~ '^0[17][0-9]{8}$'
                THEN '+254' || substring(
                    regexp_replace(COALESCE(phone, ''), '[[:space:]()-]', '', 'g')
                    FROM 2
                )
            WHEN regexp_replace(COALESCE(phone, ''), '[[:space:]()-]', '', 'g')
                ~ '^[+]?254[17][0-9]{8}$'
                THEN '+' || regexp_replace(
                    regexp_replace(COALESCE(phone, ''), '[[:space:]()-]', '', 'g'),
                    '^[+]',
                    ''
                )
            ELSE NULLIF(
                regexp_replace(COALESCE(phone, ''), '[[:space:]()-]', '', 'g'),
                ''
            )
        END
    ));

CREATE INDEX idx_users_role ON users (role);
CREATE INDEX idx_users_account_status ON users (account_status);

CREATE TRIGGER trg_users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE TABLE phone_change_verifications (
    user_id VARCHAR(25) PRIMARY KEY
        REFERENCES users (user_id) ON DELETE CASCADE,
    pending_phone VARCHAR(15),
    code_hash BYTEA,
    code_salt BYTEA,
    expires_at TIMESTAMP WITH TIME ZONE,
    send_count INTEGER NOT NULL DEFAULT 0
        CHECK (send_count BETWEEN 0 AND 3),
    window_started_at TIMESTAMP WITH TIME ZONE,
    last_sent_at TIMESTAMP WITH TIME ZONE,
    attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count BETWEEN 0 AND 5),
    attempt_window_started_at TIMESTAMP WITH TIME ZONE,
    locked_until TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT chk_phone_change_pending_phone_e164 CHECK (
        pending_phone IS NULL OR pending_phone ~ '^[+]254[17][0-9]{8}$'
    ),
    CONSTRAINT chk_phone_change_code_state CHECK (
        (pending_phone IS NULL AND code_hash IS NULL AND code_salt IS NULL AND expires_at IS NULL)
        OR
        (pending_phone IS NOT NULL AND code_hash IS NOT NULL AND code_salt IS NOT NULL
            AND octet_length(code_hash) = 32 AND octet_length(code_salt) = 16
            AND expires_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX uq_phone_change_pending_phone
    ON phone_change_verifications (pending_phone)
    WHERE pending_phone IS NOT NULL;

CREATE INDEX idx_phone_change_verifications_expiry
    ON phone_change_verifications (expires_at)
    WHERE pending_phone IS NOT NULL;

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
    duplicate_submission BOOLEAN NOT NULL DEFAULT FALSE,
    verified_at     TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT uq_kyc_records_user_id UNIQUE (user_id),
    CONSTRAINT fk_kyc_records_user FOREIGN KEY (user_id)
        REFERENCES users (user_id) ON DELETE CASCADE
);

CREATE INDEX idx_kyc_records_kyc_status ON kyc_records (kyc_status);
CREATE UNIQUE INDEX uq_kyc_records_verified_national_id
    ON kyc_records (national_id)
    WHERE kyc_status = 'VERIFIED';
CREATE INDEX idx_kyc_records_duplicate_pending
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

CREATE TRIGGER trg_kyc_records_flag_duplicate_national_id
    BEFORE INSERT OR UPDATE OF national_id, kyc_status ON kyc_records
    FOR EACH ROW
    EXECUTE FUNCTION flag_duplicate_kyc_national_id();

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
    managed_by          VARCHAR(25),
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
        REFERENCES users (user_id) ON DELETE SET NULL
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
    current_age           INTEGER CHECK (current_age IS NULL OR current_age BETWEEN 1 AND 100),
    starting_balance      NUMERIC(12,2) CHECK (starting_balance IS NULL OR starting_balance >= 0),
    yearly_projection     JSONB CHECK (
        yearly_projection IS NULL OR jsonb_typeof(yearly_projection) = 'array'
    ),
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
    checkout_request_id   VARCHAR(100),
    mpesa_phone           VARCHAR(12),
    mpesa_result_code     INTEGER,
    mpesa_result_description VARCHAR(255),
    transaction_status    VARCHAR(15)  NOT NULL DEFAULT 'PENDING'
        CHECK (transaction_status IN (
            'PENDING', 'COMPLETED', 'FAILED', 'REVERSED', 'CANCELLED', 'TIMED_OUT'
        )),
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
        CHECK (contribution_status IN (
            'PENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'
        )),
    created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT uq_contributions_transaction_id UNIQUE (transaction_id),
    CONSTRAINT uq_contributions_id_account UNIQUE (contribution_id, account_id),
    CONSTRAINT uq_contributions_id_account_transaction
        UNIQUE (contribution_id, account_id, transaction_id),
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
-- MPESA_PAYMENT_ATTEMPTS
--   PAYMENT_ATTEMPTS N --- 1 CONTRIBUTIONS : retries without duplicate contributions
-- -----------------------------------------------------------------------------
CREATE TABLE mpesa_payment_attempts (
    attempt_id                  VARCHAR(25) PRIMARY KEY DEFAULT generate_short_id(),
    account_id                  VARCHAR(25) NOT NULL,
    contribution_id             VARCHAR(25) NOT NULL,
    transaction_id              VARCHAR(25) NOT NULL,
    idempotency_key             VARCHAR(128) NOT NULL,
    expected_amount             NUMERIC(12,2) NOT NULL
        CHECK (expected_amount > 0 AND expected_amount = trunc(expected_amount)),
    mpesa_phone                 VARCHAR(12) NOT NULL
        CHECK (mpesa_phone ~ '^254[17][0-9]{8}$'),
    attempt_status              VARCHAR(25) NOT NULL DEFAULT 'PENDING'
        CHECK (attempt_status IN (
            'PENDING',
            'PROMPT_ACCEPTED',
            'OUTCOME_UNKNOWN',
            'FAILED',
            'CANCELLED',
            'TIMED_OUT'
        )),
    checkout_request_id         VARCHAR(100),
    merchant_request_id         VARCHAR(100),
    provider_result_code        VARCHAR(30),
    provider_result_description VARCHAR(255),
    created_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    provider_accepted_at        TIMESTAMP WITH TIME ZONE,
    CONSTRAINT uq_mpesa_payment_attempts_idempotency_key UNIQUE (idempotency_key),
    CONSTRAINT uq_mpesa_payment_attempts_checkout_request_id UNIQUE (checkout_request_id),
    CONSTRAINT uq_mpesa_payment_attempts_merchant_request_id UNIQUE (merchant_request_id),
    CONSTRAINT fk_mpesa_payment_attempts_contribution
        FOREIGN KEY (contribution_id, account_id, transaction_id)
        REFERENCES contributions (contribution_id, account_id, transaction_id)
        ON DELETE CASCADE,
    CONSTRAINT chk_mpesa_payment_attempts_provider_code
        CHECK (provider_result_code IS NULL OR provider_result_code ~ '^-?[0-9]{1,30}$'),
    CONSTRAINT chk_mpesa_payment_attempts_accepted_timestamp
        CHECK (
            attempt_status <> 'PROMPT_ACCEPTED'
            OR (
                checkout_request_id IS NOT NULL
                AND merchant_request_id IS NOT NULL
                AND provider_accepted_at IS NOT NULL
            )
        )
);

CREATE INDEX idx_mpesa_payment_attempts_account_created
    ON mpesa_payment_attempts (account_id, created_at DESC);
CREATE INDEX idx_mpesa_payment_attempts_contribution_created
    ON mpesa_payment_attempts (contribution_id, created_at DESC);
CREATE INDEX idx_mpesa_payment_attempts_transaction
    ON mpesa_payment_attempts (transaction_id);
CREATE INDEX idx_mpesa_payment_attempts_status_created
    ON mpesa_payment_attempts (attempt_status, created_at);
CREATE UNIQUE INDEX uq_mpesa_payment_attempts_one_active_per_contribution
    ON mpesa_payment_attempts (contribution_id)
    WHERE attempt_status IN ('PENDING', 'OUTCOME_UNKNOWN', 'PROMPT_ACCEPTED');

CREATE TRIGGER trg_mpesa_payment_attempts_set_updated_at
    BEFORE UPDATE ON mpesa_payment_attempts
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- -------------------------------------------------------------------------
-- MPESA_PAYMENT_VERIFICATIONS
--   Append-only provider verification evidence; never settles a payment.
-- -------------------------------------------------------------------------
CREATE TABLE mpesa_payment_verifications (
    verification_id             BIGSERIAL PRIMARY KEY,
    attempt_id                  VARCHAR(25) NOT NULL
        REFERENCES mpesa_payment_attempts (attempt_id) ON DELETE CASCADE,
    verification_source         VARCHAR(20) NOT NULL
        CHECK (verification_source IN ('CALLBACK', 'RECONCILIATION')),
    callback_fingerprint        CHAR(64) UNIQUE,
    callback_result_code        VARCHAR(30),
    callback_amount_matches     BOOLEAN,
    callback_phone_matches      BOOLEAN,
    callback_receipt            VARCHAR(25),
    provider_result_code        VARCHAR(30),
    provider_result_description VARCHAR(255),
    verification_status         VARCHAR(25) NOT NULL
        CHECK (verification_status IN (
            'PROCESSING',
            'UNVERIFIED',
            'INCONSISTENT',
            'VERIFIED_SUCCESS',
            'VERIFIED_FAILURE'
        )),
    created_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    completed_at                TIMESTAMP WITH TIME ZONE,
    checkout_request_id         VARCHAR(100),
    merchant_request_id         VARCHAR(100),
    CONSTRAINT chk_mpesa_verifications_callback_fingerprint
        CHECK (
            (verification_source = 'CALLBACK' AND callback_fingerprint IS NOT NULL)
            OR (verification_source = 'RECONCILIATION' AND callback_fingerprint IS NULL)
        ),
    CONSTRAINT chk_mpesa_verifications_callback_code
        CHECK (
            callback_result_code IS NULL
            OR callback_result_code ~ '^-?[0-9]{1,30}$'
        ),
    CONSTRAINT chk_mpesa_verifications_callback_code_required
        CHECK (
            verification_source <> 'CALLBACK'
            OR callback_result_code IS NOT NULL
        ),
    CONSTRAINT chk_mpesa_verifications_checkout_id
        CHECK (
            checkout_request_id IS NULL
            OR checkout_request_id ~ '^[A-Za-z0-9_-]{1,100}$'
        ),
    CONSTRAINT chk_mpesa_verifications_merchant_id
        CHECK (
            merchant_request_id IS NULL
            OR merchant_request_id ~ '^[A-Za-z0-9_-]{1,100}$'
        ),
    CONSTRAINT chk_mpesa_verifications_provider_code
        CHECK (
            provider_result_code IS NULL
            OR provider_result_code ~ '^-?[0-9]{1,30}$'
        ),
    CONSTRAINT chk_mpesa_verifications_callback_match_flags
        CHECK (
            verification_source <> 'RECONCILIATION'
            OR (callback_amount_matches IS NULL AND callback_phone_matches IS NULL)
        ),
    CONSTRAINT chk_mpesa_verifications_callback_success_metadata
        CHECK (
            verification_source <> 'CALLBACK'
            OR callback_result_code <> '0'
            OR (
                callback_amount_matches IS NOT NULL
                AND callback_phone_matches IS NOT NULL
                AND callback_receipt IS NOT NULL
            )
        ),
    CONSTRAINT chk_mpesa_verifications_callback_receipt
        CHECK (
            callback_receipt IS NULL
            OR callback_receipt ~ '^[A-Za-z0-9]{1,25}$'
        ),
    CONSTRAINT chk_mpesa_verifications_verified_success
        CHECK (
            verification_status <> 'VERIFIED_SUCCESS'
            OR (
                checkout_request_id IS NOT NULL
                AND merchant_request_id IS NOT NULL
                AND provider_result_code = '0'
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
            )
        ),
    CONSTRAINT chk_mpesa_verifications_verified_failure
        CHECK (
            verification_status <> 'VERIFIED_FAILURE'
            OR (
                provider_result_code IS NOT NULL
                AND provider_result_code <> '0'
            )
        ),
    CONSTRAINT chk_mpesa_verifications_completed_at
        CHECK (
            (verification_status = 'PROCESSING' AND completed_at IS NULL)
            OR (verification_status <> 'PROCESSING' AND completed_at IS NOT NULL)
        )
);

CREATE UNIQUE INDEX uq_mpesa_payment_verifications_processing_attempt
    ON mpesa_payment_verifications (attempt_id)
    WHERE verification_status = 'PROCESSING';
CREATE INDEX idx_mpesa_payment_verifications_attempt_created
    ON mpesa_payment_verifications (attempt_id, created_at DESC);
CREATE INDEX idx_mpesa_payment_verifications_provider_ids
    ON mpesa_payment_verifications (checkout_request_id, merchant_request_id);

CREATE TRIGGER trg_mpesa_payment_verifications_set_updated_at
    BEFORE UPDATE ON mpesa_payment_verifications
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- -------------------------------------------------------------------------
-- MPESA_CALLBACK_INBOX
--   Durable receipt for provider callbacks, including callbacks arriving
--   before their payment attempt identifiers have been persisted.
-- -------------------------------------------------------------------------
CREATE TABLE mpesa_callback_inbox (
    callback_id                 BIGSERIAL PRIMARY KEY,
    callback_fingerprint        CHAR(64) NOT NULL UNIQUE
        CHECK (callback_fingerprint ~ '^[a-f0-9]{64}$'),
    checkout_request_id         VARCHAR(100) NOT NULL
        CHECK (checkout_request_id ~ '^[A-Za-z0-9_-]{1,100}$'),
    merchant_request_id         VARCHAR(100) NOT NULL
        CHECK (merchant_request_id ~ '^[A-Za-z0-9_-]{1,100}$'),
    callback_result_code        VARCHAR(30) NOT NULL
        CHECK (callback_result_code ~ '^-?[0-9]{1,30}$'),
    callback_amount             NUMERIC(12,2),
    callback_phone              VARCHAR(12)
        CHECK (callback_phone IS NULL OR callback_phone ~ '^254[17][0-9]{8}$'),
    callback_receipt            VARCHAR(25)
        CHECK (callback_receipt IS NULL OR callback_receipt ~ '^[A-Za-z0-9]{1,25}$'),
    callback_status             VARCHAR(20) NOT NULL DEFAULT 'UNMATCHED'
        CHECK (callback_status IN ('UNMATCHED', 'CORRELATED', 'VERIFIED', 'REJECTED')),
    attempt_id                  VARCHAR(25)
        REFERENCES mpesa_payment_attempts (attempt_id) ON DELETE RESTRICT,
    verification_id             BIGINT
        REFERENCES mpesa_payment_verifications (verification_id) ON DELETE RESTRICT,
    rejection_code              VARCHAR(64),
    duplicate_count             INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
    received_at                 TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    correlated_at               TIMESTAMP WITH TIME ZONE,
    verified_at                 TIMESTAMP WITH TIME ZONE,
    updated_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT ck_mpesa_callback_success_metadata CHECK (
        callback_result_code <> '0'
        OR (
            callback_amount IS NOT NULL
            AND callback_amount > 0
            AND callback_amount = trunc(callback_amount)
            AND callback_phone IS NOT NULL
            AND callback_receipt IS NOT NULL
        )
    ),
    CONSTRAINT ck_mpesa_callback_lifecycle CHECK (
        (callback_status = 'UNMATCHED'
            AND attempt_id IS NULL
            AND verification_id IS NULL
            AND rejection_code IS NULL)
        OR (callback_status = 'CORRELATED'
            AND attempt_id IS NOT NULL
            AND verification_id IS NULL
            AND correlated_at IS NOT NULL
            AND rejection_code IS NULL)
        OR (callback_status = 'VERIFIED'
            AND attempt_id IS NOT NULL
            AND verification_id IS NOT NULL
            AND correlated_at IS NOT NULL
            AND verified_at IS NOT NULL
            AND rejection_code IS NULL)
        OR (callback_status = 'REJECTED'
            AND rejection_code IS NOT NULL)
    )
);

CREATE INDEX idx_mpesa_callback_inbox_status_received
    ON mpesa_callback_inbox (callback_status, received_at);
CREATE INDEX idx_mpesa_callback_inbox_provider_ids
    ON mpesa_callback_inbox (checkout_request_id, merchant_request_id);
CREATE INDEX idx_mpesa_callback_inbox_attempt
    ON mpesa_callback_inbox (attempt_id)
    WHERE attempt_id IS NOT NULL;

CREATE TRIGGER trg_mpesa_callback_inbox_set_updated_at
    BEFORE UPDATE ON mpesa_callback_inbox
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
CREATE UNIQUE INDEX uq_withdrawal_claims_one_pending_per_account
    ON withdrawal_claims (account_id)
    WHERE claim_status = 'PENDING';

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

-- A contribution's fund distribution is an immutable snapshot of the
-- account's selected, effective fund-allocation rows at initiation time.
-- Existing contributions remain intentionally unassigned.
CREATE TABLE contribution_fund_allocations (
    contribution_id       VARCHAR(25) NOT NULL,
    account_id            VARCHAR(25) NOT NULL,
    fund_id               VARCHAR(25) NOT NULL,
    fund_name             VARCHAR(50) NOT NULL,
    allocation_percentage NUMERIC(18,10) NOT NULL
        CHECK (allocation_percentage > 0 AND allocation_percentage <= 100),
    allocated_amount      NUMERIC(12,2) NOT NULL CHECK (allocated_amount >= 0),
    created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    PRIMARY KEY (contribution_id, fund_id),
    CONSTRAINT fk_contribution_fund_allocations_contribution
        FOREIGN KEY (contribution_id, account_id)
        REFERENCES contributions (contribution_id, account_id) ON DELETE CASCADE,
    CONSTRAINT fk_contribution_fund_allocations_fund
        FOREIGN KEY (fund_id) REFERENCES funds (fund_id) ON DELETE RESTRICT
);

-- Single-use email-verification and password-recovery tokens. Only token
-- hashes are persisted; rate-limit keys are keyed hashes rather than PII.
CREATE TABLE auth_tokens (
    auth_token_id   BIGSERIAL PRIMARY KEY,
    user_id         VARCHAR(25) NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    purpose         VARCHAR(30) NOT NULL CHECK (purpose IN ('EMAIL_VERIFICATION', 'PASSWORD_RESET')),
    email_address   VARCHAR(254) NOT NULL,
    token_hash      CHAR(64) NOT NULL UNIQUE,
    expires_at      TIMESTAMP WITH TIME ZONE NOT NULL,
    consumed_at     TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_tokens_user_purpose_created
    ON auth_tokens (user_id, purpose, created_at DESC);

CREATE TABLE pending_registrations (
    pending_registration_id VARCHAR(25) PRIMARY KEY DEFAULT generate_short_id(),
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(254) NOT NULL,
    phone VARCHAR(15) NOT NULL,
    password_hash VARCHAR(255),
    occupation VARCHAR(50) NOT NULL,
    national_id VARCHAR(25) NOT NULL,
    date_of_birth DATE NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_pending_registrations_expiry
    ON pending_registrations (expires_at);

CREATE TABLE auth_rate_limits (
    scope           VARCHAR(20) NOT NULL CHECK (scope IN ('IP', 'EMAIL', 'ACCOUNT')),
    action          VARCHAR(30) NOT NULL,
    key_hash        CHAR(64) NOT NULL,
    window_started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    request_count   INTEGER NOT NULL CHECK (request_count > 0),
    PRIMARY KEY (scope, action, key_hash)
);

CREATE INDEX idx_fund_allocations_account_id ON fund_allocations (account_id);
CREATE INDEX idx_fund_allocations_fund_id ON fund_allocations (fund_id);
CREATE INDEX idx_contribution_fund_allocations_fund
    ON contribution_fund_allocations (fund_id);

CREATE TRIGGER trg_fund_allocations_set_updated_at
    BEFORE UPDATE ON fund_allocations
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- NOTIFICATIONS
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
    notification_id     VARCHAR(25)  PRIMARY KEY DEFAULT generate_short_id(),
    user_id             VARCHAR(25),
    created_by          VARCHAR(25),
    notification_type   VARCHAR(20)  NOT NULL
        CHECK (notification_type IN ('SMS', 'EMAIL', 'PUSH', 'USSD', 'IN_APP')),
    message             TEXT         NOT NULL,
    recipient_phone     VARCHAR(16),
    recipient_email     VARCHAR(254),
    email_subject       VARCHAR(255),
    email_html_body     TEXT,
    push_title          VARCHAR(100),
    notification_category VARCHAR(40) NOT NULL DEFAULT 'GENERAL'
        CHECK (notification_category IN (
            'GENERAL', 'ANNOUNCEMENT', 'CONTRIBUTION_REMINDER', 'SCHEME_UPDATE',
            'ACCOUNT_SERVICE', 'REGULATORY_ADVISORY', 'COMPLIANCE_NOTICE',
            'DEADLINE_REMINDER', 'WORKER_EDUCATION'
        )),
    scope_fund_id       VARCHAR(25) REFERENCES funds (fund_id) ON DELETE SET NULL,
    deduplication_key   VARCHAR(128),
    admin_request_key   UUID,
    provider_message_id VARCHAR(128),
    provider_accepted_at TIMESTAMP WITH TIME ZONE,
    delivered_at        TIMESTAMP WITH TIME ZONE,
    delivery_result     JSONB,
    delivery_status     VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
        CONSTRAINT ck_notifications_delivery_status
        CHECK (delivery_status IN (
            'PENDING', 'PROCESSING', 'PROVIDER_ACCEPTED', 'DELIVERED', 'FAILED', 'UNKNOWN'
        )),
    attempt_count       INTEGER NOT NULL DEFAULT 0
        CONSTRAINT ck_notifications_attempt_count CHECK (attempt_count >= 0),
    next_attempt_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    claimed_at          TIMESTAMP WITH TIME ZONE,
    claim_token         UUID,
    last_attempt_at     TIMESTAMP WITH TIME ZONE,
    last_error_code     VARCHAR(64),
    external_recipient_consent_at TIMESTAMP WITH TIME ZONE,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    sent_at             TIMESTAMP WITH TIME ZONE,
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT ck_notifications_claim_fields CHECK (
        (delivery_status = 'PROCESSING'
            AND claimed_at IS NOT NULL
            AND claim_token IS NOT NULL)
        OR
        (delivery_status <> 'PROCESSING'
            AND claimed_at IS NULL
            AND claim_token IS NULL)
    ),
    CONSTRAINT ck_notifications_delivery_timestamps CHECK (
        (delivery_status NOT IN ('PROVIDER_ACCEPTED', 'DELIVERED')
            OR provider_accepted_at IS NOT NULL)
        AND
        (delivery_status <> 'DELIVERED' OR delivered_at IS NOT NULL)
    ),
    CONSTRAINT ck_notifications_admin_channel_snapshot CHECK (
        admin_request_key IS NULL
        OR (
            (created_by IS NOT NULL OR user_id IS NULL)
            AND notification_type IN ('SMS', 'EMAIL', 'PUSH')
            AND (
                (notification_type = 'SMS' AND recipient_phone IS NOT NULL)
                OR (notification_type = 'EMAIL'
                    AND recipient_email IS NOT NULL
                    AND email_subject IS NOT NULL)
                OR (notification_type = 'PUSH' AND push_title IS NOT NULL)
            )
        )
    ),
    CONSTRAINT ck_notifications_external_recipient CHECK (
        (
            user_id IS NOT NULL
            AND external_recipient_consent_at IS NULL
        )
        OR
        (
            user_id IS NULL
            AND notification_type = 'SMS'
            AND recipient_phone IS NOT NULL
            AND recipient_phone ~ '^[+]254[17][0-9]{8}$'
            AND admin_request_key IS NOT NULL
            AND external_recipient_consent_at IS NOT NULL
        )
    ),
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
CREATE INDEX idx_notifications_scope_fund_created
    ON notifications (scope_fund_id, created_at DESC)
    WHERE scope_fund_id IS NOT NULL;
CREATE INDEX idx_notifications_delivery_status ON notifications (delivery_status);
CREATE UNIQUE INDEX uq_notifications_sms_deduplication_key
    ON notifications (deduplication_key)
    WHERE notification_type = 'SMS' AND deduplication_key IS NOT NULL;
CREATE UNIQUE INDEX uq_notifications_user_channel_event_key
    ON notifications (user_id, notification_type, deduplication_key)
    WHERE deduplication_key IS NOT NULL;
CREATE UNIQUE INDEX uq_notifications_admin_request_channel
    ON notifications (admin_request_key, user_id, notification_type)
    WHERE admin_request_key IS NOT NULL;
CREATE UNIQUE INDEX uq_notifications_external_request
    ON notifications (admin_request_key)
    WHERE user_id IS NULL;
CREATE INDEX idx_notifications_external_admin_created
    ON notifications (created_by, created_at DESC)
    WHERE user_id IS NULL;
CREATE UNIQUE INDEX uq_notifications_provider_message_id
    ON notifications (provider_message_id)
    WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX uq_notifications_claim_token
    ON notifications (claim_token)
    WHERE claim_token IS NOT NULL;
CREATE INDEX idx_notifications_sms_pending_schedule
    ON notifications (next_attempt_at, created_at)
    WHERE notification_type = 'SMS' AND delivery_status = 'PENDING';
CREATE INDEX idx_notifications_sms_processing_claim
    ON notifications (claimed_at)
    WHERE notification_type = 'SMS' AND delivery_status = 'PROCESSING';

CREATE TRIGGER trg_notifications_set_updated_at
    BEFORE UPDATE ON notifications
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE TABLE notification_preferences (
    user_id VARCHAR(25) PRIMARY KEY
        REFERENCES users (user_id) ON DELETE CASCADE,
    sms_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_notification_preferences_set_updated_at
    BEFORE UPDATE ON notification_preferences
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- -------------------------------------------------------------------------
-- PUSH_SUBSCRIPTIONS
--   Browser subscriptions are private per-user endpoints and device keys.
-- -------------------------------------------------------------------------
CREATE TABLE push_subscriptions (
    subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(25) NOT NULL
        REFERENCES users (user_id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh_key VARCHAR(255) NOT NULL,
    auth_key VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT ck_push_subscriptions_endpoint CHECK (
        endpoint ~ '^https://'
    ),
    CONSTRAINT ck_push_subscriptions_keys CHECK (
        p256dh_key ~ '^[A-Za-z0-9_-]{40,200}$'
        AND auth_key ~ '^[A-Za-z0-9_-]{16,100}$'
    )
);

CREATE INDEX idx_push_subscriptions_user_id
    ON push_subscriptions (user_id);

CREATE TRIGGER trg_push_subscriptions_set_updated_at
    BEFORE UPDATE ON push_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE TABLE mobilesasa_sms_delivery_callbacks (
    callback_id                 BIGSERIAL PRIMARY KEY,
    provider                    VARCHAR(20) NOT NULL DEFAULT 'MOBILE_SASA'
        CHECK (provider = 'MOBILE_SASA'),
    provider_message_reference  VARCHAR(128) NOT NULL
        CHECK (provider_message_reference <> ''),
    tracking_id                 VARCHAR(128),
    provider_dispatch_reference VARCHAR(128),
    delivery_status             VARCHAR(20) NOT NULL
        CHECK (delivery_status IN (
            'SENT', 'DELIVERED', 'FAILED', 'REJECTED', 'EXPIRED', 'UNREACHABLE'
        )),
    delivery_description        VARCHAR(255),
    delivery_code               VARCHAR(40),
    gateway                     VARCHAR(40),
    provider_delivery_time      VARCHAR(40),
    provider_delivered_at       TIMESTAMP WITH TIME ZONE,
    provider_reported_at        TIMESTAMP WITH TIME ZONE,
    notification_id             VARCHAR(25)
        REFERENCES notifications (notification_id) ON DELETE SET NULL,
    original_notification_id    VARCHAR(25),
    processing_status           VARCHAR(20) NOT NULL DEFAULT 'UNMATCHED'
        CHECK (processing_status IN (
            'UNMATCHED', 'CORRELATED', 'APPLIED', 'IGNORED', 'REJECTED'
        )),
    rejection_code              VARCHAR(64)
        CHECK (rejection_code IS NULL OR rejection_code ~ '^[A-Z0-9_]{1,64}$'),
    duplicate_count             INTEGER NOT NULL DEFAULT 0
        CHECK (duplicate_count >= 0),
    signature_verified_at       TIMESTAMP WITH TIME ZONE NOT NULL,
    received_at                 TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    correlated_at               TIMESTAMP WITH TIME ZONE,
    processed_at                TIMESTAMP WITH TIME ZONE,
    updated_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT uq_mobilesasa_callback_provider_reference_status
        UNIQUE (provider, provider_message_reference, delivery_status),
    CONSTRAINT ck_mobilesasa_callback_notification_reference CHECK (
        notification_id IS NULL
        OR (
            original_notification_id IS NOT NULL
            AND original_notification_id = notification_id
        )
    ),
    CONSTRAINT ck_mobilesasa_callback_lifecycle CHECK (
        (processing_status = 'UNMATCHED'
            AND notification_id IS NULL
            AND original_notification_id IS NULL
            AND correlated_at IS NULL
            AND processed_at IS NULL
            AND rejection_code IS NULL)
        OR (processing_status = 'CORRELATED'
            AND (notification_id IS NOT NULL OR original_notification_id IS NOT NULL)
            AND correlated_at IS NOT NULL
            AND processed_at IS NULL
            AND rejection_code IS NULL)
        OR (processing_status IN ('APPLIED', 'IGNORED')
            AND (notification_id IS NOT NULL OR original_notification_id IS NOT NULL)
            AND correlated_at IS NOT NULL
            AND processed_at IS NOT NULL
            AND rejection_code IS NULL)
        OR (processing_status = 'REJECTED'
            AND processed_at IS NOT NULL
            AND rejection_code IS NOT NULL)
    )
);

CREATE OR REPLACE FUNCTION preserve_mobilesasa_callback_notification_reference()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.original_notification_id :=
            COALESCE(NEW.original_notification_id, NEW.notification_id);
    ELSIF OLD.notification_id IS NOT NULL AND NEW.notification_id IS NULL THEN
        NEW.original_notification_id :=
            COALESCE(NEW.original_notification_id, OLD.notification_id);
    ELSIF NEW.notification_id IS NOT NULL THEN
        IF OLD.original_notification_id IS NOT NULL
            AND OLD.original_notification_id <> NEW.notification_id THEN
            RAISE EXCEPTION 'A callback cannot be reassigned to another notification';
        END IF;
        NEW.original_notification_id :=
            COALESCE(NEW.original_notification_id, NEW.notification_id);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_mobilesasa_callbacks_preserve_notification_reference
    BEFORE INSERT OR UPDATE OF notification_id
    ON mobilesasa_sms_delivery_callbacks
    FOR EACH ROW
    EXECUTE FUNCTION preserve_mobilesasa_callback_notification_reference();

CREATE INDEX idx_mobilesasa_callbacks_unmatched
    ON mobilesasa_sms_delivery_callbacks (received_at, callback_id)
    WHERE processing_status = 'UNMATCHED';
CREATE INDEX idx_mobilesasa_callbacks_notification
    ON mobilesasa_sms_delivery_callbacks (notification_id, received_at DESC)
    WHERE notification_id IS NOT NULL;
CREATE INDEX idx_mobilesasa_callbacks_original_notification
    ON mobilesasa_sms_delivery_callbacks (original_notification_id, received_at DESC)
    WHERE original_notification_id IS NOT NULL;
CREATE INDEX idx_mobilesasa_callbacks_tracking_id
    ON mobilesasa_sms_delivery_callbacks (tracking_id)
    WHERE tracking_id IS NOT NULL;
CREATE INDEX idx_mobilesasa_callbacks_dispatch_reference
    ON mobilesasa_sms_delivery_callbacks (provider_dispatch_reference)
    WHERE provider_dispatch_reference IS NOT NULL;

CREATE TRIGGER trg_mobilesasa_callbacks_set_updated_at
    BEFORE UPDATE ON mobilesasa_sms_delivery_callbacks
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Explicit assignments define each regulator's read/notification scope;
-- assignments are independent of fund-manager approval.
CREATE TABLE regulator_fund_assignments (
    assignment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    regulator_user_id VARCHAR(25) NOT NULL
        REFERENCES users (user_id) ON DELETE CASCADE,
    fund_id VARCHAR(25) NOT NULL
        REFERENCES funds (fund_id) ON DELETE CASCADE,
    assigned_by VARCHAR(25)
        REFERENCES users (user_id) ON DELETE SET NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT uq_regulator_fund_assignment UNIQUE (regulator_user_id, fund_id)
);

CREATE INDEX idx_regulator_fund_assignments_active
    ON regulator_fund_assignments (regulator_user_id, fund_id)
    WHERE active = TRUE;

CREATE OR REPLACE FUNCTION enforce_regulator_fund_assignment_roles()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM users
        WHERE user_id = NEW.regulator_user_id AND role = 'REGULATOR'
    ) THEN
        RAISE EXCEPTION 'regulator_user_id must reference a REGULATOR';
    END IF;
    IF NEW.assigned_by IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM users
        WHERE user_id = NEW.assigned_by AND role = 'ADMIN'
    ) THEN
        RAISE EXCEPTION 'assigned_by must reference an ADMIN';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_regulator_fund_assignment_roles
    BEFORE INSERT OR UPDATE OF regulator_user_id, assigned_by
    ON regulator_fund_assignments
    FOR EACH ROW
    EXECUTE FUNCTION enforce_regulator_fund_assignment_roles();

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
        CHECK (action_type IN (
            'CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'APPROVE', 'REJECT',
            'SUBMIT', 'RESUBMIT', 'REQUEST_REVISION'
        )),
    entity_name   VARCHAR(50)  NOT NULL,
    entity_id     VARCHAR(25)  NOT NULL,
    details       JSONB,
    "timestamp"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    -- Audit history must outlive the acting user, so the actor reference is
    -- cleared rather than cascading a delete into the audit trail.
    CONSTRAINT fk_audit_logs_user FOREIGN KEY (user_id)
        REFERENCES users (user_id) ON DELETE SET NULL
);

CREATE INDEX idx_audit_logs_user_id ON audit_logs (user_id);
CREATE INDEX idx_audit_logs_action_type ON audit_logs (action_type);
CREATE INDEX idx_audit_logs_entity ON audit_logs (entity_name, entity_id);

CREATE TABLE notification_audit_events (
    audit_event_id BIGSERIAL PRIMARY KEY,
    request_id UUID NOT NULL,
    sender_user_id VARCHAR(25),
    sender_role VARCHAR(20) NOT NULL
        CHECK (sender_role IN ('ADMIN', 'FUND_MANAGER', 'REGULATOR', 'SYSTEM')),
    recipient_user_id VARCHAR(25),
    scope_fund_id VARCHAR(25),
    notification_category VARCHAR(40) NOT NULL,
    channels JSONB NOT NULL
        CHECK (jsonb_typeof(channels) = 'array'),
    notification_ids JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(notification_ids) = 'array'),
    authorization_outcome VARCHAR(20) NOT NULL
        CHECK (authorization_outcome IN ('AUTHORIZED', 'DENIED')),
    outcome_code VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_notification_audit_sender_created
    ON notification_audit_events (sender_user_id, created_at DESC);
CREATE INDEX idx_notification_audit_scope_created
    ON notification_audit_events (scope_fund_id, created_at DESC);
CREATE INDEX idx_notification_audit_recipient_created
    ON notification_audit_events (recipient_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_notification_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'notification audit events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notification_audit_append_only
    BEFORE UPDATE OR DELETE ON notification_audit_events
    FOR EACH ROW
    EXECUTE FUNCTION reject_notification_audit_mutation();

-- -----------------------------------------------------------------------------
-- COMPLIANCE_REPORTS
-- -----------------------------------------------------------------------------
CREATE TABLE compliance_reports (
    report_id       VARCHAR(25) PRIMARY KEY DEFAULT generate_short_id(),
    generated_by    VARCHAR(25),
    fund_id         VARCHAR(25),
    report_type     VARCHAR(20),
    period_start    DATE,
    period_end      DATE,
    report_content  JSONB,
    is_legacy       BOOLEAN NOT NULL DEFAULT FALSE,
    rba_status      VARCHAR(25) NOT NULL DEFAULT 'DRAFT'
        CHECK (rba_status IN ('DRAFT', 'SUBMITTED', 'REVISION_REQUESTED', 'ACCEPTED', 'REJECTED')),
    generated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    submitted_at    TIMESTAMP WITH TIME ZONE,
    last_submitted_at TIMESTAMP WITH TIME ZONE,
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT fk_compliance_reports_generated_by FOREIGN KEY (generated_by)
        REFERENCES users (user_id) ON DELETE SET NULL,
    CONSTRAINT fk_compliance_reports_fund FOREIGN KEY (fund_id)
        REFERENCES funds (fund_id) ON DELETE RESTRICT,
    CONSTRAINT chk_compliance_reports_report_type
        CHECK (report_type IS NULL OR report_type IN ('RBA', 'NSSF', 'INTERNAL')),
    CONSTRAINT chk_compliance_reports_period
        CHECK (period_start IS NULL OR period_end IS NULL OR period_end >= period_start)
);

CREATE INDEX idx_compliance_reports_generated_by ON compliance_reports (generated_by);
CREATE INDEX idx_compliance_reports_rba_status ON compliance_reports (rba_status);
CREATE INDEX idx_compliance_reports_fund ON compliance_reports (fund_id);
CREATE INDEX idx_compliance_reports_submitted ON compliance_reports (rba_status, submitted_at DESC);

CREATE TABLE report_generation_history (
    report_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    generated_by VARCHAR(25)
        REFERENCES users (user_id) ON DELETE SET NULL,
    generator_role VARCHAR(20) NOT NULL
        CHECK (generator_role IN ('ADMIN', 'FUND_MANAGER', 'REGULATOR')),
    report_key VARCHAR(60) NOT NULL,
    export_format VARCHAR(10) NOT NULL
        CHECK (export_format IN ('CSV', 'XLSX', 'PDF')),
    applied_filters JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(applied_filters) = 'object'),
    scope_fund_ids JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(scope_fund_ids) = 'array'),
    generation_status VARCHAR(20) NOT NULL
        CHECK (generation_status IN ('SUCCEEDED', 'FAILED')),
    result_count INTEGER NOT NULL DEFAULT 0 CHECK (result_count >= 0),
    generated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_report_generation_history_user_created
    ON report_generation_history (generated_by, generated_at DESC);

CREATE TABLE report_download_events (
    download_event_id BIGSERIAL PRIMARY KEY,
    report_id UUID NOT NULL,
    downloaded_by VARCHAR(25),
    downloaded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    outcome VARCHAR(20) NOT NULL
        CHECK (outcome IN ('SUCCEEDED', 'DENIED', 'FAILED'))
);

CREATE INDEX idx_report_download_events_report
    ON report_download_events (report_id, downloaded_at DESC);

CREATE OR REPLACE FUNCTION reject_report_download_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'report download events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_report_download_events_append_only
    BEFORE UPDATE OR DELETE ON report_download_events
    FOR EACH ROW
    EXECUTE FUNCTION reject_report_download_mutation();

CREATE TRIGGER trg_compliance_reports_set_updated_at
    BEFORE UPDATE ON compliance_reports
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Enforces the design rule: only FUND_MANAGER users submit compliance reports.
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

CREATE TRIGGER trg_compliance_reports_enforce_generator_role
    BEFORE INSERT OR UPDATE OF generated_by ON compliance_reports
    FOR EACH ROW
    EXECUTE FUNCTION enforce_compliance_report_generator_role();

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
    CONSTRAINT uq_compliance_report_reviews_submission UNIQUE (submission_id),
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

CREATE OR REPLACE FUNCTION enforce_compliance_report_review_state()
RETURNS TRIGGER AS $$
DECLARE
    report_status VARCHAR(25);
    report_is_legacy BOOLEAN;
    report_submitted_at TIMESTAMP WITH TIME ZONE;
    report_last_submitted_at TIMESTAMP WITH TIME ZONE;
    latest_submission_id VARCHAR(25);
BEGIN
    SELECT rba_status, is_legacy, submitted_at, last_submitted_at
    INTO report_status, report_is_legacy, report_submitted_at, report_last_submitted_at
    FROM compliance_reports
    WHERE report_id = NEW.report_id
    FOR UPDATE;

    IF NOT FOUND
       OR report_status <> 'SUBMITTED'
       OR report_is_legacy
       OR report_submitted_at IS NULL
       OR report_last_submitted_at IS NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'compliance decisions require a complete, non-legacy submitted report';
    END IF;

    SELECT submission_id
    INTO latest_submission_id
    FROM compliance_report_submissions
    WHERE report_id = NEW.report_id
    ORDER BY version DESC
    LIMIT 1;

    IF latest_submission_id IS DISTINCT FROM NEW.submission_id THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'compliance decisions must reference the latest report submission';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_compliance_report_reviews_submitted_state
    BEFORE INSERT ON compliance_report_reviews
    FOR EACH ROW
    EXECUTE FUNCTION enforce_compliance_report_review_state();

CREATE OR REPLACE FUNCTION enforce_compliance_report_status_transition()
RETURNS TRIGGER AS $$
DECLARE
    latest_submission_id VARCHAR(25);
    latest_submission_at TIMESTAMP WITH TIME ZONE;
BEGIN
    IF NEW.rba_status IS NOT DISTINCT FROM OLD.rba_status THEN
        RETURN NEW;
    END IF;

    IF NEW.is_legacy THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'legacy compliance reports cannot enter the workflow';
    END IF;

    IF OLD.rba_status IN ('DRAFT', 'REVISION_REQUESTED')
       AND NEW.rba_status = 'SUBMITTED' THEN
        SELECT submission_id, submitted_at
        INTO latest_submission_id, latest_submission_at
        FROM compliance_report_submissions
        WHERE report_id = NEW.report_id
        ORDER BY version DESC
        LIMIT 1;

        IF NOT FOUND
           OR NEW.submitted_at IS NULL
           OR NEW.last_submitted_at IS NULL
           OR NEW.last_submitted_at IS NOT DISTINCT FROM OLD.last_submitted_at
           OR NEW.last_submitted_at IS DISTINCT FROM latest_submission_at THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'a report can be submitted only with a new matching submission history row';
        END IF;

        RETURN NEW;
    END IF;

    IF OLD.rba_status = 'SUBMITTED'
       AND NEW.rba_status IN ('ACCEPTED', 'REJECTED', 'REVISION_REQUESTED') THEN
        SELECT submission_id
        INTO latest_submission_id
        FROM compliance_report_submissions
        WHERE report_id = NEW.report_id
        ORDER BY version DESC
        LIMIT 1;

        IF NOT FOUND OR NOT EXISTS (
            SELECT 1
            FROM compliance_report_reviews
            WHERE report_id = NEW.report_id
              AND submission_id = latest_submission_id
              AND decision = NEW.rba_status
        ) THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'a report decision status requires a matching review of its latest submission';
        END IF;

        RETURN NEW;
    END IF;

    RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
            'invalid compliance report status transition from %s to %s',
            OLD.rba_status,
            NEW.rba_status
        );
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_compliance_reports_status_transition
    BEFORE UPDATE OF rba_status ON compliance_reports
    FOR EACH ROW
    EXECUTE FUNCTION enforce_compliance_report_status_transition();

CREATE OR REPLACE FUNCTION enforce_compliance_submission_status_at_commit()
RETURNS TRIGGER AS $$
DECLARE
    report_status VARCHAR(25);
    report_last_submitted_at TIMESTAMP WITH TIME ZONE;
    latest_submission_id VARCHAR(25);
BEGIN
    SELECT rba_status, last_submitted_at
    INTO report_status, report_last_submitted_at
    FROM compliance_reports
    WHERE report_id = NEW.report_id;

    SELECT submission_id
    INTO latest_submission_id
    FROM compliance_report_submissions
    WHERE report_id = NEW.report_id
    ORDER BY version DESC
    LIMIT 1;

    IF report_status IS DISTINCT FROM 'SUBMITTED'
       OR report_last_submitted_at IS DISTINCT FROM NEW.submitted_at
       OR latest_submission_id IS DISTINCT FROM NEW.submission_id THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'submission history must be committed with its submitted report state';
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_compliance_report_submissions_status_at_commit
    AFTER INSERT ON compliance_report_submissions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION enforce_compliance_submission_status_at_commit();

CREATE OR REPLACE FUNCTION enforce_compliance_review_status_at_commit()
RETURNS TRIGGER AS $$
DECLARE
    report_status VARCHAR(25);
    latest_submission_id VARCHAR(25);
BEGIN
    SELECT rba_status
    INTO report_status
    FROM compliance_reports
    WHERE report_id = NEW.report_id;

    SELECT submission_id
    INTO latest_submission_id
    FROM compliance_report_submissions
    WHERE report_id = NEW.report_id
    ORDER BY version DESC
    LIMIT 1;

    IF report_status IS DISTINCT FROM NEW.decision
       OR latest_submission_id IS DISTINCT FROM NEW.submission_id THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'review history must be committed with its matching report decision';
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_compliance_report_reviews_status_at_commit
    AFTER INSERT ON compliance_report_reviews
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION enforce_compliance_review_status_at_commit();

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

INSERT INTO system_settings (setting_key, setting_value, description) VALUES
    ('assumed_yearly_growth', '8', 'Annual growth assumption used by retirement projections (percent).'),
    ('max_failed_login_attempts', '5', 'Failed login attempts before a temporary account lockout.'),
    ('account_lockout_duration_minutes', '15', 'Duration of a temporary account lockout (minutes).'),
    ('require_otp_on_withdrawal', 'true', 'Require OTP verification before future payout dispatch. M-Pesa payout dispatch is currently disabled.')
ON CONFLICT (setting_key) DO NOTHING;

CREATE INDEX idx_system_settings_updated_by ON system_settings (updated_by);

CREATE TRIGGER trg_system_settings_set_updated_at
    BEFORE UPDATE ON system_settings
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
