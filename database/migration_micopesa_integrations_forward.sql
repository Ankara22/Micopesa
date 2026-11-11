-- Add only the integration objects missing from the audited Micopesa schema.
-- This is a one-time forward migration, not a replacement for schema.sql or
-- the historical migrations. It does not update or delete application rows.
BEGIN;

DO $preflight$
DECLARE
    required_table TEXT;
    required_column TEXT;
    notification_type_attnum SMALLINT;
    type_constraint RECORD;
    type_literals TEXT[];
    normalized_notification_type_constraint TEXT;
    notification_scope_fund_attnum SMALLINT;
    fund_id_attnum SMALLINT;
    legacy_type_constraint TEXT;
    compatible_type_constraint_found BOOLEAN := FALSE;
    status_constraint_definition TEXT;
    normalized_status_constraint TEXT;
    expected_column RECORD;
    actual_data_type TEXT;
    actual_max_length INTEGER;
    expected_preference_column RECORD;
    actual_preference_data_type TEXT;
    actual_preference_max_length INTEGER;
    actual_preference_nullable TEXT;
    actual_preference_identity TEXT;
    actual_preference_generated TEXT;
    actual_preference_default TEXT;
    normalized_preference_default TEXT;
    preference_column_count INTEGER;
    preference_user_attnum SMALLINT;
    users_user_attnum SMALLINT;
    preference_relation_kind "char";
    preference_trigger_count INTEGER;
    expected_callback_column RECORD;
    actual_callback_data_type TEXT;
    actual_callback_max_length INTEGER;
    actual_callback_numeric_precision INTEGER;
    actual_callback_numeric_scale INTEGER;
    actual_callback_nullable TEXT;
    actual_callback_identity TEXT;
    actual_callback_generated TEXT;
    actual_callback_default TEXT;
    normalized_callback_default TEXT;
    callback_column_count INTEGER;
    callback_id_attnum SMALLINT;
    callback_id_default_oid OID;
    callback_sequence_name TEXT;
    callback_sequence_oid OID;
    callback_relation_kind "char";
    expected_callback_constraint RECORD;
    actual_callback_constraint RECORD;
    normalized_callback_constraint TEXT;
    callback_constraint_literals TEXT[];
    callback_constraint_attnum SMALLINT;
    callback_reference_attnum SMALLINT;
    expected_callback_index RECORD;
    actual_callback_index RECORD;
    callback_trigger_count INTEGER;
    mobilesasa_relation_kind "char";
    expected_mobilesasa_column RECORD;
    actual_mobilesasa_data_type TEXT;
    actual_mobilesasa_max_length INTEGER;
    actual_mobilesasa_nullable TEXT;
    actual_mobilesasa_identity TEXT;
    actual_mobilesasa_generated TEXT;
    actual_mobilesasa_default TEXT;
    normalized_mobilesasa_default TEXT;
    mobilesasa_column_count INTEGER;
    mobilesasa_callback_attnum SMALLINT;
    mobilesasa_reference_attnum SMALLINT;
    expected_mobilesasa_constraint RECORD;
    actual_mobilesasa_constraint RECORD;
    normalized_mobilesasa_constraint TEXT;
    mobilesasa_constraint_literals TEXT[];
    expected_mobilesasa_index RECORD;
    actual_mobilesasa_index RECORD;
    mobilesasa_sequence_name TEXT;
    mobilesasa_sequence_oid OID;
    mobilesasa_callback_id_attnum SMALLINT;
    mobilesasa_callback_id_default_oid OID;
    mobilesasa_preserve_function_oid OID;
    mobilesasa_preserve_trigger_count INTEGER;
    mobilesasa_updated_trigger_count INTEGER;
    required_notification_columns TEXT[] := ARRAY[
        'notification_id',
        'user_id',
        'notification_type',
        'message',
        'recipient_phone',
        'deduplication_key',
        'provider_accepted_at',
        'delivered_at',
        'delivery_result',
        'delivery_status',
        'attempt_count',
        'next_attempt_at',
        'claimed_at',
        'claim_token',
        'last_attempt_at',
        'last_error_code',
        'notification_category',
        'created_at',
        'updated_at'
    ];
BEGIN
    FOREACH required_table IN ARRAY ARRAY[
        'notifications',
        'users',
        'funds',
        'notification_audit_events',
        'mpesa_payment_attempts',
        'mpesa_payment_verifications'
    ]
    LOOP
        IF to_regclass(required_table) IS NULL THEN
            RAISE EXCEPTION
                'Integration migration prerequisite missing: table % must exist',
                required_table;
        END IF;
    END LOOP;

    IF to_regprocedure('set_updated_at()') IS NULL THEN
        RAISE EXCEPTION
            'Integration migration prerequisite missing: set_updated_at() must exist';
    END IF;

    FOREACH required_column IN ARRAY required_notification_columns
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'notifications'
              AND column_name = required_column
        ) THEN
            RAISE EXCEPTION
                'Incompatible notifications schema: required column % is missing',
                required_column;
        END IF;
    END LOOP;

    FOR expected_column IN
        SELECT * FROM (VALUES
            ('notification_id', 'character varying', 25),
            ('user_id', 'character varying', 25),
            ('notification_type', 'character varying', 20),
            ('message', 'text', NULL::INTEGER),
            ('recipient_phone', 'character varying', 16),
            ('deduplication_key', 'character varying', 128),
            ('provider_accepted_at', 'timestamp with time zone', NULL::INTEGER),
            ('delivered_at', 'timestamp with time zone', NULL::INTEGER),
            ('delivery_result', 'jsonb', NULL::INTEGER),
            ('delivery_status', 'character varying', 20),
            ('attempt_count', 'integer', NULL::INTEGER),
            ('next_attempt_at', 'timestamp with time zone', NULL::INTEGER),
            ('claimed_at', 'timestamp with time zone', NULL::INTEGER),
            ('claim_token', 'uuid', NULL::INTEGER),
            ('last_attempt_at', 'timestamp with time zone', NULL::INTEGER),
            ('last_error_code', 'character varying', 64),
            ('notification_category', 'character varying', 40),
            ('created_at', 'timestamp with time zone', NULL::INTEGER),
            ('updated_at', 'timestamp with time zone', NULL::INTEGER),
            ('recipient_email', 'character varying', 254),
            ('email_subject', 'character varying', 255),
            ('email_html_body', 'text', NULL::INTEGER),
            ('push_title', 'character varying', 100),
            ('admin_request_key', 'uuid', NULL::INTEGER),
            ('scope_fund_id', 'character varying', 25),
            ('provider_message_id', 'character varying', 128)
        ) AS expected(name, data_type, max_length)
    LOOP
        SELECT data_type, character_maximum_length
        INTO actual_data_type, actual_max_length
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'notifications'
          AND column_name = expected_column.name;
        IF FOUND AND (
            actual_data_type <> expected_column.data_type
            OR actual_max_length IS DISTINCT FROM expected_column.max_length
        ) THEN
            RAISE EXCEPTION
                'Incompatible notifications schema: column % has an unexpected type',
                expected_column.name;
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'notifications'
          AND column_name = 'scope_fund_id'
    ) THEN
        SELECT attnum INTO notification_scope_fund_attnum
        FROM pg_attribute
        WHERE attrelid = to_regclass('notifications')
          AND attname = 'scope_fund_id'
          AND NOT attisdropped;
        SELECT attnum INTO fund_id_attnum
        FROM pg_attribute
        WHERE attrelid = to_regclass('funds')
          AND attname = 'fund_id'
          AND NOT attisdropped;
        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint constraint_data
            WHERE constraint_data.conrelid = to_regclass('notifications')
              AND constraint_data.contype = 'f'
              AND constraint_data.convalidated
              AND NOT constraint_data.condeferrable
              AND NOT constraint_data.condeferred
              AND constraint_data.conkey = ARRAY[notification_scope_fund_attnum]::SMALLINT[]
              AND constraint_data.confrelid = to_regclass('funds')
              AND constraint_data.confkey = ARRAY[fund_id_attnum]::SMALLINT[]
              AND constraint_data.confmatchtype = 's'
              AND constraint_data.confupdtype = 'a'
              AND constraint_data.confdeltype = 'n'
              AND EXISTS (
                  SELECT 1
                  FROM pg_attribute local_column
                  JOIN pg_attribute referenced_column
                    ON referenced_column.attrelid = constraint_data.confrelid
                   AND referenced_column.attnum = fund_id_attnum
                  WHERE local_column.attrelid = constraint_data.conrelid
                    AND local_column.attnum = notification_scope_fund_attnum
                    AND local_column.atttypid = referenced_column.atttypid
                    AND local_column.atttypmod = referenced_column.atttypmod
              )
        ) THEN
            RAISE EXCEPTION
                'Incompatible notifications schema: scope_fund_id must reference funds(fund_id) ON DELETE SET NULL';
        END IF;
    END IF;

    IF to_regclass('notification_preferences') IS NOT NULL THEN
        SELECT relation.relkind
        INTO preference_relation_kind
        FROM pg_class relation
        WHERE relation.oid = to_regclass('notification_preferences');
        IF preference_relation_kind <> 'r' THEN
            RAISE EXCEPTION
                'Incompatible notification_preferences: expected a regular table';
        END IF;

        SELECT count(*)::INTEGER
        INTO preference_column_count
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'notification_preferences';
        IF preference_column_count <> 5 THEN
            RAISE EXCEPTION
                'Incompatible notification_preferences: expected exactly 5 columns, found %',
                preference_column_count;
        END IF;

        FOR expected_preference_column IN
            SELECT * FROM (VALUES
                ('user_id', 'character varying', 25, NULL::TEXT),
                ('sms_enabled', 'boolean', NULL::INTEGER, 'false'),
                ('email_enabled', 'boolean', NULL::INTEGER, 'false'),
                ('created_at', 'timestamp with time zone', NULL::INTEGER, 'now'),
                ('updated_at', 'timestamp with time zone', NULL::INTEGER, 'now')
            ) AS expected(name, data_type, max_length, default_expression)
        LOOP
            SELECT column_info.data_type,
                   column_info.character_maximum_length,
                   column_info.is_nullable,
                   column_info.is_identity,
                   column_info.is_generated,
                   pg_get_expr(column_default.adbin, column_default.adrelid)
            INTO actual_preference_data_type,
                 actual_preference_max_length,
                 actual_preference_nullable,
                 actual_preference_identity,
                 actual_preference_generated,
                 actual_preference_default
            FROM information_schema.columns column_info
            LEFT JOIN pg_namespace relation_schema
              ON relation_schema.nspname = column_info.table_schema
            LEFT JOIN pg_class relation
              ON relation.relnamespace = relation_schema.oid
             AND relation.relname = column_info.table_name
            LEFT JOIN pg_attribute attribute
              ON attribute.attrelid = relation.oid
             AND attribute.attname = column_info.column_name
             AND NOT attribute.attisdropped
            LEFT JOIN pg_attrdef column_default
              ON column_default.adrelid = relation.oid
             AND column_default.adnum = attribute.attnum
            WHERE column_info.table_schema = current_schema()
              AND column_info.table_name = 'notification_preferences'
              AND column_info.column_name = expected_preference_column.name;

            IF NOT FOUND THEN
                RAISE EXCEPTION
                    'Incompatible notification_preferences: required column % is missing',
                    expected_preference_column.name;
            END IF;
            IF actual_preference_data_type <> expected_preference_column.data_type
               OR actual_preference_max_length IS DISTINCT FROM expected_preference_column.max_length THEN
                RAISE EXCEPTION
                    'Incompatible notification_preferences: column % has an unexpected type',
                    expected_preference_column.name;
            END IF;
            IF actual_preference_nullable <> 'NO' THEN
                RAISE EXCEPTION
                    'Incompatible notification_preferences: column % must be NOT NULL',
                    expected_preference_column.name;
            END IF;
            IF actual_preference_identity <> 'NO'
               OR actual_preference_generated <> 'NEVER' THEN
                RAISE EXCEPTION
                    'Incompatible notification_preferences: column % must not be generated or identity-backed',
                    expected_preference_column.name;
            END IF;

            normalized_preference_default := CASE
                WHEN actual_preference_default IS NULL THEN NULL
                ELSE regexp_replace(
                    regexp_replace(
                        lower(actual_preference_default),
                        '::(pg_catalog\.)?(boolean|timestamp with time zone|timestamptz)',
                        '',
                        'g'
                    ),
                    '[()[:space:]]',
                    '',
                    'g'
                )
            END;
            IF normalized_preference_default IS DISTINCT FROM
               expected_preference_column.default_expression THEN
                RAISE EXCEPTION
                    'Incompatible notification_preferences: column % has an unexpected default',
                    expected_preference_column.name;
            END IF;
        END LOOP;

        IF EXISTS (
            SELECT 1
            FROM unnest(ARRAY[
                'created_at', 'email_enabled', 'sms_enabled', 'updated_at', 'user_id'
            ]::TEXT[]) AS expected_not_null(column_name)
            JOIN pg_attribute attribute
              ON attribute.attrelid = to_regclass('notification_preferences')
             AND attribute.attname = expected_not_null.column_name
             AND NOT attribute.attisdropped
            WHERE NOT EXISTS (
                SELECT 1
                FROM pg_constraint constraint_data
                WHERE constraint_data.conrelid = to_regclass('notification_preferences')
                  AND constraint_data.contype::TEXT = 'n'
                  AND constraint_data.conkey = ARRAY[attribute.attnum]::SMALLINT[]
            )
        ) THEN
            RAISE EXCEPTION
                'Incompatible notification_preferences: a required PostgreSQL NOT NULL constraint is missing';
        END IF;

        SELECT attribute.attnum
        INTO preference_user_attnum
        FROM pg_attribute attribute
        WHERE attribute.attrelid = to_regclass('notification_preferences')
          AND attribute.attname = 'user_id'
          AND NOT attribute.attisdropped;
        SELECT attribute.attnum
        INTO users_user_attnum
        FROM pg_attribute attribute
        WHERE attribute.attrelid = to_regclass('users')
          AND attribute.attname = 'user_id'
          AND NOT attribute.attisdropped;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint constraint_data
            WHERE constraint_data.conrelid = to_regclass('notification_preferences')
              AND constraint_data.conname = 'notification_preferences_pkey'
              AND constraint_data.contype = 'p'
              AND constraint_data.convalidated
              AND NOT constraint_data.condeferrable
              AND NOT constraint_data.condeferred
              AND constraint_data.conkey = ARRAY[preference_user_attnum]::SMALLINT[]
        ) THEN
            RAISE EXCEPTION
                'Incompatible notification_preferences: primary key must contain only user_id';
        END IF;
        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint constraint_data
            WHERE constraint_data.conrelid = to_regclass('notification_preferences')
              AND constraint_data.conname = 'notification_preferences_user_id_fkey'
              AND constraint_data.contype = 'f'
              AND constraint_data.convalidated
              AND NOT constraint_data.condeferrable
              AND NOT constraint_data.condeferred
              AND constraint_data.conkey = ARRAY[preference_user_attnum]::SMALLINT[]
              AND constraint_data.confrelid = to_regclass('users')
              AND constraint_data.confkey = ARRAY[users_user_attnum]::SMALLINT[]
              AND constraint_data.confmatchtype = 's'
              AND constraint_data.confupdtype = 'a'
              AND constraint_data.confdeltype = 'c'
              AND EXISTS (
                  SELECT 1
                  FROM pg_attribute local_column
                  JOIN pg_attribute referenced_column
                    ON referenced_column.attrelid = constraint_data.confrelid
                   AND referenced_column.attnum = users_user_attnum
                  WHERE local_column.attrelid = constraint_data.conrelid
                    AND local_column.attnum = preference_user_attnum
                    AND local_column.atttypid = referenced_column.atttypid
                    AND local_column.atttypmod = referenced_column.atttypmod
              )
        ) THEN
            RAISE EXCEPTION
                'Incompatible notification_preferences: user_id must reference users(user_id) ON DELETE CASCADE';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM pg_constraint constraint_data
            WHERE constraint_data.conrelid = to_regclass('notification_preferences')
              AND constraint_data.contype::TEXT IN ('p', 'u', 'f', 'c')
              AND constraint_data.conname NOT IN (
                  'notification_preferences_pkey',
                  'notification_preferences_user_id_fkey'
              )
              AND NOT constraint_data.convalidated
        ) THEN
            RAISE EXCEPTION
                'Incompatible notification_preferences: an additional legacy structural constraint is unvalidated';
        END IF;

        SELECT count(*) FILTER (
                   WHERE trigger_data.tgname = 'trg_notification_preferences_set_updated_at'
                     AND trigger_data.tgenabled IN ('O', 'A')
                     AND trigger_data.tgtype = 19
                     AND trigger_data.tgattr = ''::int2vector
                     AND trigger_data.tgnargs = 0
                     AND trigger_data.tgqual IS NULL
                     AND trigger_data.tgfoid = to_regprocedure('set_updated_at()')
               )::INTEGER
        INTO preference_trigger_count
        FROM pg_trigger trigger_data
        WHERE trigger_data.tgrelid = to_regclass('notification_preferences')
          AND NOT trigger_data.tgisinternal;
        IF preference_trigger_count > 1 OR EXISTS (
            SELECT 1
            FROM pg_trigger trigger_data
            WHERE trigger_data.tgrelid = to_regclass('notification_preferences')
              AND trigger_data.tgname = 'trg_notification_preferences_set_updated_at'
              AND NOT trigger_data.tgisinternal
              AND NOT (
                  trigger_data.tgenabled IN ('O', 'A')
                  AND trigger_data.tgtype = 19
                  AND trigger_data.tgattr = ''::int2vector
                  AND trigger_data.tgnargs = 0
                  AND trigger_data.tgqual IS NULL
                  AND trigger_data.tgfoid = to_regprocedure('set_updated_at()')
              )
        ) THEN
            RAISE EXCEPTION
                'Incompatible notification_preferences: trigger trg_notification_preferences_set_updated_at has an unexpected definition';
        END IF;
    END IF;
    IF to_regclass('mpesa_callback_inbox') IS NOT NULL THEN
        SELECT relation.relkind
        INTO callback_relation_kind
        FROM pg_class relation
        WHERE relation.oid = to_regclass('mpesa_callback_inbox');
        IF callback_relation_kind <> 'r' THEN
            RAISE EXCEPTION
                'Incompatible mpesa_callback_inbox: expected a regular table';
        END IF;

        SELECT count(*)::INTEGER
        INTO callback_column_count
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'mpesa_callback_inbox';
        IF callback_column_count <> 17 THEN
            RAISE EXCEPTION
                'Incompatible mpesa_callback_inbox: expected exactly 17 columns, found %',
                callback_column_count;
        END IF;

        FOR expected_callback_column IN
            SELECT * FROM (VALUES
                ('callback_id', 'bigint', NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, 'NO', 'sequence'),
                ('callback_fingerprint', 'character', 64, NULL::INTEGER, NULL::INTEGER, 'NO', NULL::TEXT),
                ('checkout_request_id', 'character varying', 100, NULL::INTEGER, NULL::INTEGER, 'NO', NULL::TEXT),
                ('merchant_request_id', 'character varying', 100, NULL::INTEGER, NULL::INTEGER, 'NO', NULL::TEXT),
                ('callback_result_code', 'character varying', 30, NULL::INTEGER, NULL::INTEGER, 'NO', NULL::TEXT),
                ('callback_amount', 'numeric', NULL::INTEGER, 12, 2, 'YES', NULL::TEXT),
                ('callback_phone', 'character varying', 12, NULL::INTEGER, NULL::INTEGER, 'YES', NULL::TEXT),
                ('callback_receipt', 'character varying', 25, NULL::INTEGER, NULL::INTEGER, 'YES', NULL::TEXT),
                ('callback_status', 'character varying', 20, NULL::INTEGER, NULL::INTEGER, 'NO', '''unmatched'''),
                ('attempt_id', 'character varying', 25, NULL::INTEGER, NULL::INTEGER, 'YES', NULL::TEXT),
                ('verification_id', 'bigint', NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, 'YES', NULL::TEXT),
                ('rejection_code', 'character varying', 64, NULL::INTEGER, NULL::INTEGER, 'YES', NULL::TEXT),
                ('duplicate_count', 'integer', NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, 'NO', '0'),
                ('received_at', 'timestamp with time zone', NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, 'NO', 'now'),
                ('correlated_at', 'timestamp with time zone', NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, 'YES', NULL::TEXT),
                ('verified_at', 'timestamp with time zone', NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, 'YES', NULL::TEXT),
                ('updated_at', 'timestamp with time zone', NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, 'NO', 'now')
            ) AS expected(name, data_type, max_length, numeric_precision,
                          numeric_scale, is_nullable, default_expression)
        LOOP
            SELECT column_info.data_type,
                   column_info.character_maximum_length,
                   column_info.numeric_precision,
                   column_info.numeric_scale,
                   column_info.is_nullable,
                   column_info.is_identity,
                   column_info.is_generated,
                   pg_get_expr(column_default.adbin, column_default.adrelid)
            INTO actual_callback_data_type,
                 actual_callback_max_length,
                 actual_callback_numeric_precision,
                 actual_callback_numeric_scale,
                 actual_callback_nullable,
                 actual_callback_identity,
                 actual_callback_generated,
                 actual_callback_default
            FROM information_schema.columns column_info
            LEFT JOIN pg_namespace relation_schema
              ON relation_schema.nspname = column_info.table_schema
            LEFT JOIN pg_class relation
              ON relation.relnamespace = relation_schema.oid
             AND relation.relname = column_info.table_name
            LEFT JOIN pg_attribute attribute
              ON attribute.attrelid = relation.oid
             AND attribute.attname = column_info.column_name
             AND NOT attribute.attisdropped
            LEFT JOIN pg_attrdef column_default
              ON column_default.adrelid = relation.oid
             AND column_default.adnum = attribute.attnum
            WHERE column_info.table_schema = current_schema()
              AND column_info.table_name = 'mpesa_callback_inbox'
              AND column_info.column_name = expected_callback_column.name;

            IF NOT FOUND THEN
                RAISE EXCEPTION
                    'Incompatible mpesa_callback_inbox: required column % is missing',
                    expected_callback_column.name;
            END IF;
            IF actual_callback_data_type <> expected_callback_column.data_type
               OR actual_callback_max_length IS DISTINCT FROM expected_callback_column.max_length
               OR (
                   expected_callback_column.data_type = 'numeric'
                   AND (
                       actual_callback_numeric_precision IS DISTINCT FROM expected_callback_column.numeric_precision
                       OR actual_callback_numeric_scale IS DISTINCT FROM expected_callback_column.numeric_scale
                   )
               ) THEN
                RAISE EXCEPTION
                    'Incompatible mpesa_callback_inbox: column % has an unexpected type or length',
                    expected_callback_column.name;
            END IF;
            IF actual_callback_nullable <> expected_callback_column.is_nullable THEN
                RAISE EXCEPTION
                    'Incompatible mpesa_callback_inbox: column % has unexpected nullability',
                    expected_callback_column.name;
            END IF;
            IF actual_callback_identity <> 'NO'
               OR actual_callback_generated <> 'NEVER' THEN
                RAISE EXCEPTION
                    'Incompatible mpesa_callback_inbox: column % must not be generated or identity-backed',
                    expected_callback_column.name;
            END IF;

            IF expected_callback_column.default_expression = 'sequence' THEN
                IF actual_callback_default IS NULL
                   OR actual_callback_default NOT LIKE 'nextval(%' THEN
                    RAISE EXCEPTION
                        'Incompatible mpesa_callback_inbox: callback_id must have a sequence-backed default';
                END IF;
            ELSE
                normalized_callback_default := CASE
                    WHEN actual_callback_default IS NULL THEN NULL
                    ELSE regexp_replace(
                        regexp_replace(
                            lower(actual_callback_default),
                            '::(pg_catalog\.)?(character varying|timestamp with time zone|timestamptz|integer)',
                            '',
                            'g'
                        ),
                        '[()[:space:]]',
                        '',
                        'g'
                    )
                END;
                IF normalized_callback_default IS DISTINCT FROM
                   expected_callback_column.default_expression THEN
                    RAISE EXCEPTION
                        'Incompatible mpesa_callback_inbox: column % has an unexpected default',
                        expected_callback_column.name;
                END IF;
            END IF;
        END LOOP;

        SELECT attribute.attnum, column_default.oid
        INTO callback_id_attnum, callback_id_default_oid
        FROM pg_attribute attribute
        JOIN pg_attrdef column_default
          ON column_default.adrelid = attribute.attrelid
         AND column_default.adnum = attribute.attnum
        WHERE attribute.attrelid = to_regclass('mpesa_callback_inbox')
          AND attribute.attname = 'callback_id'
          AND NOT attribute.attisdropped;
        callback_sequence_name := pg_get_serial_sequence(
            'mpesa_callback_inbox',
            'callback_id'
        );
        callback_sequence_oid := to_regclass(callback_sequence_name);
        IF callback_sequence_name IS NULL
           OR callback_sequence_oid IS NULL
           OR callback_id_attnum IS NULL
           OR NOT EXISTS (
               SELECT 1
               FROM pg_class sequence_relation
               WHERE sequence_relation.oid = callback_sequence_oid
                 AND sequence_relation.relkind = 'S'
           )
           OR NOT EXISTS (
               SELECT 1
               FROM pg_sequence sequence_definition
               WHERE sequence_definition.seqrelid = callback_sequence_oid
                 AND sequence_definition.seqtypid = 'bigint'::regtype
                 AND sequence_definition.seqstart = 1
                 AND sequence_definition.seqincrement = 1
                 AND sequence_definition.seqmin = 1
                 AND sequence_definition.seqmax = 9223372036854775807
                 AND sequence_definition.seqcache = 1
                 AND NOT sequence_definition.seqcycle
           )
           OR NOT EXISTS (
               SELECT 1
               FROM pg_depend sequence_ownership
               WHERE sequence_ownership.classid = 'pg_class'::regclass
                 AND sequence_ownership.objid = callback_sequence_oid
                 AND sequence_ownership.refclassid = 'pg_class'::regclass
                 AND sequence_ownership.refobjid = to_regclass('mpesa_callback_inbox')
                 AND sequence_ownership.refobjsubid = callback_id_attnum
                 AND sequence_ownership.deptype IN ('a', 'i')
           )
           OR NOT EXISTS (
               SELECT 1
               FROM pg_depend default_dependency
               WHERE default_dependency.classid = 'pg_attrdef'::regclass
                 AND default_dependency.objid = callback_id_default_oid
                 AND default_dependency.refclassid = 'pg_class'::regclass
                 AND default_dependency.refobjid = callback_sequence_oid
           ) THEN
            RAISE EXCEPTION
                'Incompatible mpesa_callback_inbox: callback_id sequence is missing, unowned, or not used by its default';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM unnest(ARRAY[
                'callback_fingerprint',
                'callback_id',
                'callback_result_code',
                'callback_status',
                'checkout_request_id',
                'duplicate_count',
                'merchant_request_id',
                'received_at',
                'updated_at'
            ]::TEXT[]) AS expected_not_null(column_name)
            JOIN pg_attribute attribute
              ON attribute.attrelid = to_regclass('mpesa_callback_inbox')
             AND attribute.attname = expected_not_null.column_name
             AND NOT attribute.attisdropped
            WHERE NOT EXISTS (
                SELECT 1
                FROM pg_constraint constraint_data
                WHERE constraint_data.conrelid = to_regclass('mpesa_callback_inbox')
                  AND constraint_data.contype::TEXT = 'n'
                  AND constraint_data.conkey = ARRAY[attribute.attnum]::SMALLINT[]
            )
        ) THEN
            RAISE EXCEPTION
                'Incompatible mpesa_callback_inbox: a required PostgreSQL NOT NULL constraint is missing';
        END IF;

        FOR expected_callback_constraint IN
            SELECT * FROM (VALUES
                ('mpesa_callback_inbox_pkey', 'p', NULL::TEXT, NULL::TEXT[]),
                ('mpesa_callback_inbox_callback_fingerprint_key', 'u', NULL::TEXT, NULL::TEXT[]),
                ('mpesa_callback_inbox_callback_fingerprint_check', 'c',
                    'checkcallback_fingerprint~''^[a-f0-9]{64}$''',
                    ARRAY['^[a-f0-9]{64}$']::TEXT[]),
                ('mpesa_callback_inbox_checkout_request_id_check', 'c',
                    'checkcheckout_request_id~''^[a-za-z0-9_-]{1,100}$''',
                    ARRAY['^[A-Za-z0-9_-]{1,100}$']::TEXT[]),
                ('mpesa_callback_inbox_merchant_request_id_check', 'c',
                    'checkmerchant_request_id~''^[a-za-z0-9_-]{1,100}$''',
                    ARRAY['^[A-Za-z0-9_-]{1,100}$']::TEXT[]),
                ('mpesa_callback_inbox_callback_result_code_check', 'c',
                    'checkcallback_result_code~''^-?[0-9]{1,30}$''',
                    ARRAY['^-?[0-9]{1,30}$']::TEXT[]),
                ('mpesa_callback_inbox_callback_phone_check', 'c',
                    'checkcallback_phoneisnullorcallback_phone~''^254[17][0-9]{8}$''',
                    ARRAY['^254[17][0-9]{8}$']::TEXT[]),
                ('mpesa_callback_inbox_callback_receipt_check', 'c',
                    'checkcallback_receiptisnullorcallback_receipt~''^[a-za-z0-9]{1,25}$''',
                    ARRAY['^[A-Za-z0-9]{1,25}$']::TEXT[]),
                ('mpesa_callback_inbox_callback_status_check', 'c',
                    'checkcallback_status=anyarray[''unmatched'',''correlated'',''verified'',''rejected'']',
                    ARRAY['CORRELATED', 'REJECTED', 'UNMATCHED', 'VERIFIED']::TEXT[]),
                ('mpesa_callback_inbox_duplicate_count_check', 'c',
                    'checkduplicate_count>=0', NULL::TEXT[]),
                ('ck_mpesa_callback_success_metadata', 'c',
                    'checkcallback_result_code<>''0''orcallback_amountisnotnullandcallback_amount>0andcallback_amount=trunccallback_amountandcallback_phoneisnotnullandcallback_receiptisnotnull',
                    ARRAY['0']::TEXT[]),
                ('ck_mpesa_callback_lifecycle', 'c',
                    'checkcallback_status=''unmatched''andattempt_idisnullandverification_idisnullandrejection_codeisnullorcallback_status=''correlated''andattempt_idisnotnullandverification_idisnullandcorrelated_atisnotnullandrejection_codeisnullorcallback_status=''verified''andattempt_idisnotnullandverification_idisnotnullandcorrelated_atisnotnullandverified_atisnotnullandrejection_codeisnullorcallback_status=''rejected''andrejection_codeisnotnull',
                    ARRAY['CORRELATED', 'REJECTED', 'UNMATCHED', 'VERIFIED']::TEXT[]),
                ('mpesa_callback_inbox_attempt_id_fkey', 'f', NULL::TEXT, NULL::TEXT[]),
                ('mpesa_callback_inbox_verification_id_fkey', 'f', NULL::TEXT, NULL::TEXT[])
            ) AS expected(name, constraint_type, normalized_definition, expected_literals)
        LOOP
            SELECT constraint_data.*
            INTO actual_callback_constraint
            FROM pg_constraint constraint_data
            WHERE constraint_data.conrelid = to_regclass('mpesa_callback_inbox')
              AND constraint_data.conname = expected_callback_constraint.name;
            IF NOT FOUND THEN
                RAISE EXCEPTION
                    'Incompatible mpesa_callback_inbox: required constraint % is missing',
                    expected_callback_constraint.name;
            END IF;
            IF actual_callback_constraint.contype <> expected_callback_constraint.constraint_type
               OR actual_callback_constraint.condeferrable
               OR actual_callback_constraint.condeferred
               OR (expected_callback_constraint.constraint_type IN ('c', 'f')
                   AND NOT actual_callback_constraint.convalidated) THEN
                RAISE EXCEPTION
                    'Incompatible mpesa_callback_inbox: constraint % has an unexpected type or is not validated',
                    expected_callback_constraint.name;
            END IF;
            IF expected_callback_constraint.constraint_type = 'c' THEN
                IF expected_callback_constraint.normalized_definition IS NOT NULL THEN
                    -- Preserve literal case; lowercasing a CHECK definition can hide semantic changes.
                    SELECT array_agg(literal_value ORDER BY literal_value)
                    INTO callback_constraint_literals
                    FROM (
                        SELECT captures[1] AS literal_value
                        FROM regexp_matches(
                            pg_get_constraintdef(actual_callback_constraint.oid),
                            '''([^'']*)''',
                            'g'
                        ) AS matches(captures)
                    ) AS literals;
                    IF callback_constraint_literals IS DISTINCT FROM
                       expected_callback_constraint.expected_literals THEN
                        RAISE EXCEPTION
                            'Incompatible mpesa_callback_inbox: constraint % has unexpected case-sensitive literals',
                            expected_callback_constraint.name;
                    END IF;

                    normalized_callback_constraint := regexp_replace(
                        regexp_replace(
                            lower(pg_get_constraintdef(actual_callback_constraint.oid)),
                            '::(pg_catalog\.)?(text|numeric|character varying|integer|bigint)(\[\])?',
                            '',
                            'g'
                        ),
                        '[()[:space:]]',
                        '',
                        'g'
                    );
                    IF normalized_callback_constraint IS DISTINCT FROM
                       expected_callback_constraint.normalized_definition THEN
                        RAISE EXCEPTION
                            'Incompatible mpesa_callback_inbox: constraint % has an unexpected definition',
                            expected_callback_constraint.name;
                    END IF;
                END IF;
            END IF;
        END LOOP;

        IF EXISTS (
            SELECT 1
            FROM pg_constraint constraint_data
            WHERE constraint_data.conrelid = to_regclass('mpesa_callback_inbox')
              AND constraint_data.contype::TEXT IN ('p', 'u', 'f', 'c')
              AND constraint_data.conname NOT IN (
                  'mpesa_callback_inbox_pkey',
                  'mpesa_callback_inbox_callback_fingerprint_key',
                  'mpesa_callback_inbox_callback_fingerprint_check',
                  'mpesa_callback_inbox_checkout_request_id_check',
                  'mpesa_callback_inbox_merchant_request_id_check',
                  'mpesa_callback_inbox_callback_result_code_check',
                  'mpesa_callback_inbox_callback_phone_check',
                  'mpesa_callback_inbox_callback_receipt_check',
                  'mpesa_callback_inbox_callback_status_check',
                  'mpesa_callback_inbox_duplicate_count_check',
                  'ck_mpesa_callback_success_metadata',
                  'ck_mpesa_callback_lifecycle',
                  'mpesa_callback_inbox_attempt_id_fkey',
                  'mpesa_callback_inbox_verification_id_fkey'
              )
              AND NOT constraint_data.convalidated
        ) THEN
            RAISE EXCEPTION
                'Incompatible mpesa_callback_inbox: an additional legacy structural constraint is unvalidated';
        END IF;

        SELECT attnum INTO callback_constraint_attnum
        FROM pg_attribute
        WHERE attrelid = to_regclass('mpesa_callback_inbox')
          AND attname = 'callback_id'
          AND NOT attisdropped;
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = to_regclass('mpesa_callback_inbox')
              AND conname = 'mpesa_callback_inbox_pkey'
              AND conkey = ARRAY[callback_constraint_attnum]::SMALLINT[]
              AND conindid <> 0
              AND EXISTS (
                  SELECT 1 FROM pg_index
                  WHERE indexrelid = pg_constraint.conindid
                    AND indisunique AND indisprimary
                    AND indisvalid AND indisready AND indislive AND indimmediate
                    AND indpred IS NULL AND indexprs IS NULL
                    AND indnatts = indnkeyatts
              )
        ) THEN
            RAISE EXCEPTION
                'Incompatible mpesa_callback_inbox: primary key must contain only callback_id';
        END IF;
        SELECT attnum INTO callback_constraint_attnum
        FROM pg_attribute
        WHERE attrelid = to_regclass('mpesa_callback_inbox')
          AND attname = 'callback_fingerprint'
          AND NOT attisdropped;
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = to_regclass('mpesa_callback_inbox')
              AND conname = 'mpesa_callback_inbox_callback_fingerprint_key'
              AND conkey = ARRAY[callback_constraint_attnum]::SMALLINT[]
              AND conindid <> 0
              AND EXISTS (
                  SELECT 1 FROM pg_index
                  WHERE indexrelid = pg_constraint.conindid
                    AND indisunique AND NOT indisprimary
                    AND indisvalid AND indisready AND indislive AND indimmediate
                    AND indpred IS NULL AND indexprs IS NULL
                    AND indnatts = indnkeyatts
              )
        ) THEN
            RAISE EXCEPTION
                'Incompatible mpesa_callback_inbox: callback_fingerprint must have a single-column unique constraint';
        END IF;

        SELECT attnum INTO callback_constraint_attnum
        FROM pg_attribute
        WHERE attrelid = to_regclass('mpesa_callback_inbox')
          AND attname = 'attempt_id'
          AND NOT attisdropped;
        SELECT attnum INTO callback_reference_attnum
        FROM pg_attribute
        WHERE attrelid = to_regclass('mpesa_payment_attempts')
          AND attname = 'attempt_id'
          AND NOT attisdropped;
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = to_regclass('mpesa_callback_inbox')
              AND conname = 'mpesa_callback_inbox_attempt_id_fkey'
              AND conkey = ARRAY[callback_constraint_attnum]::SMALLINT[]
              AND confrelid = to_regclass('mpesa_payment_attempts')
              AND confkey = ARRAY[callback_reference_attnum]::SMALLINT[]
              AND confmatchtype = 's'
              AND confupdtype = 'a'
              AND confdeltype = 'r'
              AND EXISTS (
                  SELECT 1
                  FROM pg_attribute local_column
                  JOIN pg_attribute referenced_column
                    ON referenced_column.attrelid = pg_constraint.confrelid
                   AND referenced_column.attnum = callback_reference_attnum
                  WHERE local_column.attrelid = pg_constraint.conrelid
                    AND local_column.attnum = callback_constraint_attnum
                    AND local_column.atttypid = referenced_column.atttypid
                    AND local_column.atttypmod = referenced_column.atttypmod
              )
        ) THEN
            RAISE EXCEPTION
                'Incompatible mpesa_callback_inbox: attempt_id must reference mpesa_payment_attempts(attempt_id) ON DELETE RESTRICT';
        END IF;
        SELECT attnum INTO callback_constraint_attnum
        FROM pg_attribute
        WHERE attrelid = to_regclass('mpesa_callback_inbox')
          AND attname = 'verification_id'
          AND NOT attisdropped;
        SELECT attnum INTO callback_reference_attnum
        FROM pg_attribute
        WHERE attrelid = to_regclass('mpesa_payment_verifications')
          AND attname = 'verification_id'
          AND NOT attisdropped;
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = to_regclass('mpesa_callback_inbox')
              AND conname = 'mpesa_callback_inbox_verification_id_fkey'
              AND conkey = ARRAY[callback_constraint_attnum]::SMALLINT[]
              AND confrelid = to_regclass('mpesa_payment_verifications')
              AND confkey = ARRAY[callback_reference_attnum]::SMALLINT[]
              AND confmatchtype = 's'
              AND confupdtype = 'a'
              AND confdeltype = 'r'
              AND EXISTS (
                  SELECT 1
                  FROM pg_attribute local_column
                  JOIN pg_attribute referenced_column
                    ON referenced_column.attrelid = pg_constraint.confrelid
                   AND referenced_column.attnum = callback_reference_attnum
                  WHERE local_column.attrelid = pg_constraint.conrelid
                    AND local_column.attnum = callback_constraint_attnum
                    AND local_column.atttypid = referenced_column.atttypid
                    AND local_column.atttypmod = referenced_column.atttypmod
              )
        ) THEN
            RAISE EXCEPTION
                'Incompatible mpesa_callback_inbox: verification_id must reference mpesa_payment_verifications(verification_id) ON DELETE RESTRICT';
        END IF;

        FOR expected_callback_index IN
            SELECT * FROM (VALUES
                ('idx_mpesa_callback_inbox_status_received',
                    ARRAY['callback_status', 'received_at']::TEXT[], FALSE, NULL::TEXT),
                ('idx_mpesa_callback_inbox_provider_ids',
                    ARRAY['checkout_request_id', 'merchant_request_id']::TEXT[], FALSE, NULL::TEXT),
                ('idx_mpesa_callback_inbox_attempt',
                    ARRAY['attempt_id']::TEXT[], FALSE, 'attempt_idisnotnull')
            ) AS expected(name, key_columns, is_unique, predicate)
        LOOP
            SELECT index_data.*,
                   index_class.relname AS index_name,
                   access_method.amname
            INTO actual_callback_index
            FROM pg_index index_data
            JOIN pg_class index_class ON index_class.oid = index_data.indexrelid
            JOIN pg_namespace index_schema ON index_schema.oid = index_class.relnamespace
            JOIN pg_am access_method ON access_method.oid = index_class.relam
            WHERE index_schema.nspname = current_schema()
              AND index_class.relname = expected_callback_index.name
              AND index_data.indrelid = to_regclass('mpesa_callback_inbox');
            IF NOT FOUND THEN
                IF to_regclass(expected_callback_index.name) IS NOT NULL THEN
                    RAISE EXCEPTION
                        'Incompatible mpesa_callback_inbox: index name % is used by a different relation',
                        expected_callback_index.name;
                END IF;
                CONTINUE;
            END IF;
            IF actual_callback_index.indisunique <> expected_callback_index.is_unique
               OR NOT actual_callback_index.indisvalid
               OR NOT actual_callback_index.indisready
               OR NOT actual_callback_index.indislive
               OR actual_callback_index.amname <> 'btree'
               OR actual_callback_index.indexprs IS NOT NULL
               OR actual_callback_index.indnatts <> actual_callback_index.indnkeyatts
               OR EXISTS (
                   SELECT 1
                   FROM unnest(actual_callback_index.indoption) AS option_data(option_flags)
                   WHERE (option_data.option_flags & 1) <> 0
               )
               OR ARRAY(
                   SELECT attribute.attname::TEXT
                   FROM unnest(actual_callback_index.indkey) WITH ORDINALITY AS key_column(attnum, position)
                   JOIN pg_attribute attribute
                     ON attribute.attrelid = actual_callback_index.indrelid
                    AND attribute.attnum = key_column.attnum
                   WHERE key_column.position <= actual_callback_index.indnkeyatts
                   ORDER BY key_column.position
               ) IS DISTINCT FROM expected_callback_index.key_columns
               OR (
                   expected_callback_index.predicate IS NULL
                   AND pg_get_expr(
                       actual_callback_index.indpred,
                       actual_callback_index.indrelid
                   ) IS NOT NULL
               )
               OR (
                   expected_callback_index.predicate IS NOT NULL
                   AND regexp_replace(
                       lower(pg_get_expr(
                           actual_callback_index.indpred,
                           actual_callback_index.indrelid
                       )),
                       '[()[:space:]]',
                       '',
                       'g'
                   ) IS DISTINCT FROM expected_callback_index.predicate
               ) THEN
                RAISE EXCEPTION
                    'Incompatible mpesa_callback_inbox: index % has an unexpected definition',
                    expected_callback_index.name;
            END IF;
        END LOOP;

        SELECT count(*) FILTER (
                   WHERE trigger_data.tgname = 'trg_mpesa_callback_inbox_set_updated_at'
                     AND trigger_data.tgenabled IN ('O', 'A')
                     AND trigger_data.tgtype = 19
                     AND trigger_data.tgattr = ''::int2vector
                     AND trigger_data.tgnargs = 0
                     AND trigger_data.tgqual IS NULL
                     AND trigger_data.tgfoid = to_regprocedure('set_updated_at()')
               )::INTEGER
        INTO callback_trigger_count
        FROM pg_trigger trigger_data
        WHERE trigger_data.tgrelid = to_regclass('mpesa_callback_inbox')
          AND NOT trigger_data.tgisinternal;
        IF callback_trigger_count > 1 OR EXISTS (
            SELECT 1
            FROM pg_trigger trigger_data
            WHERE trigger_data.tgrelid = to_regclass('mpesa_callback_inbox')
              AND trigger_data.tgname = 'trg_mpesa_callback_inbox_set_updated_at'
              AND NOT trigger_data.tgisinternal
              AND NOT (
                  trigger_data.tgenabled IN ('O', 'A')
                  AND trigger_data.tgtype = 19
                  AND trigger_data.tgattr = ''::int2vector
                  AND trigger_data.tgnargs = 0
                  AND trigger_data.tgqual IS NULL
                  AND trigger_data.tgfoid = to_regprocedure('set_updated_at()')
              )
        ) THEN
            RAISE EXCEPTION
                'Incompatible mpesa_callback_inbox: trigger trg_mpesa_callback_inbox_set_updated_at has an unexpected definition';
        END IF;
    END IF;

    IF to_regclass('mpesa_callback_inbox') IS NULL
       AND (
           to_regclass('idx_mpesa_callback_inbox_status_received') IS NOT NULL
           OR to_regclass('idx_mpesa_callback_inbox_provider_ids') IS NOT NULL
           OR to_regclass('idx_mpesa_callback_inbox_attempt') IS NOT NULL
       ) THEN
        RAISE EXCEPTION
            'Daraja callback index names exist without their inbox table; inspect this partial schema before migration';
    END IF;

    IF to_regclass('mobilesasa_sms_delivery_callbacks') IS NOT NULL THEN
        SELECT relation.relkind
        INTO mobilesasa_relation_kind
        FROM pg_class relation
        WHERE relation.oid = to_regclass('mobilesasa_sms_delivery_callbacks');
        IF mobilesasa_relation_kind <> 'r' THEN
            RAISE EXCEPTION
                'Incompatible mobilesasa_sms_delivery_callbacks: expected a regular table';
        END IF;

        SELECT count(*)::INTEGER
        INTO mobilesasa_column_count
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'mobilesasa_sms_delivery_callbacks';
        IF mobilesasa_column_count <> 22 THEN
            RAISE EXCEPTION
                'Incompatible mobilesasa_sms_delivery_callbacks: expected 22 columns, found %',
                mobilesasa_column_count;
        END IF;

        FOR expected_mobilesasa_column IN
            SELECT * FROM (VALUES
                ('callback_id', 'bigint', NULL::INTEGER, 'NO', 'sequence'),
                ('provider', 'character varying', 20, 'NO', '''mobile_sasa'''),
                ('provider_message_reference', 'character varying', 128, 'NO', NULL::TEXT),
                ('tracking_id', 'character varying', 128, 'YES', NULL::TEXT),
                ('provider_dispatch_reference', 'character varying', 128, 'YES', NULL::TEXT),
                ('delivery_status', 'character varying', 20, 'NO', NULL::TEXT),
                ('delivery_description', 'character varying', 255, 'YES', NULL::TEXT),
                ('delivery_code', 'character varying', 40, 'YES', NULL::TEXT),
                ('gateway', 'character varying', 40, 'YES', NULL::TEXT),
                ('provider_delivery_time', 'character varying', 40, 'YES', NULL::TEXT),
                ('provider_delivered_at', 'timestamp with time zone', NULL::INTEGER, 'YES', NULL::TEXT),
                ('provider_reported_at', 'timestamp with time zone', NULL::INTEGER, 'YES', NULL::TEXT),
                ('notification_id', 'character varying', 25, 'YES', NULL::TEXT),
                ('original_notification_id', 'character varying', 25, 'YES', NULL::TEXT),
                ('processing_status', 'character varying', 20, 'NO', '''unmatched'''),
                ('rejection_code', 'character varying', 64, 'YES', NULL::TEXT),
                ('duplicate_count', 'integer', NULL::INTEGER, 'NO', '0'),
                ('signature_verified_at', 'timestamp with time zone', NULL::INTEGER, 'NO', NULL::TEXT),
                ('received_at', 'timestamp with time zone', NULL::INTEGER, 'NO', 'now'),
                ('correlated_at', 'timestamp with time zone', NULL::INTEGER, 'YES', NULL::TEXT),
                ('processed_at', 'timestamp with time zone', NULL::INTEGER, 'YES', NULL::TEXT),
                ('updated_at', 'timestamp with time zone', NULL::INTEGER, 'NO', 'now')
            ) AS expected(name, data_type, max_length, is_nullable, default_expression)
        LOOP
            SELECT column_info.data_type,
                   column_info.character_maximum_length,
                   column_info.is_nullable,
                   column_info.is_identity,
                   column_info.is_generated,
                   pg_get_expr(column_default.adbin, column_default.adrelid)
            INTO actual_mobilesasa_data_type,
                 actual_mobilesasa_max_length,
                 actual_mobilesasa_nullable,
                 actual_mobilesasa_identity,
                 actual_mobilesasa_generated,
                 actual_mobilesasa_default
            FROM information_schema.columns column_info
            LEFT JOIN pg_namespace relation_schema
              ON relation_schema.nspname = column_info.table_schema
            LEFT JOIN pg_class relation
              ON relation.relnamespace = relation_schema.oid
             AND relation.relname = column_info.table_name
            LEFT JOIN pg_attribute attribute
              ON attribute.attrelid = relation.oid
             AND attribute.attname = column_info.column_name
             AND NOT attribute.attisdropped
            LEFT JOIN pg_attrdef column_default
              ON column_default.adrelid = relation.oid
             AND column_default.adnum = attribute.attnum
            WHERE column_info.table_schema = current_schema()
              AND column_info.table_name = 'mobilesasa_sms_delivery_callbacks'
              AND column_info.column_name = expected_mobilesasa_column.name;

            IF NOT FOUND THEN
                RAISE EXCEPTION
                    'Incompatible mobilesasa_sms_delivery_callbacks: required column % is missing',
                    expected_mobilesasa_column.name;
            END IF;
            IF actual_mobilesasa_data_type <> expected_mobilesasa_column.data_type
               OR actual_mobilesasa_max_length IS DISTINCT FROM expected_mobilesasa_column.max_length
               OR actual_mobilesasa_nullable <> expected_mobilesasa_column.is_nullable THEN
                RAISE EXCEPTION
                    'Incompatible mobilesasa_sms_delivery_callbacks: column % has an unexpected type, length, or nullability',
                    expected_mobilesasa_column.name;
            END IF;
            IF actual_mobilesasa_identity <> 'NO'
               OR actual_mobilesasa_generated <> 'NEVER' THEN
                RAISE EXCEPTION
                    'Incompatible mobilesasa_sms_delivery_callbacks: column % must not be generated or identity-backed',
                    expected_mobilesasa_column.name;
            END IF;

            normalized_mobilesasa_default := CASE
                WHEN actual_mobilesasa_default IS NULL THEN NULL
                ELSE regexp_replace(
                    regexp_replace(
                        lower(actual_mobilesasa_default),
                        '::(pg_catalog\.)?(character varying|timestamp with time zone|timestamptz|integer)',
                        '',
                        'g'
                    ),
                    '[()[:space:]]',
                    '',
                    'g'
                )
            END;
            IF expected_mobilesasa_column.name <> 'callback_id'
               AND normalized_mobilesasa_default IS DISTINCT FROM
                   expected_mobilesasa_column.default_expression THEN
                RAISE EXCEPTION
                    'Incompatible mobilesasa_sms_delivery_callbacks: column % has an unexpected default',
                    expected_mobilesasa_column.name;
            END IF;
            IF expected_mobilesasa_column.name = 'callback_id'
               AND actual_mobilesasa_default NOT LIKE 'nextval(%' THEN
                RAISE EXCEPTION
                    'Incompatible mobilesasa_sms_delivery_callbacks: callback_id must have a sequence-backed default';
            END IF;
        END LOOP;

        IF EXISTS (
            SELECT 1
            FROM unnest(ARRAY[
                'callback_id', 'duplicate_count', 'delivery_status', 'processing_status',
                'provider', 'provider_message_reference', 'received_at',
                'signature_verified_at', 'updated_at'
            ]::TEXT[]) AS expected_not_null(column_name)
            JOIN pg_attribute attribute
              ON attribute.attrelid = to_regclass('mobilesasa_sms_delivery_callbacks')
             AND attribute.attname = expected_not_null.column_name
             AND NOT attribute.attisdropped
            WHERE NOT EXISTS (
                SELECT 1
                FROM pg_constraint constraint_data
                WHERE constraint_data.conrelid = to_regclass('mobilesasa_sms_delivery_callbacks')
                  AND constraint_data.contype::TEXT = 'n'
                  AND constraint_data.conkey = ARRAY[attribute.attnum]::SMALLINT[]
            )
        ) THEN
            RAISE EXCEPTION
                'Incompatible mobilesasa_sms_delivery_callbacks: a required PostgreSQL NOT NULL constraint is missing';
        END IF;

        SELECT attribute.attnum
        INTO mobilesasa_callback_id_attnum
        FROM pg_attribute attribute
        WHERE attribute.attrelid = to_regclass('mobilesasa_sms_delivery_callbacks')
          AND attribute.attname = 'callback_id'
          AND NOT attribute.attisdropped;
        mobilesasa_sequence_name := pg_get_serial_sequence(
            'mobilesasa_sms_delivery_callbacks',
            'callback_id'
        );
        mobilesasa_sequence_oid := to_regclass(mobilesasa_sequence_name);
        SELECT column_default.oid
        INTO mobilesasa_callback_id_default_oid
        FROM pg_attrdef column_default
        WHERE column_default.adrelid = to_regclass('mobilesasa_sms_delivery_callbacks')
          AND column_default.adnum = mobilesasa_callback_id_attnum;
        IF mobilesasa_sequence_name IS NULL
           OR mobilesasa_sequence_oid IS NULL
           OR NOT EXISTS (
               SELECT 1
               FROM pg_class sequence_relation
               WHERE sequence_relation.oid = mobilesasa_sequence_oid
                 AND sequence_relation.relkind = 'S'
           )
           OR NOT EXISTS (
               SELECT 1
               FROM pg_sequence sequence_definition
               WHERE sequence_definition.seqrelid = mobilesasa_sequence_oid
                 AND sequence_definition.seqtypid = 'bigint'::regtype
                 AND sequence_definition.seqstart = 1
                 AND sequence_definition.seqincrement = 1
                 AND sequence_definition.seqmin = 1
                 AND sequence_definition.seqmax = 9223372036854775807
                 AND sequence_definition.seqcache = 1
                 AND NOT sequence_definition.seqcycle
           )
           OR NOT EXISTS (
               SELECT 1
               FROM pg_depend sequence_ownership
               WHERE sequence_ownership.classid = 'pg_class'::regclass
                 AND sequence_ownership.objid = mobilesasa_sequence_oid
                 AND sequence_ownership.refclassid = 'pg_class'::regclass
                 AND sequence_ownership.refobjid = to_regclass('mobilesasa_sms_delivery_callbacks')
                 AND sequence_ownership.refobjsubid = mobilesasa_callback_id_attnum
                 AND sequence_ownership.deptype IN ('a', 'i')
           )
           OR NOT EXISTS (
               SELECT 1
               FROM pg_depend default_dependency
               WHERE default_dependency.classid = 'pg_attrdef'::regclass
                 AND default_dependency.objid = mobilesasa_callback_id_default_oid
                 AND default_dependency.refclassid = 'pg_class'::regclass
                 AND default_dependency.refobjid = mobilesasa_sequence_oid
           ) THEN
            RAISE EXCEPTION
                'Incompatible mobilesasa_sms_delivery_callbacks: callback_id sequence is missing, unowned, or not used by its default';
        END IF;

        SELECT attnum INTO mobilesasa_callback_attnum
        FROM pg_attribute
        WHERE attrelid = to_regclass('mobilesasa_sms_delivery_callbacks')
          AND attname = 'callback_id'
          AND NOT attisdropped;
        SELECT attnum INTO mobilesasa_reference_attnum
        FROM pg_attribute
        WHERE attrelid = to_regclass('mobilesasa_sms_delivery_callbacks')
          AND attname = 'notification_id'
          AND NOT attisdropped;

        FOR expected_mobilesasa_constraint IN
            SELECT * FROM (VALUES
                ('mobilesasa_sms_delivery_callbacks_pkey', 'p', NULL::TEXT, NULL::TEXT[]),
                ('mobilesasa_sms_delivery_callbacks_provider_check', 'c',
                    'checkprovider=''mobile_sasa''', ARRAY['MOBILE_SASA']::TEXT[]),
                ('mobilesasa_sms_delivery_callba_provider_message_reference_check', 'c',
                    'checkprovider_message_reference<>''''', ARRAY['']::TEXT[]),
                ('mobilesasa_sms_delivery_callbacks_delivery_status_check', 'c',
                    'checkdelivery_status=anyarray[''sent'',''delivered'',''failed'',''rejected'',''expired'',''unreachable'']',
                    ARRAY['DELIVERED', 'EXPIRED', 'FAILED', 'REJECTED', 'SENT', 'UNREACHABLE']::TEXT[]),
                ('mobilesasa_sms_delivery_callbacks_notification_id_fkey', 'f', NULL::TEXT, NULL::TEXT[]),
                ('mobilesasa_sms_delivery_callbacks_processing_status_check', 'c',
                    'checkprocessing_status=anyarray[''unmatched'',''correlated'',''applied'',''ignored'',''rejected'']',
                    ARRAY['APPLIED', 'CORRELATED', 'IGNORED', 'REJECTED', 'UNMATCHED']::TEXT[]),
                ('mobilesasa_sms_delivery_callbacks_rejection_code_check', 'c',
                    'checkrejection_codeisnullorrejection_code~''^[a-z0-9_]{1,64}$''',
                    ARRAY['^[A-Z0-9_]{1,64}$']::TEXT[]),
                ('mobilesasa_sms_delivery_callbacks_duplicate_count_check', 'c',
                    'checkduplicate_count>=0', NULL::TEXT[]),
                ('uq_mobilesasa_callback_provider_reference_status', 'u', NULL::TEXT, NULL::TEXT[]),
                ('ck_mobilesasa_callback_notification_reference', 'c',
                    'checknotification_idisnullororiginal_notification_idisnotnullandoriginal_notification_id=notification_id',
                    NULL::TEXT[]),
                ('ck_mobilesasa_callback_lifecycle', 'c',
                    'checkprocessing_status=''unmatched''andnotification_idisnullandoriginal_notification_idisnullandcorrelated_atisnullandprocessed_atisnullandrejection_codeisnullorprocessing_status=''correlated''and(notification_idisnotnullororiginal_notification_idisnotnull)andcorrelated_atisnotnullandprocessed_atisnullandrejection_codeisnullorprocessing_status=anyarray[''applied'',''ignored'']and(notification_idisnotnullororiginal_notification_idisnotnull)andcorrelated_atisnotnullandprocessed_atisnotnullandrejection_codeisnullorprocessing_status=''rejected''andprocessed_atisnotnullandrejection_codeisnotnull',
                    ARRAY['APPLIED', 'CORRELATED', 'IGNORED', 'REJECTED', 'UNMATCHED']::TEXT[])
            ) AS expected(name, constraint_type, normalized_definition, expected_literals)
        LOOP
            SELECT constraint_data.*
            INTO actual_mobilesasa_constraint
            FROM pg_constraint constraint_data
            WHERE constraint_data.conrelid = to_regclass('mobilesasa_sms_delivery_callbacks')
              AND constraint_data.conname = expected_mobilesasa_constraint.name;
            IF NOT FOUND
               OR actual_mobilesasa_constraint.contype::TEXT <>
                    expected_mobilesasa_constraint.constraint_type
               OR NOT actual_mobilesasa_constraint.convalidated
               OR actual_mobilesasa_constraint.condeferrable
               OR actual_mobilesasa_constraint.condeferred THEN
                RAISE EXCEPTION
                    'Incompatible mobilesasa_sms_delivery_callbacks: required constraint % is missing or has incompatible attributes',
                    expected_mobilesasa_constraint.name;
            END IF;

            IF expected_mobilesasa_constraint.constraint_type IN ('p', 'u')
               AND (
                   actual_mobilesasa_constraint.conindid = 0
                   OR NOT EXISTS (
                       SELECT 1
                       FROM pg_index index_data
                       JOIN pg_class index_relation
                         ON index_relation.oid = index_data.indexrelid
                       JOIN pg_am access_method
                         ON access_method.oid = index_relation.relam
                       WHERE index_data.indexrelid =
                                actual_mobilesasa_constraint.conindid
                         AND index_data.indisunique
                         AND index_data.indisvalid
                         AND index_data.indisready
                         AND index_data.indislive
                         AND index_data.indimmediate
                         AND index_data.indpred IS NULL
                         AND index_data.indexprs IS NULL
                         AND index_data.indnatts = index_data.indnkeyatts
                         AND access_method.amname = 'btree'
                   )
               ) THEN
                RAISE EXCEPTION
                    'Incompatible mobilesasa_sms_delivery_callbacks: constraint % has an invalid backing index',
                    expected_mobilesasa_constraint.name;
            END IF;

            IF expected_mobilesasa_constraint.normalized_definition IS NOT NULL THEN
                -- Preserve literal case; lowercasing a CHECK definition can hide semantic changes.
                SELECT array_agg(literal_value ORDER BY literal_value)
                INTO mobilesasa_constraint_literals
                FROM (
                    SELECT captures[1] AS literal_value
                    FROM regexp_matches(
                        pg_get_constraintdef(actual_mobilesasa_constraint.oid),
                        '''([^'']*)''',
                        'g'
                    ) AS matches(captures)
                ) AS literals;
                IF mobilesasa_constraint_literals IS DISTINCT FROM
                   expected_mobilesasa_constraint.expected_literals THEN
                    RAISE EXCEPTION
                        'Incompatible mobilesasa_sms_delivery_callbacks: constraint % has unexpected case-sensitive literals',
                        expected_mobilesasa_constraint.name;
                END IF;

                normalized_mobilesasa_constraint := regexp_replace(
                    regexp_replace(
                        lower(pg_get_constraintdef(actual_mobilesasa_constraint.oid)),
                        '::(pg_catalog\.)?(character varying|text|integer)(\[\])?',
                        '',
                        'g'
                    ),
                    '[()[:space:]]',
                    '',
                    'g'
                );
                IF normalized_mobilesasa_constraint IS DISTINCT FROM
                   expected_mobilesasa_constraint.normalized_definition THEN
                    RAISE EXCEPTION
                        'Incompatible mobilesasa_sms_delivery_callbacks: constraint % has an unexpected definition',
                        expected_mobilesasa_constraint.name;
                END IF;
            END IF;

            IF expected_mobilesasa_constraint.name =
               'mobilesasa_sms_delivery_callbacks_pkey'
               AND actual_mobilesasa_constraint.conkey <>
                   ARRAY[mobilesasa_callback_attnum]::SMALLINT[] THEN
                RAISE EXCEPTION
                    'Incompatible mobilesasa_sms_delivery_callbacks: primary key must contain only callback_id';
            ELSIF expected_mobilesasa_constraint.name =
                  'uq_mobilesasa_callback_provider_reference_status'
                  AND actual_mobilesasa_constraint.conkey IS DISTINCT FROM ARRAY[
                      (SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('mobilesasa_sms_delivery_callbacks') AND attname = 'provider'),
                      (SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('mobilesasa_sms_delivery_callbacks') AND attname = 'provider_message_reference'),
                      (SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('mobilesasa_sms_delivery_callbacks') AND attname = 'delivery_status')
                  ]::SMALLINT[] THEN
                RAISE EXCEPTION
                    'Incompatible mobilesasa_sms_delivery_callbacks: provider/reference/status unique key is incorrect';
            ELSIF expected_mobilesasa_constraint.name =
                  'mobilesasa_sms_delivery_callbacks_notification_id_fkey'
                  AND (
                      actual_mobilesasa_constraint.conkey IS DISTINCT FROM
                          ARRAY[mobilesasa_reference_attnum]::SMALLINT[]
                      OR actual_mobilesasa_constraint.confrelid <> to_regclass('notifications')
                      OR actual_mobilesasa_constraint.confdeltype <> 'n'
                      OR actual_mobilesasa_constraint.confupdtype <> 'a'
                      OR actual_mobilesasa_constraint.confmatchtype <> 's'
                      OR actual_mobilesasa_constraint.confkey IS DISTINCT FROM ARRAY[
                          (SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('notifications') AND attname = 'notification_id')
                      ]::SMALLINT[]
                      OR NOT EXISTS (
                          SELECT 1
                          FROM pg_attribute local_column
                          JOIN pg_attribute referenced_column
                            ON referenced_column.attrelid =
                                actual_mobilesasa_constraint.confrelid
                           AND referenced_column.attnum =
                                actual_mobilesasa_constraint.confkey[1]
                          WHERE local_column.attrelid =
                                actual_mobilesasa_constraint.conrelid
                            AND local_column.attnum =
                                actual_mobilesasa_constraint.conkey[1]
                            AND local_column.atttypid =
                                referenced_column.atttypid
                            AND local_column.atttypmod =
                                referenced_column.atttypmod
                      )
                  ) THEN
                RAISE EXCEPTION
                    'Incompatible mobilesasa_sms_delivery_callbacks: notification_id must reference notifications(notification_id) ON DELETE SET NULL';
            END IF;
        END LOOP;

        IF EXISTS (
            SELECT 1
            FROM pg_constraint constraint_data
            WHERE constraint_data.conrelid = to_regclass('mobilesasa_sms_delivery_callbacks')
              AND constraint_data.contype::TEXT IN ('p', 'u', 'f', 'c')
              AND constraint_data.conname NOT IN (
                  'mobilesasa_sms_delivery_callbacks_pkey',
                  'mobilesasa_sms_delivery_callbacks_provider_check',
                  'mobilesasa_sms_delivery_callba_provider_message_reference_check',
                  'mobilesasa_sms_delivery_callbacks_delivery_status_check',
                  'mobilesasa_sms_delivery_callbacks_notification_id_fkey',
                  'mobilesasa_sms_delivery_callbacks_processing_status_check',
                  'mobilesasa_sms_delivery_callbacks_rejection_code_check',
                  'mobilesasa_sms_delivery_callbacks_duplicate_count_check',
                  'uq_mobilesasa_callback_provider_reference_status',
                  'ck_mobilesasa_callback_notification_reference',
                  'ck_mobilesasa_callback_lifecycle'
              )
              AND NOT constraint_data.convalidated
        ) THEN
            RAISE EXCEPTION
                'Incompatible mobilesasa_sms_delivery_callbacks: an additional legacy structural constraint is unvalidated';
        END IF;

        FOR expected_mobilesasa_index IN
            SELECT * FROM (VALUES
                ('idx_mobilesasa_callbacks_unmatched',
                    ARRAY['received_at', 'callback_id']::TEXT[],
                    ARRAY[0, 0]::SMALLINT[], 'processing_status=''unmatched''',
                    ARRAY['UNMATCHED']::TEXT[]),
                ('idx_mobilesasa_callbacks_notification',
                    ARRAY['notification_id', 'received_at']::TEXT[],
                    ARRAY[0, 3]::SMALLINT[], 'notification_idisnotnull', NULL::TEXT[]),
                ('idx_mobilesasa_callbacks_original_notification',
                    ARRAY['original_notification_id', 'received_at']::TEXT[],
                    ARRAY[0, 3]::SMALLINT[], 'original_notification_idisnotnull', NULL::TEXT[]),
                ('idx_mobilesasa_callbacks_tracking_id',
                    ARRAY['tracking_id']::TEXT[], ARRAY[0]::SMALLINT[],
                    'tracking_idisnotnull', NULL::TEXT[]),
                ('idx_mobilesasa_callbacks_dispatch_reference',
                    ARRAY['provider_dispatch_reference']::TEXT[], ARRAY[0]::SMALLINT[],
                    'provider_dispatch_referenceisnotnull', NULL::TEXT[])
            ) AS expected(name, key_columns, index_options, predicate, expected_literals)
        LOOP
            IF to_regclass(expected_mobilesasa_index.name) IS NULL THEN
                CONTINUE;
            END IF;

            SELECT index_relation.oid AS index_oid,
                   index_data.indrelid,
                   index_data.indisunique,
                   index_data.indisvalid,
                   index_data.indisready,
                   index_data.indislive,
                   index_data.indnullsnotdistinct,
                   index_data.indnkeyatts,
                   index_data.indnatts,
                   index_data.indkey,
                   index_data.indoption,
                   index_data.indpred,
                   index_data.indexprs,
                   access_method.amname
            INTO actual_mobilesasa_index
            FROM pg_class index_relation
            JOIN pg_index index_data ON index_data.indexrelid = index_relation.oid
            JOIN pg_am access_method ON access_method.oid = index_relation.relam
            WHERE index_relation.oid = to_regclass(expected_mobilesasa_index.name)
              AND index_relation.relkind = 'i';

            IF NOT FOUND
               OR actual_mobilesasa_index.indrelid <>
                    to_regclass('mobilesasa_sms_delivery_callbacks')
               OR actual_mobilesasa_index.amname <> 'btree'
               OR actual_mobilesasa_index.indisunique
               OR NOT actual_mobilesasa_index.indisvalid
               OR NOT actual_mobilesasa_index.indisready
               OR NOT actual_mobilesasa_index.indislive
               OR actual_mobilesasa_index.indnullsnotdistinct
               OR actual_mobilesasa_index.indnkeyatts <>
                    cardinality(expected_mobilesasa_index.key_columns)
               OR actual_mobilesasa_index.indnatts <>
                    cardinality(expected_mobilesasa_index.key_columns)
               OR actual_mobilesasa_index.indexprs IS NOT NULL
               OR (
                   SELECT array_agg(attribute.attname::TEXT ORDER BY key_column.position)
                   FROM unnest(actual_mobilesasa_index.indkey)
                        WITH ORDINALITY AS key_column(attnum, position)
                   JOIN pg_attribute attribute
                     ON attribute.attrelid = actual_mobilesasa_index.indrelid
                    AND attribute.attnum = key_column.attnum
                   WHERE key_column.position <= actual_mobilesasa_index.indnkeyatts
               ) IS DISTINCT FROM expected_mobilesasa_index.key_columns
               OR (
                   SELECT array_agg(option_data.option_flags::SMALLINT
                                    ORDER BY option_data.position)
                   FROM unnest(actual_mobilesasa_index.indoption)
                        WITH ORDINALITY AS option_data(option_flags, position)
               ) IS DISTINCT FROM expected_mobilesasa_index.index_options
               OR regexp_replace(
                   regexp_replace(
                       lower(pg_get_expr(
                           actual_mobilesasa_index.indpred,
                           actual_mobilesasa_index.indrelid
                       )),
                       '::(pg_catalog\.)?(text|character varying)',
                       '',
                       'g'
                   ),
                   '[()[:space:]]',
                   '',
                   'g'
               ) IS DISTINCT FROM expected_mobilesasa_index.predicate
               OR (
                   expected_mobilesasa_index.expected_literals IS NOT NULL
                   AND ARRAY(
                       SELECT captures[1]
                       FROM regexp_matches(
                           pg_get_expr(
                               actual_mobilesasa_index.indpred,
                               actual_mobilesasa_index.indrelid
                           ),
                           '''([^'']*)''',
                           'g'
                       ) AS matches(captures)
                       ORDER BY captures[1]
                   ) IS DISTINCT FROM expected_mobilesasa_index.expected_literals
               ) THEN
                RAISE EXCEPTION
                    'Incompatible mobilesasa_sms_delivery_callbacks: index % has an unexpected definition',
                    expected_mobilesasa_index.name;
            END IF;
        END LOOP;

        SELECT attribute.attnum
        INTO mobilesasa_reference_attnum
        FROM pg_attribute attribute
        WHERE attribute.attrelid = to_regclass('mobilesasa_sms_delivery_callbacks')
          AND attribute.attname = 'notification_id'
          AND NOT attribute.attisdropped;
        SELECT count(*) FILTER (
                   WHERE trigger_data.tgname =
                            'trg_mobilesasa_callbacks_preserve_notification_reference'
                     AND trigger_data.tgenabled IN ('O', 'A')
                     AND trigger_data.tgtype = 23
                     AND trigger_data.tgattr::TEXT =
                            mobilesasa_reference_attnum::TEXT
                     AND trigger_data.tgnargs = 0
                     AND trigger_data.tgqual IS NULL
                     AND trigger_data.tgfoid =
                            to_regprocedure('preserve_mobilesasa_callback_notification_reference()')
               )::INTEGER,
               count(*) FILTER (
                   WHERE trigger_data.tgname =
                            'trg_mobilesasa_callbacks_set_updated_at'
                     AND trigger_data.tgenabled IN ('O', 'A')
                     AND trigger_data.tgtype = 19
                     AND trigger_data.tgattr = ''::int2vector
                     AND trigger_data.tgnargs = 0
                     AND trigger_data.tgqual IS NULL
                     AND trigger_data.tgfoid = to_regprocedure('set_updated_at()')
               )::INTEGER
        INTO mobilesasa_preserve_trigger_count, mobilesasa_updated_trigger_count
        FROM pg_trigger trigger_data
        WHERE trigger_data.tgrelid = to_regclass('mobilesasa_sms_delivery_callbacks')
          AND NOT trigger_data.tgisinternal;
        IF mobilesasa_preserve_trigger_count > 1 OR mobilesasa_updated_trigger_count > 1 THEN
            RAISE EXCEPTION
                'Incompatible mobilesasa_sms_delivery_callbacks: a required trigger name is duplicated';
        END IF;
        IF EXISTS (
            SELECT 1
            FROM pg_trigger trigger_data
            WHERE trigger_data.tgrelid = to_regclass('mobilesasa_sms_delivery_callbacks')
              AND NOT trigger_data.tgisinternal
              AND trigger_data.tgname IN (
                  'trg_mobilesasa_callbacks_preserve_notification_reference',
                  'trg_mobilesasa_callbacks_set_updated_at'
              )
              AND (
                  (trigger_data.tgname =
                       'trg_mobilesasa_callbacks_preserve_notification_reference'
                   AND NOT (
                       trigger_data.tgenabled IN ('O', 'A')
                       AND trigger_data.tgtype = 23
                       AND trigger_data.tgattr::TEXT =
                           mobilesasa_reference_attnum::TEXT
                       AND trigger_data.tgnargs = 0
                       AND trigger_data.tgqual IS NULL
                       AND trigger_data.tgfoid =
                           to_regprocedure('preserve_mobilesasa_callback_notification_reference()')
                   ))
                  OR
                  (trigger_data.tgname =
                       'trg_mobilesasa_callbacks_set_updated_at'
                   AND NOT (
                       trigger_data.tgenabled IN ('O', 'A')
                       AND trigger_data.tgtype = 19
                       AND trigger_data.tgattr = ''::int2vector
                       AND trigger_data.tgnargs = 0
                       AND trigger_data.tgqual IS NULL
                       AND trigger_data.tgfoid = to_regprocedure('set_updated_at()')
                   ))
              )
        ) THEN
            RAISE EXCEPTION
                'Incompatible mobilesasa_sms_delivery_callbacks: a required trigger has an unexpected definition';
        END IF;
    END IF;

    IF to_regprocedure('set_updated_at()') IS NULL
       OR NOT EXISTS (
           SELECT 1
           FROM pg_proc p
           JOIN pg_language language_data ON language_data.oid = p.prolang
           WHERE p.oid = to_regprocedure('set_updated_at()')
             AND p.pronargs = 0
             AND p.prorettype = 'trigger'::regtype
             AND language_data.lanname = 'plpgsql'
             AND NOT p.prosecdef
             AND p.proconfig IS NULL
             AND regexp_replace(lower(p.prosrc), '[[:space:]]', '', 'g') =
                 'beginnew.updated_at=now();returnnew;end;'
       ) THEN
        RAISE EXCEPTION
            'Incompatible set_updated_at(): required trigger function is missing or has an unexpected definition';
    END IF;

    SELECT p.oid
    INTO mobilesasa_preserve_function_oid
    FROM pg_proc p
    WHERE p.oid = to_regprocedure(
        'preserve_mobilesasa_callback_notification_reference()'
    );
    IF mobilesasa_preserve_function_oid IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM pg_proc p
           JOIN pg_language language_data ON language_data.oid = p.prolang
           WHERE p.oid = mobilesasa_preserve_function_oid
             AND p.pronargs = 0
             AND p.prorettype = 'trigger'::regtype
             AND language_data.lanname = 'plpgsql'
             AND NOT p.prosecdef
             AND p.proconfig IS NULL
             AND regexp_replace(lower(p.prosrc), '[[:space:]]', '', 'g') =
                 'beginiftg_op=''insert''thennew.original_notification_id:=coalesce(new.original_notification_id,new.notification_id);elsifold.notification_idisnotnullandnew.notification_idisnullthennew.original_notification_id:=coalesce(new.original_notification_id,old.notification_id);elsifnew.notification_idisnotnullthenifold.original_notification_idisnotnullandold.original_notification_id<>new.notification_idthenraiseexception''acallbackcannotbereassignedtoanothernotification'';endif;new.original_notification_id:=coalesce(new.original_notification_id,new.notification_id);endif;returnnew;end;'
       ) THEN
        RAISE EXCEPTION
            'Incompatible preserve_mobilesasa_callback_notification_reference(): signature or function body differs from the required implementation';
    END IF;

    IF to_regclass('mobilesasa_sms_delivery_callbacks') IS NULL
       AND (
           to_regclass('idx_mobilesasa_callbacks_unmatched') IS NOT NULL
           OR to_regclass('idx_mobilesasa_callbacks_notification') IS NOT NULL
           OR to_regclass('idx_mobilesasa_callbacks_original_notification') IS NOT NULL
           OR to_regclass('idx_mobilesasa_callbacks_tracking_id') IS NOT NULL
           OR to_regclass('idx_mobilesasa_callbacks_dispatch_reference') IS NOT NULL
       ) THEN
        RAISE EXCEPTION
            'MobileSasa callback index names exist without their inbox table; inspect this partial schema before migration';
    END IF;

    SELECT pg_get_constraintdef(oid)
    INTO status_constraint_definition
    FROM pg_constraint
    WHERE conrelid = 'notifications'::regclass
      AND conname = 'ck_notifications_delivery_status'
      AND contype = 'c';
    IF status_constraint_definition IS NULL THEN
        RAISE EXCEPTION
            'Incompatible notifications schema: ck_notifications_delivery_status is required';
    END IF;
    SELECT array_agg(literal_value ORDER BY literal_value)
    INTO type_literals
    FROM (
        SELECT captures[1] AS literal_value
        FROM regexp_matches(
            status_constraint_definition,
            '''([^'']*)''',
            'g'
        ) AS matches(captures)
    ) AS literals;
    IF type_literals IS DISTINCT FROM ARRAY[
        'DELIVERED', 'FAILED', 'PENDING', 'PROCESSING',
        'PROVIDER_ACCEPTED', 'UNKNOWN'
    ]::TEXT[] THEN
        RAISE EXCEPTION
            'Incompatible notifications schema: ck_notifications_delivery_status has an unexpected definition';
    END IF;
    normalized_status_constraint := regexp_replace(
        regexp_replace(
            lower(status_constraint_definition),
            '::(pg_catalog\.)?(text|character varying)(\[\])?',
            '',
            'g'
        ),
        '[()[:space:]]',
        '',
        'g'
    );
    IF normalized_status_constraint !~ '^checkdelivery_status=anyarray\[[^]]+\]$' THEN
        RAISE EXCEPTION
            'Incompatible notifications schema: ck_notifications_delivery_status has unexpected logic';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM notifications
        WHERE delivery_status NOT IN (
            'PENDING', 'PROCESSING', 'PROVIDER_ACCEPTED',
            'DELIVERED', 'FAILED', 'UNKNOWN'
        )
    ) THEN
        RAISE EXCEPTION
            'Incompatible notifications data: an unsupported delivery_status exists';
    END IF;
    IF EXISTS (SELECT 1 FROM notifications WHERE attempt_count < 0) THEN
        RAISE EXCEPTION
            'Incompatible notifications data: a negative attempt_count exists';
    END IF;

    SELECT attnum INTO notification_type_attnum
    FROM pg_attribute
    WHERE attrelid = 'notifications'::regclass
      AND attname = 'notification_type'
      AND NOT attisdropped;
    IF notification_type_attnum IS NULL THEN
        RAISE EXCEPTION
            'Incompatible notifications schema: notification_type is missing';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM notifications
        WHERE notification_type NOT IN ('SMS', 'EMAIL', 'PUSH', 'USSD', 'IN_APP')
    ) THEN
        RAISE EXCEPTION
            'Incompatible notifications data: an unsupported notification_type exists';
    END IF;

    FOR type_constraint IN
        SELECT oid, conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'notifications'::regclass
          AND contype = 'c'
          AND conkey @> ARRAY[notification_type_attnum]::SMALLINT[]
          AND conname NOT IN (
              'ck_notifications_admin_channel_snapshot',
              'ck_notifications_external_recipient'
          )
    LOOP
        normalized_notification_type_constraint := regexp_replace(
            regexp_replace(
                lower(type_constraint.definition),
                '::(pg_catalog\.)?(text|character varying)(\[\])?',
                '',
                'g'
            ),
            '[()[:space:]]',
            '',
            'g'
        );
        IF normalized_notification_type_constraint
           !~ '^checknotification_type=anyarray\[[^]]+\]$' THEN
            RAISE EXCEPTION
                'Incompatible notification_type constraint %: expected a single-value-list check',
                type_constraint.conname;
        END IF;

        SELECT array_agg(literal_value ORDER BY literal_value)
        INTO type_literals
        FROM (
            SELECT captures[1] AS literal_value
            FROM regexp_matches(
                type_constraint.definition,
                '''([^'']*)''',
                'g'
            ) AS matches(captures)
        ) AS literals;

        IF type_constraint.conname IN (
            'notifications_notification_type_check',
            'ck_notifications_notification_type',
            'ck_notifications_notification_type_integrations'
        ) AND type_literals IS NOT DISTINCT FROM ARRAY[
            'EMAIL', 'IN_APP', 'PUSH', 'SMS', 'USSD'
        ]::TEXT[] THEN
            IF compatible_type_constraint_found OR legacy_type_constraint IS NOT NULL THEN
                RAISE EXCEPTION
                    'Multiple notification_type constraints found; review them before migration';
            END IF;
            compatible_type_constraint_found := TRUE;
            CONTINUE;
        END IF;

        IF type_constraint.conname <> 'notifications_notification_type_check'
           OR type_literals IS DISTINCT FROM ARRAY['EMAIL', 'PUSH', 'SMS', 'USSD']::TEXT[] THEN
            RAISE EXCEPTION
                'Incompatible notification_type constraint %: refusing to replace an unrecognized constraint',
                type_constraint.conname;
        END IF;
        IF legacy_type_constraint IS NOT NULL OR compatible_type_constraint_found THEN
            RAISE EXCEPTION
                'Multiple legacy notification_type constraints found; review them before migration';
        END IF;
        legacy_type_constraint := type_constraint.conname;
    END LOOP;

    IF EXISTS (
        SELECT 1
        FROM notifications
        WHERE deduplication_key IS NOT NULL
          AND user_id IS NOT NULL
        GROUP BY user_id, notification_type, deduplication_key
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'Cannot create transactional event uniqueness: duplicate user/channel/event keys exist';
    END IF;

    IF to_regclass('uq_notifications_user_channel_event_key') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM pg_index i
           WHERE i.indexrelid = to_regclass('uq_notifications_user_channel_event_key')
             AND i.indrelid = 'notifications'::regclass
             AND i.indisunique
             AND i.indisvalid
             AND i.indisready
             AND i.indislive
             AND NOT i.indnullsnotdistinct
             AND i.indnatts = i.indnkeyatts
             AND i.indexprs IS NULL
             AND EXISTS (
                 SELECT 1
                 FROM pg_class index_relation
                 JOIN pg_am access_method ON access_method.oid = index_relation.relam
                 WHERE index_relation.oid = i.indexrelid
                   AND access_method.amname = 'btree'
             )
             AND ARRAY(
                 SELECT a.attname::TEXT
                 FROM unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, position)
                 JOIN pg_attribute a
                   ON a.attrelid = i.indrelid
                  AND a.attnum = key_column.attnum
                 WHERE key_column.position <= i.indnkeyatts
                 ORDER BY key_column.position
             ) = ARRAY['user_id', 'notification_type', 'deduplication_key']::TEXT[]
             AND regexp_replace(
                 lower(pg_get_expr(i.indpred, i.indrelid)),
                 '[()[:space:]]',
                 '',
                 'g'
             ) = 'deduplication_keyisnotnull'
       ) THEN
        RAISE EXCEPTION
            'Conflicting object uq_notifications_user_channel_event_key exists with an incompatible definition';
    END IF;

    FOREACH required_column IN ARRAY ARRAY[
        'attempt_id',
        'contribution_id',
        'attempt_status'
    ]
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'mpesa_payment_attempts'
              AND column_name = required_column
        ) THEN
            RAISE EXCEPTION
                'Incompatible M-Pesa schema: mpesa_payment_attempts.% is missing',
                required_column;
        END IF;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_index i
        WHERE i.indrelid = 'mpesa_payment_attempts'::regclass
          AND i.indisunique
          AND i.indisvalid
          AND i.indisready
          AND i.indislive
          AND NOT i.indnullsnotdistinct
          AND i.indnatts = i.indnkeyatts
          AND i.indexprs IS NULL
          AND EXISTS (
              SELECT 1
              FROM pg_class index_relation
              JOIN pg_am access_method ON access_method.oid = index_relation.relam
              WHERE index_relation.oid = i.indexrelid
                AND access_method.amname = 'btree'
          )
          AND ARRAY(
              SELECT a.attname::TEXT
              FROM unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, position)
              JOIN pg_attribute a
                ON a.attrelid = i.indrelid
               AND a.attnum = key_column.attnum
              WHERE key_column.position <= i.indnkeyatts
              ORDER BY key_column.position
          ) = ARRAY['contribution_id']::TEXT[]
          AND regexp_replace(
              regexp_replace(
                  lower(pg_get_expr(i.indpred, i.indrelid)),
                  '::(pg_catalog\.)?(text|character varying)(\[\])?',
                  '',
                  'g'
              ),
              '[()[:space:]]',
              '',
              'g'
          ) = 'attempt_status=anyarray[''pending'',''outcome_unknown'',''prompt_accepted'']'
          AND ARRAY(
              SELECT captures[1]
              FROM regexp_matches(
                  pg_get_expr(i.indpred, i.indrelid),
                  '''([^'']*)''',
                  'g'
              ) AS matches(captures)
              ORDER BY captures[1]
          ) = ARRAY['OUTCOME_UNKNOWN', 'PENDING', 'PROMPT_ACCEPTED']::TEXT[]
    ) THEN
        IF EXISTS (
            SELECT 1
            FROM mpesa_payment_attempts
            WHERE attempt_status IN ('PENDING', 'OUTCOME_UNKNOWN', 'PROMPT_ACCEPTED')
            GROUP BY contribution_id
            HAVING COUNT(*) > 1
        ) THEN
            RAISE EXCEPTION
                'Cannot create single-active-attempt protection: duplicate active attempts exist';
        END IF;
        IF to_regclass('uq_mpesa_payment_attempts_one_active_per_contribution') IS NOT NULL THEN
            RAISE EXCEPTION
                'Conflicting object uq_mpesa_payment_attempts_one_active_per_contribution exists';
        END IF;
    END IF;
    IF to_regclass('uq_mpesa_payment_attempts_one_active_per_contribution') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM pg_index i
           JOIN pg_class index_relation ON index_relation.oid = i.indexrelid
           JOIN pg_am access_method ON access_method.oid = index_relation.relam
           WHERE i.indexrelid =
                    to_regclass('uq_mpesa_payment_attempts_one_active_per_contribution')
             AND i.indrelid = 'mpesa_payment_attempts'::regclass
             AND i.indisunique
             AND i.indisvalid
             AND i.indisready
             AND i.indislive
             AND NOT i.indnullsnotdistinct
             AND i.indnatts = i.indnkeyatts
             AND i.indexprs IS NULL
             AND access_method.amname = 'btree'
             AND ARRAY(
                 SELECT attribute.attname::TEXT
                 FROM unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, position)
                 JOIN pg_attribute attribute
                   ON attribute.attrelid = i.indrelid
                  AND attribute.attnum = key_column.attnum
                 WHERE key_column.position <= i.indnkeyatts
                 ORDER BY key_column.position
             ) = ARRAY['contribution_id']::TEXT[]
             AND NOT EXISTS (
                 SELECT 1
                 FROM unnest(i.indoption) AS option_data(option_flags)
                 WHERE (option_data.option_flags & 1) <> 0
             )
             AND regexp_replace(
                 regexp_replace(
                     lower(pg_get_expr(i.indpred, i.indrelid)),
                     '::(pg_catalog\.)?(text|character varying)(\[\])?',
                     '',
                     'g'
                 ),
                 '[()[:space:]]',
                 '',
                 'g'
             ) = 'attempt_status=anyarray[''pending'',''outcome_unknown'',''prompt_accepted'']'
             AND ARRAY(
                 SELECT captures[1]
                 FROM regexp_matches(
                     pg_get_expr(i.indpred, i.indrelid),
                     '''([^'']*)''',
                     'g'
                 ) AS matches(captures)
                 ORDER BY captures[1]
             ) = ARRAY['OUTCOME_UNKNOWN', 'PENDING', 'PROMPT_ACCEPTED']::TEXT[]
       ) THEN
        RAISE EXCEPTION
            'Conflicting object uq_mpesa_payment_attempts_one_active_per_contribution has an incompatible definition';
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'notifications'
          AND column_name = 'admin_request_key'
    ) THEN
        IF EXISTS (
            SELECT 1
            FROM notifications
            WHERE admin_request_key IS NOT NULL
              AND user_id IS NOT NULL
            GROUP BY admin_request_key, user_id, notification_type
            HAVING COUNT(*) > 1
        ) THEN
            RAISE EXCEPTION
                'Cannot create notification request uniqueness: duplicate request/channel records exist';
        END IF;
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'notifications'
          AND column_name = 'provider_message_id'
    ) THEN
        IF EXISTS (
            SELECT 1
            FROM notifications
            WHERE provider_message_id IS NOT NULL
            GROUP BY provider_message_id
            HAVING COUNT(*) > 1
        ) THEN
            RAISE EXCEPTION
                'Cannot create provider message uniqueness: duplicate provider_message_id values exist';
        END IF;
    END IF;

    IF to_regclass('uq_notifications_admin_request_channel') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM pg_index i
           WHERE i.indexrelid = to_regclass('uq_notifications_admin_request_channel')
             AND i.indrelid = 'notifications'::regclass
             AND i.indisunique
             AND i.indisvalid
             AND i.indisready
             AND i.indislive
             AND NOT i.indnullsnotdistinct
             AND i.indnatts = i.indnkeyatts
             AND i.indexprs IS NULL
             AND EXISTS (
                 SELECT 1
                 FROM pg_class index_relation
                 JOIN pg_am access_method ON access_method.oid = index_relation.relam
                 WHERE index_relation.oid = i.indexrelid
                   AND access_method.amname = 'btree'
             )
             AND ARRAY(
                 SELECT a.attname::TEXT
                 FROM unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, position)
                 JOIN pg_attribute a
                   ON a.attrelid = i.indrelid
                  AND a.attnum = key_column.attnum
                 WHERE key_column.position <= i.indnkeyatts
                 ORDER BY key_column.position
             ) = ARRAY['admin_request_key', 'user_id', 'notification_type']::TEXT[]
             AND regexp_replace(
                 lower(pg_get_expr(i.indpred, i.indrelid)),
                 '[()[:space:]]',
                 '',
                 'g'
             ) = 'admin_request_keyisnotnull'
       ) THEN
        RAISE EXCEPTION
            'Conflicting object uq_notifications_admin_request_channel has an incompatible definition';
    END IF;

    FOREACH required_column IN ARRAY ARRAY[
        'verification_id'
    ]
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'mpesa_payment_verifications'
              AND column_name = required_column
              AND data_type = 'bigint'
        ) THEN
            RAISE EXCEPTION
                'Incompatible M-Pesa schema: mpesa_payment_verifications.% must be BIGINT',
                required_column;
        END IF;
    END LOOP;

    IF to_regclass('uq_notifications_provider_message_id') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM pg_index i
           WHERE i.indexrelid = to_regclass('uq_notifications_provider_message_id')
             AND i.indrelid = 'notifications'::regclass
             AND i.indisunique
             AND i.indisvalid
             AND i.indisready
             AND i.indislive
             AND NOT i.indnullsnotdistinct
             AND i.indnatts = i.indnkeyatts
             AND i.indexprs IS NULL
             AND EXISTS (
                 SELECT 1
                 FROM pg_class index_relation
                 JOIN pg_am access_method ON access_method.oid = index_relation.relam
                 WHERE index_relation.oid = i.indexrelid
                   AND access_method.amname = 'btree'
             )
             AND ARRAY(
                 SELECT a.attname::TEXT
                 FROM unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, position)
                 JOIN pg_attribute a
                   ON a.attrelid = i.indrelid
                  AND a.attnum = key_column.attnum
                 WHERE key_column.position <= i.indnkeyatts
                 ORDER BY key_column.position
             ) = ARRAY['provider_message_id']::TEXT[]
             AND regexp_replace(
                 lower(pg_get_expr(i.indpred, i.indrelid)),
                 '[()[:space:]]',
                 '',
                 'g'
             ) = 'provider_message_idisnotnull'
       ) THEN
        RAISE EXCEPTION
            'Conflicting object uq_notifications_provider_message_id has an incompatible definition';
    END IF;

    IF to_regclass('idx_mobilesasa_callbacks_unmatched') IS NOT NULL
       OR to_regclass('idx_mobilesasa_callbacks_notification') IS NOT NULL
       OR to_regclass('idx_mobilesasa_callbacks_original_notification') IS NOT NULL
       OR to_regclass('idx_mobilesasa_callbacks_tracking_id') IS NOT NULL
       OR to_regclass('idx_mobilesasa_callbacks_dispatch_reference') IS NOT NULL THEN
        RAISE EXCEPTION
            'Mobile Sasa callback objects exist without their inbox table; inspect this partial schema before migration';
    END IF;
END
$preflight$;

-- Add application notification fields only when absent. Existing field types
-- were checked above, and no existing notification value is rewritten.
DO $notification_columns$
DECLARE
    optional_column RECORD;
BEGIN
    FOR optional_column IN
        SELECT * FROM (VALUES
            ('recipient_email', 'VARCHAR(254)'),
            ('email_subject', 'VARCHAR(255)'),
            ('email_html_body', 'TEXT'),
            ('push_title', 'VARCHAR(100)'),
            ('admin_request_key', 'UUID'),
            ('provider_message_id', 'VARCHAR(128)')
        ) AS optional(name, definition)
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'notifications'
              AND column_name = optional_column.name
        ) THEN
            EXECUTE format(
                'ALTER TABLE notifications ADD COLUMN %I %s',
                optional_column.name,
                optional_column.definition
            );
        END IF;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'notifications'
          AND column_name = 'scope_fund_id'
    ) THEN
        ALTER TABLE notifications
            ADD COLUMN scope_fund_id VARCHAR(25)
                REFERENCES funds (fund_id) ON DELETE SET NULL;
    END IF;
END
$notification_columns$;

-- Preserve the prior notification type domain and widen it only to include
-- the IN_APP channel used by transactional events.
DO $notification_type_constraint$
DECLARE
    notification_type_attnum SMALLINT;
    constraint_name TEXT;
    constraint_definition TEXT;
    type_literals TEXT[];
    normalized_type_constraint TEXT;
BEGIN
    SELECT attnum INTO notification_type_attnum
    FROM pg_attribute
    WHERE attrelid = 'notifications'::regclass
      AND attname = 'notification_type'
      AND NOT attisdropped;

    SELECT conname, pg_get_constraintdef(oid)
    INTO constraint_name, constraint_definition
    FROM pg_constraint
    WHERE conrelid = 'notifications'::regclass
      AND contype = 'c'
      AND conkey @> ARRAY[notification_type_attnum]::SMALLINT[]
      AND conname NOT IN (
          'ck_notifications_admin_channel_snapshot',
          'ck_notifications_external_recipient'
      )
      AND conname = 'notifications_notification_type_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%''IN_APP''%';

    IF constraint_name IS NOT NULL THEN
        SELECT array_agg(literal_value ORDER BY literal_value)
        INTO type_literals
        FROM (
            SELECT captures[1] AS literal_value
            FROM regexp_matches(
                constraint_definition,
                '''([^'']*)''',
                'g'
            ) AS matches(captures)
        ) AS literals;
        IF type_literals IS DISTINCT FROM ARRAY['EMAIL', 'PUSH', 'SMS', 'USSD']::TEXT[] THEN
            RAISE EXCEPTION
                'Refusing to replace unrecognized general notification_type constraint %',
                constraint_name;
        END IF;
        normalized_type_constraint := regexp_replace(
            regexp_replace(
                lower(constraint_definition),
                '::(pg_catalog\.)?(text|character varying)(\[\])?',
                '',
                'g'
            ),
            '[()[:space:]]',
            '',
            'g'
        );
        IF normalized_type_constraint !~ '^checknotification_type=anyarray\[[^]]+\]$' THEN
            RAISE EXCEPTION
                'Refusing to replace notification_type constraint % with unexpected logic',
                constraint_name;
        END IF;

        EXECUTE format(
            'ALTER TABLE notifications DROP CONSTRAINT %I',
            constraint_name
        );
        EXECUTE format(
            'ALTER TABLE notifications ADD CONSTRAINT %I CHECK '
            '(notification_type IN (''SMS'', ''EMAIL'', ''PUSH'', ''USSD'', ''IN_APP''))',
            constraint_name
        );
    ELSIF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'notifications'::regclass
          AND contype = 'c'
          AND conkey @> ARRAY[notification_type_attnum]::SMALLINT[]
          AND conname NOT IN (
              'ck_notifications_admin_channel_snapshot',
              'ck_notifications_external_recipient'
          )
    ) THEN
        ALTER TABLE notifications
            ADD CONSTRAINT ck_notifications_notification_type_integrations
            CHECK (notification_type IN ('SMS', 'EMAIL', 'PUSH', 'USSD', 'IN_APP'));
    END IF;
END
$notification_type_constraint$;

DO $notification_objects$
BEGIN
    IF to_regclass('notification_preferences') IS NULL THEN
        CREATE TABLE notification_preferences (
            user_id VARCHAR(25) PRIMARY KEY
                REFERENCES users (user_id) ON DELETE CASCADE,
            sms_enabled BOOLEAN NOT NULL DEFAULT FALSE,
            email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
        );
        CREATE TRIGGER trg_notification_preferences_set_updated_at
            BEFORE UPDATE ON notification_preferences
            FOR EACH ROW
            EXECUTE FUNCTION set_updated_at();
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = to_regclass('notification_preferences')
          AND tgname = 'trg_notification_preferences_set_updated_at'
          AND NOT tgisinternal
    ) THEN
        CREATE TRIGGER trg_notification_preferences_set_updated_at
            BEFORE UPDATE ON notification_preferences
            FOR EACH ROW
            EXECUTE FUNCTION set_updated_at();
    END IF;

    IF to_regclass('uq_notifications_user_channel_event_key') IS NULL
       AND NOT EXISTS (
           SELECT 1
           FROM pg_index i
           WHERE i.indrelid = 'notifications'::regclass
             AND i.indisunique
             AND i.indisvalid
             AND i.indisready
             AND i.indislive
             AND NOT i.indnullsnotdistinct
             AND i.indnatts = i.indnkeyatts
             AND i.indexprs IS NULL
             AND EXISTS (
                 SELECT 1
                 FROM pg_class index_relation
                 JOIN pg_am access_method ON access_method.oid = index_relation.relam
                 WHERE index_relation.oid = i.indexrelid
                   AND access_method.amname = 'btree'
             )
             AND ARRAY(
                 SELECT a.attname::TEXT
                 FROM unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, position)
                 JOIN pg_attribute a
                   ON a.attrelid = i.indrelid
                  AND a.attnum = key_column.attnum
                 WHERE key_column.position <= i.indnkeyatts
                 ORDER BY key_column.position
             ) = ARRAY['user_id', 'notification_type', 'deduplication_key']::TEXT[]
             AND regexp_replace(
                 lower(pg_get_expr(i.indpred, i.indrelid)),
                 '[()[:space:]]',
                 '',
                 'g'
             ) = 'deduplication_keyisnotnull'
       ) THEN
        CREATE UNIQUE INDEX uq_notifications_user_channel_event_key
            ON notifications (user_id, notification_type, deduplication_key)
            WHERE deduplication_key IS NOT NULL;
    END IF;

    IF to_regclass('uq_notifications_admin_request_channel') IS NULL
       AND NOT EXISTS (
           SELECT 1
           FROM pg_index i
           WHERE i.indrelid = 'notifications'::regclass
             AND i.indisunique
             AND i.indisvalid
             AND i.indisready
             AND i.indislive
             AND NOT i.indnullsnotdistinct
             AND i.indnatts = i.indnkeyatts
             AND i.indexprs IS NULL
             AND EXISTS (
                 SELECT 1
                 FROM pg_class index_relation
                 JOIN pg_am access_method ON access_method.oid = index_relation.relam
                 WHERE index_relation.oid = i.indexrelid
                   AND access_method.amname = 'btree'
             )
             AND ARRAY(
                 SELECT a.attname::TEXT
                 FROM unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, position)
                 JOIN pg_attribute a
                   ON a.attrelid = i.indrelid
                  AND a.attnum = key_column.attnum
                 WHERE key_column.position <= i.indnkeyatts
                 ORDER BY key_column.position
             ) = ARRAY['admin_request_key', 'user_id', 'notification_type']::TEXT[]
             AND regexp_replace(
                 lower(pg_get_expr(i.indpred, i.indrelid)),
                 '[()[:space:]]',
                 '',
                 'g'
             ) = 'admin_request_keyisnotnull'
       ) THEN
        CREATE UNIQUE INDEX uq_notifications_admin_request_channel
            ON notifications (admin_request_key, user_id, notification_type)
            WHERE admin_request_key IS NOT NULL;
    END IF;

    IF to_regclass('uq_notifications_provider_message_id') IS NULL
       AND NOT EXISTS (
           SELECT 1
           FROM pg_index i
           WHERE i.indrelid = 'notifications'::regclass
             AND i.indisunique
             AND i.indisvalid
             AND i.indisready
             AND i.indislive
             AND NOT i.indnullsnotdistinct
             AND i.indnatts = i.indnkeyatts
             AND i.indexprs IS NULL
             AND EXISTS (
                 SELECT 1
                 FROM pg_class index_relation
                 JOIN pg_am access_method ON access_method.oid = index_relation.relam
                 WHERE index_relation.oid = i.indexrelid
                   AND access_method.amname = 'btree'
             )
             AND ARRAY(
                 SELECT a.attname::TEXT
                 FROM unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, position)
                 JOIN pg_attribute a
                   ON a.attrelid = i.indrelid
                  AND a.attnum = key_column.attnum
                 WHERE key_column.position <= i.indnkeyatts
                 ORDER BY key_column.position
             ) = ARRAY['provider_message_id']::TEXT[]
             AND regexp_replace(
                 lower(pg_get_expr(i.indpred, i.indrelid)),
                 '[()[:space:]]',
                 '',
                 'g'
             ) = 'provider_message_idisnotnull'
       ) THEN
        CREATE UNIQUE INDEX uq_notifications_provider_message_id
            ON notifications (provider_message_id)
            WHERE provider_message_id IS NOT NULL;
    END IF;
END
$notification_objects$;

DO $payment_indexes$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_index i
        WHERE i.indrelid = 'mpesa_payment_attempts'::regclass
          AND i.indisunique
          AND i.indisvalid
          AND i.indisready
          AND i.indislive
          AND NOT i.indnullsnotdistinct
          AND i.indnatts = i.indnkeyatts
          AND i.indexprs IS NULL
          AND EXISTS (
              SELECT 1
              FROM pg_class index_relation
              JOIN pg_am access_method ON access_method.oid = index_relation.relam
              WHERE index_relation.oid = i.indexrelid
                AND access_method.amname = 'btree'
          )
          AND ARRAY(
              SELECT a.attname::TEXT
              FROM unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, position)
              JOIN pg_attribute a
                ON a.attrelid = i.indrelid
               AND a.attnum = key_column.attnum
              WHERE key_column.position <= i.indnkeyatts
              ORDER BY key_column.position
          ) = ARRAY['contribution_id']::TEXT[]
          AND regexp_replace(
              regexp_replace(
                  lower(pg_get_expr(i.indpred, i.indrelid)),
                  '::(pg_catalog\.)?(text|character varying)(\[\])?',
                  '',
                  'g'
              ),
              '[()[:space:]]',
              '',
              'g'
          ) = 'attempt_status=anyarray[''pending'',''outcome_unknown'',''prompt_accepted'']'
          AND ARRAY(
              SELECT captures[1]
              FROM regexp_matches(
                  pg_get_expr(i.indpred, i.indrelid),
                  '''([^'']*)''',
                  'g'
              ) AS matches(captures)
              ORDER BY captures[1]
          ) = ARRAY['OUTCOME_UNKNOWN', 'PENDING', 'PROMPT_ACCEPTED']::TEXT[]
    ) THEN
        CREATE UNIQUE INDEX uq_mpesa_payment_attempts_one_active_per_contribution
            ON mpesa_payment_attempts (contribution_id)
            WHERE attempt_status IN ('PENDING', 'OUTCOME_UNKNOWN', 'PROMPT_ACCEPTED');
    END IF;
END
$payment_indexes$;

DO $mpesa_callback_inbox_objects$
BEGIN
IF to_regclass('mpesa_callback_inbox') IS NULL THEN
CREATE TABLE mpesa_callback_inbox (
    callback_id                 BIGSERIAL PRIMARY KEY,
    callback_fingerprint        CHAR(64) NOT NULL UNIQUE
        CHECK (callback_fingerprint ~ '^[a-f0-9]{64}$'),
    checkout_request_id         VARCHAR(100) NOT NULL
        CHECK (checkout_request_id ~ '^[A-Za-z0-9_-]{1,100}$'),
    merchant_request_id         VARCHAR(100) NOT NULL
        CHECK (merchant_request_id ~ '^[A-Za-z0-9_-]{1,100}$'),
    callback_result_code        VARCHAR(30) NOT NULL
        CHECK (callback_result_code ~ '^-?[0-9]{1,30}$'),
    callback_amount             NUMERIC(12,2),
    callback_phone              VARCHAR(12)
        CHECK (callback_phone IS NULL OR callback_phone ~ '^254[17][0-9]{8}$'),
    callback_receipt            VARCHAR(25)
        CHECK (callback_receipt IS NULL OR callback_receipt ~ '^[A-Za-z0-9]{1,25}$'),
    callback_status             VARCHAR(20) NOT NULL DEFAULT 'UNMATCHED'
        CHECK (callback_status IN ('UNMATCHED', 'CORRELATED', 'VERIFIED', 'REJECTED')),
    attempt_id                  VARCHAR(25)
        REFERENCES mpesa_payment_attempts (attempt_id) ON DELETE RESTRICT,
    verification_id             BIGINT
        REFERENCES mpesa_payment_verifications (verification_id) ON DELETE RESTRICT,
    rejection_code              VARCHAR(64),
    duplicate_count             INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
    received_at                 TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    correlated_at               TIMESTAMP WITH TIME ZONE,
    verified_at                 TIMESTAMP WITH TIME ZONE,
    updated_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT ck_mpesa_callback_success_metadata CHECK (
        callback_result_code <> '0'
        OR (
            callback_amount IS NOT NULL
            AND callback_amount > 0
            AND callback_amount = trunc(callback_amount)
            AND callback_phone IS NOT NULL
            AND callback_receipt IS NOT NULL
        )
    ),
    CONSTRAINT ck_mpesa_callback_lifecycle CHECK (
        (callback_status = 'UNMATCHED'
            AND attempt_id IS NULL
            AND verification_id IS NULL
            AND rejection_code IS NULL)
        OR (callback_status = 'CORRELATED'
            AND attempt_id IS NOT NULL
            AND verification_id IS NULL
            AND correlated_at IS NOT NULL
            AND rejection_code IS NULL)
        OR (callback_status = 'VERIFIED'
            AND attempt_id IS NOT NULL
            AND verification_id IS NOT NULL
            AND correlated_at IS NOT NULL
            AND verified_at IS NOT NULL
            AND rejection_code IS NULL)
        OR (callback_status = 'REJECTED'
            AND rejection_code IS NOT NULL)
    )
);
END IF;

IF to_regclass('idx_mpesa_callback_inbox_status_received') IS NULL THEN
CREATE INDEX idx_mpesa_callback_inbox_status_received
    ON mpesa_callback_inbox (callback_status, received_at);
END IF;
IF to_regclass('idx_mpesa_callback_inbox_provider_ids') IS NULL THEN
CREATE INDEX idx_mpesa_callback_inbox_provider_ids
    ON mpesa_callback_inbox (checkout_request_id, merchant_request_id);
END IF;
IF to_regclass('idx_mpesa_callback_inbox_attempt') IS NULL THEN
CREATE INDEX idx_mpesa_callback_inbox_attempt
    ON mpesa_callback_inbox (attempt_id)
    WHERE attempt_id IS NOT NULL;
END IF;

IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = to_regclass('mpesa_callback_inbox')
      AND tgname = 'trg_mpesa_callback_inbox_set_updated_at'
      AND NOT tgisinternal
) THEN
CREATE TRIGGER trg_mpesa_callback_inbox_set_updated_at
    BEFORE UPDATE ON mpesa_callback_inbox
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
END IF;
END
$mpesa_callback_inbox_objects$;

DO $mobilesasa_callback_table$
BEGIN
IF to_regclass('mobilesasa_sms_delivery_callbacks') IS NULL THEN
CREATE TABLE mobilesasa_sms_delivery_callbacks (
    callback_id                 BIGSERIAL PRIMARY KEY,
    provider                    VARCHAR(20) NOT NULL DEFAULT 'MOBILE_SASA'
        CHECK (provider = 'MOBILE_SASA'),
    provider_message_reference  VARCHAR(128) NOT NULL
        CHECK (provider_message_reference <> ''),
    tracking_id                 VARCHAR(128),
    provider_dispatch_reference VARCHAR(128),
    delivery_status             VARCHAR(20) NOT NULL
        CHECK (delivery_status IN (
            'SENT', 'DELIVERED', 'FAILED', 'REJECTED', 'EXPIRED', 'UNREACHABLE'
        )),
    delivery_description        VARCHAR(255),
    delivery_code               VARCHAR(40),
    gateway                     VARCHAR(40),
    provider_delivery_time      VARCHAR(40),
    provider_delivered_at       TIMESTAMP WITH TIME ZONE,
    provider_reported_at        TIMESTAMP WITH TIME ZONE,
    notification_id             VARCHAR(25)
        REFERENCES notifications (notification_id) ON DELETE SET NULL,
    original_notification_id    VARCHAR(25),
    processing_status           VARCHAR(20) NOT NULL DEFAULT 'UNMATCHED'
        CHECK (processing_status IN (
            'UNMATCHED', 'CORRELATED', 'APPLIED', 'IGNORED', 'REJECTED'
        )),
    rejection_code              VARCHAR(64)
        CHECK (rejection_code IS NULL OR rejection_code ~ '^[A-Z0-9_]{1,64}$'),
    duplicate_count             INTEGER NOT NULL DEFAULT 0
        CHECK (duplicate_count >= 0),
    signature_verified_at       TIMESTAMP WITH TIME ZONE NOT NULL,
    received_at                 TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    correlated_at               TIMESTAMP WITH TIME ZONE,
    processed_at                TIMESTAMP WITH TIME ZONE,
    updated_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT uq_mobilesasa_callback_provider_reference_status
        UNIQUE (provider, provider_message_reference, delivery_status),
    CONSTRAINT ck_mobilesasa_callback_notification_reference CHECK (
        notification_id IS NULL
        OR (
            original_notification_id IS NOT NULL
            AND original_notification_id = notification_id
        )
    ),
    CONSTRAINT ck_mobilesasa_callback_lifecycle CHECK (
        (processing_status = 'UNMATCHED'
            AND notification_id IS NULL
            AND original_notification_id IS NULL
            AND correlated_at IS NULL
            AND processed_at IS NULL
            AND rejection_code IS NULL)
        OR (processing_status = 'CORRELATED'
            AND (notification_id IS NOT NULL OR original_notification_id IS NOT NULL)
            AND correlated_at IS NOT NULL
            AND processed_at IS NULL
            AND rejection_code IS NULL)
        OR (processing_status IN ('APPLIED', 'IGNORED')
            AND (notification_id IS NOT NULL OR original_notification_id IS NOT NULL)
            AND correlated_at IS NOT NULL
            AND processed_at IS NOT NULL
            AND rejection_code IS NULL)
        OR (processing_status = 'REJECTED'
            AND processed_at IS NOT NULL
            AND rejection_code IS NOT NULL)
    )
);
END IF;
END
$mobilesasa_callback_table$;

DO $mobilesasa_callback_function$
BEGIN
IF to_regprocedure('preserve_mobilesasa_callback_notification_reference()') IS NULL THEN
CREATE FUNCTION preserve_mobilesasa_callback_notification_reference()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.original_notification_id :=
            COALESCE(NEW.original_notification_id, NEW.notification_id);
    ELSIF OLD.notification_id IS NOT NULL AND NEW.notification_id IS NULL THEN
        NEW.original_notification_id :=
            COALESCE(NEW.original_notification_id, OLD.notification_id);
    ELSIF NEW.notification_id IS NOT NULL THEN
        IF OLD.original_notification_id IS NOT NULL
            AND OLD.original_notification_id <> NEW.notification_id THEN
            RAISE EXCEPTION 'A callback cannot be reassigned to another notification';
        END IF;
        NEW.original_notification_id :=
            COALESCE(NEW.original_notification_id, NEW.notification_id);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
END IF;
END
$mobilesasa_callback_function$;

DO $mobilesasa_callback_objects$
BEGIN
IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = to_regclass('mobilesasa_sms_delivery_callbacks')
      AND tgname = 'trg_mobilesasa_callbacks_preserve_notification_reference'
      AND NOT tgisinternal
) THEN
CREATE TRIGGER trg_mobilesasa_callbacks_preserve_notification_reference
    BEFORE INSERT OR UPDATE OF notification_id
    ON mobilesasa_sms_delivery_callbacks
    FOR EACH ROW
    EXECUTE FUNCTION preserve_mobilesasa_callback_notification_reference();
END IF;

IF to_regclass('idx_mobilesasa_callbacks_unmatched') IS NULL THEN
CREATE INDEX idx_mobilesasa_callbacks_unmatched
    ON mobilesasa_sms_delivery_callbacks (received_at, callback_id)
    WHERE processing_status = 'UNMATCHED';
END IF;
IF to_regclass('idx_mobilesasa_callbacks_notification') IS NULL THEN
CREATE INDEX idx_mobilesasa_callbacks_notification
    ON mobilesasa_sms_delivery_callbacks (notification_id, received_at DESC)
    WHERE notification_id IS NOT NULL;
END IF;
IF to_regclass('idx_mobilesasa_callbacks_original_notification') IS NULL THEN
CREATE INDEX idx_mobilesasa_callbacks_original_notification
    ON mobilesasa_sms_delivery_callbacks (original_notification_id, received_at DESC)
    WHERE original_notification_id IS NOT NULL;
END IF;
IF to_regclass('idx_mobilesasa_callbacks_tracking_id') IS NULL THEN
CREATE INDEX idx_mobilesasa_callbacks_tracking_id
    ON mobilesasa_sms_delivery_callbacks (tracking_id)
    WHERE tracking_id IS NOT NULL;
END IF;
IF to_regclass('idx_mobilesasa_callbacks_dispatch_reference') IS NULL THEN
CREATE INDEX idx_mobilesasa_callbacks_dispatch_reference
    ON mobilesasa_sms_delivery_callbacks (provider_dispatch_reference)
    WHERE provider_dispatch_reference IS NOT NULL;
END IF;

IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = to_regclass('mobilesasa_sms_delivery_callbacks')
      AND tgname = 'trg_mobilesasa_callbacks_set_updated_at'
      AND NOT tgisinternal
) THEN
CREATE TRIGGER trg_mobilesasa_callbacks_set_updated_at
    BEFORE UPDATE ON mobilesasa_sms_delivery_callbacks
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
END IF;
END
$mobilesasa_callback_objects$;

COMMIT;
