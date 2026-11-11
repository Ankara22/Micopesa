BEGIN;
SET TRANSACTION READ ONLY;

DO $preflight$
DECLARE
    server_address INET;
BEGIN
    IF current_database() <> 'Micopesa_migration_audit' THEN
        RAISE EXCEPTION 'Refusing diagnostic: unexpected database';
    END IF;

    server_address := inet_server_addr();
    IF server_address IS NULL
       OR host(server_address) NOT IN ('::1', '127.0.0.1') THEN
        RAISE EXCEPTION 'Refusing diagnostic: unexpected server address';
    END IF;

    IF inet_server_port() <> 5433 THEN
        RAISE EXCEPTION 'Refusing diagnostic: unexpected server port';
    END IF;
END;
$preflight$;

SELECT
    current_database() AS database_name,
    host(inet_server_addr()) AS server_address,
    inet_server_port() AS server_port,
    version() AS server_version;

SELECT
    relation.relname AS object_name,
    CASE relation.relkind
        WHEN 'r' THEN 'table'
        WHEN 'p' THEN 'partitioned table'
        WHEN 'v' THEN 'view'
        WHEN 'm' THEN 'materialized view'
        WHEN 'f' THEN 'foreign table'
        ELSE relation.relkind::TEXT
    END AS object_type,
    pg_get_userbyid(relation.relowner) AS owner,
    relation.relpersistence AS persistence
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'public'
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND (
      relation.relname ILIKE '%mobilesasa%'
      OR relation.relname ILIKE '%mobile_sasa%'
  )
ORDER BY relation.relname;

SELECT
    relation.relname AS relation_name,
    attribute.attnum AS ordinal_position,
    attribute.attname AS column_name,
    format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
    NOT attribute.attnotnull AS is_nullable,
    pg_get_expr(default_value.adbin, default_value.adrelid) AS column_default
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
LEFT JOIN pg_attrdef AS default_value
  ON default_value.adrelid = relation.oid
 AND default_value.adnum = attribute.attnum
WHERE namespace.nspname = 'public'
  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND (
      relation.relname ILIKE '%mobilesasa%'
      OR relation.relname ILIKE '%mobile_sasa%'
  )
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
ORDER BY relation.relname, attribute.attnum;

SELECT
    table_relation.relname AS table_name,
    index_relation.relname AS index_name,
    index_data.indisunique AS is_unique,
    index_data.indisvalid AS is_valid,
    index_data.indisready AS is_ready,
    index_data.indislive AS is_live,
    pg_get_indexdef(index_data.indexrelid) AS definition,
    pg_get_expr(index_data.indpred, index_data.indrelid) AS predicate
FROM pg_index AS index_data
JOIN pg_class AS table_relation ON table_relation.oid = index_data.indrelid
JOIN pg_namespace AS table_namespace
  ON table_namespace.oid = table_relation.relnamespace
JOIN pg_class AS index_relation ON index_relation.oid = index_data.indexrelid
JOIN pg_namespace AS index_namespace
  ON index_namespace.oid = index_relation.relnamespace
WHERE table_namespace.nspname = 'public'
  AND index_namespace.nspname = 'public'
  AND (
      table_relation.relname ILIKE '%mobilesasa%'
      OR table_relation.relname ILIKE '%mobile_sasa%'
      OR index_relation.relname ILIKE '%mobilesasa%'
      OR index_relation.relname ILIKE '%mobile_sasa%'
  )
ORDER BY table_relation.relname, index_relation.relname;

SELECT
    table_relation.relname AS table_name,
    constraint_data.conname AS constraint_name,
    constraint_data.contype::TEXT AS constraint_type,
    constraint_data.convalidated AS is_validated,
    constraint_data.condeferrable AS is_deferrable,
    constraint_data.condeferred AS is_initially_deferred,
    referenced_namespace.nspname AS referenced_schema,
    referenced_relation.relname AS referenced_table,
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
  AND (
      table_relation.relname ILIKE '%mobilesasa%'
      OR table_relation.relname ILIKE '%mobile_sasa%'
      OR referenced_relation.relname ILIKE '%mobilesasa%'
      OR referenced_relation.relname ILIKE '%mobile_sasa%'
  )
ORDER BY table_relation.relname, constraint_data.conname;

SELECT
    sequence_relation.relname AS sequence_name,
    format_type(sequence_data.seqtypid, NULL) AS sequence_data_type,
    sequence_data.seqstart AS start_value,
    sequence_data.seqincrement AS increment_by,
    sequence_data.seqmin AS minimum_value,
    sequence_data.seqmax AS maximum_value,
    sequence_data.seqcache AS cache_size,
    sequence_data.seqcycle AS cycles,
    owner_namespace.nspname AS owned_table_schema,
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
LEFT JOIN pg_namespace AS owner_namespace
  ON owner_namespace.oid = owner_relation.relnamespace
LEFT JOIN pg_attribute AS owner_attribute
  ON owner_attribute.attrelid = owner_relation.oid
 AND owner_attribute.attnum = dependency.refobjsubid
WHERE sequence_namespace.nspname = 'public'
  AND (
      sequence_relation.relname ILIKE '%mobilesasa%'
      OR sequence_relation.relname ILIKE '%mobile_sasa%'
      OR owner_relation.relname ILIKE '%mobilesasa%'
      OR owner_relation.relname ILIKE '%mobile_sasa%'
  )
ORDER BY sequence_relation.relname;

SELECT
    table_relation.relname AS table_name,
    trigger_data.tgname AS trigger_name,
    trigger_data.tgenabled AS enabled_state,
    pg_get_triggerdef(trigger_data.oid, TRUE) AS definition,
    procedure_namespace.nspname AS function_schema,
    procedure_data.proname AS function_name,
    pg_get_function_identity_arguments(procedure_data.oid) AS function_arguments,
    language_data.lanname AS function_language,
    procedure_data.prosecdef AS is_security_definer
FROM pg_trigger AS trigger_data
JOIN pg_class AS table_relation ON table_relation.oid = trigger_data.tgrelid
JOIN pg_namespace AS table_namespace
  ON table_namespace.oid = table_relation.relnamespace
JOIN pg_proc AS procedure_data ON procedure_data.oid = trigger_data.tgfoid
JOIN pg_namespace AS procedure_namespace
  ON procedure_namespace.oid = procedure_data.pronamespace
JOIN pg_language AS language_data ON language_data.oid = procedure_data.prolang
WHERE table_namespace.nspname = 'public'
  AND (
      table_relation.relname ILIKE '%mobilesasa%'
      OR table_relation.relname ILIKE '%mobile_sasa%'
      OR trigger_data.tgname ILIKE '%mobilesasa%'
      OR trigger_data.tgname ILIKE '%mobile_sasa%'
      OR procedure_data.proname ILIKE '%mobilesasa%'
      OR procedure_data.proname ILIKE '%mobile_sasa%'
  )
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
    md5(procedure_data.prosrc) AS source_fingerprint
FROM pg_proc AS procedure_data
JOIN pg_namespace AS procedure_namespace
  ON procedure_namespace.oid = procedure_data.pronamespace
JOIN pg_language AS language_data ON language_data.oid = procedure_data.prolang
WHERE procedure_namespace.nspname = 'public'
  AND (
      procedure_data.proname ILIKE '%mobilesasa%'
      OR procedure_data.proname ILIKE '%mobile_sasa%'
  )
ORDER BY procedure_data.proname, pg_get_function_identity_arguments(procedure_data.oid);

SELECT
    to_regclass('public.mobilesasa_sms_delivery_callbacks')::TEXT
        AS expected_callback_table,
    to_regclass('public.mobilesasa_sms_delivery_callbacks') IS NOT NULL
        AS expected_callback_table_exists,
    ARRAY(
        SELECT relation.relname
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND (
              relation.relname ILIKE '%mobilesasa%'
              OR relation.relname ILIKE '%mobile_sasa%'
          )
        ORDER BY relation.relname
    ) AS all_public_mobile_sasa_relations,
    ARRAY(
        SELECT index_relation.relname
        FROM pg_class AS index_relation
        JOIN pg_namespace AS index_namespace
          ON index_namespace.oid = index_relation.relnamespace
        WHERE index_namespace.nspname = 'public'
          AND index_relation.relkind IN ('i', 'I')
          AND index_relation.relname IN (
              'idx_mobilesasa_callbacks_unmatched',
              'idx_mobilesasa_callbacks_notification',
              'idx_mobilesasa_callbacks_original_notification',
              'idx_mobilesasa_callbacks_tracking_id',
              'idx_mobilesasa_callbacks_dispatch_reference'
          )
        ORDER BY index_relation.relname
    ) AS indexes_named_by_migration_guard,
    EXISTS (
        SELECT 1
        FROM pg_class AS callback_table
        JOIN pg_namespace AS callback_namespace
          ON callback_namespace.oid = callback_table.relnamespace
        JOIN pg_constraint AS callback_fk
          ON callback_fk.conrelid = callback_table.oid
         AND callback_fk.contype = 'f'
        JOIN pg_class AS referenced_table
          ON referenced_table.oid = callback_fk.confrelid
        JOIN pg_namespace AS referenced_namespace
          ON referenced_namespace.oid = referenced_table.relnamespace
        WHERE callback_namespace.nspname = 'public'
          AND callback_table.relname = 'mobilesasa_sms_delivery_callbacks'
          AND referenced_namespace.nspname = 'public'
          AND (
              referenced_table.relname ILIKE '%mobilesasa%'
              OR referenced_table.relname ILIKE '%mobile_sasa%'
          )
    ) AS callback_table_references_another_mobilesasa_table;

ROLLBACK;
