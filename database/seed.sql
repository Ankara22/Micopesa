-- =============================================================================
-- MicoPesa Development Seed Data
--
-- Intended to run against a freshly created schema (see database/schema.sql).
-- All primary keys are hardcoded (rather than relying on generate_short_id())
-- so that foreign keys in this file can reference them directly and the data
-- set is reproducible across environments.
--
-- Run order:
--   psql -d micopesa -f database/schema.sql
--   psql -d micopesa -f database/seed.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- USERS
-- One user per role: informal worker, fund manager, RBA regulator, and
-- system administrator.
-- password_hash values are placeholder bcrypt-shaped hashes for local/dev use
-- only and are not valid credentials.
-- The ADMIN user is intentionally never referenced as a fund manager
-- (funds.managed_by), a withdrawal-claim reviewer (withdrawal_claims.reviewed_by),
-- or a compliance-report generator (compliance_reports.generated_by) anywhere
-- in this file, consistent with the platform's role boundaries.
-- -----------------------------------------------------------------------------
INSERT INTO users (user_id, full_name, phone, password_hash, role, occupation, account_status, created_at, updated_at) VALUES
    ('USR0000000000000000000001', 'Jane Worker',      '+254700000001', '$2b$10$devseedhashplaceholder0000000001', 'WORKER',       'Boda Boda Rider',          'ACTIVE', now(), now()),
    ('USR0000000000000000000002', 'Fredrick Manager', '+254700000002', '$2b$10$devseedhashplaceholder0000000002', 'FUND_MANAGER', 'Fund Administrator',       'ACTIVE', now(), now()),
    ('USR0000000000000000000003', 'Rita Regulator',   '+254700000003', '$2b$10$devseedhashplaceholder0000000003', 'REGULATOR',    'RBA Compliance Officer',   'ACTIVE', now(), now()),
    ('USR0000000000000000000004', 'Amina Admin',      '+254700000004', '$2b$10$devseedhashplaceholder0000000004', 'ADMIN',        'System Administrator',     'ACTIVE', now(), now());

-- -----------------------------------------------------------------------------
-- KYC_RECORDS
-- Jane Worker's identity has been verified.
-- -----------------------------------------------------------------------------
INSERT INTO kyc_records (kyc_id, user_id, national_id, date_of_birth, kyc_status, verified_at, created_at, updated_at) VALUES
    ('KYC0000000000000000000001', 'USR0000000000000000000001', '30112233', '1990-05-14', 'VERIFIED', now() - INTERVAL '30 days', now() - INTERVAL '32 days', now() - INTERVAL '30 days');

-- -----------------------------------------------------------------------------
-- PENSION_ACCOUNTS
-- Jane Worker's active pension account; balance reflects the contribution
-- recorded below (KSh 1,500.00).
-- -----------------------------------------------------------------------------
INSERT INTO pension_accounts (account_id, user_id, current_balance, retirement_age, account_status, created_at, updated_at) VALUES
    ('ACC0000000000000000000001', 'USR0000000000000000000001', 1500.00, 60, 'ACTIVE', now() - INTERVAL '30 days', now() - INTERVAL '1 days');

-- -----------------------------------------------------------------------------
-- FUNDS
-- Default fund managed by the fund manager.
-- -----------------------------------------------------------------------------
INSERT INTO funds (fund_id, managed_by, fund_name, administrator_name, risk_level, expected_return, fund_status, created_at, updated_at) VALUES
    ('FND0000000000000000000001', 'USR0000000000000000000002', 'MicoPesa Growth Fund', 'Fredrick Manager', 'MEDIUM', 8.50, 'ACTIVE', now() - INTERVAL '60 days', now() - INTERVAL '60 days');

-- -----------------------------------------------------------------------------
-- TRANSACTIONS
-- Completed M-Pesa transaction settling Jane Worker's contribution.
-- -----------------------------------------------------------------------------
INSERT INTO transactions (transaction_id, transaction_type, amount, mpesa_receipt, checkout_request_id, transaction_status, initiated_at, completed_at, updated_at) VALUES
    ('TXN0000000000000000000001', 'CONTRIBUTION', 1500.00, 'QGH7XJ2K9L', 'ws_CO_010120240001', 'COMPLETED', now() - INTERVAL '1 days', now() - INTERVAL '1 days' + INTERVAL '2 minutes', now() - INTERVAL '1 days' + INTERVAL '2 minutes');

-- -----------------------------------------------------------------------------
-- CONTRIBUTIONS
-- Contribution matching the settled transaction and account balance.
-- -----------------------------------------------------------------------------
INSERT INTO contributions (contribution_id, account_id, transaction_id, amount, channel, contribution_status, created_at, updated_at) VALUES
    ('CTB0000000000000000000001', 'ACC0000000000000000000001', 'TXN0000000000000000000001', 1500.00, 'MPESA', 'COMPLETED', now() - INTERVAL '1 days', now() - INTERVAL '1 days' + INTERVAL '2 minutes');

-- -----------------------------------------------------------------------------
-- RETIREMENT_PLANS
-- Jane Worker's retirement plan: target KSh 500,000 by age 60, contributing
-- monthly.
-- -----------------------------------------------------------------------------
INSERT INTO retirement_plans (plan_id, account_id, target_amount, target_age, expected_return, contribution_frequency, plan_status, created_at, updated_at) VALUES
    ('PLN0000000000000000000001', 'ACC0000000000000000000001', 500000.00, 60, 8.50, 'MONTHLY', 'ACTIVE', now() - INTERVAL '30 days', now() - INTERVAL '30 days');

-- -----------------------------------------------------------------------------
-- RETIREMENT_PROJECTIONS
-- Projected growth for Jane Worker's plan, assuming continued monthly
-- contributions at the plan's expected return.
-- -----------------------------------------------------------------------------
INSERT INTO retirement_projections (projection_id, plan_id, assumed_contribution, assumed_return, projected_amount, projection_years, projected_at, created_at, updated_at) VALUES
    ('PRJ0000000000000000000001', 'PLN0000000000000000000001', 1500.00, 8.50, 512340.75, 25, now() - INTERVAL '1 days', now() - INTERVAL '1 days', now() - INTERVAL '1 days');
