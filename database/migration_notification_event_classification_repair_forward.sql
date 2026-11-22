BEGIN;

DO $preflight_table$
BEGIN
    IF to_regclass('public.notifications') IS NULL THEN
        RAISE EXCEPTION 'Required table public.notifications is missing';
    END IF;
END
$preflight_table$;

LOCK TABLE public.notifications IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE _notification_event_expected_inline (
    notification_event_type VARCHAR(40)
        CONSTRAINT expected_notification_event_inline
        CHECK (notification_event_type IN (
            'CONTRIBUTION_CONFIRMED',
            'KYC_VERIFIED',
            'KYC_REJECTED',
            'RETIREMENT_PLAN_SAVED'
        ))
) ON COMMIT DROP;

CREATE TEMP TABLE _notification_event_expected_nullable (
    notification_event_type VARCHAR(40),
    CONSTRAINT expected_notification_event_nullable
        CHECK (
            notification_event_type IS NULL
            OR notification_event_type IN (
                'CONTRIBUTION_CONFIRMED',
                'KYC_VERIFIED',
                'KYC_REJECTED',
                'RETIREMENT_PLAN_SAVED'
            )
        )
) ON COMMIT DROP;

CREATE TEMP TABLE _notification_constraints_before ON COMMIT DROP AS
SELECT
    c.conname,
    c.contype,
    c.conkey,
    c.convalidated,
    c.condeferrable,
    c.condeferred,
    pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.conrelid = 'public.notifications'::regclass
  AND c.conname <> 'ck_notifications_event_type';

DO $repair$
DECLARE
    v_event_attnum SMALLINT;
    v_event_type TEXT;
    v_event_not_null BOOLEAN;
    v_event_default TEXT;

    v_constraint_exists BOOLEAN;
    v_constraint_type "char";
    v_constraint_columns SMALLINT[];
    v_constraint_validated BOOLEAN;
    v_constraint_definition TEXT;

    v_expected_inline_definition TEXT;
    v_expected_nullable_definition TEXT;
BEGIN
    SELECT pg_get_constraintdef(c.oid)
    INTO v_expected_inline_definition
    FROM pg_constraint c
    WHERE c.conrelid = 'pg_temp._notification_event_expected_inline'::regclass
      AND c.conname = 'expected_notification_event_inline';

    SELECT pg_get_constraintdef(c.oid)
    INTO v_expected_nullable_definition
    FROM pg_constraint c
    WHERE c.conrelid = 'pg_temp._notification_event_expected_nullable'::regclass
      AND c.conname = 'expected_notification_event_nullable';

    SELECT
        a.attnum,
        format_type(a.atttypid, a.atttypmod),
        a.attnotnull,
        pg_get_expr(d.adbin, d.adrelid)
    INTO
        v_event_attnum,
        v_event_type,
        v_event_not_null,
        v_event_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d
      ON d.adrelid = a.attrelid
     AND d.adnum = a.attnum
    WHERE a.attrelid = 'public.notifications'::regclass
      AND a.attname = 'notification_event_type'
      AND NOT a.attisdropped;

    IF v_event_attnum IS NOT NULL
       AND (
           v_event_type IS DISTINCT FROM 'character varying(40)'
           OR v_event_not_null IS DISTINCT FROM FALSE
           OR v_event_default IS NOT NULL
       ) THEN
        RAISE EXCEPTION
            'notification_event_type must be nullable VARCHAR(40) with no default';
    END IF;

    SELECT
        c.contype,
        c.conkey,
        c.convalidated,
        pg_get_constraintdef(c.oid)
    INTO
        v_constraint_type,
        v_constraint_columns,
        v_constraint_validated,
        v_constraint_definition
    FROM pg_constraint c
    WHERE c.conrelid = 'public.notifications'::regclass
      AND c.conname = 'ck_notifications_event_type';

    v_constraint_exists := FOUND;

    IF v_constraint_exists THEN
        IF v_event_attnum IS NULL
           OR v_constraint_type IS DISTINCT FROM 'c'
           OR v_constraint_columns IS DISTINCT FROM
                ARRAY[v_event_attnum]::SMALLINT[]
           OR v_constraint_validated IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION
                'ck_notifications_event_type does not match the historical event-column constraint';
        END IF;

        IF v_constraint_definition IS DISTINCT FROM v_expected_inline_definition
           AND v_constraint_definition IS DISTINCT FROM v_expected_nullable_definition THEN
            RAISE EXCEPTION
                'ck_notifications_event_type has an unexpected definition: %',
                v_constraint_definition;
        END IF;
    END IF;

    IF v_event_attnum IS NOT NULL AND EXISTS (
        SELECT 1
        FROM pg_constraint c
        WHERE c.conrelid = 'public.notifications'::regclass
          AND c.contype = 'c'
          AND v_event_attnum = ANY(c.conkey)
          AND c.conname <> 'ck_notifications_event_type'
    ) THEN
        RAISE EXCEPTION
            'An additional CHECK constraint references notification_event_type';
    END IF;

    IF v_constraint_exists THEN
        ALTER TABLE public.notifications
            DROP CONSTRAINT ck_notifications_event_type;
    END IF;

    IF v_event_attnum IS NULL THEN
        ALTER TABLE public.notifications
            ADD COLUMN notification_event_type VARCHAR(40);
    END IF;
END
$repair$;

DO $verify$
DECLARE
    v_event_attnum SMALLINT;
BEGIN
    SELECT a.attnum
    INTO v_event_attnum
    FROM pg_attribute a
    WHERE a.attrelid = 'public.notifications'::regclass
      AND a.attname = 'notification_event_type'
      AND NOT a.attisdropped;

    IF v_event_attnum IS NULL OR NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'notifications'
          AND column_name = 'notification_event_type'
          AND data_type = 'character varying'
          AND character_maximum_length = 40
          AND is_nullable = 'YES'
          AND column_default IS NULL
    ) THEN
        RAISE EXCEPTION
            'notification_event_type is not nullable VARCHAR(40) with no default';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_constraint c
        WHERE c.conrelid = 'public.notifications'::regclass
          AND c.conname = 'ck_notifications_event_type'
    ) OR EXISTS (
        SELECT 1
        FROM pg_constraint c
        WHERE c.conrelid = 'public.notifications'::regclass
          AND c.contype = 'c'
          AND v_event_attnum = ANY(c.conkey)
    ) THEN
        RAISE EXCEPTION
            'An event-column CHECK constraint remains after repair';
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
        WHERE c.conrelid = 'public.notifications'::regclass
          AND c.conname <> 'ck_notifications_event_type'
        EXCEPT ALL
        SELECT
            s.conname,
            s.contype,
            s.conkey,
            s.convalidated,
            s.condeferrable,
            s.condeferred,
            s.definition
        FROM _notification_constraints_before s
    ) OR EXISTS (
        SELECT
            s.conname,
            s.contype,
            s.conkey,
            s.convalidated,
            s.condeferrable,
            s.condeferred,
            s.definition
        FROM _notification_constraints_before s
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
        WHERE c.conrelid = 'public.notifications'::regclass
          AND c.conname <> 'ck_notifications_event_type'
    ) THEN
        RAISE EXCEPTION 'An unrelated notifications constraint changed';
    END IF;
END
$verify$;

COMMIT;
