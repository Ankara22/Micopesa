\set ON_ERROR_STOP on

SELECT (
    current_database() = :'expected_database'
    AND current_user = 'postgres'
    AND inet_server_addr() IS NULL
    AND inet_server_port() IS NULL
    AND current_setting('data_directory') = '/var/lib/postgresql/18/main'
    AND current_setting('listen_addresses') = ''
    AND current_setting('server_version_num')::integer >= 180000
    AND current_setting('server_version_num')::integer < 190000
    AND EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = :'api_role'
          AND rolsuper = FALSE
          AND rolcreatedb = FALSE
          AND rolcreaterole = FALSE
    )
    AND to_regclass('public.compliance_reports') IS NOT NULL
    AND to_regclass('public.compliance_report_submissions') IS NOT NULL
    AND to_regclass('public.compliance_report_reviews') IS NOT NULL
) AS integration_identity_ok
\gset

\if :integration_identity_ok
\else
\echo 'Refusing integration support setup: database, socket, PostgreSQL version, role, or schema identity did not match.'
\quit 3
\endif

SELECT (
    (SELECT count(*) FROM public.users) = 0
    AND (SELECT count(*) FROM public.funds) = 0
    AND (SELECT count(*) FROM public.compliance_reports) = 0
    AND (SELECT count(*) FROM public.compliance_report_submissions) = 0
    AND (SELECT count(*) FROM public.compliance_report_reviews) = 0
    AND to_regclass('public.compliance_api_integration_failure_targets') IS NULL
    AND to_regprocedure('public.compliance_api_integration_data_directory()') IS NULL
    AND NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_compliance_api_integration_fail_target_audit'
          AND NOT tgisinternal
    )
) AS integration_database_is_fresh
\gset

\if :integration_database_is_fresh
\else
\echo 'Refusing integration support setup: this must be a fresh disposable database without integration fixtures or helper objects.'
\quit 3
\endif

CREATE TABLE public.compliance_api_integration_failure_targets (
    report_id VARCHAR(25) PRIMARY KEY
);

CREATE OR REPLACE FUNCTION public.compliance_api_integration_data_directory()
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
    SELECT current_setting('data_directory');
$$;

CREATE OR REPLACE FUNCTION public.compliance_api_integration_reject_target_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.compliance_api_integration_failure_targets
        WHERE report_id = NEW.entity_id
    ) THEN
        RAISE EXCEPTION 'controlled compliance API integration audit failure';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.compliance_api_integration_data_directory() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compliance_api_integration_reject_target_audit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compliance_api_integration_data_directory() TO :"api_role";

CREATE TRIGGER trg_compliance_api_integration_fail_target_audit
BEFORE INSERT ON public.audit_logs
FOR EACH ROW
EXECUTE FUNCTION public.compliance_api_integration_reject_target_audit();

GRANT INSERT (user_id, full_name, phone, password_hash, role, account_status)
    ON public.users TO :"api_role";
GRANT INSERT (fund_id, managed_by, fund_name, administrator_name, risk_level, expected_return)
    ON public.funds TO :"api_role";
GRANT SELECT ON public.users, public.funds,
    public.compliance_reports, public.compliance_report_submissions,
    public.compliance_report_reviews TO :"api_role";
GRANT UPDATE (user_id) ON public.users TO :"api_role";
GRANT UPDATE (fund_id) ON public.funds TO :"api_role";
GRANT INSERT, UPDATE ON public.compliance_reports TO :"api_role";
GRANT INSERT ON public.compliance_report_submissions,
    public.compliance_report_reviews, public.notifications, public.audit_logs
    TO :"api_role";
GRANT SELECT ON public.notifications, public.audit_logs TO :"api_role";
GRANT SELECT, INSERT ON public.compliance_api_integration_failure_targets TO :"api_role";
