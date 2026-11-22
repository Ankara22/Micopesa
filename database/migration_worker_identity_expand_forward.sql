BEGIN;

DO $$
DECLARE
    evidence_owner_invalid BOOLEAN;
    verifier_invalid BOOLEAN;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname = 'micopesa_national_id_evidence_owner'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
        WHERE rolname = 'micopesa_national_id_verifier'
    ) THEN
        RAISE EXCEPTION 'Pre-provision micopesa_national_id_evidence_owner and micopesa_national_id_verifier before worker identity expansion';
    END IF;

    SELECT rolsuper OR rolinherit OR rolcreaterole OR rolcreatedb OR rolcanlogin
           OR rolreplication OR rolbypassrls
      INTO evidence_owner_invalid
    FROM pg_catalog.pg_roles
    WHERE rolname = 'micopesa_national_id_evidence_owner';
    SELECT rolsuper OR rolinherit OR rolcreaterole OR rolcreatedb OR NOT rolcanlogin
           OR rolreplication OR rolbypassrls
      INTO verifier_invalid
    FROM pg_catalog.pg_roles
    WHERE rolname = 'micopesa_national_id_verifier';

    IF evidence_owner_invalid OR verifier_invalid THEN
        RAISE EXCEPTION 'National ID evidence owner must be NOLOGIN and verifier must be a non-privileged NOINHERIT login';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members
        WHERE roleid IN (
            'micopesa_national_id_evidence_owner'::regrole,
            'micopesa_national_id_verifier'::regrole
        )
           OR member IN (
            'micopesa_national_id_evidence_owner'::regrole,
            'micopesa_national_id_verifier'::regrole
        )
    ) THEN
        RAISE EXCEPTION 'National ID evidence owner and verifier must not have role memberships';
    END IF;
END;
$$;

GRANT USAGE, CREATE ON SCHEMA public TO micopesa_national_id_evidence_owner;
GRANT USAGE ON SCHEMA public TO micopesa_national_id_verifier;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS approval_status VARCHAR(15) NOT NULL DEFAULT 'APPROVED';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.users'::regclass
          AND conname = 'ck_users_approval_status'
    ) THEN
        ALTER TABLE public.users
            ADD CONSTRAINT ck_users_approval_status
            CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED'));
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_users_worker_approval_status
    ON public.users (approval_status, created_at)
    WHERE role = 'WORKER';

ALTER TABLE public.kyc_records
    ADD COLUMN IF NOT EXISTS national_id_ciphertext BYTEA,
    ADD COLUMN IF NOT EXISTS national_id_iv BYTEA,
    ADD COLUMN IF NOT EXISTS national_id_tag BYTEA,
    ADD COLUMN IF NOT EXISTS national_id_key_version VARCHAR(10),
    ADD COLUMN IF NOT EXISTS national_id_fingerprint VARCHAR(64),
    ADD COLUMN IF NOT EXISTS national_id_last_four CHAR(4);

ALTER TABLE public.pending_registrations
    ADD COLUMN IF NOT EXISTS national_id_ciphertext BYTEA,
    ADD COLUMN IF NOT EXISTS national_id_iv BYTEA,
    ADD COLUMN IF NOT EXISTS national_id_tag BYTEA,
    ADD COLUMN IF NOT EXISTS national_id_key_version VARCHAR(10),
    ADD COLUMN IF NOT EXISTS national_id_fingerprint VARCHAR(64),
    ADD COLUMN IF NOT EXISTS national_id_last_four CHAR(4);

UPDATE public.kyc_records
SET national_id_key_version = 'v1'
WHERE national_id_ciphertext IS NOT NULL
  AND national_id_key_version IS NULL;
UPDATE public.pending_registrations
SET national_id_key_version = 'v1'
WHERE national_id_ciphertext IS NOT NULL
  AND national_id_key_version IS NULL;

CREATE TABLE IF NOT EXISTS public.worker_registration_challenges (
    challenge_id UUID PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    phone VARCHAR(15) NOT NULL
        CHECK (phone ~ '^[+]254[17][0-9]{8}$'),
    email VARCHAR(254),
    occupation VARCHAR(50) NOT NULL,
    date_of_birth DATE NOT NULL,
    national_id_ciphertext BYTEA NOT NULL,
    national_id_iv BYTEA NOT NULL
        CHECK (octet_length(national_id_iv) = 12),
    national_id_tag BYTEA NOT NULL
        CHECK (octet_length(national_id_tag) = 16),
    national_id_key_version VARCHAR(10) NOT NULL DEFAULT 'v1'
        CHECK (national_id_key_version = 'v1'),
    national_id_fingerprint VARCHAR(64) NOT NULL
        CHECK (national_id_fingerprint ~ '^[0-9a-f]{64}$'),
    national_id_last_four CHAR(4) NOT NULL
        CHECK (national_id_last_four ~ '^[0-9]{4}$'),
    code_hash BYTEA,
    code_salt BYTEA,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    send_count INTEGER NOT NULL DEFAULT 0
        CHECK (send_count BETWEEN 0 AND 3),
    window_started_at TIMESTAMP WITH TIME ZONE,
    last_sent_at TIMESTAMP WITH TIME ZONE,
    attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count BETWEEN 0 AND 5),
    attempt_window_started_at TIMESTAMP WITH TIME ZONE,
    locked_until TIMESTAMP WITH TIME ZONE,
    challenge_status VARCHAR(15) NOT NULL DEFAULT 'PENDING'
        CHECK (challenge_status IN ('PENDING', 'CONSUMED', 'CANCELLED')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT ck_worker_registration_challenge_code CHECK (
        (code_hash IS NULL AND code_salt IS NULL)
        OR
        (code_hash IS NOT NULL AND code_salt IS NOT NULL
            AND octet_length(code_hash) = 32 AND octet_length(code_salt) = 16)
    )
);

CREATE INDEX IF NOT EXISTS idx_worker_registration_challenges_expiry
    ON public.worker_registration_challenges (expires_at)
    WHERE challenge_status = 'PENDING';

CREATE TABLE IF NOT EXISTS public.worker_password_reset_challenges (
    challenge_id UUID PRIMARY KEY,
    user_id VARCHAR(25) NOT NULL
        REFERENCES public.users (user_id) ON DELETE CASCADE,
    code_hash BYTEA NOT NULL
        CHECK (octet_length(code_hash) = 32),
    code_salt BYTEA NOT NULL
        CHECK (octet_length(code_salt) = 16),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    send_count INTEGER NOT NULL DEFAULT 1
        CHECK (send_count BETWEEN 1 AND 3),
    window_started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    last_sent_at TIMESTAMP WITH TIME ZONE NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count BETWEEN 0 AND 5),
    attempt_window_started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    locked_until TIMESTAMP WITH TIME ZONE,
    challenge_status VARCHAR(15) NOT NULL DEFAULT 'PENDING'
        CHECK (challenge_status IN ('PENDING', 'CONSUMED', 'CANCELLED')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_worker_password_reset_pending_user
    ON public.worker_password_reset_challenges (user_id)
    WHERE challenge_status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_worker_password_reset_expiry
    ON public.worker_password_reset_challenges (expires_at)
    WHERE challenge_status = 'PENDING';

CREATE TABLE IF NOT EXISTS public.worker_national_id_claims (
    national_id_fingerprint VARCHAR(64) PRIMARY KEY
        CHECK (national_id_fingerprint ~ '^[0-9a-f]{64}$'),
    claim_status VARCHAR(20) NOT NULL
        CHECK (claim_status IN ('RESERVED', 'CLAIMED', 'LEGACY_CONFLICT')),
    user_id VARCHAR(25)
        REFERENCES public.users (user_id) ON DELETE CASCADE,
    registration_challenge_id UUID
        REFERENCES public.worker_registration_challenges (challenge_id) ON DELETE CASCADE,
    pending_registration_id VARCHAR(25)
        REFERENCES public.pending_registrations (pending_registration_id) ON DELETE CASCADE,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT ck_worker_national_id_claim_state CHECK (
        (claim_status = 'CLAIMED'
            AND user_id IS NOT NULL
            AND registration_challenge_id IS NULL
            AND pending_registration_id IS NULL
            AND expires_at IS NULL)
        OR
        (claim_status = 'RESERVED'
            AND user_id IS NULL
            AND num_nonnulls(registration_challenge_id, pending_registration_id) = 1
            AND expires_at IS NOT NULL)
        OR
        (claim_status = 'LEGACY_CONFLICT'
            AND user_id IS NULL
            AND registration_challenge_id IS NULL
            AND pending_registration_id IS NULL
            AND expires_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_worker_national_id_claims_expiry
    ON public.worker_national_id_claims (expires_at)
    WHERE claim_status = 'RESERVED';

CREATE TABLE IF NOT EXISTS public.worker_national_id_verification_evidence (
    source_table VARCHAR(30) NOT NULL
        CHECK (source_table IN ('kyc_records', 'pending_registrations')),
    source_record_id VARCHAR(25) NOT NULL,
    national_id_fingerprint VARCHAR(64) NOT NULL
        CHECK (national_id_fingerprint ~ '^[0-9a-f]{64}$'),
    national_id_ciphertext BYTEA NOT NULL,
    national_id_iv BYTEA NOT NULL CHECK (octet_length(national_id_iv) = 12),
    national_id_tag BYTEA NOT NULL CHECK (octet_length(national_id_tag) = 16),
    national_id_key_version VARCHAR(10) NOT NULL
        CHECK (national_id_key_version = 'v1'),
    national_id_last_four CHAR(4) NOT NULL
        CHECK (national_id_last_four ~ '^[0-9]{4}$'),
    verified_plaintext_fingerprint VARCHAR(64) NOT NULL
        CHECK (verified_plaintext_fingerprint ~ '^[0-9a-f]{64}$'),
    plaintext_matched BOOLEAN NOT NULL CHECK (plaintext_matched IS TRUE),
    verified_by TEXT NOT NULL,
    verified_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    PRIMARY KEY (source_table, source_record_id)
);

CREATE OR REPLACE FUNCTION public.guard_worker_national_id_verification_evidence()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'National ID verification evidence is immutable';
    END IF;
    IF session_user <> 'micopesa_national_id_verifier' THEN
        RAISE EXCEPTION 'National ID verification evidence requires the verifier role';
    END IF;
    NEW.verified_by := session_user;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_worker_national_id_verification_evidence_guard
    ON public.worker_national_id_verification_evidence;
CREATE TRIGGER trg_worker_national_id_verification_evidence_guard
    BEFORE INSERT OR UPDATE OR DELETE
    ON public.worker_national_id_verification_evidence
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_worker_national_id_verification_evidence();

ALTER TABLE public.worker_national_id_verification_evidence
    OWNER TO micopesa_national_id_evidence_owner;
ALTER FUNCTION public.guard_worker_national_id_verification_evidence()
    OWNER TO micopesa_national_id_evidence_owner;
REVOKE CREATE ON SCHEMA public FROM micopesa_national_id_evidence_owner;

REVOKE ALL ON TABLE public.worker_national_id_verification_evidence FROM PUBLIC;
REVOKE ALL ON TABLE public.worker_national_id_verification_evidence
    FROM micopesa_national_id_verifier;
REVOKE ALL ON FUNCTION public.guard_worker_national_id_verification_evidence() FROM PUBLIC;
GRANT SELECT (
    source_table, source_record_id, national_id_fingerprint,
    national_id_ciphertext, national_id_iv, national_id_tag,
    national_id_key_version, national_id_last_four,
    verified_plaintext_fingerprint, plaintext_matched, verified_by
) ON TABLE public.worker_national_id_verification_evidence
    TO micopesa_national_id_verifier;
GRANT INSERT (
    source_table, source_record_id, national_id_fingerprint,
    national_id_ciphertext, national_id_iv, national_id_tag,
    national_id_key_version, national_id_last_four,
    verified_plaintext_fingerprint, plaintext_matched
) ON TABLE public.worker_national_id_verification_evidence
    TO micopesa_national_id_verifier;

GRANT SELECT (
    kyc_id, user_id, national_id, national_id_ciphertext, national_id_iv,
    national_id_tag, national_id_key_version, national_id_fingerprint,
    national_id_last_four
) ON TABLE public.kyc_records TO micopesa_national_id_verifier;
GRANT UPDATE (
    national_id_ciphertext, national_id_iv, national_id_tag,
    national_id_key_version, national_id_fingerprint, national_id_last_four
) ON TABLE public.kyc_records TO micopesa_national_id_verifier;
GRANT SELECT (
    pending_registration_id, national_id, national_id_ciphertext,
    national_id_iv, national_id_tag, national_id_key_version,
    national_id_fingerprint, national_id_last_four, expires_at
) ON TABLE public.pending_registrations TO micopesa_national_id_verifier;
GRANT UPDATE (
    national_id_ciphertext, national_id_iv, national_id_tag,
    national_id_key_version, national_id_fingerprint, national_id_last_four
) ON TABLE public.pending_registrations TO micopesa_national_id_verifier;
GRANT SELECT (
    national_id_fingerprint, claim_status, user_id,
    pending_registration_id, expires_at
) ON TABLE public.worker_national_id_claims TO micopesa_national_id_verifier;
GRANT INSERT (
    national_id_fingerprint, claim_status, user_id,
    pending_registration_id, expires_at
) ON TABLE public.worker_national_id_claims TO micopesa_national_id_verifier;

CREATE TABLE IF NOT EXISTS public.worker_approval_reviews (
    review_id BIGSERIAL PRIMARY KEY,
    worker_user_id VARCHAR(25) NOT NULL
        REFERENCES public.users (user_id) ON DELETE RESTRICT,
    reviewed_by_user_id VARCHAR(25)
        REFERENCES public.users (user_id) ON DELETE SET NULL,
    previous_status VARCHAR(15) NOT NULL
        CHECK (previous_status IN ('PENDING', 'APPROVED', 'REJECTED')),
    decision VARCHAR(15) NOT NULL
        CHECK (decision IN ('APPROVED', 'REJECTED')),
    reason VARCHAR(500) NOT NULL
        CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_worker_approval_reviews_worker_created
    ON public.worker_approval_reviews (worker_user_id, created_at DESC, review_id DESC);

ALTER TABLE public.auth_rate_limits
    DROP CONSTRAINT IF EXISTS auth_rate_limits_scope_check;
ALTER TABLE public.auth_rate_limits
    ADD CONSTRAINT auth_rate_limits_scope_check
    CHECK (scope IN ('IP', 'EMAIL', 'ACCOUNT', 'PHONE'));

ALTER TABLE public.audit_logs
    DROP CONSTRAINT IF EXISTS audit_logs_action_type_check;
ALTER TABLE public.audit_logs
    ADD CONSTRAINT audit_logs_action_type_check
    CHECK (action_type IN (
        'CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'APPROVE', 'REJECT',
        'SUBMIT', 'RESUBMIT', 'REQUEST_REVISION', 'VIEW'
    ));

COMMIT;
