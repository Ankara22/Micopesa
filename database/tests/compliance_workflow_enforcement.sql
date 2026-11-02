-- Run against a fresh disposable database after applying the compliance
-- workflow and workflow-enforcement migrations.
-- The fixture rows are intentionally retained in that disposable database.
\set ON_ERROR_STOP on

SELECT current_database() AS database_name,
       current_user AS connected_role,
       inet_server_addr() AS server_address,
       inet_server_port() AS server_port,
       current_setting('data_directory') AS data_directory,
       current_setting('listen_addresses') AS listen_addresses,
       version() AS server_version;

DO $$
BEGIN
    IF current_database() !~ '^micopesa_compliance_enforcement_[a-z0-9_]+$'
       OR current_user <> 'postgres'
       OR inet_server_addr() IS NOT NULL
       OR inet_server_port() IS NOT NULL
       OR current_setting('data_directory') <> '/var/lib/postgresql/18/main'
       OR current_setting('listen_addresses') <> ''
       OR current_setting('server_version_num')::INTEGER < 180000
       OR current_setting('server_version_num')::INTEGER >= 190000 THEN
        RAISE EXCEPTION
            'Refusing workflow tests: expected the isolated PostgreSQL 18 Ubuntu-24.04 socket instance and a named enforcement test database';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_fails(
    p_sql TEXT,
    p_expected_state TEXT,
    p_label TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    actual_state TEXT;
    actual_message TEXT;
BEGIN
    BEGIN
        EXECUTE p_sql;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS
            actual_state = RETURNED_SQLSTATE,
            actual_message = MESSAGE_TEXT;
        IF actual_state = p_expected_state THEN
            RAISE NOTICE 'PASS: % rejected with SQLSTATE % (%).',
                p_label, actual_state, actual_message;
            RETURN;
        END IF;
        RAISE EXCEPTION 'FAIL: %, expected SQLSTATE %, got % (%).',
            p_label, p_expected_state, actual_state, actual_message;
    END;
    RAISE EXCEPTION 'FAIL: % unexpectedly succeeded.', p_label;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'compliance_report_submissions'::regclass
          AND tgname = 'trg_compliance_report_submissions_no_truncate'
          AND tgenabled = 'O'
          AND NOT tgisinternal
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'compliance_report_reviews'::regclass
          AND tgname = 'trg_compliance_report_reviews_no_truncate'
          AND tgenabled = 'O'
          AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'FAIL: append-only TRUNCATE guards are missing or disabled';
    END IF;
    RAISE NOTICE 'PASS: both compliance history tables have enabled TRUNCATE guards.';
END;
$$;

INSERT INTO users (user_id, full_name, phone, password_hash, role)
VALUES
    ('wf-enf-manager', 'Fictional Workflow Manager', '+254799999901', 'fixture-only', 'FUND_MANAGER'),
    ('wf-enf-other-manager', 'Fictional Other Manager', '+254799999906', 'fixture-only', 'FUND_MANAGER'),
    ('wf-enf-regulator', 'Fictional Workflow Regulator', '+254799999902', 'fixture-only', 'REGULATOR'),
    ('wf-enf-worker', 'Fictional Workflow Worker', '+254799999903', 'fixture-only', 'WORKER'),
    ('wf-enf-admin', 'Fictional Workflow Admin', '+254799999904', 'fixture-only', 'ADMIN');
INSERT INTO users (user_id, full_name, phone, password_hash, role, account_status)
VALUES
    ('wf-enf-inactive', 'Fictional Inactive Manager', '+254799999905',
     'fixture-only', 'FUND_MANAGER', 'INACTIVE'),
    ('wf-enf-inactive-regulator', 'Fictional Inactive Regulator', '+254799999907',
     'fixture-only', 'REGULATOR', 'INACTIVE');

INSERT INTO funds (fund_id, managed_by, fund_name, administrator_name, risk_level, expected_return)
VALUES ('wf-enf-fund', 'wf-enf-manager', 'Fictional Workflow Fund', 'Fixture Admin', 'LOW', 4.25);

INSERT INTO compliance_reports
    (report_id, generated_by, fund_id, report_type, period_start, period_end, report_content, rba_status)
VALUES
    ('wf-enf-main', 'wf-enf-manager', 'wf-enf-fund', 'RBA', DATE '2026-01-01', DATE '2026-03-31', '{}', 'DRAFT'),
    ('wf-enf-reject', 'wf-enf-manager', 'wf-enf-fund', 'NSSF', DATE '2026-04-01', DATE '2026-06-30', '{}', 'DRAFT'),
    ('wf-enf-draft', 'wf-enf-manager', 'wf-enf-fund', 'RBA', DATE '2026-07-01', DATE '2026-09-30', '{}', 'DRAFT'),
    ('wf-enf-orphan', 'wf-enf-manager', 'wf-enf-fund', 'RBA', DATE '2026-10-01', DATE '2026-12-31', '{}', 'DRAFT');

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM compliance_reports
        WHERE report_id IN ('wf-enf-main', 'wf-enf-reject', 'wf-enf-draft', 'wf-enf-orphan')
          AND (rba_status <> 'DRAFT' OR is_legacy)
    ) THEN
        RAISE EXCEPTION 'FAIL: legitimate new reports must begin as non-legacy DRAFT records';
    END IF;
    RAISE NOTICE 'PASS: legitimate new reports begin as non-legacy DRAFT records.';
END;
$$;

SELECT pg_temp.assert_fails(
    $q$INSERT INTO compliance_reports
       (report_id, generated_by, fund_id, report_type, period_start, period_end,
        report_content, rba_status)
       VALUES ('wf-enf-bad-sub', 'wf-enf-manager', 'wf-enf-fund', 'RBA',
               DATE '2026-01-01', DATE '2026-01-31', '{}', 'SUBMITTED')$q$,
    'P0001',
    'new reports cannot be inserted directly as SUBMITTED'
);
SELECT pg_temp.assert_fails(
    $q$INSERT INTO compliance_reports
       (report_id, generated_by, fund_id, report_type, period_start, period_end,
        report_content, rba_status)
       VALUES ('wf-enf-bad-accept', 'wf-enf-manager', 'wf-enf-fund', 'RBA',
               DATE '2026-01-01', DATE '2026-01-31', '{}', 'ACCEPTED')$q$,
    'P0001',
    'new reports cannot be inserted directly as ACCEPTED'
);
SELECT pg_temp.assert_fails(
    $q$INSERT INTO compliance_reports
       (report_id, generated_by, fund_id, report_type, period_start, period_end,
        report_content, rba_status)
       VALUES ('wf-enf-bad-reject', 'wf-enf-manager', 'wf-enf-fund', 'RBA',
               DATE '2026-01-01', DATE '2026-01-31', '{}', 'REJECTED')$q$,
    'P0001',
    'new reports cannot be inserted directly as REJECTED'
);
SELECT pg_temp.assert_fails(
    $q$INSERT INTO compliance_reports
       (report_id, generated_by, fund_id, report_type, period_start, period_end,
        report_content, rba_status)
       VALUES ('wf-enf-bad-revision', 'wf-enf-manager', 'wf-enf-fund', 'RBA',
               DATE '2026-01-01', DATE '2026-01-31', '{}', 'REVISION_REQUESTED')$q$,
    'P0001',
    'new reports cannot be inserted directly as REVISION_REQUESTED'
);
SELECT pg_temp.assert_fails(
    $q$INSERT INTO compliance_reports
       (report_id, generated_by, fund_id, report_type, period_start, period_end,
        report_content, is_legacy)
       VALUES ('wf-enf-bad-legacy', 'wf-enf-manager', 'wf-enf-fund', 'RBA',
               DATE '2026-01-01', DATE '2026-01-31', '{}', TRUE)$q$,
    'P0001',
    'new reports cannot be inserted as legacy'
);
SELECT pg_temp.assert_fails(
    $q$INSERT INTO compliance_reports
       (report_id, generated_by, fund_id, report_type, period_start, period_end,
        report_content, submitted_at)
       VALUES ('wf-enf-bad-time', 'wf-enf-manager', 'wf-enf-fund', 'RBA',
               DATE '2026-01-01', DATE '2026-01-31', '{}', now())$q$,
    'P0001',
    'new draft reports cannot be inserted with submission timestamps'
);

SELECT pg_temp.assert_fails(
    $q$INSERT INTO compliance_reports
       (report_id, generated_by, fund_id, report_type, period_start, period_end, report_content)
       VALUES ('wf-enf-deny-fund-owner', 'wf-enf-other-manager', 'wf-enf-fund', 'RBA',
               DATE '2026-01-01', DATE '2026-01-31', '{}')$q$,
    'P0001',
    'report generator must manage the selected fund'
);

SELECT pg_temp.assert_fails(
    $q$INSERT INTO compliance_reports
       (report_id, generated_by, fund_id, report_type, period_start, period_end, report_content)
       VALUES ('wf-enf-deny-reg', 'wf-enf-regulator', 'wf-enf-fund', 'RBA',
               DATE '2026-01-01', DATE '2026-01-31', '{}')$q$,
    'P0001',
    'regulator cannot generate a compliance report'
);
SELECT pg_temp.assert_fails(
    $q$INSERT INTO compliance_reports
       (report_id, generated_by, fund_id, report_type, period_start, period_end, report_content)
       VALUES ('wf-enf-deny-worker', 'wf-enf-worker', 'wf-enf-fund', 'RBA',
               DATE '2026-01-01', DATE '2026-01-31', '{}')$q$,
    'P0001',
    'worker cannot generate a compliance report'
);
SELECT pg_temp.assert_fails(
    $q$INSERT INTO compliance_reports
       (report_id, generated_by, fund_id, report_type, period_start, period_end, report_content)
       VALUES ('wf-enf-deny-admin', 'wf-enf-admin', 'wf-enf-fund', 'RBA',
               DATE '2026-01-01', DATE '2026-01-31', '{}')$q$,
    'P0001',
    'admin cannot generate a compliance report'
);
SELECT pg_temp.assert_fails(
    $q$INSERT INTO compliance_reports
       (report_id, generated_by, fund_id, report_type, period_start, period_end, report_content)
       VALUES ('wf-enf-deny-inactive', 'wf-enf-inactive', 'wf-enf-fund', 'RBA',
               DATE '2026-01-01', DATE '2026-01-31', '{}')$q$,
    'P0001',
    'inactive manager cannot generate a compliance report'
);
SELECT pg_temp.assert_fails(
    $q$INSERT INTO compliance_reports
       (report_id, generated_by, fund_id, report_type, period_start, period_end, report_content)
       VALUES ('wf-enf-deny-null', NULL, 'wf-enf-fund', 'RBA',
               DATE '2026-01-01', DATE '2026-01-31', '{}')$q$,
    'P0001',
    'new compliance report cannot omit generator attribution'
);

SELECT pg_temp.assert_fails(
    $q$UPDATE compliance_reports
       SET submitted_at = now()
       WHERE report_id = 'wf-enf-draft'$q$,
    '23514',
    'submitted_at cannot be changed independently'
);
SELECT pg_temp.assert_fails(
    $q$UPDATE compliance_reports
       SET last_submitted_at = now()
       WHERE report_id = 'wf-enf-draft'$q$,
    '23514',
    'last_submitted_at cannot be changed independently'
);

INSERT INTO compliance_reports
    (report_id, generated_by, fund_id, report_type, period_start, period_end, report_content)
VALUES
    ('wf-enf-null-attribution', 'wf-enf-manager', 'wf-enf-fund', 'RBA',
     DATE '2026-01-01', DATE '2026-01-31', '{}');
UPDATE compliance_reports
SET generated_by = NULL
WHERE report_id = 'wf-enf-null-attribution';
DO $$
BEGIN
    IF (SELECT generated_by FROM compliance_reports
        WHERE report_id = 'wf-enf-null-attribution') IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL: historical generator attribution could not be cleared';
    END IF;
    RAISE NOTICE 'PASS: active manager creation is allowed and historical NULL attribution remains allowed.';
END;
$$;

SELECT pg_temp.assert_fails(
    $q$UPDATE compliance_reports SET rba_status = 'ACCEPTED' WHERE report_id = 'wf-enf-draft'$q$,
    '23514',
    'direct DRAFT to ACCEPTED transition'
);
SELECT pg_temp.assert_fails(
    $q$UPDATE compliance_reports SET rba_status = 'SUBMITTED' WHERE report_id = 'wf-enf-draft'$q$,
    '23514',
    'submission status without submission history'
);
SELECT pg_temp.assert_fails(
    $q$INSERT INTO compliance_report_reviews
       (report_id, submission_id, reviewed_by, reviewed_by_name, reviewed_by_role, decision)
       VALUES ('wf-enf-draft', 'missing-submission', 'wf-enf-regulator',
               'Fictional Workflow Regulator', 'REGULATOR', 'ACCEPTED')$q$,
    '23514',
    'decision against a draft report'
);

DO $$
DECLARE
    failed BOOLEAN := FALSE;
BEGIN
    BEGIN
        INSERT INTO compliance_report_submissions
            (submission_id, report_id, version, submitted_by, submitted_by_name, submitted_by_role,
             report_content, report_type, period_start, period_end)
        VALUES
            ('wf-enf-bad-actor', 'wf-enf-orphan', 1, 'wf-enf-manager',
             'Incorrect Snapshot Name', 'FUND_MANAGER', '{}', 'RBA',
             DATE '2026-10-01', DATE '2026-12-31');
    EXCEPTION WHEN raise_exception THEN
        failed := TRUE;
    END;

    IF NOT failed OR EXISTS (
        SELECT 1 FROM compliance_report_submissions
        WHERE submission_id = 'wf-enf-bad-actor'
    ) THEN
        RAISE EXCEPTION 'FAIL: a submission with a mismatched actor snapshot was accepted';
    END IF;
    RAISE NOTICE 'PASS: submission actor snapshots must match the active database user.';
END;
$$;

DO $$
DECLARE
    failed BOOLEAN := FALSE;
BEGIN
    BEGIN
        INSERT INTO compliance_report_submissions
            (submission_id, report_id, version, submitted_by, submitted_by_name, submitted_by_role,
             report_content, report_type, period_start, period_end)
        VALUES
            ('wf-enf-orphan-sub', 'wf-enf-orphan', 1, 'wf-enf-manager',
             'Fictional Workflow Manager', 'FUND_MANAGER', '{}', 'RBA',
             DATE '2026-10-01', DATE '2026-12-31');
        SET CONSTRAINTS trg_compliance_report_submissions_status_at_commit IMMEDIATE;
    EXCEPTION WHEN check_violation THEN
        failed := TRUE;
    END;

    IF NOT failed THEN
        RAISE EXCEPTION 'FAIL: submission without matching report status was accepted';
    END IF;
    IF EXISTS (
        SELECT 1 FROM compliance_report_submissions
        WHERE submission_id = 'wf-enf-orphan-sub'
    ) THEN
        RAISE EXCEPTION 'FAIL: rejected orphan submission was not rolled back';
    END IF;
    RAISE NOTICE 'PASS: submission history without submitted report state is rejected and rolled back.';
END;
$$;

DO $$
DECLARE
    failed BOOLEAN;
BEGIN
    failed := FALSE;
    BEGIN
        INSERT INTO compliance_report_submissions
            (submission_id, report_id, version, submitted_by, submitted_by_name, submitted_by_role,
             report_content, report_type, period_start, period_end, submitted_at)
        VALUES
            ('wf-enf-bad-first-time', 'wf-enf-main', 1, 'wf-enf-manager',
             'Fictional Workflow Manager', 'FUND_MANAGER', '{}', 'RBA',
             DATE '2026-01-01', DATE '2026-03-31', TIMESTAMPTZ '2026-01-02 12:00:00+00');
        UPDATE compliance_reports
        SET rba_status = 'SUBMITTED',
            submitted_at = TIMESTAMPTZ '2026-01-03 12:00:00+00',
            last_submitted_at = TIMESTAMPTZ '2026-01-02 12:00:00+00'
        WHERE report_id = 'wf-enf-main';
    EXCEPTION WHEN check_violation THEN
        failed := TRUE;
    END;

    IF NOT failed OR EXISTS (
        SELECT 1 FROM compliance_report_submissions
        WHERE submission_id = 'wf-enf-bad-first-time'
    ) THEN
        RAISE EXCEPTION 'FAIL: submission timestamp differing from the first history row was accepted';
    END IF;

    failed := FALSE;
    BEGIN
        INSERT INTO compliance_report_submissions
            (submission_id, report_id, version, submitted_by, submitted_by_name, submitted_by_role,
             report_content, report_type, period_start, period_end, submitted_at)
        VALUES
            ('wf-enf-bad-latest-time', 'wf-enf-main', 1, 'wf-enf-manager',
             'Fictional Workflow Manager', 'FUND_MANAGER', '{}', 'RBA',
             DATE '2026-01-01', DATE '2026-03-31', TIMESTAMPTZ '2026-01-02 12:00:00+00');
        UPDATE compliance_reports
        SET rba_status = 'SUBMITTED',
            submitted_at = TIMESTAMPTZ '2026-01-02 12:00:00+00',
            last_submitted_at = TIMESTAMPTZ '2026-01-03 12:00:00+00'
        WHERE report_id = 'wf-enf-main';
    EXCEPTION WHEN check_violation THEN
        failed := TRUE;
    END;

    IF NOT failed OR EXISTS (
        SELECT 1 FROM compliance_report_submissions
        WHERE submission_id = 'wf-enf-bad-latest-time'
    ) THEN
        RAISE EXCEPTION 'FAIL: last-submission timestamp differing from history was accepted';
    END IF;
    RAISE NOTICE 'PASS: initial submission timestamps must match the first and latest history rows.';
END;
$$;

BEGIN;
INSERT INTO compliance_report_submissions
    (submission_id, report_id, version, submitted_by, submitted_by_name, submitted_by_role,
     report_content, report_type, period_start, period_end)
VALUES
    ('wf-enf-main-v1', 'wf-enf-main', 1, 'wf-enf-manager',
     'Fictional Workflow Manager', 'FUND_MANAGER', '{}', 'RBA',
     DATE '2026-01-01', DATE '2026-03-31');
UPDATE compliance_reports
SET rba_status = 'SUBMITTED',
     submitted_at = now(),
    last_submitted_at = now()
WHERE report_id = 'wf-enf-main';
COMMIT;

SELECT pg_temp.assert_fails(
     $q$INSERT INTO compliance_report_reviews
        (review_id, report_id, submission_id, reviewed_by, reviewed_by_name, reviewed_by_role, decision, reason)
        VALUES ('wf-enf-review-worker', 'wf-enf-main', 'wf-enf-main-v1', 'wf-enf-worker',
                'Fictional Workflow Worker', 'REGULATOR', 'REVISION_REQUESTED',
                'A fictional worker must not review this report.')$q$,
     'P0001',
     'worker cannot review compliance reports'
);
SELECT pg_temp.assert_fails(
     $q$INSERT INTO compliance_report_reviews
        (review_id, report_id, submission_id, reviewed_by, reviewed_by_name, reviewed_by_role, decision, reason)
        VALUES ('wf-enf-review-inactive', 'wf-enf-main', 'wf-enf-main-v1',
                'wf-enf-inactive-regulator', 'Fictional Inactive Regulator', 'REGULATOR',
                'REVISION_REQUESTED', 'An inactive regulator must not review this report.')$q$,
     'P0001',
     'inactive regulator cannot review compliance reports'
);
SELECT pg_temp.assert_fails(
     $q$INSERT INTO compliance_report_reviews
        (review_id, report_id, submission_id, reviewed_by, reviewed_by_name, reviewed_by_role, decision, reason)
        VALUES ('wf-enf-review-name', 'wf-enf-main', 'wf-enf-main-v1',
                'wf-enf-regulator', 'Incorrect Snapshot Name', 'REGULATOR',
                'REVISION_REQUESTED', 'A mismatched actor snapshot must be rejected.')$q$,
     'P0001',
     'review actor snapshot must match the database user'
);

BEGIN;
INSERT INTO compliance_report_reviews
    (review_id, report_id, submission_id, reviewed_by, reviewed_by_name, reviewed_by_role, decision, reason)
VALUES
    ('wf-enf-main-r1', 'wf-enf-main', 'wf-enf-main-v1', 'wf-enf-regulator',
     'Fictional Workflow Regulator', 'REGULATOR', 'REVISION_REQUESTED',
     'Please clarify the fictional reporting assumptions.');
SELECT pg_temp.assert_fails(
    $q$INSERT INTO compliance_report_reviews
       (review_id, report_id, submission_id, reviewed_by, reviewed_by_name, reviewed_by_role, decision, reason)
       VALUES ('wf-enf-main-dup', 'wf-enf-main', 'wf-enf-main-v1', 'wf-enf-regulator',
               'Fictional Workflow Regulator', 'REGULATOR', 'ACCEPTED', NULL)$q$,
    '23505',
    'duplicate decision for the same submission'
);
UPDATE compliance_reports
SET rba_status = 'REVISION_REQUESTED'
WHERE report_id = 'wf-enf-main';
COMMIT;

SELECT pg_temp.assert_fails(
    $q$INSERT INTO compliance_report_reviews
       (review_id, report_id, submission_id, reviewed_by, reviewed_by_name, reviewed_by_role, decision, reason)
       VALUES ('wf-enf-main-rbad', 'wf-enf-main', 'wf-enf-main-v1', 'wf-enf-regulator',
               'Fictional Workflow Regulator', 'REGULATOR', 'ACCEPTED', NULL)$q$,
    '23514',
    'decision while report awaits manager revision'
);

BEGIN;
INSERT INTO compliance_report_submissions
    (submission_id, report_id, version, submitted_by, submitted_by_name, submitted_by_role,
     report_content, report_type, period_start, period_end)
VALUES
    ('wf-enf-main-v2', 'wf-enf-main', 2, 'wf-enf-manager',
     'Fictional Workflow Manager', 'FUND_MANAGER', '{}', 'RBA',
     DATE '2026-01-01', DATE '2026-03-31');
UPDATE compliance_reports
SET rba_status = 'SUBMITTED',
    last_submitted_at = now()
WHERE report_id = 'wf-enf-main';
COMMIT;

BEGIN;
INSERT INTO compliance_report_reviews
    (review_id, report_id, submission_id, reviewed_by, reviewed_by_name, reviewed_by_role, decision)
VALUES
    ('wf-enf-main-r2', 'wf-enf-main', 'wf-enf-main-v2', 'wf-enf-regulator',
     'Fictional Workflow Regulator', 'REGULATOR', 'ACCEPTED');
UPDATE compliance_reports
SET rba_status = 'ACCEPTED'
WHERE report_id = 'wf-enf-main';
COMMIT;

BEGIN;
INSERT INTO compliance_report_submissions
    (submission_id, report_id, version, submitted_by, submitted_by_name, submitted_by_role,
     report_content, report_type, period_start, period_end)
VALUES
    ('wf-enf-reject-v1', 'wf-enf-reject', 1, 'wf-enf-manager',
     'Fictional Workflow Manager', 'FUND_MANAGER', '{}', 'NSSF',
     DATE '2026-04-01', DATE '2026-06-30');
UPDATE compliance_reports
SET rba_status = 'SUBMITTED',
    submitted_at = COALESCE(submitted_at, now()),
    last_submitted_at = now()
WHERE report_id = 'wf-enf-reject';
COMMIT;

BEGIN;
INSERT INTO compliance_report_reviews
    (review_id, report_id, submission_id, reviewed_by, reviewed_by_name, reviewed_by_role, decision, reason)
VALUES
    ('wf-enf-reject-r1', 'wf-enf-reject', 'wf-enf-reject-v1', 'wf-enf-regulator',
     'Fictional Workflow Regulator', 'REGULATOR', 'REJECTED',
     'Please correct the fictional test data.');
UPDATE compliance_reports
SET rba_status = 'REJECTED'
WHERE report_id = 'wf-enf-reject';
COMMIT;

DO $$
DECLARE
    failed BOOLEAN := FALSE;
BEGIN
    BEGIN
        INSERT INTO compliance_reports
            (report_id, generated_by, fund_id, report_type, period_start, period_end, report_content, rba_status)
        VALUES
            ('wf-enf-rollback', 'wf-enf-manager', 'wf-enf-fund', 'RBA',
             DATE '2026-01-01', DATE '2026-03-31', '{}', 'DRAFT');
        INSERT INTO compliance_report_submissions
            (submission_id, report_id, version, submitted_by, submitted_by_name, submitted_by_role,
             report_content, report_type, period_start, period_end)
        VALUES
            ('wf-enf-rollback-v1', 'wf-enf-rollback', 1, 'wf-enf-manager',
             'Fictional Workflow Manager', 'FUND_MANAGER', '{}', 'RBA',
             DATE '2026-01-01', DATE '2026-03-31');
        UPDATE compliance_reports
        SET rba_status = 'SUBMITTED',
            submitted_at = now(),
            last_submitted_at = now()
        WHERE report_id = 'wf-enf-rollback';
        INSERT INTO compliance_report_reviews
            (review_id, report_id, submission_id, reviewed_by, reviewed_by_name, reviewed_by_role, decision)
        VALUES
            ('wf-enf-rollback-r1', 'wf-enf-rollback', 'wf-enf-rollback-v1', 'wf-enf-regulator',
             'Fictional Workflow Regulator', 'REGULATOR', 'ACCEPTED');
        UPDATE compliance_reports
        SET rba_status = 'ACCEPTED'
        WHERE report_id = 'wf-enf-rollback';
        INSERT INTO audit_logs (user_id, action_type, entity_name, entity_id)
        VALUES ('wf-enf-regulator', 'NOT_A_REAL_ACTION', 'COMPLIANCE_REPORTS', 'wf-enf-rollback');
    EXCEPTION WHEN check_violation THEN
        failed := TRUE;
    END;

    IF NOT failed THEN
        RAISE EXCEPTION 'FAIL: injected audit failure did not occur';
    END IF;
    IF EXISTS (
        SELECT 1 FROM compliance_reports WHERE report_id = 'wf-enf-rollback'
    ) OR EXISTS (
        SELECT 1 FROM compliance_report_submissions WHERE report_id = 'wf-enf-rollback'
    ) OR EXISTS (
        SELECT 1 FROM compliance_report_reviews WHERE report_id = 'wf-enf-rollback'
    ) THEN
        RAISE EXCEPTION 'FAIL: failed workflow transaction left partial records';
    END IF;
    RAISE NOTICE 'PASS: failed audit insert rolls back report, submission, and review writes.';
END;
$$;

DO $$
BEGIN
    IF (SELECT count(*) FROM compliance_report_reviews
        WHERE report_id = 'wf-enf-main') <> 2
       OR (SELECT count(DISTINCT submission_id) FROM compliance_report_reviews
           WHERE report_id = 'wf-enf-main') <> 2
       OR (SELECT rba_status FROM compliance_reports
           WHERE report_id = 'wf-enf-main') <> 'ACCEPTED'
       OR (SELECT submitted_at FROM compliance_reports
           WHERE report_id = 'wf-enf-main') IS DISTINCT FROM (
               SELECT submitted_at FROM compliance_report_submissions
               WHERE submission_id = 'wf-enf-main-v1'
           )
       OR (SELECT last_submitted_at FROM compliance_reports
           WHERE report_id = 'wf-enf-main') IS DISTINCT FROM (
               SELECT submitted_at FROM compliance_report_submissions
               WHERE submission_id = 'wf-enf-main-v2'
           )
       OR NOT EXISTS (
           SELECT 1
           FROM compliance_report_reviews review
           JOIN compliance_report_submissions submission
             ON submission.submission_id = review.submission_id
           WHERE review.review_id = 'wf-enf-main-r1'
             AND review.decision = 'REVISION_REQUESTED'
             AND submission.version = 1
       )
       OR NOT EXISTS (
           SELECT 1
           FROM compliance_report_reviews review
           JOIN compliance_report_submissions submission
             ON submission.submission_id = review.submission_id
           WHERE review.review_id = 'wf-enf-main-r2'
             AND review.decision = 'ACCEPTED'
             AND submission.version = 2
       ) THEN
        RAISE EXCEPTION 'FAIL: resubmissions did not receive distinct decisions';
    END IF;

    IF (SELECT rba_status FROM compliance_reports
        WHERE report_id = 'wf-enf-reject') <> 'REJECTED'
       OR NOT EXISTS (
           SELECT 1 FROM compliance_report_reviews
           WHERE report_id = 'wf-enf-reject'
             AND decision = 'REJECTED'
       ) THEN
        RAISE EXCEPTION 'FAIL: rejection transition was not preserved';
    END IF;

    PERFORM pg_temp.assert_fails(
        $q$UPDATE compliance_reports SET rba_status = 'SUBMITTED'
           WHERE report_id = 'wf-enf-main'$q$,
        '23514',
        'accepted reports cannot be resubmitted'
    );

    RAISE NOTICE 'PASS: each resubmission has one decision and all supported terminal outcomes are valid.';
END;
$$;

SELECT pg_temp.assert_fails(
    $q$UPDATE compliance_report_submissions
       SET report_content = '{"changed":true}'
       WHERE submission_id = 'wf-enf-main-v1'$q$,
    '55000',
    'submission history rejects UPDATE'
);
SELECT pg_temp.assert_fails(
    $q$DELETE FROM compliance_report_submissions
       WHERE submission_id = 'wf-enf-main-v1'$q$,
    '55000',
    'submission history rejects DELETE'
);
SELECT pg_temp.assert_fails(
    $q$TRUNCATE TABLE compliance_report_submissions, compliance_report_reviews$q$,
    '55000',
    'submission history rejects TRUNCATE'
);
SELECT pg_temp.assert_fails(
    $q$UPDATE compliance_report_reviews
       SET reason = 'Changed review history reason.'
       WHERE review_id = 'wf-enf-main-r1'$q$,
    '55000',
    'review history rejects UPDATE'
);
SELECT pg_temp.assert_fails(
    $q$DELETE FROM compliance_report_reviews
       WHERE review_id = 'wf-enf-main-r1'$q$,
    '55000',
    'review history rejects DELETE'
);
SELECT pg_temp.assert_fails(
    $q$TRUNCATE TABLE compliance_report_reviews$q$,
    '55000',
    'review history rejects TRUNCATE'
);

SELECT report_id, rba_status,
       (SELECT count(*) FROM compliance_report_submissions s WHERE s.report_id = cr.report_id) AS submission_count,
       (SELECT count(*) FROM compliance_report_reviews r WHERE r.report_id = cr.report_id) AS review_count
FROM compliance_reports cr
WHERE report_id IN ('wf-enf-main', 'wf-enf-reject', 'wf-enf-draft');
