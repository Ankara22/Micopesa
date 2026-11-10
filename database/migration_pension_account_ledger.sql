BEGIN;

-- Deployment must freeze and drain every legacy financial writer before this
-- migration starts. This lock only protects the snapshot while this transaction
-- is open; it does not replace the deployment freeze after commit.
LOCK TABLE pension_accounts IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE pension_accounts
    ADD CONSTRAINT uq_pension_accounts_id_user UNIQUE (account_id, user_id);

ALTER TABLE mpesa_payment_attempts
    ADD COLUMN provider_mode VARCHAR(20);

ALTER TABLE mpesa_payment_verifications
    ADD COLUMN provider_mode VARCHAR(20);

ALTER TABLE mpesa_payment_verifications
    ADD COLUMN simulator_outcome VARCHAR(10);

ALTER TABLE mpesa_payment_attempts
    ADD CONSTRAINT chk_mpesa_attempt_provider_mode
        CHECK (provider_mode IS NULL OR provider_mode IN ('DARAJA', 'SIMULATOR'));

ALTER TABLE mpesa_payment_verifications
    ADD CONSTRAINT chk_mpesa_verification_provider_mode
        CHECK (provider_mode IS NULL OR provider_mode IN ('DARAJA', 'SIMULATOR')),
    ADD CONSTRAINT chk_mpesa_verification_simulator_outcome
        CHECK (simulator_outcome IS NULL OR simulator_outcome IN (
            'SUCCESS', 'PENDING', 'FAILED', 'UNKNOWN'
        )),
    ADD CONSTRAINT uq_mpesa_verification_attempt_provider
        UNIQUE (verification_id, attempt_id, provider_mode),
    ADD CONSTRAINT uq_mpesa_verification_attempt
        UNIQUE (verification_id, attempt_id);

ALTER TABLE mpesa_payment_attempts
    ADD CONSTRAINT uq_mpesa_attempt_source_provider
        UNIQUE (attempt_id, account_id, contribution_id, transaction_id, provider_mode);

ALTER TABLE mpesa_callback_inbox
    ADD CONSTRAINT uq_mpesa_callback_attempt_verification
        UNIQUE (callback_id, attempt_id, verification_id),
    ADD CONSTRAINT fk_mpesa_callback_verification_same_attempt
        FOREIGN KEY (verification_id, attempt_id)
        REFERENCES mpesa_payment_verifications (verification_id, attempt_id)
        ON DELETE RESTRICT;

ALTER TABLE withdrawal_claims
    ADD CONSTRAINT uq_withdrawal_claim_account
        UNIQUE (claim_id, account_id),
    ADD CONSTRAINT uq_withdrawal_claim_account_transaction
        UNIQUE (claim_id, account_id, transaction_id);

CREATE TABLE pension_ledger (
    singleton_key BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton_key),
    ledger_id UUID NOT NULL UNIQUE,
    status VARCHAR(15) NOT NULL
        CHECK (status IN ('PREPARING', 'ACTIVE', 'CLOSED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    CHECK (
        (status = 'PREPARING' AND activated_at IS NULL AND closed_at IS NULL)
        OR (status = 'ACTIVE' AND activated_at IS NOT NULL AND closed_at IS NULL)
        OR (status = 'CLOSED' AND closed_at IS NOT NULL)
    ),
    UNIQUE (ledger_id, singleton_key)
);

CREATE TABLE pension_ledger_cutover_batches (
    batch_id UUID PRIMARY KEY,
    ledger_id UUID NOT NULL,
    singleton_key BOOLEAN NOT NULL DEFAULT TRUE CHECK (singleton_key),
    batch_type VARCHAR(24) NOT NULL
        CHECK (batch_type IN ('INITIAL_CUTOVER', 'ACCOUNT_OPENING')),
    account_id VARCHAR(25),
    captured_at TIMESTAMPTZ NOT NULL,
    provenance TEXT NOT NULL CHECK (length(trim(provenance)) > 0),
    migration_actor TEXT NOT NULL CHECK (length(trim(migration_actor)) > 0),
    FOREIGN KEY (ledger_id, singleton_key)
        REFERENCES pension_ledger (ledger_id, singleton_key) ON DELETE RESTRICT,
    FOREIGN KEY (account_id)
        REFERENCES pension_accounts (account_id) ON DELETE RESTRICT,
    CHECK (
        (batch_type = 'INITIAL_CUTOVER' AND account_id IS NULL)
        OR (batch_type = 'ACCOUNT_OPENING' AND account_id IS NOT NULL)
    ),
    UNIQUE (batch_id, ledger_id),
    UNIQUE (batch_id, ledger_id, batch_type, account_id)
);

CREATE UNIQUE INDEX uq_pension_ledger_initial_cutover_batch
    ON pension_ledger_cutover_batches (ledger_id)
    WHERE batch_type = 'INITIAL_CUTOVER';

CREATE UNIQUE INDEX uq_pension_ledger_account_opening_batch
    ON pension_ledger_cutover_batches (ledger_id, account_id)
    WHERE batch_type = 'ACCOUNT_OPENING';

CREATE TABLE simulator_payment_confirmations (
    confirmation_id UUID PRIMARY KEY,
    attempt_id VARCHAR(25) NOT NULL,
    verification_id BIGINT NOT NULL,
    provider_mode VARCHAR(20) NOT NULL DEFAULT 'SIMULATOR'
        CHECK (provider_mode = 'SIMULATOR'),
    outcome VARCHAR(10) NOT NULL
        CHECK (outcome IN ('SUCCESS', 'PENDING', 'FAILED', 'UNKNOWN')),
    synthetic_reference VARCHAR(100) NOT NULL UNIQUE
        CHECK (synthetic_reference ~ '^SIM[A-F0-9]{22}$'),
    confirmed_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (outcome = 'SUCCESS')
        OR (outcome IN ('PENDING', 'FAILED', 'UNKNOWN'))
    ),
    FOREIGN KEY (verification_id, attempt_id, provider_mode)
        REFERENCES mpesa_payment_verifications
            (verification_id, attempt_id, provider_mode)
        ON DELETE RESTRICT,
    UNIQUE (confirmation_id, attempt_id, verification_id, provider_mode),
    UNIQUE (verification_id)
);

CREATE TABLE pension_adjustment_requests (
    request_id UUID PRIMARY KEY,
    account_id VARCHAR(25) NOT NULL
        REFERENCES pension_accounts (account_id) ON DELETE RESTRICT,
    amount NUMERIC(12,2) NOT NULL CHECK (amount <> 0),
    currency CHAR(3) NOT NULL DEFAULT 'KES' CHECK (currency = 'KES'),
    requester_user_id VARCHAR(25) NOT NULL,
    requester_name_snapshot VARCHAR(100) NOT NULL,
    requester_role_snapshot VARCHAR(20) NOT NULL,
    approver_user_id VARCHAR(25),
    approver_name_snapshot VARCHAR(100),
    approver_role_snapshot VARCHAR(20),
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    authorization_reference TEXT NOT NULL
        CHECK (length(trim(authorization_reference)) > 0),
    status VARCHAR(10) NOT NULL DEFAULT 'REQUESTED'
        CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ,
    CHECK (approver_user_id IS NULL OR approver_user_id <> requester_user_id),
    CHECK (
        (status = 'REQUESTED' AND approver_user_id IS NULL
            AND approver_name_snapshot IS NULL
            AND approver_role_snapshot IS NULL AND decided_at IS NULL)
        OR
        (status IN ('APPROVED', 'REJECTED') AND approver_user_id IS NOT NULL
            AND approver_name_snapshot IS NOT NULL
            AND approver_role_snapshot IS NOT NULL AND decided_at IS NOT NULL)
    ),
    UNIQUE (request_id, account_id, amount, currency)
);

CREATE TABLE pension_adjustment_decision_audit (
    request_id UUID PRIMARY KEY
        REFERENCES pension_adjustment_requests (request_id) ON DELETE RESTRICT,
    decision VARCHAR(10) NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
    actor_user_id VARCHAR(25) NOT NULL,
    actor_name_snapshot VARCHAR(100) NOT NULL,
    actor_role_snapshot VARCHAR(20) NOT NULL,
    authorization_reference TEXT NOT NULL
        CHECK (length(trim(authorization_reference)) > 0),
    decided_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE withdrawal_otp_authorizations (
    authorization_id UUID PRIMARY KEY,
    challenge_id UUID NOT NULL UNIQUE,
    claim_id VARCHAR(25) NOT NULL,
    account_id VARCHAR(25) NOT NULL,
    worker_user_id VARCHAR(25) NOT NULL,
    worker_name_snapshot VARCHAR(100) NOT NULL,
    destination_phone_snapshot VARCHAR(15) NOT NULL,
    destination_verified_at TIMESTAMPTZ NOT NULL,
    challenge_reference VARCHAR(100) NOT NULL UNIQUE,
    issued_at TIMESTAMPTZ NOT NULL,
    verified_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(10) NOT NULL
        CHECK (status IN ('ISSUED', 'VERIFIED', 'CONSUMED', 'EXPIRED', 'FAILED')),
    consumed_by_payout_attempt_id VARCHAR(25),
    FOREIGN KEY (claim_id, account_id)
        REFERENCES withdrawal_claims (claim_id, account_id) ON DELETE RESTRICT,
    FOREIGN KEY (account_id, worker_user_id)
        REFERENCES pension_accounts (account_id, user_id) ON DELETE RESTRICT,
    CHECK (expires_at > issued_at),
    CHECK (
        (status IN ('ISSUED', 'FAILED', 'EXPIRED')
            AND verified_at IS NULL AND consumed_by_payout_attempt_id IS NULL)
        OR
        (status = 'VERIFIED'
            AND verified_at IS NOT NULL AND consumed_by_payout_attempt_id IS NULL)
        OR
        (status = 'CONSUMED'
            AND verified_at IS NOT NULL AND consumed_by_payout_attempt_id IS NOT NULL)
    ),
    UNIQUE (authorization_id, claim_id, account_id),
    UNIQUE (authorization_id, claim_id, account_id, consumed_by_payout_attempt_id)
);

CREATE TABLE withdrawal_payout_attempts (
    payout_attempt_id VARCHAR(25) PRIMARY KEY DEFAULT generate_short_id(),
    claim_id VARCHAR(25) NOT NULL,
    account_id VARCHAR(25) NOT NULL,
    transaction_id VARCHAR(25) NOT NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    currency CHAR(3) NOT NULL DEFAULT 'KES' CHECK (currency = 'KES'),
    provider_mode VARCHAR(20) NOT NULL CHECK (provider_mode IN ('DARAJA', 'SIMULATOR')),
    destination_phone_snapshot VARCHAR(15) NOT NULL,
    destination_verified_at TIMESTAMPTZ NOT NULL,
    authorization_id UUID NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    provider_reference VARCHAR(100),
    outcome VARCHAR(10) NOT NULL DEFAULT 'PENDING'
        CHECK (outcome IN ('PENDING', 'FAILED', 'UNKNOWN', 'SUCCEEDED')),
    retry_decision_id UUID,
    retry_of_attempt_id VARCHAR(25),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (claim_id, account_id, transaction_id)
        REFERENCES withdrawal_claims (claim_id, account_id, transaction_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (authorization_id, claim_id, account_id)
        REFERENCES withdrawal_otp_authorizations (authorization_id, claim_id, account_id)
        ON DELETE RESTRICT,
    CHECK (
        (retry_decision_id IS NULL AND retry_of_attempt_id IS NULL)
        OR (retry_decision_id IS NOT NULL AND retry_of_attempt_id IS NOT NULL)
    ),
    UNIQUE (payout_attempt_id, claim_id, account_id, transaction_id, provider_mode),
    UNIQUE (payout_attempt_id, authorization_id, claim_id, account_id),
    UNIQUE (payout_attempt_id, claim_id, account_id)
);

CREATE TABLE withdrawal_payout_retry_decisions (
    retry_decision_id UUID PRIMARY KEY,
    prior_payout_attempt_id VARCHAR(25) NOT NULL UNIQUE,
    claim_id VARCHAR(25) NOT NULL,
    account_id VARCHAR(25) NOT NULL,
    authorized_by_user_id VARCHAR(25) NOT NULL,
    authorized_by_name_snapshot VARCHAR(100) NOT NULL,
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    authorized_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (prior_payout_attempt_id, claim_id, account_id)
        REFERENCES withdrawal_payout_attempts
            (payout_attempt_id, claim_id, account_id)
        ON DELETE RESTRICT,
    UNIQUE (retry_decision_id, prior_payout_attempt_id, claim_id, account_id)
);

ALTER TABLE withdrawal_payout_attempts
    ADD CONSTRAINT fk_payout_attempt_retry_decision
        FOREIGN KEY (retry_decision_id, retry_of_attempt_id, claim_id, account_id)
        REFERENCES withdrawal_payout_retry_decisions
            (retry_decision_id, prior_payout_attempt_id, claim_id, account_id)
        ON DELETE RESTRICT;

ALTER TABLE withdrawal_otp_authorizations
    ADD CONSTRAINT fk_otp_consumed_by_matching_payout
        FOREIGN KEY (
            consumed_by_payout_attempt_id, authorization_id, claim_id, account_id
        )
        REFERENCES withdrawal_payout_attempts (
            payout_attempt_id, authorization_id, claim_id, account_id
        )
        ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX uq_payout_provider_reference
    ON withdrawal_payout_attempts (provider_mode, provider_reference)
    WHERE provider_reference IS NOT NULL;

CREATE UNIQUE INDEX uq_one_successful_payout_per_claim
    ON withdrawal_payout_attempts (claim_id)
    WHERE outcome = 'SUCCEEDED';

CREATE UNIQUE INDEX uq_one_active_payout_per_claim
    ON withdrawal_payout_attempts (claim_id)
    WHERE outcome IN ('PENDING', 'UNKNOWN');
CREATE UNIQUE INDEX uq_payout_retry_decision_single_use
    ON withdrawal_payout_attempts (retry_decision_id)
    WHERE retry_decision_id IS NOT NULL;
CREATE INDEX idx_payout_attempts_claim_created
    ON withdrawal_payout_attempts (claim_id, created_at DESC);

CREATE TABLE withdrawal_payout_verifications (
    payout_verification_id VARCHAR(25) PRIMARY KEY DEFAULT generate_short_id(),
    payout_attempt_id VARCHAR(25) NOT NULL
        REFERENCES withdrawal_payout_attempts (payout_attempt_id) ON DELETE RESTRICT,
    provider_mode VARCHAR(20) NOT NULL CHECK (provider_mode IN ('DARAJA', 'SIMULATOR')),
    verification_status VARCHAR(20) NOT NULL
        CHECK (verification_status IN (
            'PROCESSING', 'UNVERIFIED', 'VERIFIED_SUCCESS', 'VERIFIED_FAILURE'
        )),
    amount_matches BOOLEAN,
    destination_matches BOOLEAN,
    provider_result_code VARCHAR(30),
    provider_reference VARCHAR(100),
    verified_at TIMESTAMPTZ,
    UNIQUE (payout_verification_id, payout_attempt_id, provider_mode),
    UNIQUE (payout_verification_id, payout_attempt_id)
);

CREATE UNIQUE INDEX uq_payout_verification_provider_reference
    ON withdrawal_payout_verifications (provider_mode, provider_reference)
    WHERE provider_reference IS NOT NULL;
CREATE INDEX idx_payout_verifications_attempt
    ON withdrawal_payout_verifications (payout_attempt_id, verified_at DESC);

CREATE TABLE withdrawal_payout_callbacks (
    payout_callback_id VARCHAR(25) PRIMARY KEY DEFAULT generate_short_id(),
    callback_fingerprint CHAR(64) NOT NULL UNIQUE,
    payout_attempt_id VARCHAR(25) NOT NULL,
    payout_verification_id VARCHAR(25) NOT NULL,
    provider_mode VARCHAR(20) NOT NULL CHECK (provider_mode IN ('DARAJA', 'SIMULATOR')),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (payout_verification_id, payout_attempt_id, provider_mode)
        REFERENCES withdrawal_payout_verifications
            (payout_verification_id, payout_attempt_id, provider_mode)
        ON DELETE RESTRICT,
    UNIQUE (payout_callback_id, payout_attempt_id, payout_verification_id)
);
CREATE INDEX idx_payout_callbacks_attempt
    ON withdrawal_payout_callbacks (payout_attempt_id, received_at DESC);

CREATE TABLE withdrawal_payout_return_evidence (
    return_evidence_id UUID PRIMARY KEY,
    payout_attempt_id VARCHAR(25) NOT NULL
        REFERENCES withdrawal_payout_attempts (payout_attempt_id) ON DELETE RESTRICT,
    provider_mode VARCHAR(20) NOT NULL CHECK (provider_mode = 'DARAJA'),
    provider_reference VARCHAR(100) NOT NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    verified_at TIMESTAMPTZ NOT NULL,
    UNIQUE (provider_mode, provider_reference),
    UNIQUE (return_evidence_id, payout_attempt_id, amount)
);

CREATE OR REPLACE FUNCTION pension_ledger_future_payout_disabled()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Withdrawal payout workflows are disabled pending a separately reviewed implementation';
END;
$$;

CREATE OR REPLACE FUNCTION pension_ledger_guard_payout_retry_decision()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE prior_row withdrawal_payout_attempts%ROWTYPE;
        approver_row users%ROWTYPE;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Payout retry decisions are append-only';
    END IF;
    SELECT * INTO prior_row FROM withdrawal_payout_attempts
    WHERE payout_attempt_id = NEW.prior_payout_attempt_id
    FOR UPDATE;
    IF NOT FOUND OR prior_row.outcome <> 'FAILED'
       OR prior_row.claim_id <> NEW.claim_id
       OR prior_row.account_id <> NEW.account_id THEN
        RAISE EXCEPTION 'Retry authorization requires the matching definitive failed payout';
    END IF;
    SELECT * INTO approver_row FROM users
    WHERE user_id = NEW.authorized_by_user_id;
    IF NOT FOUND OR approver_row.role <> 'ADMIN'
       OR approver_row.full_name <> NEW.authorized_by_name_snapshot THEN
        RAISE EXCEPTION 'Payout retry authorization requires an administrator';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payout_retry_decision_guard
    BEFORE INSERT OR UPDATE OR DELETE ON withdrawal_payout_retry_decisions
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_guard_payout_retry_decision();

CREATE OR REPLACE FUNCTION pension_ledger_guard_otp_authorization()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'OTP authorization evidence cannot be deleted';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'ISSUED' OR NEW.verified_at IS NOT NULL
           OR NEW.consumed_by_payout_attempt_id IS NOT NULL THEN
            RAISE EXCEPTION 'OTP authorizations must begin in ISSUED state';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
       OR NEW.challenge_id IS DISTINCT FROM OLD.challenge_id
       OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.worker_user_id IS DISTINCT FROM OLD.worker_user_id
       OR NEW.worker_name_snapshot IS DISTINCT FROM OLD.worker_name_snapshot
       OR NEW.destination_phone_snapshot IS DISTINCT FROM OLD.destination_phone_snapshot
       OR NEW.destination_verified_at IS DISTINCT FROM OLD.destination_verified_at
       OR NEW.challenge_reference IS DISTINCT FROM OLD.challenge_reference
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'OTP authorization identity and destination are immutable';
    END IF;
    IF OLD.status <> 'ISSUED' AND
       NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
        RAISE EXCEPTION 'OTP verification timestamp is immutable once verified';
    END IF;
    IF OLD.status = 'ISSUED' AND NEW.status <> 'VERIFIED'
       AND NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
        RAISE EXCEPTION 'Unverified OTP authorization cannot set a verification timestamp';
    END IF;
    IF OLD.consumed_by_payout_attempt_id IS NOT NULL
       AND NEW.consumed_by_payout_attempt_id
           IS DISTINCT FROM OLD.consumed_by_payout_attempt_id THEN
        RAISE EXCEPTION 'OTP consumption attribution is immutable';
    END IF;
    IF OLD.status IN ('CONSUMED', 'FAILED', 'EXPIRED') THEN
        RAISE EXCEPTION 'Final OTP authorization cannot be reused or changed';
    END IF;
    IF OLD.status = 'ISSUED' AND NEW.status NOT IN ('VERIFIED', 'FAILED', 'EXPIRED') THEN
        RAISE EXCEPTION 'Invalid OTP authorization transition';
    END IF;
    IF OLD.status = 'VERIFIED' AND NEW.status NOT IN ('CONSUMED', 'EXPIRED') THEN
        RAISE EXCEPTION 'Invalid OTP authorization transition';
    END IF;
    IF NEW.status = 'VERIFIED'
       AND (NEW.verified_at IS NULL OR NEW.verified_at >= NEW.expires_at
            OR NEW.verified_at > now()) THEN
        RAISE EXCEPTION 'OTP verification must occur before expiry';
    END IF;
    IF NEW.status = 'CONSUMED'
       AND (NEW.consumed_by_payout_attempt_id IS NULL OR NEW.verified_at >= NEW.expires_at) THEN
        RAISE EXCEPTION 'Expired OTP authorization cannot be consumed';
    END IF;
    IF NEW.status = 'EXPIRED' AND now() < NEW.expires_at THEN
        RAISE EXCEPTION 'OTP authorization cannot expire before its expiration timestamp';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_otp_authorization_guard
    BEFORE INSERT OR UPDATE OR DELETE ON withdrawal_otp_authorizations
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_guard_otp_authorization();

CREATE OR REPLACE FUNCTION pension_ledger_guard_payout_attempt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE claim_row withdrawal_claims%ROWTYPE;
        otp_row withdrawal_otp_authorizations%ROWTYPE;
        worker_phone VARCHAR(15);
        prior_row withdrawal_payout_attempts%ROWTYPE;
        prior_count BIGINT;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.payout_attempt_id IS DISTINCT FROM OLD.payout_attempt_id
           OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
           OR NEW.account_id IS DISTINCT FROM OLD.account_id
           OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
           OR NEW.amount IS DISTINCT FROM OLD.amount
           OR NEW.provider_mode IS DISTINCT FROM OLD.provider_mode
           OR NEW.destination_phone_snapshot IS DISTINCT FROM OLD.destination_phone_snapshot
           OR NEW.destination_verified_at IS DISTINCT FROM OLD.destination_verified_at
           OR NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
           OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
           OR NEW.retry_decision_id IS DISTINCT FROM OLD.retry_decision_id
           OR NEW.retry_of_attempt_id IS DISTINCT FROM OLD.retry_of_attempt_id THEN
            RAISE EXCEPTION 'Payout attempt source and authorization are immutable';
        END IF;
        IF OLD.outcome IN ('FAILED', 'SUCCEEDED') THEN
            RAISE EXCEPTION 'Terminal payout outcome is immutable';
        END IF;
        IF OLD.provider_reference IS NOT NULL
           AND NEW.provider_reference IS DISTINCT FROM OLD.provider_reference THEN
            RAISE EXCEPTION 'Payout provider reference is immutable once recorded';
        END IF;
        IF OLD.provider_reference IS NULL AND NEW.provider_reference IS NOT NULL
           AND NOT EXISTS (
               SELECT 1 FROM withdrawal_payout_verifications v
               WHERE v.payout_attempt_id = NEW.payout_attempt_id
                 AND v.provider_mode = NEW.provider_mode
                 AND v.provider_reference = NEW.provider_reference
                 AND v.verification_status IN (
                     'VERIFIED_FAILURE', 'VERIFIED_SUCCESS'
                 )
           ) THEN
            RAISE EXCEPTION 'Payout provider reference requires matching verification evidence';
        END IF;
        IF (OLD.outcome = 'PENDING' AND NEW.outcome NOT IN ('UNKNOWN', 'FAILED'))
           OR (OLD.outcome = 'UNKNOWN' AND NEW.outcome <> 'FAILED') THEN
            RAISE EXCEPTION 'Invalid payout outcome transition';
        END IF;
        IF NEW.outcome = 'SUCCEEDED' THEN
            RAISE EXCEPTION 'Payout settlement is disabled pending reviewed implementation';
        END IF;
        IF NEW.outcome = 'FAILED' THEN
            PERFORM 1 FROM withdrawal_payout_verifications v
            WHERE v.payout_attempt_id = NEW.payout_attempt_id
              AND v.provider_mode = NEW.provider_mode
              AND v.verification_status = 'VERIFIED_FAILURE'
              AND v.amount_matches IS TRUE
              AND v.destination_matches IS TRUE
              AND v.provider_result_code IS NOT NULL
              AND v.verified_at IS NOT NULL
              AND v.verified_at <= now();
            IF NOT FOUND THEN
                RAISE EXCEPTION 'Failed payout requires independently verified definitive failure evidence';
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.outcome <> 'PENDING' THEN
        RAISE EXCEPTION 'Payout attempts must begin in PENDING status';
    END IF;
    IF NEW.provider_reference IS NOT NULL THEN
        RAISE EXCEPTION 'Payout provider reference cannot be client-supplied at creation';
    END IF;
    PERFORM 1 FROM pension_accounts
    WHERE account_id = NEW.account_id FOR UPDATE;
    SELECT * INTO claim_row FROM withdrawal_claims
    WHERE claim_id = NEW.claim_id AND account_id = NEW.account_id
    FOR UPDATE;
    IF NOT FOUND OR claim_row.claim_status <> 'APPROVED'
       OR claim_row.transaction_id IS DISTINCT FROM NEW.transaction_id
       OR claim_row.amount_requested <> NEW.amount THEN
        RAISE EXCEPTION 'Payout attempt requires the matching approved claim';
    END IF;
    IF NEW.provider_mode <> 'DARAJA' THEN
        RAISE EXCEPTION 'Simulated payout is disabled pending separate evidence design';
    END IF;
    SELECT u.phone INTO worker_phone
    FROM pension_accounts p JOIN users u ON u.user_id = p.user_id
    WHERE p.account_id = NEW.account_id AND p.user_id = (
        SELECT worker_user_id FROM withdrawal_otp_authorizations
        WHERE authorization_id = NEW.authorization_id
    )
      AND u.phone_verified_at IS NOT NULL
    FOR SHARE OF p, u;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payout destination has no verified worker profile';
    END IF;
    IF worker_phone ~ '^0[17][0-9]{8}$' THEN
        worker_phone := '254' || substr(worker_phone, 2);
    ELSIF worker_phone ~ '^\\+?254[17][0-9]{8}$' THEN
        worker_phone := regexp_replace(worker_phone, '^\\+', '');
    ELSE
        RAISE EXCEPTION 'Verified worker profile phone is not a supported mobile number';
    END IF;

    SELECT * INTO otp_row FROM withdrawal_otp_authorizations
    WHERE authorization_id = NEW.authorization_id FOR UPDATE;
    IF NOT FOUND OR otp_row.status <> 'VERIFIED'
       OR otp_row.claim_id <> NEW.claim_id OR otp_row.account_id <> NEW.account_id
       OR otp_row.destination_phone_snapshot <> worker_phone
       OR NEW.destination_phone_snapshot <> otp_row.destination_phone_snapshot
       OR NEW.destination_verified_at <> otp_row.destination_verified_at
       OR otp_row.verified_at IS NULL OR otp_row.expires_at <= now() THEN
        RAISE EXCEPTION 'Payout attempt requires fresh, matching, unconsumed OTP authorization';
    END IF;

    SELECT count(*) INTO prior_count
    FROM withdrawal_payout_attempts
    WHERE claim_id = NEW.claim_id;
    IF prior_count = 0 THEN
        IF NEW.retry_decision_id IS NOT NULL OR NEW.retry_of_attempt_id IS NOT NULL THEN
            RAISE EXCEPTION 'Initial payout attempt cannot reference a retry decision';
        END IF;
    ELSE
        IF NEW.retry_decision_id IS NULL OR NEW.retry_of_attempt_id IS NULL THEN
            RAISE EXCEPTION 'Payout retry requires an authorized retry decision';
        END IF;
        SELECT * INTO prior_row FROM withdrawal_payout_attempts
        WHERE payout_attempt_id = NEW.retry_of_attempt_id
          AND claim_id = NEW.claim_id FOR UPDATE;
        IF NOT FOUND OR prior_row.outcome <> 'FAILED'
           OR NOT EXISTS (
               SELECT 1 FROM withdrawal_payout_retry_decisions d
               WHERE d.retry_decision_id = NEW.retry_decision_id
                 AND d.prior_payout_attempt_id = prior_row.payout_attempt_id
                 AND d.claim_id = NEW.claim_id
                 AND d.account_id = NEW.account_id
           ) THEN
            RAISE EXCEPTION 'Only an authorized retry after definitive failure is allowed';
        END IF;
        IF EXISTS (
            SELECT 1 FROM withdrawal_payout_attempts
            WHERE claim_id = NEW.claim_id
              AND outcome IN ('PENDING', 'UNKNOWN', 'SUCCEEDED')
        ) THEN
            RAISE EXCEPTION 'Pending, unknown, or successful payout blocks retry';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payout_attempt_guard
    BEFORE INSERT OR UPDATE ON withdrawal_payout_attempts
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_guard_payout_attempt();

CREATE OR REPLACE FUNCTION pension_ledger_consume_payout_otp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE withdrawal_otp_authorizations
    SET status = 'CONSUMED',
        consumed_by_payout_attempt_id = NEW.payout_attempt_id
    WHERE authorization_id = NEW.authorization_id
      AND status = 'VERIFIED'
      AND expires_at > now();
    IF NOT FOUND THEN
        RAISE EXCEPTION 'OTP authorization could not be consumed atomically';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payout_attempt_consume_otp
    AFTER INSERT ON withdrawal_payout_attempts
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_consume_payout_otp();

CREATE OR REPLACE FUNCTION pension_ledger_guard_payout_verification()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE attempt_row withdrawal_payout_attempts%ROWTYPE;
BEGIN
    IF TG_OP = 'INSERT' AND NEW.verification_status <> 'PROCESSING' THEN
        RAISE EXCEPTION 'Payout verifications must begin in PROCESSING state';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Payout verification evidence cannot be deleted';
    END IF;
    SELECT * INTO attempt_row FROM withdrawal_payout_attempts
    WHERE payout_attempt_id = NEW.payout_attempt_id FOR UPDATE;
    IF NOT FOUND OR NEW.provider_mode <> attempt_row.provider_mode THEN
        RAISE EXCEPTION 'Payout verification provider does not match its attempt';
    END IF;
    IF NEW.verification_status = 'VERIFIED_SUCCESS'
       AND (NEW.amount_matches IS NOT TRUE
            OR NEW.destination_matches IS NOT TRUE
            OR NEW.provider_reference IS NULL OR NEW.verified_at IS NULL) THEN
        RAISE EXCEPTION 'Successful payout requires matching independent evidence';
    END IF;
    IF NEW.verification_status = 'VERIFIED_FAILURE'
       AND (NEW.amount_matches IS NOT TRUE
            OR NEW.destination_matches IS NOT TRUE
            OR NEW.provider_result_code IS NULL OR NEW.verified_at IS NULL
            OR NEW.verified_at > now()) THEN
        RAISE EXCEPTION 'Definitive payout failure requires matching provider evidence';
    END IF;
    IF TG_OP = 'UPDATE'
       AND (NEW.payout_attempt_id IS DISTINCT FROM OLD.payout_attempt_id
            OR NEW.provider_mode IS DISTINCT FROM OLD.provider_mode
            OR OLD.verification_status <> 'PROCESSING'
            OR NEW.verification_status NOT IN (
                'UNVERIFIED', 'VERIFIED_SUCCESS', 'VERIFIED_FAILURE'
            )) THEN
        RAISE EXCEPTION 'Payout verification source is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payout_verification_guard
    BEFORE INSERT OR UPDATE OR DELETE ON withdrawal_payout_verifications
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_guard_payout_verification();

CREATE OR REPLACE FUNCTION pension_ledger_guard_payout_callback()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE verification_row withdrawal_payout_verifications%ROWTYPE;
BEGIN
    SELECT * INTO verification_row FROM withdrawal_payout_verifications
    WHERE payout_verification_id = NEW.payout_verification_id
      AND payout_attempt_id = NEW.payout_attempt_id
      AND provider_mode = NEW.provider_mode FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payout callback does not match its verification and attempt';
    END IF;
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Payout callback evidence is append-only';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payout_callback_guard
    BEFORE INSERT OR UPDATE OR DELETE ON withdrawal_payout_callbacks
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_guard_payout_callback();

CREATE TRIGGER trg_00_disable_otp_authorizations
    BEFORE INSERT OR UPDATE OR DELETE ON withdrawal_otp_authorizations
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_future_payout_disabled();
CREATE TRIGGER trg_00_disable_payout_attempts
    BEFORE INSERT OR UPDATE OR DELETE ON withdrawal_payout_attempts
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_future_payout_disabled();
CREATE TRIGGER trg_00_disable_payout_retry_decisions
    BEFORE INSERT OR UPDATE OR DELETE ON withdrawal_payout_retry_decisions
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_future_payout_disabled();
CREATE TRIGGER trg_00_disable_payout_verifications
    BEFORE INSERT OR UPDATE OR DELETE ON withdrawal_payout_verifications
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_future_payout_disabled();
CREATE TRIGGER trg_00_disable_payout_callbacks
    BEFORE INSERT OR UPDATE OR DELETE ON withdrawal_payout_callbacks
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_future_payout_disabled();
CREATE TRIGGER trg_00_disable_payout_returns
    BEFORE INSERT OR UPDATE OR DELETE ON withdrawal_payout_return_evidence
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_future_payout_disabled();

CREATE TABLE pension_account_movements (
    movement_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ledger_id UUID NOT NULL
        REFERENCES pension_ledger (ledger_id) ON DELETE RESTRICT,
    account_id VARCHAR(25) NOT NULL
        REFERENCES pension_accounts (account_id) ON DELETE RESTRICT,
    movement_type VARCHAR(24) NOT NULL CHECK (movement_type IN (
        'OPENING_BALANCE', 'CONTRIBUTION_SETTLEMENT',
        'WITHDRAWAL_SETTLEMENT', 'REVERSAL', 'ADMIN_ADJUSTMENT'
    )),
    amount NUMERIC(12,2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'KES' CHECK (currency = 'KES'),
    idempotency_key VARCHAR(160) NOT NULL UNIQUE,

    transaction_id VARCHAR(25),
    contribution_id VARCHAR(25),
    payment_attempt_id VARCHAR(25),
    payment_verification_id BIGINT,
    payment_callback_id BIGINT,
    simulator_confirmation_id UUID,

    withdrawal_claim_id VARCHAR(25),
    payout_attempt_id VARCHAR(25),
    payout_verification_id VARCHAR(25),
    payout_callback_id VARCHAR(25),
    adjustment_request_id UUID,
    original_movement_id UUID
        REFERENCES pension_account_movements (movement_id) ON DELETE RESTRICT,
    payout_return_attempt_id VARCHAR(25),
    payout_return_evidence_id UUID,
    cutover_batch_id UUID,
    provenance TEXT,

    effective_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_user_id VARCHAR(25),
    actor_name_snapshot VARCHAR(100),
    actor_role_snapshot VARCHAR(20),
    actor_type VARCHAR(10) NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM', 'MIGRATION')),
    actor_reference TEXT,
    reason TEXT,
    authorization_reference TEXT,
    provider_mode VARCHAR(20) CHECK (provider_mode IN (
        'DARAJA', 'SIMULATOR', 'MIGRATION', 'NONE'
    )),

    FOREIGN KEY (cutover_batch_id, ledger_id)
        REFERENCES pension_ledger_cutover_batches (batch_id, ledger_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (
        payment_attempt_id, account_id, contribution_id, transaction_id, provider_mode
    ) REFERENCES mpesa_payment_attempts (
        attempt_id, account_id, contribution_id, transaction_id, provider_mode
    ) ON DELETE RESTRICT,
    FOREIGN KEY (payment_verification_id, payment_attempt_id, provider_mode)
        REFERENCES mpesa_payment_verifications
            (verification_id, attempt_id, provider_mode)
        ON DELETE RESTRICT,
    FOREIGN KEY (payment_callback_id, payment_attempt_id, payment_verification_id)
        REFERENCES mpesa_callback_inbox (callback_id, attempt_id, verification_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (
        simulator_confirmation_id, payment_attempt_id, payment_verification_id, provider_mode
    ) REFERENCES simulator_payment_confirmations
        (confirmation_id, attempt_id, verification_id, provider_mode)
        ON DELETE RESTRICT,
    FOREIGN KEY (contribution_id, account_id, transaction_id)
        REFERENCES contributions (contribution_id, account_id, transaction_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (
        payout_attempt_id, withdrawal_claim_id, account_id, transaction_id, provider_mode
    ) REFERENCES withdrawal_payout_attempts (
        payout_attempt_id, claim_id, account_id, transaction_id, provider_mode
    ) ON DELETE RESTRICT,
    FOREIGN KEY (payout_verification_id, payout_attempt_id, provider_mode)
        REFERENCES withdrawal_payout_verifications
            (payout_verification_id, payout_attempt_id, provider_mode)
        ON DELETE RESTRICT,
    FOREIGN KEY (payout_callback_id, payout_attempt_id, payout_verification_id)
        REFERENCES withdrawal_payout_callbacks
            (payout_callback_id, payout_attempt_id, payout_verification_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (withdrawal_claim_id, account_id, transaction_id)
        REFERENCES withdrawal_claims (claim_id, account_id, transaction_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (adjustment_request_id, account_id, amount, currency)
        REFERENCES pension_adjustment_requests (request_id, account_id, amount, currency)
        ON DELETE RESTRICT,
    FOREIGN KEY (payout_return_evidence_id, payout_return_attempt_id, amount)
        REFERENCES withdrawal_payout_return_evidence
            (return_evidence_id, payout_attempt_id, amount)
        ON DELETE RESTRICT,

    CONSTRAINT chk_movement_fields_by_type CHECK (
        (movement_type = 'OPENING_BALANCE'
            AND amount >= 0
            AND cutover_batch_id IS NOT NULL
            AND provenance IS NOT NULL AND length(trim(provenance)) > 0
            AND actor_type IN ('MIGRATION', 'SYSTEM')
            AND actor_reference IS NOT NULL AND length(trim(actor_reference)) > 0
            AND provider_mode = 'MIGRATION'
            AND transaction_id IS NULL AND contribution_id IS NULL
            AND payment_attempt_id IS NULL AND payment_verification_id IS NULL
            AND payment_callback_id IS NULL AND simulator_confirmation_id IS NULL
            AND withdrawal_claim_id IS NULL AND payout_attempt_id IS NULL
            AND payout_verification_id IS NULL AND payout_callback_id IS NULL
            AND payout_return_evidence_id IS NULL AND adjustment_request_id IS NULL
            AND payout_return_attempt_id IS NULL
            AND original_movement_id IS NULL AND reason IS NULL
            AND authorization_reference IS NULL)
        OR
        (movement_type = 'CONTRIBUTION_SETTLEMENT'
            AND amount > 0
            AND transaction_id IS NOT NULL AND contribution_id IS NOT NULL
            AND payment_attempt_id IS NOT NULL AND payment_verification_id IS NOT NULL
            AND provider_mode IN ('DARAJA', 'SIMULATOR')
            AND cutover_batch_id IS NULL AND provenance IS NULL
            AND withdrawal_claim_id IS NULL AND payout_attempt_id IS NULL
            AND payout_verification_id IS NULL AND payout_callback_id IS NULL
            AND payout_return_evidence_id IS NULL AND adjustment_request_id IS NULL
            AND payout_return_attempt_id IS NULL
            AND original_movement_id IS NULL AND reason IS NULL
            AND authorization_reference IS NULL
            AND ((provider_mode = 'SIMULATOR'
                    AND simulator_confirmation_id IS NOT NULL AND payment_callback_id IS NULL)
                OR (provider_mode = 'DARAJA' AND simulator_confirmation_id IS NULL)))
        OR
        (movement_type = 'WITHDRAWAL_SETTLEMENT'
            AND amount < 0
            AND transaction_id IS NOT NULL AND withdrawal_claim_id IS NOT NULL
            AND payout_attempt_id IS NOT NULL AND payout_verification_id IS NOT NULL
            AND provider_mode = 'DARAJA'
            AND contribution_id IS NULL AND payment_attempt_id IS NULL
            AND payment_verification_id IS NULL AND payment_callback_id IS NULL
            AND simulator_confirmation_id IS NULL
            AND cutover_batch_id IS NULL AND provenance IS NULL
            AND adjustment_request_id IS NULL AND original_movement_id IS NULL
            AND payout_return_attempt_id IS NULL AND payout_return_evidence_id IS NULL
            AND reason IS NULL AND authorization_reference IS NULL)
        OR
        (movement_type = 'REVERSAL'
            AND amount <> 0 AND original_movement_id IS NOT NULL
            AND transaction_id IS NULL AND contribution_id IS NULL
            AND payment_attempt_id IS NULL AND payment_verification_id IS NULL
            AND payment_callback_id IS NULL AND simulator_confirmation_id IS NULL
            AND withdrawal_claim_id IS NULL AND payout_attempt_id IS NULL
            AND payout_verification_id IS NULL AND payout_callback_id IS NULL
            AND adjustment_request_id IS NULL AND cutover_batch_id IS NULL
            AND provenance IS NULL AND provider_mode = 'NONE'
            AND reason IS NOT NULL AND length(trim(reason)) > 0
            AND actor_type = 'USER' AND actor_user_id IS NOT NULL
            AND actor_name_snapshot IS NOT NULL AND actor_role_snapshot IS NOT NULL
            AND authorization_reference IS NOT NULL
                AND length(trim(authorization_reference)) > 0
            AND ((payout_return_attempt_id IS NULL AND payout_return_evidence_id IS NULL)
                OR (payout_return_attempt_id IS NOT NULL
                    AND payout_return_evidence_id IS NOT NULL)))
        OR
        (movement_type = 'ADMIN_ADJUSTMENT'
            AND amount <> 0 AND adjustment_request_id IS NOT NULL
            AND reason IS NOT NULL AND length(trim(reason)) > 0
            AND authorization_reference IS NOT NULL
                AND length(trim(authorization_reference)) > 0
            AND actor_type = 'USER' AND actor_user_id IS NOT NULL
            AND actor_name_snapshot IS NOT NULL AND actor_role_snapshot IS NOT NULL
            AND transaction_id IS NULL AND contribution_id IS NULL
            AND payment_attempt_id IS NULL AND payment_verification_id IS NULL
            AND payment_callback_id IS NULL AND simulator_confirmation_id IS NULL
            AND withdrawal_claim_id IS NULL AND payout_attempt_id IS NULL
            AND payout_verification_id IS NULL AND payout_callback_id IS NULL
            AND payout_return_evidence_id IS NULL
            AND payout_return_attempt_id IS NULL
            AND original_movement_id IS NULL AND cutover_batch_id IS NULL
            AND provenance IS NULL AND provider_mode = 'NONE')
    )
);

CREATE UNIQUE INDEX uq_movement_opening_per_account
    ON pension_account_movements (account_id)
    WHERE movement_type = 'OPENING_BALANCE';
CREATE UNIQUE INDEX uq_movement_contribution_once
    ON pension_account_movements (contribution_id)
    WHERE movement_type = 'CONTRIBUTION_SETTLEMENT';
CREATE UNIQUE INDEX uq_movement_withdrawal_once
    ON pension_account_movements (withdrawal_claim_id)
    WHERE movement_type = 'WITHDRAWAL_SETTLEMENT';
CREATE UNIQUE INDEX uq_movement_full_reversal_once
    ON pension_account_movements (original_movement_id)
    WHERE movement_type = 'REVERSAL';
CREATE UNIQUE INDEX uq_movement_adjustment_once
    ON pension_account_movements (adjustment_request_id)
    WHERE movement_type = 'ADMIN_ADJUSTMENT';
CREATE INDEX idx_movement_account_effective
    ON pension_account_movements (account_id, effective_at, movement_id);
CREATE INDEX idx_movement_transaction
    ON pension_account_movements (transaction_id)
    WHERE transaction_id IS NOT NULL;
CREATE INDEX idx_movement_payment_attempt
    ON pension_account_movements (payment_attempt_id)
    WHERE payment_attempt_id IS NOT NULL;
CREATE INDEX idx_movement_payment_verification
    ON pension_account_movements (payment_verification_id)
    WHERE payment_verification_id IS NOT NULL;
CREATE INDEX idx_movement_payment_callback
    ON pension_account_movements (payment_callback_id)
    WHERE payment_callback_id IS NOT NULL;
CREATE INDEX idx_movement_simulator_confirmation
    ON pension_account_movements (simulator_confirmation_id)
    WHERE simulator_confirmation_id IS NOT NULL;
CREATE INDEX idx_movement_payout_attempt
    ON pension_account_movements (payout_attempt_id)
    WHERE payout_attempt_id IS NOT NULL;
CREATE INDEX idx_movement_payout_verification
    ON pension_account_movements (payout_verification_id)
    WHERE payout_verification_id IS NOT NULL;
CREATE INDEX idx_movement_payout_callback
    ON pension_account_movements (payout_callback_id)
    WHERE payout_callback_id IS NOT NULL;
CREATE INDEX idx_movement_adjustment_request
    ON pension_account_movements (adjustment_request_id)
    WHERE adjustment_request_id IS NOT NULL;
CREATE INDEX idx_adjustment_requests_account_status
    ON pension_adjustment_requests (account_id, status, requested_at DESC);

CREATE OR REPLACE FUNCTION pension_ledger_guard_singleton()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'The pension ledger singleton is permanent';
    END IF;
    IF NEW.singleton_key IS DISTINCT FROM OLD.singleton_key
       OR NEW.ledger_id IS DISTINCT FROM OLD.ledger_id THEN
        RAISE EXCEPTION 'The pension ledger identity is immutable';
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'The pension ledger creation timestamp is immutable';
    END IF;
    IF OLD.status = 'CLOSED' THEN
        RAISE EXCEPTION 'A closed pension ledger cannot be changed';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (
           (OLD.status = 'PREPARING' AND NEW.status IN ('ACTIVE', 'CLOSED'))
           OR (OLD.status = 'ACTIVE' AND NEW.status = 'CLOSED')
       ) THEN
        RAISE EXCEPTION 'Invalid pension ledger lifecycle transition';
    END IF;
    IF NEW.status = 'ACTIVE' AND OLD.status = 'PREPARING' THEN
        IF EXISTS (
            SELECT 1
            FROM pension_accounts a
            WHERE NOT EXISTS (
                SELECT 1 FROM pension_account_movements m
                WHERE m.account_id = a.account_id
                  AND m.ledger_id = OLD.ledger_id
                  AND m.movement_type = 'OPENING_BALANCE'
            )
        ) OR EXISTS (
            SELECT 1
            FROM pension_accounts a
            JOIN pension_account_movements m
              ON m.account_id = a.account_id
             AND m.ledger_id = OLD.ledger_id
             AND m.movement_type = 'OPENING_BALANCE'
            JOIN pension_ledger_cutover_batches b
              ON b.batch_id = m.cutover_batch_id
             AND b.ledger_id = m.ledger_id
            WHERE m.amount <> a.current_balance
               OR m.currency <> 'KES'
               OR m.idempotency_key <> 'opening:' || a.account_id
               OR m.cutover_batch_id <> 'c14ad635-883f-4efb-9502-310bd3c2c241'::UUID
               OR b.batch_type <> 'INITIAL_CUTOVER'
               OR b.account_id IS NOT NULL
               OR b.singleton_key IS DISTINCT FROM TRUE
               OR m.provenance IS DISTINCT FROM b.provenance
               OR m.actor_reference IS DISTINCT FROM b.migration_actor
               OR m.actor_type <> 'MIGRATION'
               OR m.actor_name_snapshot <> 'pension-account-ledger migration'
               OR m.actor_role_snapshot <> 'MIGRATION'
               OR m.provider_mode <> 'MIGRATION'
        ) OR EXISTS (
            SELECT 1
            FROM pension_accounts a
            WHERE a.current_balance < COALESCE((
                SELECT sum(wc.amount_requested)
                FROM withdrawal_claims wc
                WHERE wc.account_id = a.account_id
                  AND wc.claim_status = 'APPROVED'
            ), 0)
        ) THEN
            RAISE EXCEPTION 'Cannot activate ledger with missing or mismatched opening movements';
        END IF;
        NEW.activated_at := now();
    ELSIF NEW.status = 'CLOSED' AND OLD.status <> 'CLOSED' THEN
        IF NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
            RAISE EXCEPTION 'Ledger activation timestamp is immutable';
        END IF;
        NEW.closed_at := now();
    ELSIF NEW.activated_at IS DISTINCT FROM OLD.activated_at
       OR NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
        RAISE EXCEPTION 'Ledger lifecycle timestamps are immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pension_ledger_guard
    BEFORE UPDATE OR DELETE ON pension_ledger
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_guard_singleton();

CREATE OR REPLACE FUNCTION pension_ledger_guard_attempt_provider()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.provider_mode IS NULL THEN
            RAISE EXCEPTION 'New payment attempts require server-assigned provider mode';
        END IF;
    ELSIF NEW.provider_mode IS DISTINCT FROM OLD.provider_mode THEN
        RAISE EXCEPTION 'Payment attempt provider mode is immutable';
    END IF;
    IF NEW.provider_mode = 'SIMULATOR'
       AND NEW.checkout_request_id IS NOT NULL
       AND NEW.checkout_request_id !~ '^SIM[A-F0-9]{22}$' THEN
        RAISE EXCEPTION 'Simulator attempt requires a synthetic reference';
    END IF;
    IF NEW.provider_mode = 'DARAJA'
       AND (NEW.checkout_request_id LIKE 'SIM%' OR NEW.merchant_request_id LIKE 'SIMM%') THEN
        RAISE EXCEPTION 'Simulator references cannot be used for Daraja attempts';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_mpesa_attempt_provider_immutable
    BEFORE INSERT OR UPDATE OF provider_mode, checkout_request_id, merchant_request_id
    ON mpesa_payment_attempts
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_guard_attempt_provider();

CREATE OR REPLACE FUNCTION pension_ledger_copy_verification_provider()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE attempt_provider VARCHAR(20);
BEGIN
    SELECT provider_mode INTO attempt_provider
    FROM mpesa_payment_attempts
    WHERE attempt_id = NEW.attempt_id
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Verification attempt does not exist';
    END IF;
    IF TG_OP = 'INSERT' THEN
        NEW.provider_mode := attempt_provider;
    ELSIF NEW.provider_mode IS DISTINCT FROM OLD.provider_mode
       OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id THEN
        RAISE EXCEPTION 'Verification provider and attempt are immutable';
    END IF;
    IF NEW.provider_mode = 'SIMULATOR'
       AND NEW.verification_source = 'CALLBACK' THEN
        RAISE EXCEPTION 'Simulator evidence cannot be a Daraja callback';
    END IF;
    IF NEW.provider_mode = 'SIMULATOR'
       AND NEW.verification_status <> 'PROCESSING'
       AND NEW.simulator_outcome IS NULL THEN
        RAISE EXCEPTION 'Completed simulator verification requires an explicit outcome';
    END IF;
    IF NEW.provider_mode = 'DARAJA' AND NEW.simulator_outcome IS NOT NULL THEN
        RAISE EXCEPTION 'Daraja verification cannot contain simulator outcome evidence';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_mpesa_verification_provider
    BEFORE INSERT OR UPDATE OF provider_mode, attempt_id, verification_source,
        verification_status, simulator_outcome
    ON mpesa_payment_verifications
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_copy_verification_provider();

CREATE OR REPLACE FUNCTION pension_ledger_guard_simulator_confirmation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE attempt_row mpesa_payment_attempts%ROWTYPE;
        verification_row mpesa_payment_verifications%ROWTYPE;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Simulator confirmation evidence is append-only';
    END IF;
    SELECT * INTO attempt_row FROM mpesa_payment_attempts
    WHERE attempt_id = NEW.attempt_id FOR SHARE;
    SELECT * INTO verification_row FROM mpesa_payment_verifications
    WHERE verification_id = NEW.verification_id
      AND attempt_id = NEW.attempt_id FOR SHARE;
    IF attempt_row.provider_mode <> 'SIMULATOR'
       OR verification_row.provider_mode <> 'SIMULATOR'
       OR verification_row.verification_source <> 'RECONCILIATION'
       OR NEW.synthetic_reference IS DISTINCT FROM attempt_row.checkout_request_id THEN
        RAISE EXCEPTION 'Simulator confirmation does not match simulator attempt evidence';
    END IF;
    IF (NEW.outcome = 'SUCCESS'
        AND (verification_row.verification_status <> 'VERIFIED_SUCCESS'
             OR verification_row.provider_result_code <> '0'))
       OR (NEW.outcome = 'FAILED'
        AND verification_row.verification_status <> 'VERIFIED_FAILURE')
       OR (NEW.outcome IN ('PENDING', 'UNKNOWN')
        AND verification_row.verification_status NOT IN ('UNVERIFIED', 'INCONSISTENT')) THEN
        RAISE EXCEPTION 'Simulator outcome conflicts with verification status';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_simulator_confirmation_guard
    BEFORE INSERT OR UPDATE OR DELETE ON simulator_payment_confirmations
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_guard_simulator_confirmation();

CREATE OR REPLACE FUNCTION pension_ledger_record_simulator_confirmation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE attempt_row mpesa_payment_attempts%ROWTYPE;
BEGIN
    IF NEW.provider_mode = 'SIMULATOR'
       AND NEW.verification_status <> 'PROCESSING'
       AND OLD.verification_status = 'PROCESSING' THEN
        SELECT * INTO attempt_row
        FROM mpesa_payment_attempts
        WHERE attempt_id = NEW.attempt_id
        FOR SHARE;
        IF attempt_row.checkout_request_id IS NULL
           OR attempt_row.checkout_request_id !~ '^SIM[A-F0-9]{22}$' THEN
            RAISE EXCEPTION 'Simulator attempt has no valid synthetic reference';
        END IF;
        INSERT INTO simulator_payment_confirmations (
            confirmation_id, attempt_id, verification_id, provider_mode,
            outcome, synthetic_reference, confirmed_at
        )
        VALUES (
            gen_random_uuid(), NEW.attempt_id, NEW.verification_id, 'SIMULATOR',
            NEW.simulator_outcome, attempt_row.checkout_request_id,
            COALESCE(NEW.completed_at, now())
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_record_simulator_confirmation
    AFTER UPDATE OF verification_status ON mpesa_payment_verifications
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_record_simulator_confirmation();

CREATE OR REPLACE FUNCTION pension_ledger_guard_adjustment_request()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE requester_row users%ROWTYPE;
        approver_row users%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Adjustment requests cannot be deleted';
    END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT * INTO requester_row FROM users
        WHERE user_id = NEW.requester_user_id;
        IF NOT FOUND
           OR requester_row.full_name <> NEW.requester_name_snapshot
           OR requester_row.role <> NEW.requester_role_snapshot THEN
            RAISE EXCEPTION 'Adjustment requester snapshot is not authoritative';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.status <> 'REQUESTED' THEN
        RAISE EXCEPTION 'Final adjustment decisions are immutable';
    END IF;
    IF NEW.request_id IS DISTINCT FROM OLD.request_id
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.requester_user_id IS DISTINCT FROM OLD.requester_user_id
       OR NEW.requester_name_snapshot IS DISTINCT FROM OLD.requester_name_snapshot
       OR NEW.requester_role_snapshot IS DISTINCT FROM OLD.requester_role_snapshot
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.authorization_reference IS DISTINCT FROM OLD.authorization_reference
       OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
       OR NEW.status NOT IN ('APPROVED', 'REJECTED')
       OR NEW.approver_user_id IS NULL
       OR NEW.approver_user_id = NEW.requester_user_id THEN
        RAISE EXCEPTION 'Invalid adjustment decision transition';
    END IF;
    SELECT * INTO approver_row FROM users
    WHERE user_id = NEW.approver_user_id;
    IF NOT FOUND OR approver_row.full_name <> NEW.approver_name_snapshot
       OR approver_row.role <> NEW.approver_role_snapshot
       OR approver_row.role <> 'ADMIN' THEN
        RAISE EXCEPTION 'Adjustment approver snapshot is not authorized';
    END IF;
    INSERT INTO pension_adjustment_decision_audit
        (request_id, decision, actor_user_id, actor_name_snapshot,
         actor_role_snapshot, authorization_reference, decided_at)
    VALUES
        (NEW.request_id, NEW.status, NEW.approver_user_id,
         NEW.approver_name_snapshot, NEW.approver_role_snapshot,
         NEW.authorization_reference, NEW.decided_at);
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_adjustment_request_guard
    BEFORE INSERT OR UPDATE OR DELETE ON pension_adjustment_requests
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_guard_adjustment_request();

CREATE OR REPLACE FUNCTION pension_ledger_immutable_rows()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER trg_adjustment_audit_immutable
    BEFORE UPDATE OR DELETE ON pension_adjustment_decision_audit
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_immutable_rows();

CREATE TRIGGER trg_ledger_cutover_batch_immutable
    BEFORE UPDATE OR DELETE ON pension_ledger_cutover_batches
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_immutable_rows();

CREATE OR REPLACE FUNCTION pension_ledger_guard_withdrawal_reservation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE account_row pension_accounts%ROWTYPE;
        ledger_status VARCHAR(15);
        reserved_amount NUMERIC(12,2);
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Withdrawal claims are retained as financial authorization history';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.claim_status <> 'PENDING' THEN
            RAISE EXCEPTION 'Withdrawal claims must begin in PENDING status';
        END IF;
    ELSE
        IF NEW.claim_id IS DISTINCT FROM OLD.claim_id
           OR NEW.account_id IS DISTINCT FROM OLD.account_id
           OR NEW.amount_requested IS DISTINCT FROM OLD.amount_requested
           OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
           OR NEW.destination_phone IS DISTINCT FROM OLD.destination_phone
           OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
            RAISE EXCEPTION 'Withdrawal claim identity and amount are immutable';
        END IF;
        IF OLD.claim_status IN ('REJECTED', 'PAID')
           OR (OLD.claim_status = 'PENDING'
               AND NEW.claim_status NOT IN ('APPROVED', 'REJECTED'))
           OR (OLD.claim_status = 'APPROVED'
               AND NEW.claim_status NOT IN ('REJECTED', 'PAID')) THEN
            RAISE EXCEPTION 'Invalid withdrawal claim status transition';
        END IF;
    END IF;
    IF NEW.claim_status = 'PAID' THEN
        RAISE EXCEPTION 'Withdrawal claims cannot be marked paid until verified payout settlement is implemented';
    END IF;

    SELECT status INTO ledger_status
    FROM pension_ledger
    WHERE singleton_key IS TRUE;
    IF ledger_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'Withdrawal claim writes require an active pension ledger';
    END IF;

    SELECT * INTO account_row FROM pension_accounts
    WHERE account_id = NEW.account_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Withdrawal claim pension account does not exist';
    END IF;
    IF NEW.claim_status = 'APPROVED' THEN
        IF account_row.account_status <> 'ACTIVE' THEN
            RAISE EXCEPTION 'Cannot reserve funds for an inactive pension account';
        END IF;
        SELECT COALESCE(sum(amount_requested), 0)
        INTO reserved_amount
        FROM withdrawal_claims
        WHERE account_id = NEW.account_id
          AND claim_status = 'APPROVED'
          AND claim_id <> NEW.claim_id;
        IF account_row.current_balance < reserved_amount + NEW.amount_requested THEN
            RAISE EXCEPTION 'Withdrawal approval exceeds available balance after reservations';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pension_ledger_guard_withdrawal_reservation
    BEFORE INSERT OR UPDATE OR DELETE ON withdrawal_claims
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_guard_withdrawal_reservation();

CREATE OR REPLACE FUNCTION pension_ledger_guard_movement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE ledger_status VARCHAR(15);
        account_balance NUMERIC(12,2);
        reserved_amount NUMERIC(12,2);
        original_row pension_account_movements%ROWTYPE;
        request_row pension_adjustment_requests%ROWTYPE;
        evidence_row RECORD;
        batch_row pension_ledger_cutover_batches%ROWTYPE;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Pension account movements are append-only';
    END IF;

    SELECT status INTO ledger_status
    FROM pension_ledger
    WHERE ledger_id = NEW.ledger_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ledger identity does not exist';
    END IF;
    IF NEW.movement_type = 'OPENING_BALANCE' THEN
        IF ledger_status NOT IN ('PREPARING', 'ACTIVE') THEN
            RAISE EXCEPTION 'Opening movements are not allowed after ledger closure';
        END IF;
    ELSIF ledger_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Financial movements require an active ledger';
    END IF;

    SELECT current_balance INTO account_balance
    FROM pension_accounts WHERE account_id = NEW.account_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Pension account does not exist';
    END IF;

    IF NEW.movement_type = 'OPENING_BALANCE' THEN
        SELECT * INTO batch_row FROM pension_ledger_cutover_batches
        WHERE batch_id = NEW.cutover_batch_id
          AND ledger_id = NEW.ledger_id FOR SHARE;
        IF NOT FOUND
           OR (ledger_status = 'PREPARING' AND batch_row.batch_type <> 'INITIAL_CUTOVER')
           OR (ledger_status = 'ACTIVE' AND batch_row.batch_type <> 'ACCOUNT_OPENING')
           OR (batch_row.batch_type = 'INITIAL_CUTOVER'
              AND (NEW.amount IS DISTINCT FROM account_balance
                   OR NEW.currency <> 'KES'
                   OR NEW.idempotency_key <> 'opening:' || NEW.account_id
                   OR NEW.actor_type <> 'MIGRATION'
                   OR NEW.actor_name_snapshot <> 'pension-account-ledger migration'
                   OR NEW.actor_role_snapshot <> 'MIGRATION'
                   OR NEW.actor_reference IS DISTINCT FROM batch_row.migration_actor
                   OR NEW.provenance IS DISTINCT FROM batch_row.provenance))
           OR (batch_row.batch_type = 'ACCOUNT_OPENING'
              AND (batch_row.account_id <> NEW.account_id
                   OR NEW.amount <> 0 OR NEW.actor_type <> 'SYSTEM'
                   OR NEW.actor_reference IS DISTINCT FROM batch_row.migration_actor
                   OR NEW.provenance IS DISTINCT FROM batch_row.provenance)) THEN
            RAISE EXCEPTION 'Opening movement does not match captured account balance';
        END IF;
    ELSIF NEW.movement_type = 'CONTRIBUTION_SETTLEMENT' THEN
        SELECT a.provider_mode, a.expected_amount, a.attempt_status,
               a.checkout_request_id AS attempt_checkout_request_id,
               a.mpesa_phone AS attempt_phone,
               c.amount AS contribution_amount, c.contribution_status,
               c.channel AS contribution_channel,
               t.amount AS transaction_amount, t.transaction_type, t.transaction_status,
               t.mpesa_receipt AS transaction_receipt,
               t.checkout_request_id AS transaction_checkout_request_id,
               t.mpesa_phone AS transaction_phone,
               t.mpesa_result_code AS transaction_result_code,
               v.verification_status, v.provider_result_code, v.verification_source,
               v.callback_result_code, v.callback_amount_matches, v.callback_phone_matches,
               v.callback_receipt, v.callback_fingerprint, v.provider_mode AS verification_provider,
               v.provider_result_description, v.simulator_outcome
        INTO evidence_row
        FROM mpesa_payment_attempts a
        JOIN contributions c ON c.contribution_id = a.contribution_id
          AND c.account_id = a.account_id AND c.transaction_id = a.transaction_id
        JOIN transactions t ON t.transaction_id = a.transaction_id
        JOIN mpesa_payment_verifications v ON v.attempt_id = a.attempt_id
        WHERE a.attempt_id = NEW.payment_attempt_id
          AND v.verification_id = NEW.payment_verification_id
          AND a.account_id = NEW.account_id
          AND a.contribution_id = NEW.contribution_id
          AND a.transaction_id = NEW.transaction_id
        FOR SHARE OF a, c, t, v;
        IF NOT FOUND
           OR evidence_row.provider_mode IS DISTINCT FROM NEW.provider_mode
           OR evidence_row.verification_provider IS DISTINCT FROM NEW.provider_mode
           OR evidence_row.verification_status <> 'VERIFIED_SUCCESS'
           OR evidence_row.provider_result_code IS DISTINCT FROM '0'
           OR evidence_row.attempt_status NOT IN ('PROMPT_ACCEPTED', 'OUTCOME_UNKNOWN')
           OR evidence_row.contribution_status <> 'COMPLETED'
           OR evidence_row.contribution_channel <> 'MPESA'
           OR evidence_row.transaction_type <> 'CONTRIBUTION'
           OR evidence_row.transaction_status <> 'COMPLETED'
           OR evidence_row.transaction_checkout_request_id
                IS DISTINCT FROM evidence_row.attempt_checkout_request_id
           OR evidence_row.transaction_phone IS DISTINCT FROM evidence_row.attempt_phone
           OR evidence_row.transaction_result_code IS DISTINCT FROM 0
           OR evidence_row.expected_amount IS DISTINCT FROM NEW.amount
           OR evidence_row.contribution_amount IS DISTINCT FROM NEW.amount
           OR evidence_row.transaction_amount IS DISTINCT FROM NEW.amount THEN
            RAISE EXCEPTION 'Contribution settlement evidence is incomplete or inconsistent';
        END IF;
        IF NEW.provider_mode = 'DARAJA' THEN
            IF NEW.simulator_confirmation_id IS NOT NULL
               OR (evidence_row.verification_source = 'CALLBACK'
                   AND (evidence_row.callback_result_code IS DISTINCT FROM '0'
                        OR evidence_row.callback_amount_matches IS NOT TRUE
                        OR evidence_row.callback_phone_matches IS NOT TRUE
                        OR evidence_row.callback_receipt IS NULL
                        OR evidence_row.transaction_receipt
                            IS DISTINCT FROM evidence_row.callback_receipt
                        OR NEW.payment_callback_id IS NULL
                        OR NOT EXISTS (
                            SELECT 1 FROM mpesa_callback_inbox cb
                            WHERE cb.callback_id = NEW.payment_callback_id
                              AND cb.attempt_id = NEW.payment_attempt_id
                              AND cb.verification_id = NEW.payment_verification_id
                              AND cb.callback_fingerprint = evidence_row.callback_fingerprint
                              AND cb.callback_status = 'VERIFIED'
                        )))
               OR (evidence_row.verification_source = 'RECONCILIATION'
                   AND NEW.payment_callback_id IS NOT NULL)
               OR evidence_row.verification_source NOT IN ('CALLBACK', 'RECONCILIATION') THEN
                RAISE EXCEPTION 'Daraja settlement requires matching Daraja verification';
            END IF;
        ELSIF NEW.provider_mode = 'SIMULATOR' THEN
            PERFORM 1
            FROM simulator_payment_confirmations s
            WHERE s.confirmation_id = NEW.simulator_confirmation_id
              AND s.attempt_id = NEW.payment_attempt_id
              AND s.verification_id = NEW.payment_verification_id
              AND s.provider_mode = 'SIMULATOR'
              AND s.outcome = 'SUCCESS'
            FOR SHARE;
            IF NOT FOUND OR evidence_row.verification_source <> 'RECONCILIATION'
               OR evidence_row.callback_result_code IS NOT NULL
               OR evidence_row.callback_receipt IS NOT NULL
               OR evidence_row.transaction_receipt IS NOT NULL
               OR NEW.payment_callback_id IS NOT NULL
               OR evidence_row.simulator_outcome IS DISTINCT FROM 'SUCCESS'
               OR evidence_row.provider_result_description IS NULL
               OR evidence_row.provider_result_description NOT ILIKE
                    'SIMULATED: %no real money was transferred.%' THEN
                RAISE EXCEPTION 'Simulator settlement requires internal simulator success evidence';
            END IF;
        ELSE
            RAISE EXCEPTION 'Unsupported contribution settlement provider';
        END IF;
    ELSIF NEW.movement_type = 'WITHDRAWAL_SETTLEMENT' THEN
        RAISE EXCEPTION 'Withdrawal payout settlement is disabled pending reviewed payout implementation';
    ELSIF NEW.movement_type = 'REVERSAL' THEN
        PERFORM 1 FROM users
        WHERE user_id = NEW.actor_user_id
          AND role = 'ADMIN'
          AND full_name = NEW.actor_name_snapshot
          AND role = NEW.actor_role_snapshot
        FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Reversal requires an authorized administrator actor';
        END IF;
        SELECT * INTO original_row FROM pension_account_movements
        WHERE movement_id = NEW.original_movement_id FOR UPDATE;
        IF NOT FOUND
           OR original_row.movement_type IN ('OPENING_BALANCE', 'REVERSAL')
           OR original_row.account_id <> NEW.account_id
           OR original_row.currency <> NEW.currency
           OR NEW.amount <> -original_row.amount THEN
            RAISE EXCEPTION 'Reversal must exactly compensate one eligible movement';
        END IF;
        IF original_row.movement_type = 'WITHDRAWAL_SETTLEMENT' THEN
            PERFORM 1 FROM withdrawal_payout_return_evidence r
            WHERE r.return_evidence_id = NEW.payout_return_evidence_id
              AND r.payout_attempt_id = original_row.payout_attempt_id
              AND NEW.payout_return_attempt_id = original_row.payout_attempt_id
              AND r.amount = abs(original_row.amount)
            FOR SHARE;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'Payout reversal requires verified returned-funds evidence';
            END IF;
        ELSIF NEW.payout_return_evidence_id IS NOT NULL
           OR NEW.payout_return_attempt_id IS NOT NULL THEN
            RAISE EXCEPTION 'Returned-payout evidence applies only to payout reversals';
        END IF;
    ELSIF NEW.movement_type = 'ADMIN_ADJUSTMENT' THEN
        SELECT * INTO request_row FROM pension_adjustment_requests
        WHERE request_id = NEW.adjustment_request_id FOR SHARE;
        IF NOT FOUND OR request_row.status <> 'APPROVED'
           OR request_row.account_id <> NEW.account_id
           OR request_row.amount <> NEW.amount
           OR request_row.currency <> NEW.currency
           OR request_row.approver_user_id <> NEW.actor_user_id
           OR request_row.approver_name_snapshot <> NEW.actor_name_snapshot
           OR request_row.approver_role_snapshot <> NEW.actor_role_snapshot
           OR request_row.authorization_reference <> NEW.authorization_reference
           OR request_row.reason <> NEW.reason THEN
            RAISE EXCEPTION 'Adjustment movement requires matching approved authorization';
        END IF;
    END IF;

    IF NEW.movement_type IN ('ADMIN_ADJUSTMENT', 'REVERSAL') AND NEW.amount < 0
       OR NEW.movement_type = 'WITHDRAWAL_SETTLEMENT' THEN
        SELECT COALESCE(sum(amount_requested), 0)
        INTO reserved_amount
        FROM withdrawal_claims
        WHERE account_id = NEW.account_id
          AND claim_status = 'APPROVED'
          AND (NEW.movement_type <> 'WITHDRAWAL_SETTLEMENT'
               OR claim_id <> NEW.withdrawal_claim_id);
        IF account_balance + NEW.amount < reserved_amount THEN
            RAISE EXCEPTION 'Movement would consume approved withdrawal reservations';
        END IF;
    END IF;
    IF account_balance + NEW.amount < 0 THEN
        RAISE EXCEPTION 'Movement would create a negative pension balance';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pension_movement_guard
    BEFORE INSERT OR UPDATE OR DELETE ON pension_account_movements
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_guard_movement();

CREATE OR REPLACE FUNCTION pension_ledger_apply_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.movement_type <> 'OPENING_BALANCE' THEN
        UPDATE pension_accounts
        SET current_balance = current_balance + NEW.amount,
            updated_at = now()
        WHERE account_id = NEW.account_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pension_movement_apply_balance
    AFTER INSERT ON pension_account_movements
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_apply_balance();

CREATE OR REPLACE FUNCTION pension_ledger_guard_balance_projection()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.current_balance IS DISTINCT FROM OLD.current_balance
       AND pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'Account balance projection may only be changed by a ledger movement';
    END IF;
    IF NEW.current_balance < 0 THEN
        RAISE EXCEPTION 'Pension account balance cannot be negative';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pension_account_balance_projection
    BEFORE UPDATE OF current_balance ON pension_accounts
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_guard_balance_projection();

CREATE OR REPLACE FUNCTION pension_ledger_open_new_account()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE ledger_row pension_ledger%ROWTYPE;
        batch_id UUID;
BEGIN
    SELECT * INTO ledger_row FROM pension_ledger
    WHERE singleton_key IS TRUE FOR SHARE;
    IF ledger_row.status = 'PREPARING' THEN
        RAISE EXCEPTION 'Account creation is frozen during ledger cutover';
    ELSIF ledger_row.status = 'CLOSED' THEN
        RAISE EXCEPTION 'Accounts cannot be created after ledger closure';
    END IF;
    IF ledger_row.status = 'ACTIVE' THEN
        IF NEW.current_balance <> 0 THEN
            RAISE EXCEPTION 'New accounts must open at zero after ledger activation';
        END IF;
        batch_id := gen_random_uuid();
        INSERT INTO pension_ledger_cutover_batches (
            batch_id, ledger_id, singleton_key, batch_type, account_id,
            captured_at, provenance, migration_actor
        )
        VALUES (
            batch_id, ledger_row.ledger_id, TRUE, 'ACCOUNT_OPENING', NEW.account_id,
            now(), 'New pension account opened at zero balance',
            'SYSTEM:account_creation'
        );
        INSERT INTO pension_account_movements (
            ledger_id, account_id, movement_type, amount, currency, idempotency_key,
            cutover_batch_id, provenance, effective_at, actor_name_snapshot,
            actor_role_snapshot, actor_type, actor_reference, provider_mode
        )
        VALUES (
            ledger_row.ledger_id, NEW.account_id, 'OPENING_BALANCE', 0, 'KES',
            'opening:' || NEW.account_id, batch_id,
            'New pension account opened at zero balance', now(),
            'MicoPesa account creation', 'SYSTEM', 'SYSTEM',
            'SYSTEM:account_creation', 'MIGRATION'
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pension_ledger_open_new_account
    AFTER INSERT ON pension_accounts
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_open_new_account();

CREATE OR REPLACE FUNCTION pension_ledger_guard_settled_contribution()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pension_account_movements m
        WHERE m.contribution_id = OLD.contribution_id
          AND m.movement_type = 'CONTRIBUTION_SETTLEMENT'
    ) AND (
        NEW.contribution_id IS DISTINCT FROM OLD.contribution_id
        OR NEW.account_id IS DISTINCT FROM OLD.account_id
        OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
        OR NEW.amount IS DISTINCT FROM OLD.amount
        OR NEW.channel IS DISTINCT FROM OLD.channel
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.contribution_status <> 'COMPLETED'
    ) THEN
        RAISE EXCEPTION 'Settled contribution source evidence is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pension_ledger_guard_contribution
    BEFORE UPDATE OR DELETE ON contributions
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_guard_settled_contribution();

CREATE OR REPLACE FUNCTION pension_ledger_guard_settled_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pension_account_movements m
        WHERE m.transaction_id = OLD.transaction_id
    ) AND (
        NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
        OR NEW.transaction_type IS DISTINCT FROM OLD.transaction_type
        OR NEW.amount IS DISTINCT FROM OLD.amount
        OR NEW.transaction_status <> 'COMPLETED'
        OR NEW.initiated_at IS DISTINCT FROM OLD.initiated_at
        OR NEW.mpesa_receipt IS DISTINCT FROM OLD.mpesa_receipt
        OR NEW.checkout_request_id IS DISTINCT FROM OLD.checkout_request_id
        OR NEW.mpesa_phone IS DISTINCT FROM OLD.mpesa_phone
        OR NEW.mpesa_result_code IS DISTINCT FROM OLD.mpesa_result_code
        OR NEW.mpesa_result_description IS DISTINCT FROM OLD.mpesa_result_description
        OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
    ) THEN
        RAISE EXCEPTION 'Settled transaction source evidence is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pension_ledger_guard_transaction
    BEFORE UPDATE OR DELETE ON transactions
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_guard_settled_transaction();

CREATE OR REPLACE FUNCTION pension_ledger_guard_attempt_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND EXISTS (
        SELECT 1 FROM pension_account_movements m
        WHERE m.payment_attempt_id = OLD.attempt_id
    ) THEN
        RAISE EXCEPTION 'Payment attempt referenced by a ledger movement cannot be deleted';
    END IF;
    IF TG_OP = 'UPDATE' AND EXISTS (
        SELECT 1 FROM pension_account_movements m
        WHERE m.payment_attempt_id = OLD.attempt_id
    ) AND (
        NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.account_id IS DISTINCT FROM OLD.account_id
        OR NEW.contribution_id IS DISTINCT FROM OLD.contribution_id
        OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
        OR NEW.expected_amount IS DISTINCT FROM OLD.expected_amount
        OR NEW.mpesa_phone IS DISTINCT FROM OLD.mpesa_phone
        OR NEW.attempt_status IS DISTINCT FROM OLD.attempt_status
        OR NEW.provider_mode IS DISTINCT FROM OLD.provider_mode
        OR NEW.checkout_request_id IS DISTINCT FROM OLD.checkout_request_id
        OR NEW.merchant_request_id IS DISTINCT FROM OLD.merchant_request_id
        OR NEW.provider_result_code IS DISTINCT FROM OLD.provider_result_code
        OR NEW.provider_result_description IS DISTINCT FROM OLD.provider_result_description
        OR NEW.provider_accepted_at IS DISTINCT FROM OLD.provider_accepted_at
    ) THEN
        RAISE EXCEPTION 'Settled payment attempt evidence is immutable';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_pension_ledger_guard_attempt_evidence
    BEFORE UPDATE OR DELETE ON mpesa_payment_attempts
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_guard_attempt_evidence();

CREATE OR REPLACE FUNCTION pension_ledger_guard_verification_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pension_account_movements m
        WHERE m.payment_verification_id = OLD.verification_id
    ) THEN
        RAISE EXCEPTION 'Payment verification referenced by a movement is immutable';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_pension_ledger_guard_verification_evidence
    BEFORE UPDATE OR DELETE ON mpesa_payment_verifications
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_guard_verification_evidence();

CREATE OR REPLACE FUNCTION pension_ledger_guard_callback_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND EXISTS (
        SELECT 1 FROM pension_account_movements m
        WHERE m.payment_callback_id = OLD.callback_id
    ) THEN
        RAISE EXCEPTION 'Callback evidence referenced by a movement cannot be deleted';
    END IF;
    IF TG_OP = 'UPDATE' AND EXISTS (
        SELECT 1 FROM pension_account_movements m
        WHERE m.payment_callback_id = OLD.callback_id
    ) AND (
        NEW.callback_fingerprint IS DISTINCT FROM OLD.callback_fingerprint
        OR NEW.checkout_request_id IS DISTINCT FROM OLD.checkout_request_id
        OR NEW.merchant_request_id IS DISTINCT FROM OLD.merchant_request_id
        OR NEW.callback_result_code IS DISTINCT FROM OLD.callback_result_code
        OR NEW.callback_amount IS DISTINCT FROM OLD.callback_amount
        OR NEW.callback_phone IS DISTINCT FROM OLD.callback_phone
        OR NEW.callback_receipt IS DISTINCT FROM OLD.callback_receipt
        OR NEW.received_at IS DISTINCT FROM OLD.received_at
        OR NEW.correlated_at IS DISTINCT FROM OLD.correlated_at
        OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
        OR NEW.rejection_code IS DISTINCT FROM OLD.rejection_code
        OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
        OR NEW.verification_id IS DISTINCT FROM OLD.verification_id
        OR NEW.callback_status <> 'VERIFIED'
    ) THEN
        RAISE EXCEPTION 'Verified callback evidence referenced by a movement is immutable';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_pension_ledger_guard_callback_evidence
    BEFORE UPDATE OR DELETE ON mpesa_callback_inbox
    FOR EACH ROW EXECUTE FUNCTION pension_ledger_guard_callback_evidence();

CREATE OR REPLACE FUNCTION pension_ledger_activate()
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE missing_count BIGINT;
        mismatch_count BIGINT;
BEGIN
    PERFORM 1 FROM pension_ledger WHERE singleton_key IS TRUE FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ledger singleton is missing';
    END IF;
    SELECT count(*) INTO missing_count
    FROM pension_accounts a
    WHERE NOT EXISTS (
        SELECT 1 FROM pension_account_movements m
        WHERE m.account_id = a.account_id
          AND m.movement_type = 'OPENING_BALANCE'
    );
    SELECT count(*) INTO mismatch_count
    FROM pension_accounts a
    JOIN pension_account_movements m
      ON m.account_id = a.account_id
     AND m.movement_type = 'OPENING_BALANCE'
    WHERE m.amount <> a.current_balance;
    IF missing_count <> 0 OR mismatch_count <> 0 THEN
        RAISE EXCEPTION 'Ledger activation blocked: missing or mismatched opening balances';
    END IF;
    UPDATE pension_ledger
    SET status = 'ACTIVE', activated_at = now()
    WHERE singleton_key IS TRUE AND status = 'PREPARING';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ledger is not in PREPARING state';
    END IF;
END;
$$;

-- Immutable identifiers are fixed for the one-time cutover. ON CONFLICT never
-- overwrites a previously created identity, batch, or provenance.
INSERT INTO pension_ledger (singleton_key, ledger_id, status)
VALUES (TRUE, '6f13cc0e-5d28-4f85-935d-342ff9cb7736', 'PREPARING')
ON CONFLICT (singleton_key) DO NOTHING;

DO $$
DECLARE ledger_row pension_ledger%ROWTYPE;
BEGIN
    SELECT * INTO ledger_row FROM pension_ledger
    WHERE singleton_key IS TRUE FOR UPDATE;
    IF ledger_row.ledger_id <> '6f13cc0e-5d28-4f85-935d-342ff9cb7736'::UUID
       OR ledger_row.status IN ('ACTIVE', 'CLOSED') THEN
        RAISE EXCEPTION 'Existing ledger identity conflicts with this cutover';
    END IF;
END;
$$;

INSERT INTO pension_ledger_cutover_batches
    (batch_id, ledger_id, singleton_key, batch_type, captured_at, provenance, migration_actor)
SELECT 'c14ad635-883f-4efb-9502-310bd3c2c241'::UUID,
       ledger_id, TRUE, 'INITIAL_CUTOVER', now(),
       'Opening balance snapshot at pension ledger cutover',
       'MIGRATION:pension-account-ledger'
FROM pension_ledger
WHERE singleton_key IS TRUE
ON CONFLICT (ledger_id) WHERE batch_type = 'INITIAL_CUTOVER' DO NOTHING;

DO $$
DECLARE batch_row pension_ledger_cutover_batches%ROWTYPE;
BEGIN
    SELECT * INTO batch_row FROM pension_ledger_cutover_batches
    WHERE batch_type = 'INITIAL_CUTOVER' FOR UPDATE;
    IF batch_row.batch_id <> 'c14ad635-883f-4efb-9502-310bd3c2c241'::UUID
       OR batch_row.provenance <> 'Opening balance snapshot at pension ledger cutover'
       OR batch_row.migration_actor <> 'MIGRATION:pension-account-ledger' THEN
        RAISE EXCEPTION 'Existing cutover batch does not match expected provenance';
    END IF;
END;
$$;

DO $$
DECLARE mismatch_count BIGINT;
BEGIN
    SELECT count(*) INTO mismatch_count
    FROM pension_account_movements m
    JOIN pension_accounts a ON a.account_id = m.account_id
    LEFT JOIN pension_ledger_cutover_batches b
      ON b.batch_id = m.cutover_batch_id
     AND b.ledger_id = m.ledger_id
    WHERE m.movement_type = 'OPENING_BALANCE'
      AND (m.ledger_id <> '6f13cc0e-5d28-4f85-935d-342ff9cb7736'::UUID
           OR m.amount <> a.current_balance
           OR m.currency <> 'KES'
           OR m.idempotency_key <> 'opening:' || a.account_id
           OR m.cutover_batch_id <> 'c14ad635-883f-4efb-9502-310bd3c2c241'::UUID
           OR b.batch_type IS DISTINCT FROM 'INITIAL_CUTOVER'
           OR b.account_id IS NOT NULL
           OR b.singleton_key IS DISTINCT FROM TRUE
           OR m.provenance IS DISTINCT FROM
                'Opening balance snapshot at pension ledger cutover'
           OR m.actor_reference IS DISTINCT FROM 'MIGRATION:pension-account-ledger'
           OR m.actor_type <> 'MIGRATION'
           OR m.actor_name_snapshot <> 'pension-account-ledger migration'
           OR m.actor_role_snapshot <> 'MIGRATION'
           OR m.provider_mode <> 'MIGRATION');
    IF mismatch_count > 0 THEN
        RAISE EXCEPTION 'Existing opening movement mismatch; refusing to overwrite';
    END IF;

    INSERT INTO pension_account_movements (
        ledger_id, account_id, movement_type, amount, currency, idempotency_key,
        cutover_batch_id, provenance, effective_at, actor_name_snapshot,
        actor_role_snapshot, actor_type, actor_reference, provider_mode
    )
    SELECT '6f13cc0e-5d28-4f85-935d-342ff9cb7736'::UUID,
           a.account_id, 'OPENING_BALANCE', a.current_balance, 'KES',
           'opening:' || a.account_id,
           'c14ad635-883f-4efb-9502-310bd3c2c241'::UUID,
           b.provenance,
           b.captured_at, 'pension-account-ledger migration', 'MIGRATION', 'MIGRATION',
           'MIGRATION:pension-account-ledger', 'MIGRATION'
    FROM pension_accounts a
    JOIN pension_ledger_cutover_batches b
      ON b.batch_id = 'c14ad635-883f-4efb-9502-310bd3c2c241'::UUID
     AND b.ledger_id = '6f13cc0e-5d28-4f85-935d-342ff9cb7736'::UUID
    WHERE NOT EXISTS (
        SELECT 1 FROM pension_account_movements existing
        WHERE existing.account_id = a.account_id
          AND existing.movement_type = 'OPENING_BALANCE'
    );
END;
$$;

DO $$
DECLARE missing_count BIGINT;
        mismatch_count BIGINT;
BEGIN
    SELECT count(*) INTO missing_count
    FROM pension_accounts a
    WHERE NOT EXISTS (
        SELECT 1 FROM pension_account_movements m
        WHERE m.account_id = a.account_id
          AND m.movement_type = 'OPENING_BALANCE'
    );
    SELECT count(*) INTO mismatch_count
    FROM pension_accounts a
    JOIN pension_account_movements m
      ON m.account_id = a.account_id AND m.movement_type = 'OPENING_BALANCE'
    LEFT JOIN pension_ledger_cutover_batches b
      ON b.batch_id = m.cutover_batch_id
     AND b.ledger_id = m.ledger_id
    WHERE m.amount <> a.current_balance
       OR m.ledger_id <> '6f13cc0e-5d28-4f85-935d-342ff9cb7736'::UUID
       OR m.currency <> 'KES'
       OR m.idempotency_key <> 'opening:' || a.account_id
       OR m.cutover_batch_id <> 'c14ad635-883f-4efb-9502-310bd3c2c241'::UUID
       OR b.batch_type IS DISTINCT FROM 'INITIAL_CUTOVER'
       OR b.account_id IS NOT NULL
       OR b.singleton_key IS DISTINCT FROM TRUE
       OR m.provenance IS DISTINCT FROM
            'Opening balance snapshot at pension ledger cutover'
       OR m.actor_reference IS DISTINCT FROM 'MIGRATION:pension-account-ledger'
       OR m.actor_type <> 'MIGRATION'
       OR m.actor_name_snapshot <> 'pension-account-ledger migration'
       OR m.actor_role_snapshot <> 'MIGRATION'
       OR m.provider_mode <> 'MIGRATION';
    IF missing_count <> 0 OR mismatch_count <> 0 THEN
        RAISE EXCEPTION 'Cutover snapshot validation failed';
    END IF;
END;
$$;

COMMIT;

-- Activation is intentionally separate and must occur only after operational
-- reconciliation and application compatibility checks. Call:
-- SELECT pension_ledger_activate();
