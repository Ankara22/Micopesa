BEGIN;

DO $preflight_table$
BEGIN
    IF to_regclass('public.mpesa_payment_attempts') IS NULL THEN
        RAISE EXCEPTION 'Required table public.mpesa_payment_attempts is missing';
    END IF;
END
$preflight_table$;

LOCK TABLE public.mpesa_payment_attempts IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE _expected_mpesa_attempt_constraints (
    attempt_id VARCHAR(25) PRIMARY KEY DEFAULT 'expected-attempt',
    account_id VARCHAR(25) NOT NULL,
    contribution_id VARCHAR(25) NOT NULL,
    transaction_id VARCHAR(25) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    expected_amount NUMERIC(12,2) NOT NULL
        CHECK (expected_amount > 0 AND expected_amount = trunc(expected_amount)),
    mpesa_phone VARCHAR(12) NOT NULL
        CHECK (mpesa_phone ~ '^254[17][0-9]{8}$'),
    -- Inline typed ANY is equivalent to the repository's inline IN list and
    -- generates the legacy catalog definition without hardcoding its deparse.
    attempt_status VARCHAR(25) NOT NULL DEFAULT 'PENDING'
        CONSTRAINT expected_legacy_status
        CHECK ((attempt_status)::text = ANY (ARRAY[
            ('PENDING'::character varying)::text,
            ('PROMPT_ACCEPTED'::character varying)::text,
            ('OUTCOME_UNKNOWN'::character varying)::text,
            ('FAILED'::character varying)::text,
            ('CANCELLED'::character varying)::text,
            ('TIMED_OUT'::character varying)::text
        ])),
    checkout_request_id VARCHAR(100),
    merchant_request_id VARCHAR(100),
    provider_result_code VARCHAR(30),
    provider_result_description VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    provider_accepted_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT expected_accepted_timestamp
        CHECK (
            attempt_status <> 'PROMPT_ACCEPTED'
            OR (
                checkout_request_id IS NOT NULL
                AND merchant_request_id IS NOT NULL
                AND provider_accepted_at IS NOT NULL
            )
        ),
    CONSTRAINT expected_settled_status
        CHECK (attempt_status IN (
            'PENDING',
            'PROMPT_ACCEPTED',
            'OUTCOME_UNKNOWN',
            'FAILED',
            'CANCELLED',
            'TIMED_OUT',
            'SETTLED'
        ))
) ON COMMIT DROP;

CREATE TEMP TABLE _mpesa_attempt_constraints_before ON COMMIT DROP AS
SELECT
    c.conname,
    c.contype,
    c.conkey,
    c.convalidated,
    c.condeferrable,
    c.condeferred,
    pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.conrelid = 'public.mpesa_payment_attempts'::regclass
  AND c.conname <> 'mpesa_payment_attempts_attempt_status_check';

DO $repair$
DECLARE
    v_status_attnum SMALLINT;
    v_checkout_attnum SMALLINT;
    v_merchant_attnum SMALLINT;
    v_accepted_at_attnum SMALLINT;

    v_expected_status_attnum SMALLINT;
    v_expected_checkout_attnum SMALLINT;
    v_expected_merchant_attnum SMALLINT;
    v_expected_accepted_at_attnum SMALLINT;

    v_legacy_type "char";
    v_legacy_columns SMALLINT[];
    v_legacy_validated BOOLEAN;
    v_legacy_definition TEXT;

    v_accepted_type "char";
    v_accepted_columns SMALLINT[];
    v_accepted_validated BOOLEAN;
    v_accepted_definition TEXT;

    v_expected_legacy_definition TEXT;
    v_expected_accepted_definition TEXT;
    v_expected_settled_definition TEXT;
    v_expected_status_columns SMALLINT[];
    v_expected_accepted_columns SMALLINT[];
    v_status_check_count INTEGER;
BEGIN
    IF EXISTS (
        SELECT 1
        FROM (
            VALUES
                ('attempt_status', 'character varying(25)', TRUE),
                ('checkout_request_id', 'character varying(100)', FALSE),
                ('merchant_request_id', 'character varying(100)', FALSE),
                ('provider_accepted_at', 'timestamp with time zone', FALSE)
        ) AS expected(column_name, expected_type, expected_not_null)
        LEFT JOIN pg_attribute a
          ON a.attrelid = 'public.mpesa_payment_attempts'::regclass
         AND a.attname = expected.column_name
         AND NOT a.attisdropped
        WHERE a.attnum IS NULL
           OR format_type(a.atttypid, a.atttypmod)
                IS DISTINCT FROM expected.expected_type
           OR a.attnotnull IS DISTINCT FROM expected.expected_not_null
    ) THEN
        RAISE EXCEPTION
            'Attempt status or accepted-timestamp columns have unexpected types or nullability';
    END IF;

    SELECT
        max(a.attnum) FILTER (WHERE a.attname = 'attempt_status'),
        max(a.attnum) FILTER (WHERE a.attname = 'checkout_request_id'),
        max(a.attnum) FILTER (WHERE a.attname = 'merchant_request_id'),
        max(a.attnum) FILTER (WHERE a.attname = 'provider_accepted_at')
    INTO
        v_status_attnum,
        v_checkout_attnum,
        v_merchant_attnum,
        v_accepted_at_attnum
    FROM pg_attribute a
    WHERE a.attrelid = 'public.mpesa_payment_attempts'::regclass
      AND NOT a.attisdropped;

    SELECT
        max(a.attnum) FILTER (WHERE a.attname = 'attempt_status'),
        max(a.attnum) FILTER (WHERE a.attname = 'checkout_request_id'),
        max(a.attnum) FILTER (WHERE a.attname = 'merchant_request_id'),
        max(a.attnum) FILTER (WHERE a.attname = 'provider_accepted_at')
    INTO
        v_expected_status_attnum,
        v_expected_checkout_attnum,
        v_expected_merchant_attnum,
        v_expected_accepted_at_attnum
    FROM pg_attribute a
    WHERE a.attrelid = 'pg_temp._expected_mpesa_attempt_constraints'::regclass
      AND NOT a.attisdropped;

    IF v_status_attnum IS DISTINCT FROM v_expected_status_attnum
       OR v_checkout_attnum IS DISTINCT FROM v_expected_checkout_attnum
       OR v_merchant_attnum IS DISTINCT FROM v_expected_merchant_attnum
       OR v_accepted_at_attnum IS DISTINCT FROM v_expected_accepted_at_attnum THEN
        RAISE EXCEPTION
            'Required payment-attempt columns are not in the expected repository order';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.mpesa_payment_attempts
        WHERE attempt_status IS NULL
           OR attempt_status NOT IN (
               'PENDING',
               'PROMPT_ACCEPTED',
               'OUTCOME_UNKNOWN',
               'FAILED',
               'CANCELLED',
               'TIMED_OUT',
               'SETTLED'
           )
    ) THEN
        RAISE EXCEPTION
            'NULL or unexpected attempt_status values exist; refusing to change constraints';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_constraint c
        WHERE c.conrelid = 'public.mpesa_payment_attempts'::regclass
          AND c.conname = 'chk_mpesa_payment_attempt_status'
    ) THEN
        RAISE EXCEPTION
            'Canonical constraint name chk_mpesa_payment_attempt_status is already in use';
    END IF;

    SELECT pg_get_constraintdef(c.oid), c.conkey
    INTO v_expected_legacy_definition, v_expected_status_columns
    FROM pg_constraint c
    WHERE c.conrelid = 'pg_temp._expected_mpesa_attempt_constraints'::regclass
      AND c.conname = 'expected_legacy_status';

    SELECT pg_get_constraintdef(c.oid), c.conkey
    INTO v_expected_accepted_definition, v_expected_accepted_columns
    FROM pg_constraint c
    WHERE c.conrelid = 'pg_temp._expected_mpesa_attempt_constraints'::regclass
      AND c.conname = 'expected_accepted_timestamp';

    SELECT pg_get_constraintdef(c.oid)
    INTO v_expected_settled_definition
    FROM pg_constraint c
    WHERE c.conrelid = 'pg_temp._expected_mpesa_attempt_constraints'::regclass
      AND c.conname = 'expected_settled_status';

    SELECT
        c.contype,
        c.conkey,
        c.convalidated,
        pg_get_constraintdef(c.oid)
    INTO
        v_legacy_type,
        v_legacy_columns,
        v_legacy_validated,
        v_legacy_definition
    FROM pg_constraint c
    WHERE c.conrelid = 'public.mpesa_payment_attempts'::regclass
      AND c.conname = 'mpesa_payment_attempts_attempt_status_check';

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Expected legacy constraint mpesa_payment_attempts_attempt_status_check is missing';
    END IF;

    IF v_legacy_type IS DISTINCT FROM 'c'
       OR v_legacy_columns IS DISTINCT FROM v_expected_status_columns THEN
        RAISE EXCEPTION
            'Legacy status constraint has an unexpected type or referenced columns';
    END IF;

    IF v_legacy_validated IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Legacy status constraint is not validated';
    END IF;

    IF v_legacy_definition IS DISTINCT FROM v_expected_legacy_definition THEN
        RAISE EXCEPTION
            'Legacy status constraint expression differs from the generated expected definition: %',
            v_legacy_definition;
    END IF;

    SELECT
        c.contype,
        c.conkey,
        c.convalidated,
        pg_get_constraintdef(c.oid)
    INTO
        v_accepted_type,
        v_accepted_columns,
        v_accepted_validated,
        v_accepted_definition
    FROM pg_constraint c
    WHERE c.conrelid = 'public.mpesa_payment_attempts'::regclass
      AND c.conname = 'chk_mpesa_payment_attempts_accepted_timestamp';

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Expected accepted-timestamp constraint is missing';
    END IF;

    IF v_accepted_type IS DISTINCT FROM 'c'
       OR v_accepted_columns IS DISTINCT FROM v_expected_accepted_columns THEN
        RAISE EXCEPTION
            'Accepted-timestamp constraint has an unexpected type or referenced columns';
    END IF;

    IF v_accepted_validated IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION
            'Accepted-timestamp constraint is not validated';
    END IF;

    IF v_accepted_definition IS DISTINCT FROM v_expected_accepted_definition THEN
        RAISE EXCEPTION
            'Accepted-timestamp constraint differs from the generated repository definition: %',
            v_accepted_definition;
    END IF;

    SELECT count(*)
    INTO v_status_check_count
    FROM pg_constraint c
    WHERE c.conrelid = 'public.mpesa_payment_attempts'::regclass
      AND c.contype = 'c'
      AND v_status_attnum = ANY(c.conkey);

    IF v_status_check_count <> 2
       OR EXISTS (
           SELECT 1
           FROM pg_constraint c
           WHERE c.conrelid = 'public.mpesa_payment_attempts'::regclass
             AND c.contype = 'c'
             AND v_status_attnum = ANY(c.conkey)
             AND c.conname NOT IN (
                 'mpesa_payment_attempts_attempt_status_check',
                 'chk_mpesa_payment_attempts_accepted_timestamp'
             )
       ) THEN
        RAISE EXCEPTION
            'Unexpected or ambiguous CHECK constraint references attempt_status';
    END IF;

    ALTER TABLE public.mpesa_payment_attempts
        DROP CONSTRAINT mpesa_payment_attempts_attempt_status_check;

    ALTER TABLE public.mpesa_payment_attempts
        ADD CONSTRAINT chk_mpesa_payment_attempt_status
        CHECK (attempt_status IN (
            'PENDING',
            'PROMPT_ACCEPTED',
            'OUTCOME_UNKNOWN',
            'FAILED',
            'CANCELLED',
            'TIMED_OUT',
            'SETTLED'
        ));

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        WHERE c.conrelid = 'public.mpesa_payment_attempts'::regclass
          AND c.conname = 'chk_mpesa_payment_attempts_accepted_timestamp'
          AND c.contype = 'c'
          AND c.convalidated
          AND c.conkey = v_expected_accepted_columns
          AND pg_get_constraintdef(c.oid) = v_expected_accepted_definition
    ) THEN
        RAISE EXCEPTION
            'Accepted-timestamp constraint changed or became invalid';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        WHERE c.conrelid = 'public.mpesa_payment_attempts'::regclass
          AND c.conname = 'chk_mpesa_payment_attempt_status'
          AND c.contype = 'c'
          AND c.convalidated
          AND c.conkey = v_expected_status_columns
          AND pg_get_constraintdef(c.oid) = v_expected_settled_definition
    ) THEN
        RAISE EXCEPTION
            'Replacement status constraint is missing or differs from its generated expected definition';
    END IF;

    SELECT count(*)
    INTO v_status_check_count
    FROM pg_constraint c
    WHERE c.conrelid = 'public.mpesa_payment_attempts'::regclass
      AND c.contype = 'c'
      AND v_status_attnum = ANY(c.conkey);

    IF v_status_check_count <> 2
       OR EXISTS (
           SELECT 1
           FROM pg_constraint c
           WHERE c.conrelid = 'public.mpesa_payment_attempts'::regclass
             AND c.contype = 'c'
             AND v_status_attnum = ANY(c.conkey)
             AND c.conname NOT IN (
                 'chk_mpesa_payment_attempt_status',
                 'chk_mpesa_payment_attempts_accepted_timestamp'
             )
       ) THEN
        RAISE EXCEPTION
            'Unexpected CHECK constraint remains on attempt_status';
    END IF;

    IF EXISTS (
        SELECT
            c.conname,
            c.contype,
            c.conkey,
            c.convalidated,
            c.condeferrable,
            c.condeferred,
            pg_get_constraintdef(c.oid)
        FROM pg_constraint c
        WHERE c.conrelid = 'public.mpesa_payment_attempts'::regclass
          AND c.conname <> 'chk_mpesa_payment_attempt_status'
        EXCEPT ALL
        SELECT
            s.conname,
            s.contype,
            s.conkey,
            s.convalidated,
            s.condeferrable,
            s.condeferred,
            s.definition
        FROM _mpesa_attempt_constraints_before s
    ) OR EXISTS (
        SELECT
            s.conname,
            s.contype,
            s.conkey,
            s.convalidated,
            s.condeferrable,
            s.condeferred,
            s.definition
        FROM _mpesa_attempt_constraints_before s
        EXCEPT ALL
        SELECT
            c.conname,
            c.contype,
            c.conkey,
            c.convalidated,
            c.condeferrable,
            c.condeferred,
            pg_get_constraintdef(c.oid)
        FROM pg_constraint c
        WHERE c.conrelid = 'public.mpesa_payment_attempts'::regclass
          AND c.conname <> 'chk_mpesa_payment_attempt_status'
    ) THEN
        RAISE EXCEPTION 'An unrelated payment-attempt constraint changed';
    END IF;
END
$repair$;

COMMIT;
