-- Add immutable, per-fund snapshots for newly initiated contributions.
-- Existing contribution rows are deliberately left unassigned.
-- Apply after the finalized schema has created contributions and funds.
BEGIN;

ALTER TABLE contributions
    ADD CONSTRAINT uq_contributions_id_account
    UNIQUE (contribution_id, account_id);

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

CREATE INDEX idx_contribution_fund_allocations_fund
    ON contribution_fund_allocations (fund_id);

COMMIT;
