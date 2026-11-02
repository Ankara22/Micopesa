BEGIN;

ALTER TABLE transactions
    ALTER COLUMN checkout_request_id TYPE VARCHAR(100),
    ADD COLUMN IF NOT EXISTS mpesa_phone VARCHAR(12),
    ADD COLUMN IF NOT EXISTS mpesa_result_code INTEGER,
    ADD COLUMN IF NOT EXISTS mpesa_result_description VARCHAR(255);

ALTER TABLE transactions
    DROP CONSTRAINT IF EXISTS transactions_transaction_status_check;

ALTER TABLE transactions
    ADD CONSTRAINT transactions_transaction_status_check
    CHECK (transaction_status IN ('PENDING', 'COMPLETED', 'FAILED', 'REVERSED', 'CANCELLED', 'TIMED_OUT'));

ALTER TABLE contributions
    DROP CONSTRAINT IF EXISTS contributions_contribution_status_check;

ALTER TABLE contributions
    ADD CONSTRAINT contributions_contribution_status_check
    CHECK (contribution_status IN ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'));

UPDATE transactions
SET transaction_status = 'TIMED_OUT'
WHERE transaction_status = 'FAILED'
  AND mpesa_result_code = 1037;

UPDATE contributions c
SET contribution_status = 'TIMED_OUT'
FROM transactions t
WHERE t.transaction_id = c.transaction_id
  AND t.transaction_status = 'TIMED_OUT'
  AND t.mpesa_result_code = 1037
  AND c.contribution_status = 'FAILED';

COMMIT;
