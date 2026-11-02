\pset pager off
\echo 'Read-only compliance workflow schema inspection'

SELECT current_database() AS database_name,
       current_user AS database_role,
       current_setting('data_directory') AS data_directory,
       current_setting('server_version') AS server_version,
       current_setting('listen_addresses') AS listen_addresses,
       inet_server_addr() AS server_address,
       inet_server_port() AS server_port;

SELECT
    (to_regclass('compliance_report_submissions') IS NOT NULL
     AND to_regclass('compliance_report_reviews') IS NOT NULL)::text
        AS history_tables_present,
    (
        SELECT count(*)::text
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (
              (table_name = 'compliance_report_submissions'
               AND column_name IN ('submitted_by_name', 'submitted_by_role'))
              OR
              (table_name = 'compliance_report_reviews'
               AND column_name IN ('reviewed_by_name', 'reviewed_by_role'))
          )
    ) AS snapshot_column_count,
    (
        SELECT (
            count(*) = 4
        )::text
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (
              (table_name = 'compliance_report_submissions'
               AND column_name IN ('submitted_by_name', 'submitted_by_role'))
              OR
              (table_name = 'compliance_report_reviews'
               AND column_name IN ('reviewed_by_name', 'reviewed_by_role'))
          )
    ) AS snapshot_columns_complete,
    (
        SELECT count(*)::text
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_index i ON i.indexrelid = c.oid
        WHERE n.nspname = current_schema()
          AND c.relname = 'uq_compliance_report_reviews_submission'
          AND i.indisunique
    ) AS unique_decision_index_count,
    (
        SELECT count(*)::text
        FROM (VALUES
            ('compliance_reports', 'trg_compliance_reports_status_transition'),
            ('compliance_report_reviews', 'trg_compliance_report_reviews_submitted_state'),
            ('compliance_report_submissions', 'trg_compliance_report_submissions_status_at_commit'),
            ('compliance_report_reviews', 'trg_compliance_report_reviews_status_at_commit')
        ) AS expected(table_name, trigger_name)
        JOIN pg_trigger t
          ON t.tgrelid = to_regclass(expected.table_name)
         AND t.tgname = expected.trigger_name
         AND NOT t.tgisinternal
    ) AS enforcement_trigger_count,
    (
        NOT EXISTS (
            SELECT 1
            FROM (VALUES
                ('users', 'user_id'),
                ('users', 'full_name'),
                ('users', 'role'),
                ('users', 'account_status'),
                ('funds', 'fund_id'),
                ('funds', 'managed_by'),
                ('audit_logs', 'action_type'),
                ('compliance_reports', 'report_id'),
                ('compliance_reports', 'generated_by'),
                ('compliance_reports', 'report_type'),
                ('compliance_reports', 'period_start'),
                ('compliance_reports', 'period_end'),
                ('compliance_reports', 'rba_status'),
                ('compliance_reports', 'generated_at'),
                ('compliance_reports', 'updated_at')
            ) AS expected(table_name, column_name)
            LEFT JOIN information_schema.columns c
              ON c.table_schema = current_schema()
             AND c.table_name = expected.table_name
             AND c.column_name = expected.column_name
            WHERE c.column_name IS NULL
        )
    )::text AS pre_workflow_source_complete,
    (
        NOT EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = current_schema()
              AND table_name IN (
                  'compliance_report_submissions',
                  'compliance_report_reviews'
              )
        )
    )::text AS no_history_tables,
    (
        NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'compliance_reports'
              AND column_name IN (
                  'fund_id', 'report_content', 'submitted_at',
                  'last_submitted_at', 'is_legacy'
              )
        )
    )::text AS no_workflow_report_columns,
    (
        NOT EXISTS (
            SELECT 1
            FROM (VALUES
                ('compliance_reports', 'report_id'),
                ('compliance_reports', 'fund_id'),
                ('compliance_reports', 'report_content'),
                ('compliance_reports', 'rba_status'),
                ('compliance_reports', 'submitted_at'),
                ('compliance_reports', 'last_submitted_at'),
                ('compliance_reports', 'is_legacy'),
                ('compliance_report_submissions', 'submission_id'),
                ('compliance_report_submissions', 'report_id'),
                ('compliance_report_submissions', 'version'),
                ('compliance_report_submissions', 'submitted_by'),
                ('compliance_report_submissions', 'report_content'),
                ('compliance_report_submissions', 'report_type'),
                ('compliance_report_submissions', 'period_start'),
                ('compliance_report_submissions', 'period_end'),
                ('compliance_report_submissions', 'submitted_at'),
                ('compliance_report_reviews', 'review_id'),
                ('compliance_report_reviews', 'report_id'),
                ('compliance_report_reviews', 'submission_id'),
                ('compliance_report_reviews', 'reviewed_by'),
                ('compliance_report_reviews', 'decision'),
                ('compliance_report_reviews', 'created_at')
            ) AS expected(table_name, column_name)
            LEFT JOIN information_schema.columns c
              ON c.table_schema = current_schema()
             AND c.table_name = expected.table_name
             AND c.column_name = expected.column_name
            WHERE c.column_name IS NULL
        )
    )::text AS workflow_source_complete,
    (
        NOT EXISTS (
            SELECT 1
            FROM (VALUES
                ('compliance_report_submissions', 'report_id'),
                ('compliance_report_submissions', 'submission_id'),
                ('compliance_report_submissions', 'version'),
                ('compliance_report_submissions', 'submitted_at'),
                ('compliance_report_reviews', 'report_id'),
                ('compliance_report_reviews', 'submission_id'),
                ('compliance_report_reviews', 'decision'),
                ('compliance_reports', 'report_id'),
                ('compliance_reports', 'rba_status'),
                ('compliance_reports', 'is_legacy'),
                ('compliance_reports', 'last_submitted_at')
            ) AS expected(table_name, column_name)
            LEFT JOIN information_schema.columns c
              ON c.table_schema = current_schema()
             AND c.table_name = expected.table_name
             AND c.column_name = expected.column_name
            WHERE c.column_name IS NULL
        )
    )::text AS history_integrity_columns_complete
\gset

\echo ''
\echo 'Missing pre-workflow source columns (if any):'
SELECT expected.table_name, expected.column_name
FROM (VALUES
    ('users', 'user_id'),
    ('users', 'full_name'),
    ('users', 'role'),
    ('users', 'account_status'),
    ('funds', 'fund_id'),
    ('funds', 'managed_by'),
    ('audit_logs', 'action_type'),
    ('compliance_reports', 'report_id'),
    ('compliance_reports', 'generated_by'),
    ('compliance_reports', 'report_type'),
    ('compliance_reports', 'period_start'),
    ('compliance_reports', 'period_end'),
    ('compliance_reports', 'rba_status'),
    ('compliance_reports', 'generated_at'),
    ('compliance_reports', 'updated_at')
) AS expected(table_name, column_name)
LEFT JOIN information_schema.columns c
  ON c.table_schema = current_schema()
 AND c.table_name = expected.table_name
 AND c.column_name = expected.column_name
WHERE c.column_name IS NULL
ORDER BY expected.table_name, expected.column_name;

\if :history_tables_present
\echo ''
\echo 'Missing workflow source columns (if any):'
SELECT expected.table_name, expected.column_name
FROM (VALUES
    ('compliance_reports', 'report_id'),
    ('compliance_reports', 'fund_id'),
    ('compliance_reports', 'report_content'),
    ('compliance_reports', 'rba_status'),
    ('compliance_reports', 'submitted_at'),
    ('compliance_reports', 'last_submitted_at'),
    ('compliance_reports', 'is_legacy'),
    ('compliance_report_submissions', 'submission_id'),
    ('compliance_report_submissions', 'report_id'),
    ('compliance_report_submissions', 'version'),
    ('compliance_report_submissions', 'submitted_by'),
    ('compliance_report_submissions', 'report_content'),
    ('compliance_report_submissions', 'report_type'),
    ('compliance_report_submissions', 'period_start'),
    ('compliance_report_submissions', 'period_end'),
    ('compliance_report_submissions', 'submitted_at'),
    ('compliance_report_reviews', 'review_id'),
    ('compliance_report_reviews', 'report_id'),
    ('compliance_report_reviews', 'submission_id'),
    ('compliance_report_reviews', 'reviewed_by'),
    ('compliance_report_reviews', 'decision'),
    ('compliance_report_reviews', 'created_at')
) AS expected(table_name, column_name)
LEFT JOIN information_schema.columns c
  ON c.table_schema = current_schema()
 AND c.table_name = expected.table_name
 AND c.column_name = expected.column_name
WHERE c.column_name IS NULL
ORDER BY expected.table_name, expected.column_name;

\echo ''
\echo 'Missing actor-snapshot columns (if any):'
SELECT expected.table_name, expected.column_name
FROM (VALUES
    ('compliance_report_submissions', 'submitted_by_name'),
    ('compliance_report_submissions', 'submitted_by_role'),
    ('compliance_report_reviews', 'reviewed_by_name'),
    ('compliance_report_reviews', 'reviewed_by_role')
) AS expected(table_name, column_name)
LEFT JOIN information_schema.columns c
  ON c.table_schema = current_schema()
 AND c.table_name = expected.table_name
 AND c.column_name = expected.column_name
WHERE c.column_name IS NULL
ORDER BY expected.table_name, expected.column_name;

\echo ''
\echo 'History row counts (run whenever both history tables exist):'
SELECT (SELECT count(*) FROM compliance_report_submissions) AS submissions,
       (SELECT count(*) FROM compliance_report_reviews) AS reviews;

\if :history_integrity_columns_complete
\echo ''
\echo 'History integrity anomalies (zero is expected):'
WITH latest AS (
    SELECT DISTINCT ON (report_id)
           report_id, submission_id, version, submitted_at
    FROM compliance_report_submissions
    ORDER BY report_id, version DESC
),
anomalies AS (
    SELECT 'submissions without a report' AS check_name, count(*) AS anomaly_count
    FROM compliance_report_submissions s
    LEFT JOIN compliance_reports r ON r.report_id = s.report_id
    WHERE r.report_id IS NULL
    UNION ALL
    SELECT 'reviews without matching report/submission pair', count(*)
    FROM compliance_report_reviews v
    LEFT JOIN compliance_report_submissions s
      ON s.submission_id = v.submission_id
     AND s.report_id = v.report_id
    WHERE s.submission_id IS NULL
    UNION ALL
    SELECT 'multiple reviews for one submission', count(*)
    FROM (
        SELECT submission_id
        FROM compliance_report_reviews
        GROUP BY submission_id
        HAVING count(*) > 1
    ) duplicate_reviews
    UNION ALL
    SELECT 'non-contiguous submission versions', count(*)
    FROM (
        SELECT report_id
        FROM compliance_report_submissions
        GROUP BY report_id
        HAVING min(version) <> 1
            OR max(version) <> count(*)
            OR count(DISTINCT version) <> count(*)
    ) irregular_versions
    UNION ALL
    SELECT 'submitted reports without latest matching submission timestamp', count(*)
    FROM compliance_reports r
    LEFT JOIN latest l ON l.report_id = r.report_id
    WHERE NOT r.is_legacy
      AND r.rba_status = 'SUBMITTED'
      AND (
          l.submission_id IS NULL
          OR r.last_submitted_at IS DISTINCT FROM l.submitted_at
      )
    UNION ALL
    SELECT 'decided reports without matching latest review', count(*)
    FROM compliance_reports r
    LEFT JOIN latest l ON l.report_id = r.report_id
    WHERE NOT r.is_legacy
      AND r.rba_status IN ('ACCEPTED', 'REJECTED', 'REVISION_REQUESTED')
      AND (
          l.submission_id IS NULL
          OR NOT EXISTS (
              SELECT 1
              FROM compliance_report_reviews v
              WHERE v.report_id = r.report_id
                AND v.submission_id = l.submission_id
                AND v.decision = r.rba_status
          )
      )
    UNION ALL
    SELECT 'draft reports with submission history', count(*)
    FROM compliance_reports r
    WHERE NOT r.is_legacy
      AND r.rba_status = 'DRAFT'
      AND EXISTS (
          SELECT 1
          FROM compliance_report_submissions s
          WHERE s.report_id = r.report_id
      )
)
SELECT check_name, anomaly_count
FROM anomalies
ORDER BY check_name;
\else
\echo 'Skipped column-dependent history checks: required source columns are missing.'
\endif
\else
\echo ''
\echo 'Workflow history checks skipped: both history tables are not present.'
\endif

\if :history_tables_present
\if :snapshot_columns_complete
\echo ''
\echo 'Actor-snapshot anomalies (zero is expected):'
SELECT 'malformed submission actor snapshots' AS check_name, count(*) AS anomaly_count
FROM compliance_report_submissions
WHERE (submitted_by_name IS NULL) IS DISTINCT FROM (submitted_by_role IS NULL)
   OR (
       submitted_by_name IS NOT NULL
       AND (btrim(submitted_by_name) = ''
            OR submitted_by_role IS DISTINCT FROM 'FUND_MANAGER')
   )
UNION ALL
SELECT 'malformed review actor snapshots', count(*)
FROM compliance_report_reviews
WHERE (reviewed_by_name IS NULL) IS DISTINCT FROM (reviewed_by_role IS NULL)
   OR (
       reviewed_by_name IS NOT NULL
       AND (btrim(reviewed_by_name) = ''
            OR reviewed_by_role IS DISTINCT FROM 'REGULATOR')
   );
\else
\echo 'Actor-snapshot checks skipped: all four actor snapshot columns are not present.'
\endif
\endif

SELECT
    (
        :'history_tables_present' = 'false'
        AND :'no_history_tables' = 'true'
        AND :'no_workflow_report_columns' = 'true'
        AND :'pre_workflow_source_complete' = 'true'
    ) AS state_a,
    (
        :'history_tables_present' = 'true'
        AND :'workflow_source_complete' = 'true'
        AND :'snapshot_column_count' = '0'
        AND :'unique_decision_index_count' = '0'
        AND :'enforcement_trigger_count' = '0'
    ) AS state_b,
    (
        :'history_tables_present' = 'true'
        AND :'workflow_source_complete' = 'true'
        AND :'snapshot_column_count' = '4'
        AND :'unique_decision_index_count' = '0'
        AND :'enforcement_trigger_count' = '0'
    ) AS state_c,
    (
        :'history_tables_present' = 'true'
        AND :'workflow_source_complete' = 'true'
        AND :'snapshot_column_count' = '4'
        AND :'unique_decision_index_count' = '1'
        AND :'enforcement_trigger_count' = '4'
    ) AS state_d
\gset

\echo ''
\echo 'Schema-state candidate (catalog evidence only; not migration provenance):'
\if :state_a
\echo 'A — pre-workflow schema candidate.'
\elif :state_b
\echo 'B — workflow history present, actor snapshots absent, enforcement absent.'
\elif :state_c
\echo 'C — workflow and all actor snapshots present, enforcement absent.'
\elif :state_d
\echo 'D — workflow, actor snapshots, and all expected enforcement objects present.'
\else
\echo 'E — incomplete, partial, or incompatible schema; do not select a migration path from this result alone.'
\endif

\echo ''
\echo 'Snapshot columns present: ' :snapshot_column_count ' of 4'
\echo 'Enforcement objects found: unique decision index=' :unique_decision_index_count ', expected triggers=' :enforcement_trigger_count ' of 4'
