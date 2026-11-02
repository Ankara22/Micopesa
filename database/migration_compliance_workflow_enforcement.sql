-- Enforce one regulator decision per report submission and valid workflow
-- transitions in the database. Apply after the workflow and actor-snapshot
-- migrations; existing history is validated and retained without repair.
BEGIN;

DO $$
DECLARE
    expected RECORD;
    snapshot_column_count INTEGER;
    constraint_count INTEGER;
    constraint_definition TEXT;
    normalized_definition TEXT;
    expected_definition TEXT;
    expected_values_sql TEXT;
    actual_values TEXT[];
    mutation_function_oid OID;
    manager_function_oid OID;
    regulator_function_oid OID;
    generator_function_oid OID;
    fund_owner_function_oid OID;
    trigger_record RECORD;
    function_source TEXT;
BEGIN
    IF to_regclass('compliance_reports') IS NULL
       OR to_regclass('compliance_report_submissions') IS NULL
       OR to_regclass('compliance_report_reviews') IS NULL THEN
        RAISE EXCEPTION
            'Incompatible schema: install the compliance report workflow before its enforcement migration';
    END IF;

    FOR expected IN
        SELECT * FROM (VALUES
            ('compliance_reports', 'report_id'),
            ('compliance_reports', 'rba_status'),
            ('compliance_reports', 'is_legacy'),
            ('compliance_reports', 'generated_by'),
            ('compliance_reports', 'fund_id'),
            ('compliance_reports', 'report_type'),
            ('compliance_reports', 'period_start'),
            ('compliance_reports', 'period_end'),
            ('compliance_reports', 'report_content'),
            ('compliance_reports', 'submitted_at'),
            ('compliance_reports', 'last_submitted_at'),
            ('users', 'user_id'),
            ('users', 'full_name'),
            ('users', 'role'),
            ('users', 'account_status'),
            ('compliance_report_submissions', 'submission_id'),
            ('compliance_report_submissions', 'report_id'),
            ('compliance_report_submissions', 'version'),
            ('compliance_report_submissions', 'submitted_by'),
            ('compliance_report_submissions', 'submitted_at'),
            ('compliance_report_submissions', 'submitted_by_name'),
            ('compliance_report_submissions', 'submitted_by_role'),
            ('compliance_report_submissions', 'report_content'),
            ('compliance_report_submissions', 'report_type'),
            ('compliance_report_submissions', 'period_start'),
            ('compliance_report_submissions', 'period_end'),
            ('compliance_report_reviews', 'report_id'),
            ('compliance_report_reviews', 'submission_id'),
            ('compliance_report_reviews', 'reviewed_by'),
            ('compliance_report_reviews', 'created_at'),
            ('compliance_report_reviews', 'reason'),
            ('compliance_report_reviews', 'decision'),
            ('compliance_report_reviews', 'reviewed_by_name'),
            ('compliance_report_reviews', 'reviewed_by_role')
        ) AS required(table_name, column_name)
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = expected.table_name
              AND column_name = expected.column_name
        ) THEN
            RAISE EXCEPTION 'Incompatible schema: missing %.%',
                expected.table_name, expected.column_name;
        END IF;
    END LOOP;

    SELECT count(*)
    INTO snapshot_column_count
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND (
          (table_name = 'compliance_report_submissions'
           AND column_name IN ('submitted_by_name', 'submitted_by_role'))
          OR
          (table_name = 'compliance_report_reviews'
           AND column_name IN ('reviewed_by_name', 'reviewed_by_role'))
      );
    IF snapshot_column_count = 0 THEN
        RAISE EXCEPTION
            'Incompatible schema: apply the compliance actor-snapshot migration before enforcement';
    ELSIF snapshot_column_count <> 4 THEN
        RAISE EXCEPTION
            'Incompatible schema: all four compliance actor-snapshot columns must exist together';
    END IF;

    FOR expected IN
        SELECT * FROM (VALUES
            ('compliance_reports', 'rba_status',
             ARRAY['DRAFT', 'SUBMITTED', 'REVISION_REQUESTED', 'ACCEPTED', 'REJECTED']::TEXT[],
             ARRAY['chk_compliance_reports_status', 'compliance_reports_rba_status_check']::TEXT[]),
            ('compliance_report_reviews', 'decision',
             ARRAY['ACCEPTED', 'REJECTED', 'REVISION_REQUESTED']::TEXT[],
             ARRAY['compliance_report_reviews_decision_check']::TEXT[]),
            ('compliance_report_submissions', 'submitted_by_role',
             ARRAY['FUND_MANAGER']::TEXT[],
             ARRAY['chk_compliance_submission_actor_role',
                   'compliance_report_submissions_submitted_by_role_check']::TEXT[]),
            ('compliance_report_reviews', 'reviewed_by_role',
             ARRAY['REGULATOR']::TEXT[],
             ARRAY['chk_compliance_review_actor_role',
                   'compliance_report_reviews_reviewed_by_role_check']::TEXT[])
        ) AS required(table_name, column_name, allowed_values, constraint_names)
    LOOP
        SELECT count(*), max(pg_get_constraintdef(oid))
        INTO constraint_count, constraint_definition
        FROM pg_constraint
        WHERE conrelid = to_regclass(expected.table_name)
          AND contype = 'c'
          AND convalidated
          AND conname = ANY(expected.constraint_names);

        IF constraint_count <> 1 THEN
            RAISE EXCEPTION
                'Incompatible schema: expected one validated allowed-value constraint for %.%',
                expected.table_name, expected.column_name;
        END IF;

        SELECT array_agg(lower(matches.value[1]) ORDER BY lower(matches.value[1]))
        INTO actual_values
        FROM regexp_matches(constraint_definition, '''([^'']+)''', 'g')
            AS matches(value);
        normalized_definition := lower(regexp_replace(
            constraint_definition, '\s+', '', 'g'));
        IF actual_values IS DISTINCT FROM (
            SELECT array_agg(lower(value) ORDER BY lower(value))
            FROM unnest(expected.allowed_values) AS values_to_check(value)
        ) OR position(lower(expected.column_name) IN normalized_definition) = 0 THEN
            RAISE EXCEPTION
                'Incompatible schema: constraint for %.% has unexpected definition: %',
                expected.table_name, expected.column_name, constraint_definition;
        END IF;

        IF expected.column_name IN ('rba_status', 'decision') THEN
            SELECT string_agg(
                quote_literal(lower(values_to_check.value)) || '::charactervarying',
                ',' ORDER BY values_to_check.ordinal
            )
            INTO expected_values_sql
            FROM unnest(expected.allowed_values) WITH ORDINALITY
                AS values_to_check(value, ordinal);
            expected_definition :=
                'check(((' || lower(expected.column_name) ||
                ')::text=any((array[' || expected_values_sql || '])::text[])))';
            IF normalized_definition <> expected_definition THEN
                RAISE EXCEPTION
                    'Incompatible schema: constraint for %.% has unexpected definition: %',
                    expected.table_name, expected.column_name, constraint_definition;
            END IF;
        ELSE
            expected_definition :=
                'check(((' || lower(expected.column_name) ||
                ')::text=' || quote_literal(lower(expected.allowed_values[1])) || '::text))';
            IF normalized_definition NOT IN (
                expected_definition,
                'check(((' || lower(expected.column_name) ||
                'isnull)or((' || lower(expected.column_name) || ')::text=' ||
                quote_literal(lower(expected.allowed_values[1])) || '::text)))'
            ) THEN
                RAISE EXCEPTION
                    'Incompatible schema: constraint for %.% has unexpected definition: %',
                    expected.table_name, expected.column_name, constraint_definition;
            END IF;
        END IF;
    END LOOP;

    SELECT count(*), max(pg_get_constraintdef(oid))
    INTO constraint_count, constraint_definition
    FROM pg_constraint
    WHERE conrelid = to_regclass('compliance_report_reviews')
      AND contype = 'c'
      AND convalidated
      AND conname = 'chk_compliance_report_review_reason';
    IF constraint_count <> 1
       OR lower(regexp_replace(constraint_definition, '\s+', '', 'g'))
          <> 'check((((decision)::text=''accepted''::text)or((reasonisnotnull)and(length(trim(bothfromreason))>=10))))' THEN
        RAISE EXCEPTION
            'Incompatible schema: compliance review reason constraint is missing or has an unexpected definition';
    END IF;

    SELECT count(*), max(pg_get_constraintdef(oid))
    INTO constraint_count, constraint_definition
    FROM pg_constraint
    WHERE conrelid = to_regclass('compliance_report_submissions')
      AND contype = 'c'
      AND convalidated
      AND conname = 'compliance_report_submissions_version_check';
    IF constraint_count <> 1
       OR lower(regexp_replace(constraint_definition, '\s+', '', 'g'))
          <> 'check((version>0))' THEN
        RAISE EXCEPTION
            'Incompatible schema: positive submission-version constraint is missing or has an unexpected definition';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        WHERE c.conrelid = to_regclass('compliance_report_submissions')
          AND c.contype = 'u'
          AND c.convalidated
          AND NOT c.condeferrable
          AND ARRAY(
              SELECT a.attname::TEXT
              FROM unnest(c.conkey) WITH ORDINALITY AS key_columns(attnum, ordinal)
              JOIN pg_attribute a
                ON a.attrelid = c.conrelid AND a.attnum = key_columns.attnum
              ORDER BY key_columns.ordinal
          ) = ARRAY['report_id', 'version']::TEXT[]
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        WHERE c.conrelid = to_regclass('compliance_report_submissions')
          AND c.contype = 'u'
          AND c.convalidated
          AND NOT c.condeferrable
          AND ARRAY(
              SELECT a.attname::TEXT
              FROM unnest(c.conkey) WITH ORDINALITY AS key_columns(attnum, ordinal)
              JOIN pg_attribute a
                ON a.attrelid = c.conrelid AND a.attnum = key_columns.attnum
              ORDER BY key_columns.ordinal
          ) = ARRAY['submission_id', 'report_id']::TEXT[]
    ) THEN
        RAISE EXCEPTION
            'Incompatible schema: submission versions and composite submission identities must be unique';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        WHERE c.conrelid = to_regclass('compliance_report_submissions')
          AND c.confrelid = to_regclass('compliance_reports')
          AND c.contype = 'f'
          AND c.convalidated
          AND c.confdeltype = 'r'
          AND c.confupdtype = 'a'
          AND c.confmatchtype = 's'
          AND NOT c.condeferrable
          AND ARRAY(
              SELECT a.attname::TEXT
              FROM unnest(c.conkey) WITH ORDINALITY AS key_columns(attnum, ordinal)
              JOIN pg_attribute a
                ON a.attrelid = c.conrelid AND a.attnum = key_columns.attnum
              ORDER BY key_columns.ordinal
          ) = ARRAY['report_id']::TEXT[]
          AND ARRAY(
              SELECT a.attname::TEXT
              FROM unnest(c.confkey) WITH ORDINALITY AS key_columns(attnum, ordinal)
              JOIN pg_attribute a
                ON a.attrelid = c.confrelid AND a.attnum = key_columns.attnum
              ORDER BY key_columns.ordinal
          ) = ARRAY['report_id']::TEXT[]
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        WHERE c.conrelid = to_regclass('compliance_report_reviews')
          AND c.confrelid = to_regclass('compliance_report_submissions')
          AND c.contype = 'f'
          AND c.convalidated
          AND c.confdeltype = 'r'
          AND c.confupdtype = 'a'
          AND c.confmatchtype = 's'
          AND NOT c.condeferrable
          AND ARRAY(
              SELECT a.attname::TEXT
              FROM unnest(c.conkey) WITH ORDINALITY AS key_columns(attnum, ordinal)
              JOIN pg_attribute a
                ON a.attrelid = c.conrelid AND a.attnum = key_columns.attnum
              ORDER BY key_columns.ordinal
          ) = ARRAY['submission_id', 'report_id']::TEXT[]
          AND ARRAY(
              SELECT a.attname::TEXT
              FROM unnest(c.confkey) WITH ORDINALITY AS key_columns(attnum, ordinal)
              JOIN pg_attribute a
                ON a.attrelid = c.confrelid AND a.attnum = key_columns.attnum
              ORDER BY key_columns.ordinal
          ) = ARRAY['submission_id', 'report_id']::TEXT[]
    ) THEN
        RAISE EXCEPTION
            'Incompatible schema: validated submission and review foreign keys with RESTRICT delete behavior are required';
    END IF;

    IF EXISTS (
        SELECT submission_id
        FROM compliance_report_reviews
        GROUP BY submission_id
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION
            'Cannot enforce one decision per submission: duplicate review history exists';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM compliance_report_submissions s
        LEFT JOIN compliance_reports r ON r.report_id = s.report_id
        WHERE r.report_id IS NULL
    ) OR EXISTS (
        SELECT 1
        FROM compliance_report_reviews v
        LEFT JOIN compliance_reports r ON r.report_id = v.report_id
        LEFT JOIN compliance_report_submissions s
          ON s.submission_id = v.submission_id AND s.report_id = v.report_id
        WHERE r.report_id IS NULL OR s.submission_id IS NULL
    ) THEN
        RAISE EXCEPTION
            'Incompatible data: orphan compliance submissions or reviews exist';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM compliance_report_submissions
        WHERE (submitted_by_name IS NULL) <> (submitted_by_role IS NULL)
           OR (submitted_by_name IS NOT NULL AND btrim(submitted_by_name) = '')
           OR (submitted_by_role IS NOT NULL
               AND submitted_by_role IS DISTINCT FROM 'FUND_MANAGER')
    ) OR EXISTS (
        SELECT 1
        FROM compliance_report_reviews
        WHERE (reviewed_by_name IS NULL) <> (reviewed_by_role IS NULL)
           OR (reviewed_by_name IS NOT NULL AND btrim(reviewed_by_name) = '')
           OR (reviewed_by_role IS NOT NULL
               AND reviewed_by_role IS DISTINCT FROM 'REGULATOR')
    ) THEN
        RAISE EXCEPTION
            'Incompatible data: compliance actor snapshots must be valid pairs; paired NULL historical snapshots are allowed';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM compliance_reports r
        WHERE r.is_legacy IS TRUE
          AND (
              EXISTS (SELECT 1 FROM compliance_report_submissions s WHERE s.report_id = r.report_id)
              OR EXISTS (SELECT 1 FROM compliance_report_reviews v WHERE v.report_id = r.report_id)
          )
    ) THEN
        RAISE EXCEPTION
            'Incompatible data: legacy compliance reports must not have workflow history';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM compliance_report_submissions s
        JOIN compliance_reports r ON r.report_id = s.report_id
        WHERE r.is_legacy IS FALSE
        GROUP BY s.report_id
        HAVING min(s.version) <> 1 OR max(s.version) <> count(*)
    ) THEN
        RAISE EXCEPTION
            'Incompatible data: non-legacy submission versions must be unique and contiguous from version 1';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM compliance_reports r
        LEFT JOIN LATERAL (
            SELECT s.submission_id, s.version, s.submitted_at
            FROM compliance_report_submissions s
            WHERE s.report_id = r.report_id
            ORDER BY s.version ASC
            LIMIT 1
        ) first_submission ON TRUE
        LEFT JOIN LATERAL (
            SELECT s.submission_id, s.version, s.submitted_at
            FROM compliance_report_submissions s
            WHERE s.report_id = r.report_id
            ORDER BY s.version DESC
            LIMIT 1
        ) latest_submission ON TRUE
        WHERE r.is_legacy IS FALSE
          AND (
              (r.rba_status = 'DRAFT' AND (
                  first_submission.submission_id IS NOT NULL
                  OR r.submitted_at IS NOT NULL
                  OR r.last_submitted_at IS NOT NULL
              ))
              OR
              (r.rba_status <> 'DRAFT' AND (
                  first_submission.submission_id IS NULL
                  OR r.submitted_at IS NULL
                  OR r.last_submitted_at IS NULL
                  OR r.submitted_at IS DISTINCT FROM first_submission.submitted_at
                  OR r.last_submitted_at IS DISTINCT FROM latest_submission.submitted_at
              ))
              OR
              (r.rba_status = 'SUBMITTED' AND EXISTS (
                  SELECT 1
                  FROM compliance_report_reviews v
                  WHERE v.report_id = r.report_id
                    AND v.submission_id = latest_submission.submission_id
              ))
              OR
              (r.rba_status IN ('REVISION_REQUESTED', 'ACCEPTED', 'REJECTED')
               AND NOT EXISTS (
                  SELECT 1
                  FROM compliance_report_reviews v
                  WHERE v.report_id = r.report_id
                    AND v.submission_id = latest_submission.submission_id
                    AND v.decision = r.rba_status
              ))
          )
    ) THEN
        RAISE EXCEPTION
            'Incompatible data: report statuses and submission/review history do not match the application workflow';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM compliance_report_submissions current_submission
        JOIN compliance_reports r ON r.report_id = current_submission.report_id
        WHERE r.is_legacy IS FALSE
          AND current_submission.version > 1
          AND NOT EXISTS (
              SELECT 1
              FROM compliance_report_submissions previous_submission
              JOIN compliance_report_reviews previous_review
                ON previous_review.report_id = previous_submission.report_id
               AND previous_review.submission_id = previous_submission.submission_id
              WHERE previous_submission.report_id = current_submission.report_id
                AND previous_submission.version = current_submission.version - 1
                AND previous_review.decision = 'REVISION_REQUESTED'
                AND previous_review.created_at <= current_submission.submitted_at
          )
    ) THEN
        RAISE EXCEPTION
            'Incompatible data: every resubmission must follow a revision request for the previous submission';
    END IF;

    mutation_function_oid := to_regprocedure(
        'prevent_compliance_history_mutation()'
    )::OID;
    manager_function_oid := to_regprocedure(
        'enforce_compliance_report_submission_role()'
    )::OID;
    regulator_function_oid := to_regprocedure(
        'enforce_compliance_report_review_role()'
    )::OID;
    generator_function_oid := to_regprocedure(
        'enforce_compliance_report_generator_role()'
    )::OID;
    fund_owner_function_oid := to_regprocedure(
        'enforce_compliance_report_fund_owner()'
    )::OID;

    IF mutation_function_oid IS NULL
       OR manager_function_oid IS NULL
       OR regulator_function_oid IS NULL
       OR generator_function_oid IS NULL
       OR fund_owner_function_oid IS NULL THEN
        RAISE EXCEPTION
            'Incompatible schema: one or more compliance workflow trigger functions are missing';
    END IF;

    SELECT prosrc INTO function_source
    FROM pg_proc WHERE oid = mutation_function_oid;
    IF lower(regexp_replace(function_source, '\s+', '', 'g'))
       <> 'beginraiseexceptionusingerrcode=''55000'',message=format(''%ihistoryisappend-only'',tg_table_name);end;' THEN
        RAISE EXCEPTION
            'Incompatible schema: prevent_compliance_history_mutation() does not reject history changes';
    END IF;

    SELECT lower(regexp_replace(prosrc, '\s+', '', 'g'))
    INTO function_source
    FROM pg_proc WHERE oid = manager_function_oid;
    IF position('actor_roleisdistinctfrom''fund_manager''' IN function_source) = 0
       OR position('actor_statusisdistinctfrom''active''' IN function_source) = 0
       OR position('new.submitted_by_nameisdistinctfromactor_name' IN function_source) = 0
       OR position('new.submitted_by_roleisdistinctfromactor_role' IN function_source) = 0 THEN
        RAISE EXCEPTION
            'Incompatible schema: submission actor trigger function does not validate active manager snapshots';
    END IF;

    SELECT lower(regexp_replace(prosrc, '\s+', '', 'g'))
    INTO function_source
    FROM pg_proc WHERE oid = regulator_function_oid;
    IF position('actor_roleisdistinctfrom''regulator''' IN function_source) = 0
       OR position('actor_statusisdistinctfrom''active''' IN function_source) = 0
       OR position('new.reviewed_by_nameisdistinctfromactor_name' IN function_source) = 0
       OR position('new.reviewed_by_roleisdistinctfromactor_role' IN function_source) = 0 THEN
        RAISE EXCEPTION
            'Incompatible schema: review actor trigger function does not validate active regulator snapshots';
    END IF;

    SELECT lower(regexp_replace(prosrc, '\s+', '', 'g'))
    INTO function_source
    FROM pg_proc WHERE oid = fund_owner_function_oid;
    IF position('fund_managerisnull' IN function_source) = 0
       OR position('fund_manager<>new.generated_by' IN function_source) = 0
       OR position('tg_op=''insert''and(new.rba_statusisdistinctfrom''draft''' IN function_source) = 0
       OR position('new.is_legacyisdistinctfromfalse' IN function_source) = 0
       OR position('new.submitted_atisnotnull' IN function_source) = 0
       OR position('new.last_submitted_atisnotnull' IN function_source) = 0 THEN
        RAISE EXCEPTION
            'Incompatible schema: compliance fund-owner trigger function lacks ownership or initial-state enforcement';
    END IF;

    FOR expected IN
        SELECT * FROM (VALUES
            ('compliance_report_submissions', 'trg_compliance_report_submissions_immutable',
             27, 'prevent_compliance_history_mutation()', NULL::TEXT),
            ('compliance_report_reviews', 'trg_compliance_report_reviews_immutable',
             27, 'prevent_compliance_history_mutation()', NULL::TEXT),
            ('compliance_report_submissions', 'trg_compliance_report_submissions_no_truncate',
             34, 'prevent_compliance_history_mutation()', NULL::TEXT),
            ('compliance_report_reviews', 'trg_compliance_report_reviews_no_truncate',
             34, 'prevent_compliance_history_mutation()', NULL::TEXT),
            ('compliance_report_submissions', 'trg_compliance_report_submissions_manager',
             23, 'enforce_compliance_report_submission_role()',
             'updateofsubmitted_by,submitted_by_name,submitted_by_role'),
            ('compliance_report_reviews', 'trg_compliance_report_reviews_regulator',
             23, 'enforce_compliance_report_review_role()',
             'updateofreviewed_by,reviewed_by_name,reviewed_by_role'),
            ('compliance_reports', 'trg_compliance_reports_enforce_generator_role',
             23, 'enforce_compliance_report_generator_role()', 'updateofgenerated_by'),
            ('compliance_reports', 'trg_compliance_reports_fund_owner',
             23, 'enforce_compliance_report_fund_owner()', 'updateoffund_id,generated_by')
        ) AS required(table_name, trigger_name, expected_type, function_name, update_clause)
    LOOP
        SELECT t.oid, t.tgtype, t.tgenabled, t.tgfoid, t.tgqual,
               lower(regexp_replace(pg_get_triggerdef(t.oid), '\s+', '', 'g')) AS definition
        INTO trigger_record
        FROM pg_trigger t
        WHERE t.tgrelid = to_regclass(expected.table_name)
          AND t.tgname = expected.trigger_name
          AND NOT t.tgisinternal;

        IF NOT FOUND
           OR trigger_record.tgtype <> expected.expected_type
           OR trigger_record.tgenabled <> 'O'
           OR trigger_record.tgqual IS NOT NULL
           OR trigger_record.tgfoid <> to_regprocedure(expected.function_name)::OID
           OR (
               expected.update_clause IS NOT NULL
               AND position(expected.update_clause || 'on'
                   IN trigger_record.definition) = 0
           ) THEN
            RAISE EXCEPTION
                'Incompatible schema: trigger % on % is missing, disabled, incorrectly bound, or has unexpected events',
                expected.trigger_name, expected.table_name;
        END IF;
    END LOOP;

    IF to_regclass('uq_compliance_report_reviews_submission') IS NOT NULL
       OR EXISTS (
           SELECT 1 FROM pg_trigger
           WHERE tgrelid = to_regclass('compliance_reports')
             AND tgname = 'trg_compliance_reports_status_transition'
             AND NOT tgisinternal
       )
       OR EXISTS (
           SELECT 1 FROM pg_trigger
           WHERE tgrelid = to_regclass('compliance_report_reviews')
             AND tgname = 'trg_compliance_report_reviews_submitted_state'
             AND NOT tgisinternal
       )
       OR EXISTS (
           SELECT 1 FROM pg_trigger
           WHERE tgrelid = to_regclass('compliance_report_submissions')
             AND tgname = 'trg_compliance_report_submissions_status_at_commit'
             AND NOT tgisinternal
       )
       OR EXISTS (
           SELECT 1 FROM pg_trigger
           WHERE tgrelid = to_regclass('compliance_report_reviews')
             AND tgname = 'trg_compliance_report_reviews_status_at_commit'
             AND NOT tgisinternal
       ) THEN
        RAISE EXCEPTION
            'Compliance workflow enforcement objects already exist; do not rerun this one-time migration';
    END IF;
END $$;

-- Reassert the same policy as canonical initialization and every upgrade path.
CREATE OR REPLACE FUNCTION enforce_compliance_report_generator_role()
RETURNS TRIGGER AS $$
DECLARE
    generator_role VARCHAR(20);
    generator_status VARCHAR(15);
BEGIN
    IF TG_OP = 'INSERT' AND NEW.generated_by IS NULL THEN
        RAISE EXCEPTION 'new compliance reports require a submitting fund manager';
    END IF;
    IF NEW.generated_by IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT role, account_status
    INTO generator_role, generator_status
    FROM users
    WHERE user_id = NEW.generated_by;
    IF generator_role IS DISTINCT FROM 'FUND_MANAGER'
       OR generator_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION
            'generated_by user % must be an active FUND_MANAGER (found role %, status %)',
            NEW.generated_by, generator_role, generator_status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE UNIQUE INDEX uq_compliance_report_reviews_submission
    ON compliance_report_reviews (submission_id);

CREATE OR REPLACE FUNCTION enforce_compliance_report_review_state()
RETURNS TRIGGER AS $$
DECLARE
    report_status VARCHAR(25);
    report_is_legacy BOOLEAN;
    report_submitted_at TIMESTAMP WITH TIME ZONE;
    report_last_submitted_at TIMESTAMP WITH TIME ZONE;
    latest_submission_id VARCHAR(25);
BEGIN
    SELECT rba_status, is_legacy, submitted_at, last_submitted_at
    INTO report_status, report_is_legacy, report_submitted_at, report_last_submitted_at
    FROM compliance_reports
    WHERE report_id = NEW.report_id
    FOR UPDATE;

    IF NOT FOUND
       OR report_status <> 'SUBMITTED'
       OR report_is_legacy
       OR report_submitted_at IS NULL
       OR report_last_submitted_at IS NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'compliance decisions require a complete, non-legacy submitted report';
    END IF;

    SELECT submission_id
    INTO latest_submission_id
    FROM compliance_report_submissions
    WHERE report_id = NEW.report_id
    ORDER BY version DESC
    LIMIT 1;

    IF latest_submission_id IS DISTINCT FROM NEW.submission_id THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'compliance decisions must reference the latest report submission';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_compliance_report_reviews_submitted_state
    BEFORE INSERT ON compliance_report_reviews
    FOR EACH ROW
    EXECUTE FUNCTION enforce_compliance_report_review_state();

CREATE OR REPLACE FUNCTION enforce_compliance_report_status_transition()
RETURNS TRIGGER AS $$
DECLARE
    first_submission_id VARCHAR(25);
    first_submission_version INTEGER;
    first_submission_at TIMESTAMP WITH TIME ZONE;
    latest_submission_id VARCHAR(25);
    latest_submission_version INTEGER;
    latest_submission_at TIMESTAMP WITH TIME ZONE;
    submission_count BIGINT;
BEGIN
    IF NEW.rba_status IS NOT DISTINCT FROM OLD.rba_status THEN
        IF NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
           OR NEW.last_submitted_at IS DISTINCT FROM OLD.last_submitted_at THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'submission timestamps can change only with a valid workflow transition';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.is_legacy THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'legacy compliance reports cannot enter the workflow';
    END IF;

    IF OLD.rba_status IN ('DRAFT', 'REVISION_REQUESTED')
       AND NEW.rba_status = 'SUBMITTED' THEN
        SELECT submission_id, version, submitted_at
        INTO first_submission_id, first_submission_version, first_submission_at
        FROM compliance_report_submissions
        WHERE report_id = NEW.report_id
        ORDER BY version ASC
        LIMIT 1;

        SELECT submission_id, version, submitted_at
        INTO latest_submission_id, latest_submission_version, latest_submission_at
        FROM compliance_report_submissions
        WHERE report_id = NEW.report_id
        ORDER BY version DESC
        LIMIT 1;

        SELECT count(*)
        INTO submission_count
        FROM compliance_report_submissions
        WHERE report_id = NEW.report_id;

        IF first_submission_id IS NULL OR latest_submission_id IS NULL
           OR NEW.submitted_at IS DISTINCT FROM first_submission_at
           OR NEW.last_submitted_at IS DISTINCT FROM latest_submission_at THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'submission timestamps must match the first and latest submission history';
        END IF;

        IF OLD.rba_status = 'DRAFT' THEN
            IF OLD.submitted_at IS NOT NULL OR OLD.last_submitted_at IS NOT NULL
               OR first_submission_id IS DISTINCT FROM latest_submission_id
               OR first_submission_version <> 1
               OR latest_submission_version <> 1
               OR submission_count <> 1 THEN
                RAISE EXCEPTION USING
                    ERRCODE = '23514',
                    MESSAGE = 'a draft report requires exactly its first submission to enter the workflow';
            END IF;
        ELSE
            IF NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
               OR OLD.submitted_at IS DISTINCT FROM first_submission_at
               OR latest_submission_version <> submission_count
               OR latest_submission_version < 2
               OR NOT EXISTS (
                   SELECT 1
                   FROM compliance_report_submissions previous_submission
                   JOIN compliance_report_reviews previous_review
                     ON previous_review.report_id = previous_submission.report_id
                    AND previous_review.submission_id = previous_submission.submission_id
                   WHERE previous_submission.report_id = NEW.report_id
                     AND previous_submission.version = latest_submission_version - 1
                     AND previous_submission.submitted_at
                         IS NOT DISTINCT FROM OLD.last_submitted_at
                     AND previous_review.decision = 'REVISION_REQUESTED'
                     AND previous_review.created_at <= latest_submission_at
               )
               OR EXISTS (
                   SELECT 1
                   FROM compliance_report_reviews latest_review
                   WHERE latest_review.report_id = NEW.report_id
                     AND latest_review.submission_id = latest_submission_id
               ) THEN
                RAISE EXCEPTION USING
                    ERRCODE = '23514',
                    MESSAGE = 'a resubmission must follow a revision request and preserve the original submission timestamp';
            END IF;
        END IF;

        RETURN NEW;
    END IF;

    IF OLD.rba_status = 'SUBMITTED'
       AND NEW.rba_status IN ('ACCEPTED', 'REJECTED', 'REVISION_REQUESTED') THEN
        SELECT submission_id, submitted_at
        INTO first_submission_id, first_submission_at
        FROM compliance_report_submissions
        WHERE report_id = NEW.report_id
        ORDER BY version ASC
        LIMIT 1;

        SELECT submission_id, submitted_at
        INTO latest_submission_id, latest_submission_at
        FROM compliance_report_submissions
        WHERE report_id = NEW.report_id
        ORDER BY version DESC
        LIMIT 1;

        IF first_submission_id IS NULL OR latest_submission_id IS NULL
           OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
           OR NEW.last_submitted_at IS DISTINCT FROM OLD.last_submitted_at
           OR NEW.submitted_at IS DISTINCT FROM first_submission_at
           OR NEW.last_submitted_at IS DISTINCT FROM latest_submission_at
           OR NOT EXISTS (
               SELECT 1
               FROM compliance_report_reviews
               WHERE report_id = NEW.report_id
                 AND submission_id = latest_submission_id
                 AND decision = NEW.rba_status
           ) THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'a report decision status requires a matching review of its latest submission';
        END IF;

        RETURN NEW;
    END IF;

    RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
            'invalid compliance report status transition from %s to %s',
            OLD.rba_status,
            NEW.rba_status
        );
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_compliance_reports_status_transition
    BEFORE UPDATE OF rba_status, submitted_at, last_submitted_at ON compliance_reports
    FOR EACH ROW
    EXECUTE FUNCTION enforce_compliance_report_status_transition();

CREATE OR REPLACE FUNCTION enforce_compliance_submission_status_at_commit()
RETURNS TRIGGER AS $$
DECLARE
    report_status VARCHAR(25);
    report_last_submitted_at TIMESTAMP WITH TIME ZONE;
    latest_submission_id VARCHAR(25);
BEGIN
    SELECT rba_status, last_submitted_at
    INTO report_status, report_last_submitted_at
    FROM compliance_reports
    WHERE report_id = NEW.report_id;

    SELECT submission_id
    INTO latest_submission_id
    FROM compliance_report_submissions
    WHERE report_id = NEW.report_id
    ORDER BY version DESC
    LIMIT 1;

    IF report_status IS DISTINCT FROM 'SUBMITTED'
       OR report_last_submitted_at IS DISTINCT FROM NEW.submitted_at
       OR latest_submission_id IS DISTINCT FROM NEW.submission_id THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'submission history must be committed with its submitted report state';
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_compliance_report_submissions_status_at_commit
    AFTER INSERT ON compliance_report_submissions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION enforce_compliance_submission_status_at_commit();

CREATE OR REPLACE FUNCTION enforce_compliance_review_status_at_commit()
RETURNS TRIGGER AS $$
DECLARE
    report_status VARCHAR(25);
    latest_submission_id VARCHAR(25);
BEGIN
    SELECT rba_status
    INTO report_status
    FROM compliance_reports
    WHERE report_id = NEW.report_id;

    SELECT submission_id
    INTO latest_submission_id
    FROM compliance_report_submissions
    WHERE report_id = NEW.report_id
    ORDER BY version DESC
    LIMIT 1;

    IF report_status IS DISTINCT FROM NEW.decision
       OR latest_submission_id IS DISTINCT FROM NEW.submission_id THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'review history must be committed with its matching report decision';
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_compliance_report_reviews_status_at_commit
    AFTER INSERT ON compliance_report_reviews
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION enforce_compliance_review_status_at_commit();

COMMIT;
