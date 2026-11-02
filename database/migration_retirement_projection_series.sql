-- Persist the input balance, age, and annual series for newly calculated projections.
-- Existing projections remain intact with NULL for assumptions that were not stored.
BEGIN;

ALTER TABLE retirement_projections
    ADD COLUMN IF NOT EXISTS current_age INTEGER
        CHECK (current_age IS NULL OR current_age BETWEEN 1 AND 100),
    ADD COLUMN IF NOT EXISTS starting_balance NUMERIC(12,2)
        CHECK (starting_balance IS NULL OR starting_balance >= 0),
    ADD COLUMN IF NOT EXISTS yearly_projection JSONB
        CHECK (yearly_projection IS NULL OR jsonb_typeof(yearly_projection) = 'array');

COMMIT;
