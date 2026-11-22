BEGIN;

DO $$
BEGIN
    IF to_regclass('public.audit_logs') IS NULL THEN
        RAISE EXCEPTION
            'Audit-log immutability migration requires public.audit_logs';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.audit_logs'::regclass
          AND conname = 'fk_audit_logs_user'
          AND confdeltype = 'n'
    ) THEN
        RAISE EXCEPTION
            'Audit-log immutability migration requires actor ON DELETE SET NULL';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND pg_trigger_depth() > 1
       AND OLD.user_id IS NOT NULL
       AND NEW.user_id IS NULL
       AND (to_jsonb(NEW) - 'user_id') IS NOT DISTINCT FROM
           (to_jsonb(OLD) - 'user_id') THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'audit_logs is append-only'
        USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_append_only ON public.audit_logs;
CREATE TRIGGER trg_audit_logs_append_only
    BEFORE UPDATE OR DELETE ON public.audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_audit_log_mutation();
ALTER TABLE public.audit_logs
    ENABLE ALWAYS TRIGGER trg_audit_logs_append_only;
REVOKE UPDATE, DELETE ON TABLE public.audit_logs FROM PUBLIC;

COMMIT;
