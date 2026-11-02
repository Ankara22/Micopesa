#!/usr/bin/env bash
set -euo pipefail

database_name="${1:-}"
if [[ ! "$database_name" =~ ^micopesa_compliance_enforcement_[a-z0-9_]+$ ]]; then
    printf '%s\n' "Usage: $0 micopesa_compliance_enforcement_<unique_suffix>" >&2
    exit 2
fi

psql_test() {
    psql -X -w -h /var/run/postgresql -U postgres -d "$database_name" "$@"
}

identity="$(psql_test -A -t -F '|' -v ON_ERROR_STOP=1 -c \
    "SELECT current_database(), current_user, inet_server_addr(), inet_server_port(), current_setting('data_directory'), current_setting('listen_addresses'), current_setting('server_version_num');")"
printf 'ISOLATED DATABASE IDENTITY: %s\n' "$identity"
expected_prefix="${database_name}|postgres|||/var/lib/postgresql/18/main||"
server_version_num="${identity##*|}"
if [[ "$identity" != "$expected_prefix"* ]] \
    || [[ ! "$server_version_num" =~ ^[0-9]+$ ]] \
    || (( server_version_num < 180000 || server_version_num >= 190000 )); then
    printf '%s\n' "Refusing concurrency test: PostgreSQL identity or socket-only configuration did not match." >&2
    exit 3
fi

psql_test -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'uq_compliance_report_reviews_submission'
    ) OR (
        SELECT count(*) FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgname IN (
              'trg_compliance_report_reviews_submitted_state',
              'trg_compliance_reports_status_transition'
          )
    ) <> 2 THEN
        RAISE EXCEPTION 'workflow enforcement migration is not installed';
    END IF;
END;
$$;
SQL

suffix="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
log_dir="/tmp/micopesa-compliance-verification/concurrency/concurrency-${suffix}"
mkdir -p "$log_dir"

psql_test -v ON_ERROR_STOP=1 -v suffix="$suffix" <<'SQL'
BEGIN;
INSERT INTO users (user_id, full_name, phone, password_hash, role)
VALUES ('wfconc-m-' || :'suffix', 'Fictional Concurrent Manager', '+254' || :'suffix' || '01', 'fixture-only', 'FUND_MANAGER'),
       ('wfconc-r-' || :'suffix', 'Fictional Concurrent Regulator', '+254' || :'suffix' || '02', 'fixture-only', 'REGULATOR');
INSERT INTO funds (fund_id, managed_by, fund_name, administrator_name, risk_level, expected_return)
VALUES ('wfconc-f-' || :'suffix', 'wfconc-m-' || :'suffix', 'Fictional Concurrent Fund', 'Fixture Admin', 'LOW', 4.25);
INSERT INTO compliance_reports
    (report_id, generated_by, fund_id, report_type, period_start, period_end, report_content, rba_status)
VALUES
    ('wfconc-p-' || :'suffix', 'wfconc-m-' || :'suffix', 'wfconc-f-' || :'suffix',
     'RBA', DATE '2026-01-01', DATE '2026-03-31', '{}', 'DRAFT');
INSERT INTO compliance_report_submissions
    (submission_id, report_id, version, submitted_by, submitted_by_name, submitted_by_role,
     report_content, report_type, period_start, period_end)
VALUES
    ('wfconc-s-' || :'suffix', 'wfconc-p-' || :'suffix', 1,
     'wfconc-m-' || :'suffix', 'Fictional Concurrent Manager', 'FUND_MANAGER',
     '{}', 'RBA', DATE '2026-01-01', DATE '2026-03-31');
UPDATE compliance_reports
SET rba_status = 'SUBMITTED', submitted_at = now(), last_submitted_at = now()
WHERE report_id = 'wfconc-p-' || :'suffix';
COMMIT;
SQL

psql_test -v ON_ERROR_STOP=1 -v suffix="$suffix" >"$log_dir/session-a.log" 2>&1 <<'SQL' &
BEGIN;
SELECT rba_status FROM compliance_reports WHERE report_id = 'wfconc-p-' || :'suffix' FOR UPDATE;
INSERT INTO compliance_report_reviews
    (review_id, report_id, submission_id, reviewed_by, reviewed_by_name, reviewed_by_role, decision)
VALUES
    ('wfconc-a-' || :'suffix', 'wfconc-p-' || :'suffix', 'wfconc-s-' || :'suffix',
     'wfconc-r-' || :'suffix', 'Fictional Concurrent Regulator', 'REGULATOR', 'ACCEPTED');
UPDATE compliance_reports SET rba_status = 'ACCEPTED' WHERE report_id = 'wfconc-p-' || :'suffix';
SELECT pg_sleep(3);
COMMIT;
SQL
session_a_pid=$!

sleep 1
set +e
psql_test -v ON_ERROR_STOP=1 -v suffix="$suffix" >"$log_dir/session-b.log" 2>&1 <<'SQL'
BEGIN;
SELECT rba_status FROM compliance_reports WHERE report_id = 'wfconc-p-' || :'suffix' FOR UPDATE;
INSERT INTO compliance_report_reviews
    (review_id, report_id, submission_id, reviewed_by, reviewed_by_name, reviewed_by_role, decision, reason)
VALUES
    ('wfconc-b-' || :'suffix', 'wfconc-p-' || :'suffix', 'wfconc-s-' || :'suffix',
     'wfconc-r-' || :'suffix', 'Fictional Concurrent Regulator', 'REGULATOR',
     'REJECTED', 'Competing decision must not be recorded.');
UPDATE compliance_reports SET rba_status = 'REJECTED' WHERE report_id = 'wfconc-p-' || :'suffix';
COMMIT;
SQL
session_b_status=$?
wait "$session_a_pid"
session_a_status=$?
set -e

printf 'SESSION_A_EXIT=%s SESSION_B_EXIT=%s\n' "$session_a_status" "$session_b_status"
cat "$log_dir/session-a.log"
cat "$log_dir/session-b.log"
if [[ "$session_a_status" -ne 0 || "$session_b_status" -eq 0 ]]; then
    printf '%s\n' "FAIL: expected session A to commit and session B to be rejected." >&2
    exit 4
fi
if ! grep -q 'compliance decisions require a complete, non-legacy submitted report' "$log_dir/session-b.log"; then
    printf '%s\n' "FAIL: session B did not fail at the submitted-state database trigger." >&2
    exit 5
fi

result="$(psql_test -A -t -F '|' -v ON_ERROR_STOP=1 -c \
    "SELECT rba_status, (SELECT count(*) FROM compliance_report_reviews WHERE report_id = 'wfconc-p-${suffix}') FROM compliance_reports WHERE report_id = 'wfconc-p-${suffix}';")"
printf 'FINAL REPORT STATUS AND REVIEW COUNT: %s\n' "$result"
if [[ "$result" != "ACCEPTED|1" ]]; then
    printf '%s\n' "FAIL: concurrent decisions left an unexpected final state." >&2
    exit 6
fi

printf 'PASS: concurrent decision evidence retained in %s\n' "$log_dir"
