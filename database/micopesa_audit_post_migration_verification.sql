\set ON_ERROR_STOP on
\pset pager off

DO $preflight$
DECLARE
    server_address INET;
BEGIN
    IF current_database() <> 'Micopesa_migration_audit' THEN
        RAISE EXCEPTION 'Refusing verification: unexpected database';
    END IF;

    server_address := inet_server_addr();
    IF server_address IS NULL
       OR NOT (
           server_address <<= inet '127.0.0.0/8'
           OR server_address <<= inet '::1/128'
       ) THEN
        RAISE EXCEPTION 'Refusing verification: server is not loopback';
    END IF;

    IF inet_server_port() <> 5433 THEN
        RAISE EXCEPTION 'Refusing verification: unexpected server port';
    END IF;
END;
$preflight$;

CREATE TEMP TABLE micopesa_expected_mpesa_callback_lifecycle
AS
SELECT
    callback_status,
    attempt_id,
    verification_id,
    correlated_at,
    verified_at,
    rejection_code
FROM public.mpesa_callback_inbox
WITH NO DATA;

ALTER TABLE pg_temp.micopesa_expected_mpesa_callback_lifecycle
ADD CONSTRAINT expected_mpesa_callback_lifecycle CHECK (
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
);

CREATE TEMP TABLE micopesa_expected_mobilesasa_callback_lifecycle
AS
SELECT
    processing_status,
    notification_id,
    original_notification_id,
    correlated_at,
    processed_at,
    rejection_code
FROM public.mobilesasa_sms_delivery_callbacks
WITH NO DATA;

ALTER TABLE pg_temp.micopesa_expected_mobilesasa_callback_lifecycle
ADD CONSTRAINT expected_mobilesasa_callback_lifecycle CHECK (
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
);

BEGIN;
SET TRANSACTION READ ONLY;

SELECT
    current_database() AS database_name,
    host(inet_server_addr()) AS server_address,
    inet_server_port() AS server_port,
    version() AS server_version;

DO $required_relations$
DECLARE
    missing_relation TEXT;
BEGIN
    FOR missing_relation IN
        SELECT expected.relation_name
        FROM unnest(ARRAY[
            'notifications',
            'notification_preferences',
            'mpesa_payment_attempts',
            'mpesa_payment_verifications',
            'mpesa_callback_inbox',
            'mobilesasa_sms_delivery_callbacks'
        ]::TEXT[]) AS expected(relation_name)
        WHERE to_regclass(format('public.%I', expected.relation_name)) IS NULL
    LOOP
        RAISE EXCEPTION 'Required post-migration relation is missing: %', missing_relation;
    END LOOP;
END;
$required_relations$;

SELECT
    relation.relname AS table_name,
    attribute.attnum AS ordinal_position,
    attribute.attname AS column_name,
    format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
    NOT attribute.attnotnull AS is_nullable,
    attribute.attidentity AS identity_kind,
    attribute.attgenerated AS generated_kind,
    pg_get_expr(default_value.adbin, default_value.adrelid) AS column_default
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
LEFT JOIN pg_attrdef AS default_value
  ON default_value.adrelid = relation.oid
 AND default_value.adnum = attribute.attnum
WHERE namespace.nspname = 'public'
  AND relation.relname IN (
      'notifications',
      'notification_preferences',
      'mpesa_payment_attempts',
      'mpesa_callback_inbox',
      'mobilesasa_sms_delivery_callbacks'
  )
  AND relation.relkind IN ('r', 'p')
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
ORDER BY relation.relname, attribute.attnum;

SELECT
    table_relation.relname AS table_name,
    constraint_data.conname AS constraint_name,
    constraint_data.contype::TEXT AS constraint_type,
    constraint_data.convalidated AS is_validated,
    constraint_data.condeferrable AS is_deferrable,
    constraint_data.condeferred AS initially_deferred,
    referenced_namespace.nspname AS referenced_schema,
    referenced_relation.relname AS referenced_table,
    constraint_data.confupdtype AS update_action_code,
    constraint_data.confdeltype AS delete_action_code,
    pg_get_constraintdef(constraint_data.oid) AS definition
FROM pg_constraint AS constraint_data
JOIN pg_class AS table_relation ON table_relation.oid = constraint_data.conrelid
JOIN pg_namespace AS table_namespace
  ON table_namespace.oid = table_relation.relnamespace
LEFT JOIN pg_class AS referenced_relation
  ON referenced_relation.oid = constraint_data.confrelid
LEFT JOIN pg_namespace AS referenced_namespace
  ON referenced_namespace.oid = referenced_relation.relnamespace
WHERE table_namespace.nspname = 'public'
  AND table_relation.relname IN (
      'notifications',
      'notification_preferences',
      'mpesa_callback_inbox',
      'mobilesasa_sms_delivery_callbacks'
  )
ORDER BY table_relation.relname, constraint_data.contype::TEXT, constraint_data.conname;

DO $required_constraints$
DECLARE
    missing_constraint RECORD;
    invalid_constraint RECORD;
    key_constraint RECORD;
BEGIN
    FOR missing_constraint IN
        SELECT required.table_name, required.constraint_name, required.constraint_type
        FROM (VALUES
            ('notification_preferences', 'notification_preferences_pkey', 'p'),
            ('notification_preferences', 'notification_preferences_user_id_fkey', 'f'),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_pkey', 'p'),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_callback_fingerprint_key', 'u'),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_callback_fingerprint_check', 'c'),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_checkout_request_id_check', 'c'),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_merchant_request_id_check', 'c'),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_callback_result_code_check', 'c'),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_callback_phone_check', 'c'),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_callback_receipt_check', 'c'),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_callback_status_check', 'c'),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_duplicate_count_check', 'c'),
            ('mpesa_callback_inbox', 'ck_mpesa_callback_success_metadata', 'c'),
            ('mpesa_callback_inbox', 'ck_mpesa_callback_lifecycle', 'c'),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_attempt_id_fkey', 'f'),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_verification_id_fkey', 'f'),
            ('mobilesasa_sms_delivery_callbacks', 'mobilesasa_sms_delivery_callbacks_pkey', 'p'),
            ('mobilesasa_sms_delivery_callbacks', 'mobilesasa_sms_delivery_callbacks_provider_check', 'c'),
            ('mobilesasa_sms_delivery_callbacks', 'mobilesasa_sms_delivery_callba_provider_message_reference_check', 'c'),
            ('mobilesasa_sms_delivery_callbacks', 'mobilesasa_sms_delivery_callbacks_delivery_status_check', 'c'),
            ('mobilesasa_sms_delivery_callbacks', 'mobilesasa_sms_delivery_callbacks_notification_id_fkey', 'f'),
            ('mobilesasa_sms_delivery_callbacks', 'mobilesasa_sms_delivery_callbacks_processing_status_check', 'c'),
            ('mobilesasa_sms_delivery_callbacks', 'mobilesasa_sms_delivery_callbacks_rejection_code_check', 'c'),
            ('mobilesasa_sms_delivery_callbacks', 'mobilesasa_sms_delivery_callbacks_duplicate_count_check', 'c'),
            ('mobilesasa_sms_delivery_callbacks', 'uq_mobilesasa_callback_provider_reference_status', 'u'),
            ('mobilesasa_sms_delivery_callbacks', 'ck_mobilesasa_callback_notification_reference', 'c'),
            ('mobilesasa_sms_delivery_callbacks', 'ck_mobilesasa_callback_lifecycle', 'c')
        ) AS required(table_name, constraint_name, constraint_type)
        LEFT JOIN pg_class AS table_relation
          ON table_relation.oid = to_regclass(format('public.%I', required.table_name))
        LEFT JOIN pg_constraint AS constraint_data
          ON constraint_data.conrelid = table_relation.oid
         AND constraint_data.conname = required.constraint_name
        WHERE constraint_data.oid IS NULL
           OR constraint_data.contype::TEXT <> required.constraint_type
           OR constraint_data.condeferrable
           OR constraint_data.condeferred
    LOOP
        RAISE EXCEPTION 'Missing or mistyped required constraint %.%',
            missing_constraint.table_name, missing_constraint.constraint_name;
    END LOOP;

    FOR invalid_constraint IN
        SELECT table_relation.relname AS table_name, constraint_data.conname AS constraint_name
        FROM pg_constraint AS constraint_data
        JOIN pg_class AS table_relation ON table_relation.oid = constraint_data.conrelid
        JOIN pg_namespace AS namespace ON namespace.oid = table_relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND table_relation.relname IN (
              'notification_preferences',
              'mpesa_callback_inbox',
              'mobilesasa_sms_delivery_callbacks'
          )
          AND constraint_data.contype::TEXT IN ('p', 'u', 'f', 'c')
          AND NOT constraint_data.convalidated
    LOOP
        RAISE EXCEPTION 'Unvalidated structural constraint %.%',
            invalid_constraint.table_name, invalid_constraint.constraint_name;
    END LOOP;

    FOR key_constraint IN
        SELECT * FROM (VALUES
            ('notification_preferences', 'notification_preferences_pkey', TRUE,
                ARRAY['user_id']::TEXT[]),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_pkey', TRUE,
                ARRAY['callback_id']::TEXT[]),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_callback_fingerprint_key', FALSE,
                ARRAY['callback_fingerprint']::TEXT[]),
            ('mobilesasa_sms_delivery_callbacks', 'mobilesasa_sms_delivery_callbacks_pkey', TRUE,
                ARRAY['callback_id']::TEXT[]),
            ('mobilesasa_sms_delivery_callbacks', 'uq_mobilesasa_callback_provider_reference_status', FALSE,
                ARRAY['provider', 'provider_message_reference', 'delivery_status']::TEXT[])
        ) AS expected(table_name, constraint_name, is_primary, key_columns)
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint AS constraint_data
            WHERE constraint_data.conrelid =
                      to_regclass(format('public.%I', key_constraint.table_name))
              AND constraint_data.conname = key_constraint.constraint_name
              AND constraint_data.conindid <> 0
              AND ARRAY(
                  SELECT attribute.attname::TEXT
                  FROM unnest(constraint_data.conkey)
                       WITH ORDINALITY AS key_column(attnum, position)
                  JOIN pg_attribute AS attribute
                    ON attribute.attrelid = constraint_data.conrelid
                   AND attribute.attnum = key_column.attnum
                  ORDER BY key_column.position
              ) = key_constraint.key_columns
              AND EXISTS (
                  SELECT 1
                  FROM pg_index AS index_data
                  JOIN pg_class AS index_relation
                    ON index_relation.oid = index_data.indexrelid
                  JOIN pg_am AS access_method
                    ON access_method.oid = index_relation.relam
                  WHERE index_data.indexrelid = constraint_data.conindid
                    AND index_data.indisunique
                    AND index_data.indisprimary = key_constraint.is_primary
                    AND index_data.indisvalid
                    AND index_data.indisready
                    AND index_data.indislive
                    AND index_data.indimmediate
                    AND NOT index_data.indnullsnotdistinct
                    AND index_data.indpred IS NULL
                    AND index_data.indexprs IS NULL
                    AND index_data.indnatts = cardinality(key_constraint.key_columns)
                    AND index_data.indnkeyatts = cardinality(key_constraint.key_columns)
                    AND access_method.amname = 'btree'
                    AND ARRAY(
                        SELECT attribute.attname::TEXT
                        FROM unnest(index_data.indkey)
                             WITH ORDINALITY AS key_column(attnum, position)
                        JOIN pg_attribute AS attribute
                          ON attribute.attrelid = index_data.indrelid
                         AND attribute.attnum = key_column.attnum
                        WHERE key_column.position <= index_data.indnkeyatts
                        ORDER BY key_column.position
                    ) = key_constraint.key_columns
              )
        ) THEN
            RAISE EXCEPTION 'Missing or incompatible key constraint/index %',
                key_constraint.constraint_name;
        END IF;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint AS constraint_data
        WHERE constraint_data.conrelid = 'public.notifications'::regclass
          AND constraint_data.conname = 'ck_notifications_delivery_status'
          AND constraint_data.contype = 'c'
          AND constraint_data.convalidated
          AND ARRAY(
              SELECT captures[1]
              FROM regexp_matches(
                  pg_get_constraintdef(constraint_data.oid),
                  '''([^'']*)''',
                  'g'
              ) AS matches(captures)
              ORDER BY captures[1]
          ) = ARRAY[
              'DELIVERED', 'FAILED', 'PENDING', 'PROCESSING',
              'PROVIDER_ACCEPTED', 'UNKNOWN'
          ]::TEXT[]
    ) THEN
        RAISE EXCEPTION 'notifications delivery-status constraint is missing, unvalidated, or incompatible';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint AS constraint_data
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = constraint_data.conrelid
         AND attribute.attname = 'notification_type'
         AND NOT attribute.attisdropped
        WHERE constraint_data.conrelid = 'public.notifications'::regclass
          AND constraint_data.contype = 'c'
          AND constraint_data.convalidated
          AND constraint_data.conkey @> ARRAY[attribute.attnum]::SMALLINT[]
          AND ARRAY(
              SELECT captures[1]
              FROM regexp_matches(
                  pg_get_constraintdef(constraint_data.oid),
                  '''([^'']*)''',
                  'g'
              ) AS matches(captures)
              ORDER BY captures[1]
          ) = ARRAY['EMAIL', 'IN_APP', 'PUSH', 'SMS', 'USSD']::TEXT[]
    ) THEN
        RAISE EXCEPTION 'notifications notification_type constraint is missing, unvalidated, or incompatible';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM unnest(ARRAY[
            'created_at', 'email_enabled', 'sms_enabled', 'updated_at', 'user_id'
        ]::TEXT[]) AS expected(column_name)
        LEFT JOIN pg_attribute AS attribute
          ON attribute.attrelid = 'public.notification_preferences'::regclass
         AND attribute.attname = expected.column_name
         AND NOT attribute.attisdropped
        WHERE attribute.attnum IS NULL OR NOT attribute.attnotnull
    ) THEN
        RAISE EXCEPTION 'notification_preferences is missing a required NOT NULL attribute';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM unnest(ARRAY[
            'callback_fingerprint', 'callback_id', 'callback_result_code',
            'callback_status', 'checkout_request_id', 'duplicate_count',
            'merchant_request_id', 'received_at', 'updated_at'
        ]::TEXT[]) AS expected(column_name)
        LEFT JOIN pg_attribute AS attribute
          ON attribute.attrelid = 'public.mpesa_callback_inbox'::regclass
         AND attribute.attname = expected.column_name
         AND NOT attribute.attisdropped
        WHERE attribute.attnum IS NULL OR NOT attribute.attnotnull
    ) THEN
        RAISE EXCEPTION 'mpesa_callback_inbox is missing a required NOT NULL attribute';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM unnest(ARRAY[
            'callback_id', 'duplicate_count', 'delivery_status', 'processing_status',
            'provider', 'provider_message_reference', 'received_at',
            'signature_verified_at', 'updated_at'
        ]::TEXT[]) AS expected(column_name)
        LEFT JOIN pg_attribute AS attribute
          ON attribute.attrelid = 'public.mobilesasa_sms_delivery_callbacks'::regclass
         AND attribute.attname = expected.column_name
         AND NOT attribute.attisdropped
        WHERE attribute.attnum IS NULL OR NOT attribute.attnotnull
    ) THEN
        RAISE EXCEPTION 'mobilesasa_sms_delivery_callbacks is missing a required NOT NULL attribute';
    END IF;
END;
$required_constraints$;

DO $required_lifecycle_definitions$
DECLARE
    expected_lifecycle RECORD;
    actual_definition TEXT;
    expected_definition TEXT;
    normalized_actual_definition TEXT;
    normalized_expected_definition TEXT;
    actual_literals TEXT[];
BEGIN
    FOR expected_lifecycle IN
        SELECT * FROM (VALUES
            ('mpesa_callback_inbox',
             'ck_mpesa_callback_lifecycle',
             'micopesa_expected_mpesa_callback_lifecycle',
             'expected_mpesa_callback_lifecycle',
             ARRAY['CORRELATED', 'REJECTED', 'UNMATCHED', 'VERIFIED']::TEXT[]),
            ('mobilesasa_sms_delivery_callbacks',
             'ck_mobilesasa_callback_lifecycle',
             'micopesa_expected_mobilesasa_callback_lifecycle',
             'expected_mobilesasa_callback_lifecycle',
             ARRAY['APPLIED', 'CORRELATED', 'IGNORED', 'REJECTED', 'UNMATCHED']::TEXT[])
        ) AS expected(
            table_name,
            constraint_name,
            expected_table_name,
            expected_constraint_name,
            expected_literals
        )
    LOOP
        SELECT pg_get_constraintdef(constraint_data.oid)
        INTO actual_definition
        FROM pg_constraint AS constraint_data
        WHERE constraint_data.conrelid =
                  to_regclass(format('public.%I', expected_lifecycle.table_name))
          AND constraint_data.conname = expected_lifecycle.constraint_name
          AND constraint_data.contype = 'c'
          AND constraint_data.convalidated;

        IF NOT FOUND THEN
            RAISE EXCEPTION
                'Missing or unvalidated lifecycle CHECK constraint public.%.%',
                expected_lifecycle.table_name,
                expected_lifecycle.constraint_name;
        END IF;

        SELECT pg_get_constraintdef(constraint_data.oid)
        INTO expected_definition
        FROM pg_constraint AS constraint_data
        WHERE constraint_data.conrelid =
                  to_regclass(format('pg_temp.%I', expected_lifecycle.expected_table_name))
          AND constraint_data.conname = expected_lifecycle.expected_constraint_name
          AND constraint_data.contype = 'c'
          AND constraint_data.convalidated;

        IF NOT FOUND THEN
            RAISE EXCEPTION
                'Could not generate expected lifecycle CHECK definition for public.%.%',
                expected_lifecycle.table_name,
                expected_lifecycle.constraint_name;
        END IF;

        SELECT array_agg(captures[1] ORDER BY captures[1])
        INTO actual_literals
        FROM regexp_matches(actual_definition, '''([^'']*)''', 'g') AS matches(captures);

        IF actual_literals IS DISTINCT FROM expected_lifecycle.expected_literals THEN
            RAISE EXCEPTION
                'Lifecycle CHECK constraint public.%.% has unexpected case-sensitive literals',
                expected_lifecycle.table_name,
                expected_lifecycle.constraint_name;
        END IF;

        normalized_actual_definition := regexp_replace(
            regexp_replace(
                lower(actual_definition),
                '::(pg_catalog\.)?(character varying|text|integer)(\[\])?',
                '',
                'g'
            ),
            '[[:space:]]',
            '',
            'g'
        );
        normalized_expected_definition := regexp_replace(
            regexp_replace(
                lower(expected_definition),
                '::(pg_catalog\.)?(character varying|text|integer)(\[\])?',
                '',
                'g'
            ),
            '[[:space:]]',
            '',
            'g'
        );

        IF normalized_actual_definition IS DISTINCT FROM
           normalized_expected_definition THEN
            RAISE EXCEPTION
                'Lifecycle CHECK constraint public.%.% has an unexpected complete definition',
                expected_lifecycle.table_name,
                expected_lifecycle.constraint_name;
        END IF;
    END LOOP;
END;
$required_lifecycle_definitions$;

DO $required_check_definitions$
DECLARE
    expected_check RECORD;
    actual_definition TEXT;
    actual_normalized_definition TEXT;
    actual_literals TEXT[];
BEGIN
    FOR expected_check IN
        SELECT * FROM (VALUES
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_callback_fingerprint_check',
                $definition$checkcallback_fingerprint~'^[a-f0-9]{64}$'$definition$,
                ARRAY['^[a-f0-9]{64}$']::TEXT[]),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_checkout_request_id_check',
                $definition$checkcheckout_request_id~'^[a-za-z0-9_-]{1,100}$'$definition$,
                ARRAY['^[A-Za-z0-9_-]{1,100}$']::TEXT[]),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_merchant_request_id_check',
                $definition$checkmerchant_request_id~'^[a-za-z0-9_-]{1,100}$'$definition$,
                ARRAY['^[A-Za-z0-9_-]{1,100}$']::TEXT[]),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_callback_result_code_check',
                $definition$checkcallback_result_code~'^-?[0-9]{1,30}$'$definition$,
                ARRAY['^-?[0-9]{1,30}$']::TEXT[]),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_callback_phone_check',
                $definition$checkcallback_phoneisnullorcallback_phone~'^254[17][0-9]{8}$'$definition$,
                ARRAY['^254[17][0-9]{8}$']::TEXT[]),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_callback_receipt_check',
                $definition$checkcallback_receiptisnullorcallback_receipt~'^[a-za-z0-9]{1,25}$'$definition$,
                ARRAY['^[A-Za-z0-9]{1,25}$']::TEXT[]),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_callback_status_check',
                $definition$checkcallback_status=anyarray['unmatched','correlated','verified','rejected']$definition$,
                ARRAY['CORRELATED', 'REJECTED', 'UNMATCHED', 'VERIFIED']::TEXT[]),
            ('mpesa_callback_inbox', 'mpesa_callback_inbox_duplicate_count_check',
                $definition$checkduplicate_count>=0$definition$, NULL::TEXT[]),
            ('mpesa_callback_inbox', 'ck_mpesa_callback_success_metadata',
                $definition$checkcallback_result_code<>'0'orcallback_amountisnotnullandcallback_amount>0andcallback_amount=trunccallback_amountandcallback_phoneisnotnullandcallback_receiptisnotnull$definition$,
                ARRAY['0']::TEXT[]),
            ('mpesa_callback_inbox', 'ck_mpesa_callback_lifecycle', NULL::TEXT,
                ARRAY['CORRELATED', 'REJECTED', 'UNMATCHED', 'VERIFIED']::TEXT[]),
            ('mobilesasa_sms_delivery_callbacks', 'mobilesasa_sms_delivery_callbacks_provider_check',
                $definition$checkprovider='mobile_sasa'$definition$, ARRAY['MOBILE_SASA']::TEXT[]),
            ('mobilesasa_sms_delivery_callbacks', 'mobilesasa_sms_delivery_callba_provider_message_reference_check',
                $definition$checkprovider_message_reference<>''$definition$, ARRAY['']::TEXT[]),
            ('mobilesasa_sms_delivery_callbacks', 'mobilesasa_sms_delivery_callbacks_delivery_status_check',
                $definition$checkdelivery_status=anyarray['sent','delivered','failed','rejected','expired','unreachable']$definition$,
                ARRAY['DELIVERED', 'EXPIRED', 'FAILED', 'REJECTED', 'SENT', 'UNREACHABLE']::TEXT[]),
            ('mobilesasa_sms_delivery_callbacks', 'mobilesasa_sms_delivery_callbacks_processing_status_check',
                $definition$checkprocessing_status=anyarray['unmatched','correlated','applied','ignored','rejected']$definition$,
                ARRAY['APPLIED', 'CORRELATED', 'IGNORED', 'REJECTED', 'UNMATCHED']::TEXT[]),
            ('mobilesasa_sms_delivery_callbacks', 'mobilesasa_sms_delivery_callbacks_rejection_code_check',
                $definition$checkrejection_codeisnullorrejection_code~'^[a-z0-9_]{1,64}$'$definition$,
                ARRAY['^[A-Z0-9_]{1,64}$']::TEXT[]),
            ('mobilesasa_sms_delivery_callbacks', 'mobilesasa_sms_delivery_callbacks_duplicate_count_check',
                $definition$checkduplicate_count>=0$definition$, NULL::TEXT[]),
            ('mobilesasa_sms_delivery_callbacks', 'ck_mobilesasa_callback_notification_reference',
                $definition$checknotification_idisnullororiginal_notification_idisnotnullandoriginal_notification_id=notification_id$definition$,
                NULL::TEXT[]),
            ('mobilesasa_sms_delivery_callbacks', 'ck_mobilesasa_callback_lifecycle', NULL::TEXT,
                ARRAY['APPLIED', 'CORRELATED', 'IGNORED', 'REJECTED', 'UNMATCHED']::TEXT[])
        ) AS expected(table_name, constraint_name, normalized_definition, expected_literals)
    LOOP
        SELECT pg_get_constraintdef(constraint_data.oid)
        INTO actual_definition
        FROM pg_constraint AS constraint_data
        WHERE constraint_data.conrelid =
                  to_regclass(format('public.%I', expected_check.table_name))
          AND constraint_data.conname = expected_check.constraint_name
          AND constraint_data.contype = 'c'
          AND constraint_data.convalidated;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Missing or unvalidated CHECK constraint %',
                expected_check.constraint_name;
        END IF;

        SELECT array_agg(captures[1] ORDER BY captures[1])
        INTO actual_literals
        FROM regexp_matches(actual_definition, '''([^'']*)''', 'g') AS matches(captures);
        IF actual_literals IS DISTINCT FROM expected_check.expected_literals THEN
            RAISE EXCEPTION 'CHECK constraint % has unexpected literals',
                expected_check.constraint_name;
        END IF;

        IF expected_check.normalized_definition IS NOT NULL THEN
            actual_normalized_definition := regexp_replace(
                regexp_replace(
                    lower(actual_definition),
                    '::(pg_catalog\.)?(text|numeric|character varying|integer|bigint)(\[\])?',
                    '',
                    'g'
                ),
                '[()[:space:]]',
                '',
                'g'
            );
            IF actual_normalized_definition IS DISTINCT FROM
               expected_check.normalized_definition THEN
                RAISE EXCEPTION 'CHECK constraint % has an unexpected definition',
                    expected_check.constraint_name;
            END IF;
        END IF;
    END LOOP;

    SELECT regexp_replace(
               regexp_replace(
                   lower(pg_get_constraintdef(constraint_data.oid)),
                   '::(pg_catalog\.)?(text|character varying)(\[\])?',
                   '',
                   'g'
               ),
               '[()[:space:]]',
               '',
               'g'
           )
    INTO actual_normalized_definition
    FROM pg_constraint AS constraint_data
    WHERE constraint_data.conrelid = 'public.notifications'::regclass
      AND constraint_data.conname = 'ck_notifications_delivery_status'
      AND constraint_data.contype = 'c'
      AND constraint_data.convalidated;
    IF actual_normalized_definition !~ '^checkdelivery_status=anyarray\[[^]]+\]$' THEN
        RAISE EXCEPTION 'notifications delivery-status constraint has unexpected logic';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint AS constraint_data
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = constraint_data.conrelid
         AND attribute.attname = 'notification_type'
         AND NOT attribute.attisdropped
        WHERE constraint_data.conrelid = 'public.notifications'::regclass
          AND constraint_data.contype = 'c'
          AND constraint_data.convalidated
          AND constraint_data.conkey @> ARRAY[attribute.attnum]::SMALLINT[]
          AND regexp_replace(
              regexp_replace(
                  lower(pg_get_constraintdef(constraint_data.oid)),
                  '::(pg_catalog\.)?(text|character varying)(\[\])?',
                  '',
                  'g'
              ),
              '[()[:space:]]',
              '',
              'g'
          ) ~ '^checknotification_type=anyarray\[[^]]+\]$'
    ) THEN
        RAISE EXCEPTION 'notifications notification_type constraint has unexpected logic';
    END IF;
END;
$required_check_definitions$;

DO $required_foreign_keys$
DECLARE
    expected_foreign_key RECORD;
BEGIN
    FOR expected_foreign_key IN
        SELECT * FROM (VALUES
            ('notification_preferences', 'user_id', 'users', 'user_id', 'c'),
            ('mpesa_callback_inbox', 'attempt_id', 'mpesa_payment_attempts', 'attempt_id', 'r'),
            ('mpesa_callback_inbox', 'verification_id', 'mpesa_payment_verifications', 'verification_id', 'r'),
            ('mobilesasa_sms_delivery_callbacks', 'notification_id', 'notifications', 'notification_id', 'n'),
            ('notifications', 'scope_fund_id', 'funds', 'fund_id', 'n')
        ) AS expected(table_name, local_column, referenced_table, referenced_column, delete_action)
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint AS constraint_data
            WHERE constraint_data.conrelid =
                      to_regclass(format('public.%I', expected_foreign_key.table_name))
              AND constraint_data.contype = 'f'
              AND constraint_data.convalidated
              AND NOT constraint_data.condeferrable
              AND NOT constraint_data.condeferred
              AND constraint_data.confrelid =
                      to_regclass(format('public.%I', expected_foreign_key.referenced_table))
              AND constraint_data.confmatchtype = 's'
              AND constraint_data.confupdtype = 'a'
              AND constraint_data.confdeltype = expected_foreign_key.delete_action
              AND ARRAY(
                  SELECT attribute.attname::TEXT
                  FROM unnest(constraint_data.conkey) WITH ORDINALITY AS key_column(attnum, position)
                  JOIN pg_attribute AS attribute
                    ON attribute.attrelid = constraint_data.conrelid
                   AND attribute.attnum = key_column.attnum
                  ORDER BY key_column.position
              ) = ARRAY[expected_foreign_key.local_column]::TEXT[]
              AND ARRAY(
                  SELECT attribute.attname::TEXT
                  FROM unnest(constraint_data.confkey) WITH ORDINALITY AS key_column(attnum, position)
                  JOIN pg_attribute AS attribute
                    ON attribute.attrelid = constraint_data.confrelid
                   AND attribute.attnum = key_column.attnum
                  ORDER BY key_column.position
              ) = ARRAY[expected_foreign_key.referenced_column]::TEXT[]
        ) THEN
            RAISE EXCEPTION 'Missing or incompatible foreign key %.% -> %.%',
                expected_foreign_key.table_name,
                expected_foreign_key.local_column,
                expected_foreign_key.referenced_table,
                expected_foreign_key.referenced_column;
        END IF;
    END LOOP;
END;
$required_foreign_keys$;

SELECT
    table_relation.relname AS table_name,
    index_relation.relname AS index_name,
    index_data.indisprimary AS is_primary,
    index_data.indisunique AS is_unique,
    index_data.indisvalid AS is_valid,
    index_data.indisready AS is_ready,
    index_data.indislive AS is_live,
    index_data.indimmediate AS is_immediate,
    ARRAY(
        SELECT attribute.attname::TEXT
        FROM unnest(index_data.indkey) WITH ORDINALITY AS key_column(attnum, position)
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = index_data.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.position <= index_data.indnkeyatts
        ORDER BY key_column.position
    ) AS key_columns,
    pg_get_expr(index_data.indpred, index_data.indrelid) AS predicate,
    pg_get_indexdef(index_data.indexrelid) AS definition
FROM pg_index AS index_data
JOIN pg_class AS table_relation ON table_relation.oid = index_data.indrelid
JOIN pg_namespace AS table_namespace
  ON table_namespace.oid = table_relation.relnamespace
JOIN pg_class AS index_relation ON index_relation.oid = index_data.indexrelid
JOIN pg_namespace AS index_namespace
  ON index_namespace.oid = index_relation.relnamespace
WHERE table_namespace.nspname = 'public'
  AND index_namespace.nspname = 'public'
  AND table_relation.relname IN (
      'notifications',
      'mpesa_payment_attempts',
      'mpesa_callback_inbox',
      'mobilesasa_sms_delivery_callbacks'
  )
ORDER BY table_relation.relname, index_relation.relname;

DO $required_indexes$
DECLARE
    expected_index RECORD;
    actual_index RECORD;
    normalized_predicate TEXT;
BEGIN
    FOR expected_index IN
        SELECT * FROM (VALUES
            ('notifications', 'uq_notifications_user_channel_event_key', TRUE,
                ARRAY['user_id', 'notification_type', 'deduplication_key']::TEXT[],
                ARRAY[0, 0, 0]::SMALLINT[], 'deduplication_keyisnotnull'),
            ('notifications', 'uq_notifications_admin_request_channel', TRUE,
                ARRAY['admin_request_key', 'user_id', 'notification_type']::TEXT[],
                ARRAY[0, 0, 0]::SMALLINT[], 'admin_request_keyisnotnull'),
            ('notifications', 'uq_notifications_provider_message_id', TRUE,
                ARRAY['provider_message_id']::TEXT[], ARRAY[0]::SMALLINT[],
                'provider_message_idisnotnull'),
            ('mpesa_payment_attempts', 'uq_mpesa_payment_attempts_one_active_per_contribution', TRUE,
                ARRAY['contribution_id']::TEXT[], ARRAY[0]::SMALLINT[],
                'attempt_status=anyarray[''pending'',''outcome_unknown'',''prompt_accepted'']'),
            ('mpesa_callback_inbox', 'idx_mpesa_callback_inbox_status_received', FALSE,
                ARRAY['callback_status', 'received_at']::TEXT[], ARRAY[0, 0]::SMALLINT[], NULL::TEXT),
            ('mpesa_callback_inbox', 'idx_mpesa_callback_inbox_provider_ids', FALSE,
                ARRAY['checkout_request_id', 'merchant_request_id']::TEXT[], ARRAY[0, 0]::SMALLINT[], NULL::TEXT),
            ('mpesa_callback_inbox', 'idx_mpesa_callback_inbox_attempt', FALSE,
                ARRAY['attempt_id']::TEXT[], ARRAY[0]::SMALLINT[], 'attempt_idisnotnull'),
            ('mobilesasa_sms_delivery_callbacks', 'idx_mobilesasa_callbacks_unmatched', FALSE,
                ARRAY['received_at', 'callback_id']::TEXT[], ARRAY[0, 0]::SMALLINT[],
                'processing_status=''unmatched'''),
            ('mobilesasa_sms_delivery_callbacks', 'idx_mobilesasa_callbacks_notification', FALSE,
                ARRAY['notification_id', 'received_at']::TEXT[], ARRAY[0, 3]::SMALLINT[],
                'notification_idisnotnull'),
            ('mobilesasa_sms_delivery_callbacks', 'idx_mobilesasa_callbacks_original_notification', FALSE,
                ARRAY['original_notification_id', 'received_at']::TEXT[], ARRAY[0, 3]::SMALLINT[],
                'original_notification_idisnotnull'),
            ('mobilesasa_sms_delivery_callbacks', 'idx_mobilesasa_callbacks_tracking_id', FALSE,
                ARRAY['tracking_id']::TEXT[], ARRAY[0]::SMALLINT[], 'tracking_idisnotnull'),
            ('mobilesasa_sms_delivery_callbacks', 'idx_mobilesasa_callbacks_dispatch_reference', FALSE,
                ARRAY['provider_dispatch_reference']::TEXT[], ARRAY[0]::SMALLINT[],
                'provider_dispatch_referenceisnotnull')
        ) AS expected(table_name, index_name, is_unique, key_columns, index_options, predicate)
    LOOP
        SELECT index_data.*,
               index_relation.oid AS index_oid,
               index_data.indrelid AS table_oid,
               access_method.amname
        INTO actual_index
        FROM pg_class AS index_relation
        JOIN pg_namespace AS index_namespace
          ON index_namespace.oid = index_relation.relnamespace
        JOIN pg_index AS index_data ON index_data.indexrelid = index_relation.oid
        JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
        WHERE index_namespace.nspname = 'public'
          AND index_relation.relname = expected_index.index_name
          AND index_relation.relkind = 'i';

        IF NOT FOUND
           OR actual_index.table_oid <>
                to_regclass(format('public.%I', expected_index.table_name))
           OR actual_index.amname <> 'btree'
           OR actual_index.indisunique <> expected_index.is_unique
           OR NOT actual_index.indisvalid
           OR NOT actual_index.indisready
           OR NOT actual_index.indislive
           OR NOT actual_index.indimmediate
           OR actual_index.indnullsnotdistinct
           OR actual_index.indnatts <> cardinality(expected_index.key_columns)
           OR actual_index.indnkeyatts <> cardinality(expected_index.key_columns)
           OR actual_index.indexprs IS NOT NULL
           OR (
               SELECT array_agg(attribute.attname::TEXT ORDER BY key_column.position)
               FROM unnest(actual_index.indkey) WITH ORDINALITY AS key_column(attnum, position)
               JOIN pg_attribute AS attribute
                 ON attribute.attrelid = actual_index.table_oid
                AND attribute.attnum = key_column.attnum
               WHERE key_column.position <= actual_index.indnkeyatts
           ) IS DISTINCT FROM expected_index.key_columns
           OR (
               SELECT array_agg(option_data.option_flags::SMALLINT ORDER BY option_data.position)
               FROM unnest(actual_index.indoption) WITH ORDINALITY AS option_data(option_flags, position)
           ) IS DISTINCT FROM expected_index.index_options THEN
            RAISE EXCEPTION 'Missing or incompatible required index %',
                expected_index.index_name;
        END IF;

        normalized_predicate := CASE
            WHEN actual_index.indpred IS NULL THEN NULL
            ELSE regexp_replace(
                regexp_replace(
                    lower(pg_get_expr(actual_index.indpred, actual_index.table_oid)),
                    '::(pg_catalog\.)?(text|character varying)(\[\])?',
                    '',
                    'g'
                ),
                '[()[:space:]]',
                '',
                'g'
            )
        END;
        IF normalized_predicate IS DISTINCT FROM expected_index.predicate THEN
            RAISE EXCEPTION 'Required index % has an unexpected predicate',
                expected_index.index_name;
        END IF;
    END LOOP;
END;
$required_indexes$;

SELECT
    table_relation.relname AS table_name,
    trigger_data.tgname AS trigger_name,
    trigger_data.tgenabled AS enabled_state,
    pg_get_triggerdef(trigger_data.oid, TRUE) AS definition,
    procedure_data.proname AS function_name,
    pg_get_function_identity_arguments(procedure_data.oid) AS function_arguments
FROM pg_trigger AS trigger_data
JOIN pg_class AS table_relation ON table_relation.oid = trigger_data.tgrelid
JOIN pg_namespace AS table_namespace
  ON table_namespace.oid = table_relation.relnamespace
JOIN pg_proc AS procedure_data ON procedure_data.oid = trigger_data.tgfoid
WHERE table_namespace.nspname = 'public'
  AND table_relation.relname IN (
      'notification_preferences',
      'mpesa_callback_inbox',
      'mobilesasa_sms_delivery_callbacks'
  )
  AND NOT trigger_data.tgisinternal
ORDER BY table_relation.relname, trigger_data.tgname;

SELECT
    procedure_namespace.nspname AS function_schema,
    procedure_data.proname AS function_name,
    pg_get_function_identity_arguments(procedure_data.oid) AS function_arguments,
    format_type(procedure_data.prorettype, NULL) AS return_type,
    language_data.lanname AS function_language,
    procedure_data.prosecdef AS is_security_definer,
    procedure_data.proconfig AS function_settings,
    length(procedure_data.prosrc) AS source_length,
    md5(procedure_data.prosrc) AS source_fingerprint,
    procedure_data.prosrc AS function_body
FROM pg_proc AS procedure_data
JOIN pg_namespace AS procedure_namespace
  ON procedure_namespace.oid = procedure_data.pronamespace
JOIN pg_language AS language_data
  ON language_data.oid = procedure_data.prolang
WHERE procedure_namespace.nspname = 'public'
  AND procedure_data.proname IN (
      'set_updated_at',
      'preserve_mobilesasa_callback_notification_reference'
  )
ORDER BY procedure_data.proname, pg_get_function_identity_arguments(procedure_data.oid);

DO $required_triggers$
DECLARE
    expected_trigger RECORD;
BEGIN
    FOR expected_trigger IN
        SELECT * FROM (VALUES
            ('notification_preferences', 'trg_notification_preferences_set_updated_at', 'set_updated_at', 19, NULL::TEXT),
            ('mpesa_callback_inbox', 'trg_mpesa_callback_inbox_set_updated_at', 'set_updated_at', 19, NULL::TEXT),
            ('mobilesasa_sms_delivery_callbacks', 'trg_mobilesasa_callbacks_preserve_notification_reference',
                'preserve_mobilesasa_callback_notification_reference', 23, 'notification_id'),
            ('mobilesasa_sms_delivery_callbacks', 'trg_mobilesasa_callbacks_set_updated_at',
                'set_updated_at', 19, NULL::TEXT)
        ) AS expected(table_name, trigger_name, function_name, trigger_type, update_column)
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM pg_trigger AS trigger_data
            JOIN pg_class AS table_relation ON table_relation.oid = trigger_data.tgrelid
            JOIN pg_namespace AS namespace ON namespace.oid = table_relation.relnamespace
            JOIN pg_proc AS procedure_data ON procedure_data.oid = trigger_data.tgfoid
            WHERE namespace.nspname = 'public'
              AND table_relation.relname = expected_trigger.table_name
              AND trigger_data.tgname = expected_trigger.trigger_name
              AND NOT trigger_data.tgisinternal
              AND trigger_data.tgenabled IN ('O', 'A')
              AND trigger_data.tgtype = expected_trigger.trigger_type
              AND trigger_data.tgnargs = 0
              AND trigger_data.tgqual IS NULL
              AND (
                  expected_trigger.update_column IS NULL
                  AND trigger_data.tgattr = ''::int2vector
                  OR expected_trigger.update_column IS NOT NULL
                  AND trigger_data.tgattr::TEXT = (
                      SELECT attribute.attnum::TEXT
                      FROM pg_attribute AS attribute
                      WHERE attribute.attrelid = trigger_data.tgrelid
                        AND attribute.attname = expected_trigger.update_column
                        AND NOT attribute.attisdropped
                  )
              )
              AND procedure_data.proname = expected_trigger.function_name
              AND procedure_data.pronamespace = 'public'::regnamespace
        ) THEN
            RAISE EXCEPTION 'Missing, disabled, or miswired trigger %',
                expected_trigger.trigger_name;
        END IF;
    END LOOP;

    IF to_regprocedure('public.set_updated_at()') IS NULL
       OR to_regprocedure('public.preserve_mobilesasa_callback_notification_reference()') IS NULL THEN
        RAISE EXCEPTION 'A required trigger function is missing';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_proc AS procedure_data
        JOIN pg_namespace AS namespace ON namespace.oid = procedure_data.pronamespace
        JOIN pg_language AS language_data ON language_data.oid = procedure_data.prolang
        WHERE namespace.nspname = 'public'
          AND procedure_data.proname IN (
              'set_updated_at',
              'preserve_mobilesasa_callback_notification_reference'
          )
          AND (
              procedure_data.pronargs <> 0
              OR procedure_data.prorettype <> 'trigger'::regtype
              OR language_data.lanname <> 'plpgsql'
              OR procedure_data.prosecdef
              OR procedure_data.proconfig IS NOT NULL
          )
    ) THEN
        RAISE EXCEPTION 'A required trigger function has an incompatible signature or attributes';
    END IF;

    IF regexp_replace(
           lower(pg_get_functiondef('public.set_updated_at()'::regprocedure)),
           '[[:space:]]',
           '',
           'g'
       ) NOT LIKE '%beginnew.updated_at=now();returnnew;end;%' THEN
        RAISE EXCEPTION 'set_updated_at() has an unexpected function body';
    END IF;

    IF regexp_replace(
           lower(pg_get_functiondef(
               'public.preserve_mobilesasa_callback_notification_reference()'::regprocedure
           )),
           '[[:space:]]',
           '',
           'g'
       ) NOT LIKE '%beginiftg_op=''insert''thennew.original_notification_id:=coalesce(new.original_notification_id,new.notification_id);elsifold.notification_idisnotnullandnew.notification_idisnullthennew.original_notification_id:=coalesce(new.original_notification_id,old.notification_id);elsifnew.notification_idisnotnullthenifold.original_notification_idisnotnullandold.original_notification_id<>new.notification_idthenraiseexception''acallbackcannotbereassignedtoanothernotification'';endif;new.original_notification_id:=coalesce(new.original_notification_id,new.notification_id);endif;returnnew;end;%' THEN
        RAISE EXCEPTION 'preserve_mobilesasa_callback_notification_reference() has an unexpected function body';
    END IF;
END;
$required_triggers$;

SELECT
    sequence_relation.relname AS sequence_name,
    format_type(sequence_data.seqtypid, NULL) AS sequence_type,
    sequence_data.seqstart AS start_value,
    sequence_data.seqincrement AS increment_by,
    sequence_data.seqmin AS minimum_value,
    sequence_data.seqmax AS maximum_value,
    sequence_data.seqcache AS cache_size,
    sequence_data.seqcycle AS cycles,
    owner_relation.relname AS owned_table,
    owner_attribute.attname AS owned_column,
    dependency.deptype AS ownership_dependency_type
FROM pg_class AS sequence_relation
JOIN pg_namespace AS sequence_namespace
  ON sequence_namespace.oid = sequence_relation.relnamespace
JOIN pg_sequence AS sequence_data ON sequence_data.seqrelid = sequence_relation.oid
LEFT JOIN pg_depend AS dependency
  ON dependency.classid = 'pg_class'::regclass
 AND dependency.objid = sequence_relation.oid
 AND dependency.refclassid = 'pg_class'::regclass
 AND dependency.deptype IN ('a', 'i')
LEFT JOIN pg_class AS owner_relation
  ON owner_relation.oid = dependency.refobjid
LEFT JOIN pg_attribute AS owner_attribute
  ON owner_attribute.attrelid = owner_relation.oid
 AND owner_attribute.attnum = dependency.refobjsubid
WHERE sequence_namespace.nspname = 'public'
  AND owner_relation.relname IN (
      'mpesa_callback_inbox',
      'mobilesasa_sms_delivery_callbacks'
  )
ORDER BY sequence_relation.relname;

DO $callback_sequences$
DECLARE
    callback_table TEXT;
    sequence_name TEXT;
    sequence_oid OID;
BEGIN
    FOREACH callback_table IN ARRAY ARRAY[
        'mpesa_callback_inbox',
        'mobilesasa_sms_delivery_callbacks'
    ]::TEXT[]
    LOOP
        sequence_name := pg_get_serial_sequence(
            format('public.%I', callback_table),
            'callback_id'
        );
        sequence_oid := to_regclass(sequence_name);
        IF sequence_name IS NULL
           OR sequence_oid IS NULL
           OR NOT EXISTS (
               SELECT 1
               FROM pg_class AS sequence_relation
               JOIN pg_namespace AS namespace ON namespace.oid = sequence_relation.relnamespace
               JOIN pg_sequence AS sequence_data ON sequence_data.seqrelid = sequence_relation.oid
               JOIN pg_depend AS ownership
                 ON ownership.classid = 'pg_class'::regclass
                AND ownership.objid = sequence_relation.oid
                AND ownership.refclassid = 'pg_class'::regclass
                AND ownership.refobjid = to_regclass(format('public.%I', callback_table))
                AND ownership.deptype IN ('a', 'i')
               JOIN pg_attribute AS owner_column
                 ON owner_column.attrelid = ownership.refobjid
                AND owner_column.attnum = ownership.refobjsubid
               WHERE namespace.nspname = 'public'
                 AND sequence_relation.oid = sequence_oid
                 AND sequence_relation.relkind = 'S'
                 AND sequence_data.seqtypid = 'bigint'::regtype
                 AND sequence_data.seqstart = 1
                 AND sequence_data.seqincrement = 1
                 AND sequence_data.seqmin = 1
                 AND sequence_data.seqmax = 9223372036854775807
                 AND sequence_data.seqcache = 1
                 AND NOT sequence_data.seqcycle
                 AND owner_column.attname = 'callback_id'
           ) THEN
            RAISE EXCEPTION 'Missing or incompatible callback_id sequence for %',
                callback_table;
        END IF;
    END LOOP;
END;
$callback_sequences$;

SELECT baseline.table_name,
       baseline.expected_rows AS pre_migration_rows,
       counts.current_rows AS current_rows,
       counts.current_rows - baseline.expected_rows AS row_count_difference
FROM (VALUES
    ('notifications', 1::BIGINT),
    ('mpesa_callback_inbox', 0::BIGINT),
    ('mobilesasa_sms_delivery_callbacks', 0::BIGINT)
) AS baseline(table_name, expected_rows)
CROSS JOIN LATERAL (
    SELECT CASE baseline.table_name
        WHEN 'notifications' THEN (SELECT count(*) FROM public.notifications)
        WHEN 'mpesa_callback_inbox' THEN (SELECT count(*) FROM public.mpesa_callback_inbox)
        WHEN 'mobilesasa_sms_delivery_callbacks' THEN
            (SELECT count(*) FROM public.mobilesasa_sms_delivery_callbacks)
    END::BIGINT AS current_rows
) AS counts
ORDER BY baseline.table_name;

SELECT
    (SELECT count(*) FROM (
        SELECT user_id, notification_type, deduplication_key
        FROM public.notifications
        WHERE deduplication_key IS NOT NULL
          AND user_id IS NOT NULL
        GROUP BY user_id, notification_type, deduplication_key
        HAVING count(*) > 1
    ) AS duplicates) AS duplicate_notification_event_key_groups,
    (SELECT count(*) FROM (
        SELECT provider_message_id
        FROM public.notifications
        WHERE provider_message_id IS NOT NULL
        GROUP BY provider_message_id
        HAVING count(*) > 1
    ) AS duplicates) AS duplicate_provider_message_id_groups,
    (SELECT count(*) FROM (
        SELECT callback_fingerprint
        FROM public.mpesa_callback_inbox
        GROUP BY callback_fingerprint
        HAVING count(*) > 1
    ) AS duplicates) AS duplicate_daraja_fingerprint_groups,
    (SELECT count(*) FROM (
        SELECT provider, provider_message_reference, delivery_status
        FROM public.mobilesasa_sms_delivery_callbacks
        GROUP BY provider, provider_message_reference, delivery_status
        HAVING count(*) > 1
    ) AS duplicates) AS duplicate_mobilesasa_callback_groups;

SELECT
    (SELECT count(*)
     FROM public.mpesa_callback_inbox AS callback
     LEFT JOIN public.mpesa_payment_attempts AS attempt
       ON attempt.attempt_id = callback.attempt_id
     WHERE callback.attempt_id IS NOT NULL
       AND attempt.attempt_id IS NULL) AS broken_daraja_attempt_references,
    (SELECT count(*)
     FROM public.mpesa_callback_inbox AS callback
     LEFT JOIN public.mpesa_payment_verifications AS verification
       ON verification.verification_id = callback.verification_id
     WHERE callback.verification_id IS NOT NULL
       AND verification.verification_id IS NULL) AS broken_daraja_verification_references,
    (SELECT count(*)
     FROM public.mobilesasa_sms_delivery_callbacks AS callback
     LEFT JOIN public.notifications AS notification
       ON notification.notification_id = callback.notification_id
     WHERE callback.notification_id IS NOT NULL
       AND notification.notification_id IS NULL) AS broken_mobilesasa_notification_references,
    (SELECT count(*)
     FROM public.mpesa_callback_inbox
     WHERE NOT ((
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
     ) IS TRUE)) AS invalid_daraja_lifecycle_rows,
    (SELECT count(*)
     FROM public.mobilesasa_sms_delivery_callbacks
     WHERE NOT ((
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
     ) IS TRUE)) AS invalid_mobilesasa_lifecycle_rows;

ROLLBACK;
