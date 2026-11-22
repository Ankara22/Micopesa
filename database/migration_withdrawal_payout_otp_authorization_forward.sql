-- Adds a dedicated payout-authorization role and OTP authorization records.
-- This does not enable or create a payout executor; payout execution remains disabled.
-- The only supported predecessor is the checked-in four-role schema without OTP objects.
BEGIN;

DO $withdrawal_otp_preflight$
DECLARE
    role_attnum SMALLINT;
    role_constraint_count INTEGER;
    role_constraint_name TEXT;
    role_constraint_validated BOOLEAN;
    normalized_role_check TEXT;
    expected_column RECORD;
    actual_type TEXT;
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtext('MicoPesa schema migrations'),
        hashtext('withdrawal payout OTP authorization')
    );

    IF to_regclass('public.users') IS NULL
       OR to_regclass('public.withdrawal_claims') IS NULL
       OR to_regclass('public.pension_accounts') IS NULL
       OR to_regclass('public.audit_logs') IS NULL THEN
        RAISE EXCEPTION
            'Withdrawal OTP migration requires public.users, public.withdrawal_claims, public.pension_accounts, and public.audit_logs';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM unnest(ARRAY[
            'users', 'withdrawal_claims', 'pension_accounts', 'audit_logs'
        ]) AS required_table(table_name)
        JOIN pg_class relation
          ON relation.oid = to_regclass(format('public.%I', required_table.table_name))
        WHERE relation.relkind <> 'r'
    ) THEN
        RAISE EXCEPTION
            'Withdrawal OTP migration requires regular tables in the public schema';
    END IF;

    FOR expected_column IN
        SELECT * FROM (VALUES
            ('users', 'user_id', 'character varying(25)'),
            ('users', 'role', 'character varying(20)'),
            ('users', 'phone', 'character varying(15)'),
            ('users', 'phone_verified_at', 'timestamp with time zone'),
            ('users', 'account_status', 'character varying(15)'),
            ('withdrawal_claims', 'claim_id', 'character varying(25)'),
            ('withdrawal_claims', 'account_id', 'character varying(25)'),
            ('withdrawal_claims', 'claim_status', 'character varying(15)'),
            ('withdrawal_claims', 'amount_requested', 'numeric(12,2)'),
            ('withdrawal_claims', 'destination_phone', 'character varying(15)'),
            ('withdrawal_claims', 'transaction_id', 'character varying(25)'),
            ('withdrawal_claims', 'processed_at', 'timestamp with time zone'),
            ('pension_accounts', 'account_id', 'character varying(25)'),
            ('pension_accounts', 'user_id', 'character varying(25)'),
            ('pension_accounts', 'account_status', 'character varying(15)'),
            ('audit_logs', 'user_id', 'character varying(25)'),
            ('audit_logs', 'action_type', 'character varying(20)'),
            ('audit_logs', 'entity_name', 'character varying(50)'),
            ('audit_logs', 'entity_id', 'character varying(25)'),
            ('audit_logs', 'details', 'jsonb')
        ) AS required_column(table_name, column_name, expected_type)
    LOOP
        SELECT format_type(attribute.atttypid, attribute.atttypmod)
        INTO actual_type
        FROM pg_attribute attribute
        WHERE attribute.attrelid =
              to_regclass(format('public.%I', expected_column.table_name))
          AND attribute.attname = expected_column.column_name
          AND NOT attribute.attisdropped;

        IF NOT FOUND OR actual_type IS DISTINCT FROM expected_column.expected_type THEN
            RAISE EXCEPTION
                'Incompatible withdrawal OTP migration target: public.%.% must be %, found %',
                expected_column.table_name,
                expected_column.column_name,
                expected_column.expected_type,
                COALESCE(actual_type, 'missing');
        END IF;
    END LOOP;

    IF to_regclass('public.withdrawal_payout_otp_authorizations') IS NOT NULL
       OR to_regclass('public.withdrawal_payout_otp_delivery_events') IS NOT NULL
       OR to_regclass('public.uq_withdrawal_payout_otp_one_active_per_claim') IS NOT NULL
       OR to_regclass('public.idx_withdrawal_payout_otp_claim_history') IS NOT NULL
       OR to_regclass('public.idx_withdrawal_payout_otp_delivery_rate_limit') IS NOT NULL
       OR to_regclass('public.uq_withdrawal_claims_claim_account_otp') IS NOT NULL
       OR to_regclass('public.uq_pension_accounts_account_user_otp') IS NOT NULL
       OR to_regprocedure('public.invalidate_withdrawal_payout_otp()') IS NOT NULL
       OR EXISTS (
           SELECT 1
           FROM pg_trigger trigger_object
           WHERE NOT trigger_object.tgisinternal
             AND trigger_object.tgrelid IN (
                 'public.withdrawal_claims'::regclass,
                 'public.users'::regclass,
                 'public.pension_accounts'::regclass
             )
             AND trigger_object.tgname IN (
                 'trg_withdrawal_claims_invalidate_payout_otp',
                 'trg_users_invalidate_payout_otp',
                 'trg_pension_accounts_invalidate_payout_otp'
             )
       ) THEN
        RAISE EXCEPTION
            'Withdrawal payout OTP objects already exist or are partially installed; do not reapply this one-time migration';
    END IF;

    SELECT attribute.attnum
    INTO role_attnum
    FROM pg_attribute attribute
    WHERE attribute.attrelid = 'public.users'::regclass
      AND attribute.attname = 'role'
      AND NOT attribute.attisdropped;

    SELECT count(*),
           min(constraint_object.conname::TEXT),
           bool_and(constraint_object.convalidated),
           min(regexp_replace(
               regexp_replace(
                   lower(pg_get_constraintdef(constraint_object.oid)),
                   '::(character varying|varchar|text)(\[\])?(\([0-9]+\))?',
                   '',
                   'g'
               ),
               '[[:space:]()]',
               '',
               'g'
           ))
    INTO role_constraint_count,
         role_constraint_name,
         role_constraint_validated,
         normalized_role_check
    FROM pg_constraint constraint_object
    WHERE constraint_object.conrelid = 'public.users'::regclass
      AND constraint_object.contype = 'c'
      AND role_attnum = ANY(constraint_object.conkey);

    IF role_constraint_count <> 1
       OR role_constraint_name IS DISTINCT FROM 'users_role_check' THEN
        RAISE EXCEPTION
            'Incompatible withdrawal OTP migration target: expected exactly the supported users_role_check on users.role';
    END IF;

    IF role_constraint_validated IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION
            'Incompatible withdrawal OTP migration target: users_role_check is not validated';
    END IF;

    IF normalized_role_check =
       'checkrole=anyarray[''worker'',''fund_manager'',''regulator'',''admin'']' THEN
        RETURN;
    ELSIF normalized_role_check =
       'checkrole=anyarray[''worker'',''fund_manager'',''regulator'',''admin'',''payout_officer'']' THEN
        RAISE EXCEPTION
            'PAYOUT_OFFICER is already allowed; target is already featured or partially upgraded, so this migration must not run';
    ELSE
        RAISE EXCEPTION
            'Incompatible withdrawal OTP migration target: users_role_check does not match the supported four-role predecessor';
    END IF;
END
$withdrawal_otp_preflight$;

ALTER TABLE public.users
    DROP CONSTRAINT users_role_check;

ALTER TABLE public.users
    ADD CONSTRAINT users_role_check
        CHECK (role IN (
            'WORKER', 'FUND_MANAGER', 'REGULATOR', 'ADMIN', 'PAYOUT_OFFICER'
        ));

DO $withdrawal_otp_parent_indexes$
DECLARE
    claim_attnum SMALLINT;
    claim_account_attnum SMALLINT;
    pension_account_attnum SMALLINT;
    pension_user_attnum SMALLINT;
BEGIN
    SELECT attnum INTO claim_attnum
    FROM pg_attribute
    WHERE attrelid = 'public.withdrawal_claims'::regclass
      AND attname = 'claim_id' AND NOT attisdropped;
    SELECT attnum INTO claim_account_attnum
    FROM pg_attribute
    WHERE attrelid = 'public.withdrawal_claims'::regclass
      AND attname = 'account_id' AND NOT attisdropped;
    SELECT attnum INTO pension_account_attnum
    FROM pg_attribute
    WHERE attrelid = 'public.pension_accounts'::regclass
      AND attname = 'account_id' AND NOT attisdropped;
    SELECT attnum INTO pension_user_attnum
    FROM pg_attribute
    WHERE attrelid = 'public.pension_accounts'::regclass
      AND attname = 'user_id' AND NOT attisdropped;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_index index_definition
        JOIN pg_class index_relation ON index_relation.oid = index_definition.indexrelid
        JOIN pg_am access_method ON access_method.oid = index_relation.relam
        WHERE index_definition.indrelid = 'public.withdrawal_claims'::regclass
          AND index_definition.indisunique
          AND index_definition.indisvalid
          AND index_definition.indisready
          AND index_definition.indpred IS NULL
          AND index_definition.indexprs IS NULL
          AND index_definition.indnatts = 2
          AND index_definition.indnkeyatts = 2
          AND index_definition.indkey[0] = claim_attnum
          AND index_definition.indkey[1] = claim_account_attnum
          AND access_method.amname = 'btree'
    ) THEN
        EXECUTE
            'CREATE UNIQUE INDEX uq_withdrawal_claims_claim_account_otp ' ||
            'ON public.withdrawal_claims (claim_id, account_id)';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_index index_definition
        JOIN pg_class index_relation ON index_relation.oid = index_definition.indexrelid
        JOIN pg_am access_method ON access_method.oid = index_relation.relam
        WHERE index_definition.indrelid = 'public.pension_accounts'::regclass
          AND index_definition.indisunique
          AND index_definition.indisvalid
          AND index_definition.indisready
          AND index_definition.indpred IS NULL
          AND index_definition.indexprs IS NULL
          AND index_definition.indnatts = 2
          AND index_definition.indnkeyatts = 2
          AND index_definition.indkey[0] = pension_account_attnum
          AND index_definition.indkey[1] = pension_user_attnum
          AND access_method.amname = 'btree'
    ) THEN
        EXECUTE
            'CREATE UNIQUE INDEX uq_pension_accounts_account_user_otp ' ||
            'ON public.pension_accounts (account_id, user_id)';
    END IF;
END
$withdrawal_otp_parent_indexes$;

CREATE TABLE public.withdrawal_payout_otp_authorizations (
    authorization_attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    claim_id VARCHAR(25) NOT NULL,
    account_id VARCHAR(25) NOT NULL,
    worker_user_id VARCHAR(25) NOT NULL,
    initiated_by_user_id VARCHAR(25) NOT NULL,
    destination_phone_snapshot VARCHAR(15) NOT NULL,
    destination_verified_at TIMESTAMPTZ NOT NULL,
    otp_hash BYTEA,
    otp_salt BYTEA,
    status VARCHAR(20) NOT NULL DEFAULT 'DELIVERY_PENDING'
        CHECK (status IN (
            'DELIVERY_PENDING', 'ISSUED', 'VERIFIED', 'EXPIRED',
            'LOCKED', 'INVALIDATED', 'DELIVERY_FAILED', 'DELIVERY_UNKNOWN'
        )),
    attempt_count SMALLINT NOT NULL DEFAULT 0
        CHECK (attempt_count BETWEEN 0 AND 5),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    issued_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    verified_at TIMESTAMPTZ,
    invalidated_at TIMESTAMPTZ,
    invalidation_reason VARCHAR(60),
    last_delivery_error_code VARCHAR(60),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (claim_id, account_id)
        REFERENCES public.withdrawal_claims (claim_id, account_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (account_id, worker_user_id)
        REFERENCES public.pension_accounts (account_id, user_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (initiated_by_user_id)
        REFERENCES public.users (user_id)
        ON DELETE RESTRICT,
    CHECK ((otp_hash IS NULL) = (otp_salt IS NULL)),
    CHECK (
        (status = 'DELIVERY_PENDING'
            AND otp_hash IS NOT NULL
            AND issued_at IS NULL AND expires_at IS NULL AND verified_at IS NULL)
        OR
        (status = 'ISSUED'
            AND otp_hash IS NOT NULL
            AND issued_at IS NOT NULL AND expires_at > issued_at AND verified_at IS NULL)
        OR
        (status = 'VERIFIED'
            AND otp_hash IS NULL
            AND issued_at IS NOT NULL AND expires_at > issued_at AND verified_at IS NOT NULL)
        OR
        (status NOT IN ('DELIVERY_PENDING', 'ISSUED', 'VERIFIED')
            AND otp_hash IS NULL AND verified_at IS NULL)
    ),
    UNIQUE (authorization_attempt_id, claim_id, worker_user_id)
);

CREATE UNIQUE INDEX uq_withdrawal_payout_otp_one_active_per_claim
    ON public.withdrawal_payout_otp_authorizations (claim_id)
    WHERE status IN ('DELIVERY_PENDING', 'ISSUED', 'VERIFIED');

CREATE INDEX idx_withdrawal_payout_otp_claim_history
    ON public.withdrawal_payout_otp_authorizations (claim_id, created_at DESC);

CREATE TABLE public.withdrawal_payout_otp_delivery_events (
    delivery_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    authorization_attempt_id UUID NOT NULL,
    claim_id VARCHAR(25) NOT NULL,
    worker_user_id VARCHAR(25) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    outcome VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (outcome IN ('PENDING', 'PROVIDER_ACCEPTED', 'FAILED', 'UNKNOWN')),
    provider_error_code VARCHAR(60),
    FOREIGN KEY (authorization_attempt_id, claim_id, worker_user_id)
        REFERENCES public.withdrawal_payout_otp_authorizations
            (authorization_attempt_id, claim_id, worker_user_id)
        ON DELETE RESTRICT
);

CREATE INDEX idx_withdrawal_payout_otp_delivery_rate_limit
    ON public.withdrawal_payout_otp_delivery_events
        (worker_user_id, claim_id, requested_at DESC);

CREATE OR REPLACE FUNCTION public.invalidate_withdrawal_payout_otp()
RETURNS TRIGGER AS $$
DECLARE
    affected_claim_id VARCHAR(25);
    affected_worker_user_id VARCHAR(25);
    invalidation_reason_value VARCHAR(60);
BEGIN
    IF TG_TABLE_NAME = 'withdrawal_claims' THEN
        affected_claim_id := NEW.claim_id;
        invalidation_reason_value := 'WITHDRAWAL_CHANGED';
    ELSIF TG_TABLE_NAME = 'users' THEN
        affected_worker_user_id := NEW.user_id;
        invalidation_reason_value := 'WORKER_CONTACT_OR_STATUS_CHANGED';
    ELSE
        affected_worker_user_id := NEW.user_id;
        invalidation_reason_value := 'PENSION_ACCOUNT_STATUS_CHANGED';
    END IF;

    WITH invalidated AS (
        UPDATE public.withdrawal_payout_otp_authorizations
        SET status = 'INVALIDATED',
            otp_hash = NULL,
            otp_salt = NULL,
            verified_at = NULL,
            invalidated_at = now(),
            invalidation_reason = invalidation_reason_value,
            updated_at = now()
        WHERE status IN ('DELIVERY_PENDING', 'ISSUED', 'VERIFIED')
          AND (affected_claim_id IS NULL OR claim_id = affected_claim_id)
          AND (affected_worker_user_id IS NULL OR worker_user_id = affected_worker_user_id)
        RETURNING authorization_attempt_id, claim_id
    )
    INSERT INTO public.audit_logs (user_id, action_type, entity_name, entity_id, details)
    SELECT NULL, 'UPDATE', 'WITHDRAWAL_PAYOUT_OTP', claim_id,
           jsonb_build_object(
               'event', 'OTP_INVALIDATED',
               'authorizationAttemptId', authorization_attempt_id,
               'reason', invalidation_reason_value
           )
    FROM invalidated;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_withdrawal_claims_invalidate_payout_otp
    AFTER UPDATE OF claim_status, amount_requested, destination_phone, account_id,
                    transaction_id, processed_at
    ON public.withdrawal_claims
    FOR EACH ROW
    WHEN (
        OLD.claim_status IS DISTINCT FROM NEW.claim_status
        OR OLD.amount_requested IS DISTINCT FROM NEW.amount_requested
        OR OLD.destination_phone IS DISTINCT FROM NEW.destination_phone
        OR OLD.account_id IS DISTINCT FROM NEW.account_id
        OR OLD.transaction_id IS DISTINCT FROM NEW.transaction_id
        OR OLD.processed_at IS DISTINCT FROM NEW.processed_at
    )
    EXECUTE FUNCTION public.invalidate_withdrawal_payout_otp();

CREATE TRIGGER trg_users_invalidate_payout_otp
    AFTER UPDATE OF phone, phone_verified_at, account_status, role
    ON public.users
    FOR EACH ROW
    WHEN (
        OLD.phone IS DISTINCT FROM NEW.phone
        OR OLD.phone_verified_at IS DISTINCT FROM NEW.phone_verified_at
        OR OLD.account_status IS DISTINCT FROM NEW.account_status
        OR OLD.role IS DISTINCT FROM NEW.role
    )
    EXECUTE FUNCTION public.invalidate_withdrawal_payout_otp();

CREATE TRIGGER trg_pension_accounts_invalidate_payout_otp
    AFTER UPDATE OF account_status
    ON public.pension_accounts
    FOR EACH ROW
    WHEN (OLD.account_status IS DISTINCT FROM NEW.account_status)
    EXECUTE FUNCTION public.invalidate_withdrawal_payout_otp();

COMMENT ON TABLE public.withdrawal_payout_otp_authorizations IS
    'Stores hashed, single-use OTP authorization state for approved withdrawal claims; it does not execute or settle payouts.';
COMMENT ON TABLE public.withdrawal_payout_otp_delivery_events IS
    'Auditable SMS delivery attempts used for idempotency and per-user/per-claim rate limits; never stores OTP values.';

COMMIT;
