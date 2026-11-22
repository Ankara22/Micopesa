BEGIN;

LOCK TABLE mpesa_payment_attempts IN ACCESS EXCLUSIVE MODE;
LOCK TABLE pension_accounts IN SHARE MODE;

CREATE TEMP TABLE expected_mpesa_attempt_checks (
    attempt_status VARCHAR(25) NOT NULL,
    checkout_request_id VARCHAR(100),
    merchant_request_id VARCHAR(100),
    provider_accepted_at TIMESTAMPTZ,
    CONSTRAINT expected_attempt_status CHECK (attempt_status IN (
        'PENDING',
        'PROMPT_ACCEPTED',
        'OUTCOME_UNKNOWN',
        'FAILED',
        'CANCELLED',
        'TIMED_OUT'
    )),
    CONSTRAINT expected_accepted_timestamp CHECK (
        attempt_status <> 'PROMPT_ACCEPTED'
        OR (
            checkout_request_id IS NOT NULL
            AND merchant_request_id IS NOT NULL
            AND provider_accepted_at IS NOT NULL
        )
    )
) ON COMMIT DROP;

DO $preflight$
DECLARE
    status_attnum SMALLINT;
    checkout_attnum SMALLINT;
    merchant_attnum SMALLINT;
    accepted_attnum SMALLINT;
    actual_status_oid OID;
    actual_accepted_oid OID;
    expected_status_definition TEXT;
    expected_accepted_definition TEXT;
    status_definition TEXT;
    accepted_definition TEXT;
    relevant_check_count INTEGER;
BEGIN
    IF to_regclass('public.mpesa_payment_attempts') IS NULL
       OR to_regclass('public.pension_accounts') IS NULL
       OR to_regclass('public.transactions') IS NULL
       OR to_regclass('public.contributions') IS NULL
       OR to_regclass('public.mpesa_payment_verifications') IS NULL
       OR to_regclass('public.mpesa_callback_inbox') IS NULL THEN
        RAISE EXCEPTION 'A required existing payment or account table is missing';
    END IF;

    IF to_regclass('public.pension_ledger') IS NOT NULL
       OR to_regclass('public.pension_ledger_cutover_batches') IS NOT NULL
       OR to_regclass('public.pension_account_movements') IS NOT NULL
       OR to_regclass('public.simulator_payment_confirmations') IS NOT NULL THEN
        RAISE EXCEPTION 'A proposed ledger table already exists; inspect before migration';
    END IF;

    SELECT attnum INTO status_attnum
    FROM pg_attribute
    WHERE attrelid = 'public.mpesa_payment_attempts'::regclass
      AND attname = 'attempt_status'
      AND NOT attisdropped
      AND format_type(atttypid, atttypmod) = 'character varying(25)'
      AND attnotnull;
    SELECT attnum INTO checkout_attnum
    FROM pg_attribute
    WHERE attrelid = 'public.mpesa_payment_attempts'::regclass
      AND attname = 'checkout_request_id'
      AND NOT attisdropped
      AND format_type(atttypid, atttypmod) = 'character varying(100)'
      AND NOT attnotnull;
    SELECT attnum INTO merchant_attnum
    FROM pg_attribute
    WHERE attrelid = 'public.mpesa_payment_attempts'::regclass
      AND attname = 'merchant_request_id'
      AND NOT attisdropped
      AND format_type(atttypid, atttypmod) = 'character varying(100)'
      AND NOT attnotnull;
    SELECT attnum INTO accepted_attnum
    FROM pg_attribute
    WHERE attrelid = 'public.mpesa_payment_attempts'::regclass
      AND attname = 'provider_accepted_at'
      AND NOT attisdropped
      AND format_type(atttypid, atttypmod) = 'timestamp with time zone'
      AND NOT attnotnull;

    IF status_attnum IS NULL OR checkout_attnum IS NULL
       OR merchant_attnum IS NULL OR accepted_attnum IS NULL THEN
        RAISE EXCEPTION 'Payment-attempt columns do not match the reviewed schema';
    END IF;

    SELECT pg_get_constraintdef(oid, false) INTO expected_status_definition
    FROM pg_constraint
    WHERE conrelid = 'pg_temp.expected_mpesa_attempt_checks'::regclass
      AND conname = 'expected_attempt_status'
      AND convalidated;
    SELECT pg_get_constraintdef(oid, false) INTO expected_accepted_definition
    FROM pg_constraint
    WHERE conrelid = 'pg_temp.expected_mpesa_attempt_checks'::regclass
      AND conname = 'expected_accepted_timestamp'
      AND convalidated;

    SELECT count(*) INTO relevant_check_count
    FROM pg_constraint
    WHERE conrelid = 'public.mpesa_payment_attempts'::regclass
      AND contype = 'c'
      AND status_attnum = ANY(conkey);
    IF relevant_check_count <> 2 THEN
        RAISE EXCEPTION
            'Expected exactly the status-domain and accepted-timestamp checks; found %',
            relevant_check_count;
    END IF;

    SELECT oid, pg_get_constraintdef(oid, false)
      INTO actual_status_oid, status_definition
    FROM pg_constraint
    WHERE conrelid = 'public.mpesa_payment_attempts'::regclass
      AND contype = 'c'
      AND conkey = ARRAY[status_attnum]::SMALLINT[]
      AND convalidated;

    SELECT oid, pg_get_constraintdef(oid, false)
      INTO actual_accepted_oid, accepted_definition
    FROM pg_constraint
    WHERE conrelid = 'public.mpesa_payment_attempts'::regclass
      AND contype = 'c'
      AND cardinality(conkey) = 4
      AND status_attnum = ANY(conkey)
      AND checkout_attnum = ANY(conkey)
      AND merchant_attnum = ANY(conkey)
      AND accepted_attnum = ANY(conkey)
      AND convalidated;

    IF actual_status_oid IS NULL
       OR status_definition IS DISTINCT FROM expected_status_definition THEN
        RAISE EXCEPTION
            'The existing payment-attempt status check is not the reviewed six-status constraint';
    END IF;
    IF actual_accepted_oid IS NULL
       OR accepted_definition IS DISTINCT FROM expected_accepted_definition THEN
        RAISE EXCEPTION
            'The accepted-timestamp guard is missing, unvalidated, or differs from the reviewed definition';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM public.mpesa_payment_attempts
        WHERE attempt_status NOT IN (
            'PENDING', 'PROMPT_ACCEPTED', 'OUTCOME_UNKNOWN',
            'FAILED', 'CANCELLED', 'TIMED_OUT'
        )
    ) THEN
        RAISE EXCEPTION 'Payment attempts contain a status outside the reviewed legacy domain';
    END IF;

    EXECUTE format(
        'ALTER TABLE public.mpesa_payment_attempts DROP CONSTRAINT %I',
        (SELECT conname FROM pg_constraint WHERE oid = actual_status_oid)
    );
END;
$preflight$;

ALTER TABLE public.mpesa_payment_attempts
    ADD CONSTRAINT chk_mpesa_payment_attempt_status_settled
    CHECK (attempt_status IN (
        'PENDING',
        'PROMPT_ACCEPTED',
        'OUTCOME_UNKNOWN',
        'FAILED',
        'CANCELLED',
        'TIMED_OUT',
        'SETTLED'
    ));

CREATE TABLE public.pension_ledger (
    singleton_key BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton_key IS TRUE),
    ledger_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    status VARCHAR(15) NOT NULL CHECK (status IN ('PREPARING', 'ACTIVE', 'CLOSED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    CHECK (
        (status = 'PREPARING' AND activated_at IS NULL AND closed_at IS NULL)
        OR (status = 'ACTIVE' AND activated_at IS NOT NULL AND closed_at IS NULL)
        OR (status = 'CLOSED' AND closed_at IS NOT NULL)
    )
);

CREATE TABLE public.pension_ledger_cutover_batches (
    batch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ledger_id UUID NOT NULL REFERENCES public.pension_ledger (ledger_id) ON DELETE RESTRICT,
    batch_type VARCHAR(24) NOT NULL CHECK (batch_type = 'INITIAL_CUTOVER'),
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    provenance TEXT NOT NULL CHECK (length(trim(provenance)) > 0),
    migration_actor TEXT NOT NULL CHECK (length(trim(migration_actor)) > 0),
    UNIQUE (batch_id, ledger_id),
    UNIQUE (ledger_id, batch_type)
);

CREATE TABLE public.simulator_payment_confirmations (
    confirmation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id VARCHAR(25) NOT NULL
        REFERENCES public.mpesa_payment_attempts (attempt_id) ON DELETE RESTRICT,
    verification_id BIGINT
        REFERENCES public.mpesa_payment_verifications (verification_id) ON DELETE RESTRICT,
    record_type VARCHAR(12) NOT NULL CHECK (record_type IN ('INITIATION', 'CONFIRMATION')),
    provider_mode VARCHAR(20) NOT NULL DEFAULT 'SIMULATOR'
        CHECK (provider_mode = 'SIMULATOR'),
    outcome VARCHAR(10) CHECK (outcome IN ('SUCCESS', 'PENDING', 'FAILED', 'UNKNOWN')),
    checkout_request_id VARCHAR(100),
    merchant_request_id VARCHAR(100),
    synthetic_reference VARCHAR(100)
        CHECK (synthetic_reference IS NULL OR synthetic_reference ~ '^SIM[A-F0-9]{22}$'),
    initiated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at TIMESTAMPTZ,
    CHECK (
        (record_type = 'INITIATION'
            AND verification_id IS NULL
            AND outcome IS NULL
            AND confirmed_at IS NULL)
        OR
        (record_type = 'CONFIRMATION'
            AND verification_id IS NOT NULL
            AND outcome IS NOT NULL
            AND checkout_request_id IS NOT NULL
            AND merchant_request_id IS NOT NULL
            AND synthetic_reference IS NOT NULL
            AND confirmed_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX uq_simulator_initiation_per_attempt
    ON public.simulator_payment_confirmations (attempt_id)
    WHERE record_type = 'INITIATION';
CREATE UNIQUE INDEX uq_simulator_confirmation_per_verification
    ON public.simulator_payment_confirmations (verification_id)
    WHERE record_type = 'CONFIRMATION';

CREATE TABLE public.pension_account_movements (
    movement_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ledger_id UUID NOT NULL
        REFERENCES public.pension_ledger (ledger_id) ON DELETE RESTRICT,
    account_id VARCHAR(25) NOT NULL
        REFERENCES public.pension_accounts (account_id) ON DELETE RESTRICT,
    movement_type VARCHAR(24) NOT NULL
        CHECK (movement_type IN ('OPENING_BALANCE', 'CONTRIBUTION_SETTLEMENT')),
    amount NUMERIC(12,2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'KES' CHECK (currency = 'KES'),
    idempotency_key VARCHAR(160) NOT NULL UNIQUE,
    transaction_id VARCHAR(25)
        REFERENCES public.transactions (transaction_id) ON DELETE RESTRICT,
    contribution_id VARCHAR(25)
        REFERENCES public.contributions (contribution_id) ON DELETE RESTRICT,
    payment_attempt_id VARCHAR(25)
        REFERENCES public.mpesa_payment_attempts (attempt_id) ON DELETE RESTRICT,
    payment_verification_id BIGINT
        REFERENCES public.mpesa_payment_verifications (verification_id) ON DELETE RESTRICT,
    payment_callback_id BIGINT
        REFERENCES public.mpesa_callback_inbox (callback_id) ON DELETE RESTRICT,
    simulator_confirmation_id UUID
        REFERENCES public.simulator_payment_confirmations (confirmation_id) ON DELETE RESTRICT,
    cutover_batch_id UUID
        REFERENCES public.pension_ledger_cutover_batches (batch_id) ON DELETE RESTRICT,
    effective_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_type VARCHAR(10) NOT NULL CHECK (actor_type IN ('SYSTEM', 'MIGRATION')),
    actor_reference TEXT NOT NULL CHECK (length(trim(actor_reference)) > 0),
    provider_mode VARCHAR(20) NOT NULL
        CHECK (provider_mode IN ('MIGRATION', 'SIMULATOR', 'DARAJA')),
    CHECK (
        (movement_type = 'OPENING_BALANCE'
            AND amount >= 0
            AND provider_mode = 'MIGRATION'
            AND cutover_batch_id IS NOT NULL
            AND transaction_id IS NULL
            AND contribution_id IS NULL
            AND payment_attempt_id IS NULL
            AND payment_verification_id IS NULL
            AND payment_callback_id IS NULL
            AND simulator_confirmation_id IS NULL)
        OR
        (movement_type = 'CONTRIBUTION_SETTLEMENT'
            AND amount > 0
            AND provider_mode IN ('SIMULATOR', 'DARAJA')
            AND cutover_batch_id IS NULL
            AND transaction_id IS NOT NULL
            AND contribution_id IS NOT NULL
            AND payment_attempt_id IS NOT NULL
            AND payment_verification_id IS NOT NULL
            AND (
                (provider_mode = 'SIMULATOR'
                    AND simulator_confirmation_id IS NOT NULL
                    AND payment_callback_id IS NULL)
                OR
                (provider_mode = 'DARAJA'
                    AND simulator_confirmation_id IS NULL
                    AND payment_callback_id IS NOT NULL)
            ))
    ),
    UNIQUE (payment_attempt_id),
    UNIQUE (contribution_id)
);

CREATE INDEX idx_pension_account_movements_account_effective
    ON public.pension_account_movements (account_id, effective_at, movement_id);

INSERT INTO public.pension_ledger (singleton_key, status)
VALUES (TRUE, 'PREPARING');

WITH initial_batch AS (
    INSERT INTO public.pension_ledger_cutover_batches (
        ledger_id, batch_type, captured_at, provenance, migration_actor
    )
    SELECT ledger_id, 'INITIAL_CUTOVER', now(),
           'Opening balances copied from existing pension_accounts.current_balance; balances not re-credited.',
           current_user
    FROM public.pension_ledger
    WHERE singleton_key IS TRUE
    RETURNING batch_id, ledger_id, captured_at
)
INSERT INTO public.pension_account_movements (
    ledger_id, account_id, movement_type, amount, currency, idempotency_key,
    cutover_batch_id, effective_at, actor_type, actor_reference, provider_mode
)
SELECT b.ledger_id, p.account_id, 'OPENING_BALANCE', p.current_balance, 'KES',
       'opening-balance:' || p.account_id, b.batch_id, b.captured_at,
       'MIGRATION', 'migration_simulator_ledger_scoped_forward', 'MIGRATION'
FROM initial_batch b
CROSS JOIN public.pension_accounts p;

DO $postflight$
DECLARE
    status_attnum SMALLINT;
    checkout_attnum SMALLINT;
    merchant_attnum SMALLINT;
    status_definition TEXT;
    accepted_attnum SMALLINT;
    accepted_definition TEXT;
    expected_settled_definition TEXT;
    expected_accepted_definition TEXT;
    account_count BIGINT;
    opening_count BIGINT;
BEGIN
    CREATE TEMP TABLE expected_settled_attempt_check (
        attempt_status VARCHAR(25) NOT NULL,
        checkout_request_id VARCHAR(100),
        merchant_request_id VARCHAR(100),
        provider_accepted_at TIMESTAMPTZ,
        CONSTRAINT expected_settled_status CHECK (attempt_status IN (
            'PENDING', 'PROMPT_ACCEPTED', 'OUTCOME_UNKNOWN', 'FAILED',
            'CANCELLED', 'TIMED_OUT', 'SETTLED'
        )),
        CONSTRAINT expected_accepted_timestamp CHECK (
            attempt_status <> 'PROMPT_ACCEPTED'
            OR (
                checkout_request_id IS NOT NULL
                AND merchant_request_id IS NOT NULL
                AND provider_accepted_at IS NOT NULL
            )
        )
    ) ON COMMIT DROP;

    SELECT attnum INTO status_attnum
    FROM pg_attribute
    WHERE attrelid = 'public.mpesa_payment_attempts'::regclass
      AND attname = 'attempt_status'
      AND NOT attisdropped;
    SELECT attnum INTO checkout_attnum
    FROM pg_attribute
    WHERE attrelid = 'public.mpesa_payment_attempts'::regclass
      AND attname = 'checkout_request_id'
      AND NOT attisdropped;
    SELECT attnum INTO merchant_attnum
    FROM pg_attribute
    WHERE attrelid = 'public.mpesa_payment_attempts'::regclass
      AND attname = 'merchant_request_id'
      AND NOT attisdropped;
    SELECT attnum INTO accepted_attnum
    FROM pg_attribute
    WHERE attrelid = 'public.mpesa_payment_attempts'::regclass
      AND attname = 'provider_accepted_at'
      AND NOT attisdropped;

    SELECT pg_get_constraintdef(oid, false) INTO expected_settled_definition
    FROM pg_constraint
    WHERE conrelid = 'pg_temp.expected_settled_attempt_check'::regclass
      AND conname = 'expected_settled_status';
    SELECT pg_get_constraintdef(oid, false) INTO expected_accepted_definition
    FROM pg_constraint
    WHERE conrelid = 'pg_temp.expected_settled_attempt_check'::regclass
      AND conname = 'expected_accepted_timestamp';

    SELECT pg_get_constraintdef(oid, false) INTO status_definition
    FROM pg_constraint
    WHERE conrelid = 'public.mpesa_payment_attempts'::regclass
      AND conname = 'chk_mpesa_payment_attempt_status_settled'
      AND contype = 'c'
      AND conkey = ARRAY[status_attnum]::SMALLINT[]
      AND convalidated;
    SELECT pg_get_constraintdef(oid, false) INTO accepted_definition
    FROM pg_constraint
    WHERE conrelid = 'public.mpesa_payment_attempts'::regclass
      AND contype = 'c'
      AND cardinality(conkey) = 4
      AND status_attnum = ANY(conkey)
      AND checkout_attnum = ANY(conkey)
      AND merchant_attnum = ANY(conkey)
      AND accepted_attnum = ANY(conkey)
      AND convalidated;

    IF status_definition IS DISTINCT FROM expected_settled_definition
       OR accepted_definition IS DISTINCT FROM expected_accepted_definition THEN
        RAISE EXCEPTION 'Payment-attempt status constraint or accepted-timestamp guard failed postflight';
    END IF;

    SELECT count(*) INTO account_count FROM public.pension_accounts;
    SELECT count(*) INTO opening_count
    FROM public.pension_account_movements
    WHERE movement_type = 'OPENING_BALANCE';
    IF opening_count <> account_count THEN
        RAISE EXCEPTION
            'Expected one opening movement for each pension account; accounts %, movements %',
            account_count, opening_count;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.pension_ledger
        WHERE singleton_key IS TRUE
          AND (status <> 'PREPARING' OR activated_at IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'The new ledger must remain PREPARING after migration';
    END IF;
END;
$postflight$;

COMMIT;
