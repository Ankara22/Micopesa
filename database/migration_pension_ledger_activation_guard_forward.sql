BEGIN;

CREATE OR REPLACE FUNCTION public.pension_ledger_activate()
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
AS $activation$
DECLARE
    v_ledger_id UUID;
    v_batch_id UUID;
    v_singleton_count BIGINT;
    v_account_count BIGINT;
    v_batch_count BIGINT;
    v_opening_count BIGINT;
    v_opening_total NUMERIC(20, 2);
    v_account_total NUMERIC(20, 2);
    v_missing_account_count BIGINT;
    v_duplicate_account_count BIGINT;
    v_orphan_opening_count BIGINT;
    v_mismatched_opening_count BIGINT;
    v_inconsistent_opening_count BIGINT;
    v_nonopening_count BIGINT;
    v_historical_attempt_count BIGINT;
    v_distinct_historical_transaction_count BIGINT;
    v_distinct_historical_contribution_count BIGINT;
    v_invalid_historical_count BIGINT;
    v_historical_simulator_count BIGINT;
    v_historical_settlement_count BIGINT;
    v_unresolved_attempt_count BIGINT;
    v_updated_rows BIGINT;
BEGIN
    LOCK TABLE
        public.contributions,
        public.mpesa_payment_attempts,
        public.mpesa_payment_verifications,
        public.pension_account_movements,
        public.pension_accounts,
        public.pension_ledger,
        public.pension_ledger_cutover_batches,
        public.simulator_payment_confirmations,
        public.transactions
    IN SHARE ROW EXCLUSIVE MODE;

    SELECT count(*) INTO v_singleton_count
    FROM public.pension_ledger;

    IF v_singleton_count <> 1 THEN
        RAISE EXCEPTION
            'Ledger activation blocked: expected exactly one ledger singleton, found %',
            v_singleton_count;
    END IF;

    SELECT ledger_id INTO v_ledger_id
    FROM public.pension_ledger
    WHERE singleton_key IS TRUE
      AND status = 'PREPARING'
      AND activated_at IS NULL
      AND closed_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Ledger activation blocked: the singleton is missing or is not PREPARING';
    END IF;

    PERFORM b.batch_id
    FROM public.pension_ledger_cutover_batches b
    ORDER BY b.batch_id
    FOR UPDATE;

    SELECT count(*) INTO v_batch_count
    FROM public.pension_ledger_cutover_batches;

    IF v_batch_count <> 1 THEN
        RAISE EXCEPTION
            'Ledger activation blocked: expected exactly one cutover batch, found %',
            v_batch_count;
    END IF;

    SELECT b.batch_id INTO v_batch_id
    FROM public.pension_ledger_cutover_batches b
    WHERE b.ledger_id = v_ledger_id
      AND b.batch_type = 'INITIAL_CUTOVER'
      AND b.provenance =
          'Opening balances copied from existing pension_accounts.current_balance; balances not re-credited.'
      AND length(trim(b.migration_actor)) > 0
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Ledger activation blocked: the initial cutover batch is missing or incomplete';
    END IF;

    PERFORM a.account_id
    FROM public.pension_accounts a
    ORDER BY a.account_id
    FOR UPDATE;

    SELECT count(*) INTO v_account_count
    FROM public.pension_accounts;

    IF v_account_count <> 6 THEN
        RAISE EXCEPTION
            'Ledger activation blocked: expected six pension accounts, found %',
            v_account_count;
    END IF;

    PERFORM m.movement_id
    FROM public.pension_account_movements m
    ORDER BY m.movement_id
    FOR UPDATE;

    SELECT count(*) INTO v_opening_count
    FROM public.pension_account_movements m
    WHERE m.movement_type = 'OPENING_BALANCE';

    IF v_opening_count <> 6 THEN
        RAISE EXCEPTION
            'Ledger activation blocked: expected six opening movements, found %',
            v_opening_count;
    END IF;

    SELECT count(*) INTO v_missing_account_count
    FROM public.pension_accounts a
    WHERE NOT EXISTS (
        SELECT 1
        FROM public.pension_account_movements m
        WHERE m.account_id = a.account_id
          AND m.movement_type = 'OPENING_BALANCE'
    );

    SELECT count(*) INTO v_duplicate_account_count
    FROM (
        SELECT m.account_id
        FROM public.pension_account_movements m
        WHERE m.movement_type = 'OPENING_BALANCE'
        GROUP BY m.account_id
        HAVING count(*) <> 1
    ) duplicate_openings;

    SELECT count(*) INTO v_orphan_opening_count
    FROM public.pension_account_movements m
    LEFT JOIN public.pension_accounts a ON a.account_id = m.account_id
    WHERE m.movement_type = 'OPENING_BALANCE'
      AND a.account_id IS NULL;

    SELECT count(*) INTO v_mismatched_opening_count
    FROM public.pension_account_movements m
    JOIN public.pension_accounts a ON a.account_id = m.account_id
    WHERE m.movement_type = 'OPENING_BALANCE'
      AND m.amount IS DISTINCT FROM a.current_balance;

    SELECT count(*) INTO v_inconsistent_opening_count
    FROM public.pension_account_movements m
    LEFT JOIN public.pension_ledger_cutover_batches b
      ON b.batch_id = m.cutover_batch_id
    WHERE m.movement_type = 'OPENING_BALANCE'
      AND (
          m.ledger_id IS DISTINCT FROM v_ledger_id
          OR m.cutover_batch_id IS DISTINCT FROM v_batch_id
          OR b.batch_id IS NULL
          OR b.ledger_id IS DISTINCT FROM v_ledger_id
          OR b.batch_type IS DISTINCT FROM 'INITIAL_CUTOVER'
          OR m.effective_at IS DISTINCT FROM b.captured_at
          OR m.currency IS DISTINCT FROM 'KES'
          OR m.actor_type IS DISTINCT FROM 'MIGRATION'
          OR m.actor_reference IS DISTINCT FROM
              'migration_simulator_ledger_scoped_forward'
          OR m.provider_mode IS DISTINCT FROM 'MIGRATION'
          OR m.idempotency_key IS DISTINCT FROM
              ('opening-balance:' || m.account_id)
          OR m.transaction_id IS NOT NULL
          OR m.contribution_id IS NOT NULL
          OR m.payment_attempt_id IS NOT NULL
          OR m.payment_verification_id IS NOT NULL
          OR m.payment_callback_id IS NOT NULL
          OR m.simulator_confirmation_id IS NOT NULL
      );

    IF v_missing_account_count <> 0
       OR v_duplicate_account_count <> 0
       OR v_orphan_opening_count <> 0
       OR v_mismatched_opening_count <> 0
       OR v_inconsistent_opening_count <> 0 THEN
        RAISE EXCEPTION
            'Ledger activation blocked: opening movements are missing, duplicated, orphaned, mismatched, or inconsistent';
    END IF;

    SELECT count(*) INTO v_nonopening_count
    FROM public.pension_account_movements m
    WHERE m.movement_type <> 'OPENING_BALANCE';

    IF v_nonopening_count <> 0 THEN
        RAISE EXCEPTION
            'Ledger activation blocked: found % non-opening movements before cutover activation',
            v_nonopening_count;
    END IF;

    SELECT coalesce(sum(m.amount), 0)::NUMERIC(20, 2)
    INTO v_opening_total
    FROM public.pension_account_movements m
    WHERE m.movement_type = 'OPENING_BALANCE';

    SELECT coalesce(sum(a.current_balance), 0)::NUMERIC(20, 2)
    INTO v_account_total
    FROM public.pension_accounts a;

    IF v_opening_total IS DISTINCT FROM 2501.00::NUMERIC
       OR v_account_total IS DISTINCT FROM 2501.00::NUMERIC THEN
        RAISE EXCEPTION
            'Ledger activation blocked: opening and account totals must both equal KES 2,501.00 (openings %, accounts %)',
            v_opening_total,
            v_account_total;
    END IF;

    PERFORM a.attempt_id
    FROM public.mpesa_payment_attempts a
    WHERE a.attempt_status = 'PROMPT_ACCEPTED'
    ORDER BY a.attempt_id
    FOR UPDATE;

    PERFORM t.transaction_id
    FROM public.transactions t
    JOIN public.mpesa_payment_attempts a
      ON a.transaction_id = t.transaction_id
    WHERE a.attempt_status = 'PROMPT_ACCEPTED'
    ORDER BY t.transaction_id
    FOR UPDATE OF t;

    PERFORM c.contribution_id
    FROM public.contributions c
    JOIN public.mpesa_payment_attempts a
      ON a.contribution_id = c.contribution_id
    WHERE a.attempt_status = 'PROMPT_ACCEPTED'
    ORDER BY c.contribution_id
    FOR UPDATE OF c;

    PERFORM v.verification_id
    FROM public.mpesa_payment_verifications v
    JOIN public.mpesa_payment_attempts a
      ON a.attempt_id = v.attempt_id
    WHERE a.attempt_status = 'PROMPT_ACCEPTED'
    ORDER BY v.verification_id
    FOR UPDATE OF v;

    SELECT count(*) INTO v_historical_attempt_count
    FROM public.mpesa_payment_attempts a
    WHERE a.attempt_status = 'PROMPT_ACCEPTED';

    IF v_historical_attempt_count <> 2 THEN
        RAISE EXCEPTION
            'Ledger activation blocked: expected two historical PROMPT_ACCEPTED attempts, found %',
            v_historical_attempt_count;
    END IF;

    SELECT count(DISTINCT a.transaction_id),
           count(DISTINCT a.contribution_id)
    INTO v_distinct_historical_transaction_count,
         v_distinct_historical_contribution_count
    FROM public.mpesa_payment_attempts a
    WHERE a.attempt_status = 'PROMPT_ACCEPTED';

    IF v_distinct_historical_transaction_count <> 2
       OR v_distinct_historical_contribution_count <> 2 THEN
        RAISE EXCEPTION
            'Ledger activation blocked: historical attempts do not have distinct linked transactions and contributions';
    END IF;

    SELECT count(*) INTO v_invalid_historical_count
    FROM public.mpesa_payment_attempts a
    LEFT JOIN public.transactions t
      ON t.transaction_id = a.transaction_id
    LEFT JOIN public.contributions c
      ON c.contribution_id = a.contribution_id
    WHERE a.attempt_status = 'PROMPT_ACCEPTED'
      AND (
          t.transaction_id IS NULL
          OR t.transaction_type IS DISTINCT FROM 'CONTRIBUTION'
          OR t.transaction_status IS DISTINCT FROM 'COMPLETED'
          OR t.mpesa_result_code IS DISTINCT FROM 0
          OR t.completed_at IS NULL
          OR t.amount IS DISTINCT FROM a.expected_amount
          OR c.contribution_id IS NULL
          OR c.account_id IS DISTINCT FROM a.account_id
          OR c.transaction_id IS DISTINCT FROM a.transaction_id
          OR c.channel IS DISTINCT FROM 'MPESA'
          OR c.contribution_status IS DISTINCT FROM 'COMPLETED'
          OR c.amount IS DISTINCT FROM a.expected_amount
          OR NOT EXISTS (
              SELECT 1
              FROM public.mpesa_payment_verifications v
              WHERE v.attempt_id = a.attempt_id
                AND v.verification_source = 'RECONCILIATION'
                AND v.verification_status = 'VERIFIED_SUCCESS'
                AND v.provider_result_code = '0'
                AND v.completed_at IS NOT NULL
                AND v.checkout_request_id = a.checkout_request_id
                AND v.merchant_request_id = a.merchant_request_id
          )
      );

    IF v_invalid_historical_count <> 0 THEN
        RAISE EXCEPTION
            'Ledger activation blocked: a historical PROMPT_ACCEPTED attempt or linked completion evidence is inconsistent';
    END IF;

    SELECT count(*) INTO v_historical_simulator_count
    FROM public.simulator_payment_confirmations s
    WHERE EXISTS (
        SELECT 1
        FROM public.mpesa_payment_attempts a
        WHERE a.attempt_status = 'PROMPT_ACCEPTED'
          AND a.attempt_id = s.attempt_id
    )
       OR EXISTS (
        SELECT 1
        FROM public.mpesa_payment_verifications v
        JOIN public.mpesa_payment_attempts a
          ON a.attempt_id = v.attempt_id
        WHERE a.attempt_status = 'PROMPT_ACCEPTED'
          AND v.verification_id = s.verification_id
    );

    IF v_historical_simulator_count <> 0 THEN
        RAISE EXCEPTION
            'Ledger activation blocked: a historical attempt has simulator confirmation evidence';
    END IF;

    SELECT count(*) INTO v_historical_settlement_count
    FROM public.pension_account_movements m
    WHERE m.movement_type = 'CONTRIBUTION_SETTLEMENT'
      AND (
          EXISTS (
              SELECT 1
              FROM public.mpesa_payment_attempts a
              WHERE a.attempt_status = 'PROMPT_ACCEPTED'
                AND a.attempt_id = m.payment_attempt_id
          )
          OR EXISTS (
              SELECT 1
              FROM public.mpesa_payment_attempts a
              WHERE a.attempt_status = 'PROMPT_ACCEPTED'
                AND (
                    a.transaction_id = m.transaction_id
                    OR a.contribution_id = m.contribution_id
                    OR a.attempt_id = m.payment_attempt_id
                )
          )
          OR EXISTS (
              SELECT 1
              FROM public.mpesa_payment_verifications v
              JOIN public.mpesa_payment_attempts a
                ON a.attempt_id = v.attempt_id
              WHERE a.attempt_status = 'PROMPT_ACCEPTED'
                AND v.verification_id = m.payment_verification_id
          )
      );

    IF v_historical_settlement_count <> 0 THEN
        RAISE EXCEPTION
            'Ledger activation blocked: a historical attempt was replayed as a new settlement';
    END IF;

    SELECT count(*) INTO v_unresolved_attempt_count
    FROM public.mpesa_payment_attempts a
    WHERE a.attempt_status IN ('PENDING', 'OUTCOME_UNKNOWN');

    IF v_unresolved_attempt_count <> 0 THEN
        RAISE EXCEPTION
            'Ledger activation blocked: found % unresolved payment attempts',
            v_unresolved_attempt_count;
    END IF;

    UPDATE public.pension_ledger
    SET status = 'ACTIVE',
        activated_at = now()
    WHERE singleton_key IS TRUE
      AND ledger_id = v_ledger_id
      AND status = 'PREPARING';

    GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
    IF v_updated_rows <> 1 THEN
        RAISE EXCEPTION
            'Ledger activation blocked: the PREPARING singleton changed during activation';
    END IF;
END;
$activation$;

COMMIT;
