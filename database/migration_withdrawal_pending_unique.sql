-- Enforces one pending withdrawal claim per pension account.
-- Existing duplicate pending claims are reported and left unchanged.
BEGIN;

DO $$
DECLARE
    duplicate_accounts TEXT;
BEGIN
    SELECT string_agg(account_id || ' (' || pending_count || ')', ', ')
    INTO duplicate_accounts
    FROM (
        SELECT account_id, count(*) AS pending_count
        FROM withdrawal_claims
        WHERE claim_status = 'PENDING'
        GROUP BY account_id
        HAVING count(*) > 1
        ORDER BY account_id
        LIMIT 20
    ) duplicates;

    IF duplicate_accounts IS NOT NULL THEN
        RAISE EXCEPTION
            'Migration aborted without changing data: multiple pending withdrawal claims exist for account(s): %. Resolve these claims explicitly, then rerun.',
            duplicate_accounts;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_withdrawal_claims_one_pending_per_account
    ON withdrawal_claims (account_id)
    WHERE claim_status = 'PENDING';

COMMIT;
