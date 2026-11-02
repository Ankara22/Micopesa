-- Adds a reason for newly submitted worker withdrawal claims.
-- Nullable so existing claims remain valid and no historical data is changed.
ALTER TABLE withdrawal_claims
    ADD COLUMN IF NOT EXISTS withdrawal_reason VARCHAR(255);
