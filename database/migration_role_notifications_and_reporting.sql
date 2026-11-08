-- Add explicit regulator fund scopes, role-aware notification audit metadata,
-- and private report-generation history. Apply after
-- migration_unified_notifications.sql.
BEGIN;

CREATE TABLE regulator_fund_assignments (
    assignment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    regulator_user_id VARCHAR(25) NOT NULL
        REFERENCES users (user_id) ON DELETE CASCADE,
    fund_id VARCHAR(25) NOT NULL
        REFERENCES funds (fund_id) ON DELETE CASCADE,
    assigned_by VARCHAR(25)
        REFERENCES users (user_id) ON DELETE SET NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT uq_regulator_fund_assignment UNIQUE (regulator_user_id, fund_id)
);

CREATE INDEX idx_regulator_fund_assignments_active
    ON regulator_fund_assignments (regulator_user_id, fund_id)
    WHERE active = TRUE;

CREATE FUNCTION enforce_regulator_fund_assignment_roles()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM users
        WHERE user_id = NEW.regulator_user_id AND role = 'REGULATOR'
    ) THEN
        RAISE EXCEPTION 'regulator_user_id must reference a REGULATOR';
    END IF;
    IF NEW.assigned_by IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM users
        WHERE user_id = NEW.assigned_by AND role = 'ADMIN'
    ) THEN
        RAISE EXCEPTION 'assigned_by must reference an ADMIN';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_regulator_fund_assignment_roles
    BEFORE INSERT OR UPDATE OF regulator_user_id, assigned_by
    ON regulator_fund_assignments
    FOR EACH ROW
    EXECUTE FUNCTION enforce_regulator_fund_assignment_roles();

ALTER TABLE notifications
    ADD COLUMN notification_category VARCHAR(40) NOT NULL DEFAULT 'GENERAL',
    ADD COLUMN scope_fund_id VARCHAR(25)
        REFERENCES funds (fund_id) ON DELETE SET NULL,
    ADD CONSTRAINT ck_notifications_category CHECK (
        notification_category IN (
            'GENERAL', 'ANNOUNCEMENT', 'CONTRIBUTION_REMINDER', 'SCHEME_UPDATE',
            'ACCOUNT_SERVICE', 'REGULATORY_ADVISORY', 'COMPLIANCE_NOTICE',
            'DEADLINE_REMINDER', 'WORKER_EDUCATION'
        )
    );

CREATE INDEX idx_notifications_scope_fund_created
    ON notifications (scope_fund_id, created_at DESC)
    WHERE scope_fund_id IS NOT NULL;

DROP INDEX uq_notifications_admin_request_channel;
CREATE UNIQUE INDEX uq_notifications_admin_request_channel
    ON notifications (admin_request_key, user_id, notification_type)
    WHERE admin_request_key IS NOT NULL;

CREATE TABLE notification_audit_events (
    audit_event_id BIGSERIAL PRIMARY KEY,
    request_id UUID NOT NULL,
    sender_user_id VARCHAR(25),
    sender_role VARCHAR(20) NOT NULL
        CHECK (sender_role IN ('ADMIN', 'FUND_MANAGER', 'REGULATOR', 'SYSTEM')),
    recipient_user_id VARCHAR(25),
    scope_fund_id VARCHAR(25),
    notification_category VARCHAR(40) NOT NULL,
    channels JSONB NOT NULL
        CHECK (jsonb_typeof(channels) = 'array'),
    notification_ids JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(notification_ids) = 'array'),
    authorization_outcome VARCHAR(20) NOT NULL
        CHECK (authorization_outcome IN ('AUTHORIZED', 'DENIED')),
    outcome_code VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_notification_audit_sender_created
    ON notification_audit_events (sender_user_id, created_at DESC);
CREATE INDEX idx_notification_audit_scope_created
    ON notification_audit_events (scope_fund_id, created_at DESC);
CREATE INDEX idx_notification_audit_recipient_created
    ON notification_audit_events (recipient_user_id, created_at DESC);

WITH legacy_events AS (
    SELECT n.notification_id, n.admin_request_key,
           COALESCE(n.admin_request_key, gen_random_uuid()) AS request_id,
           n.created_by, sender.role AS sender_role, n.user_id,
           n.scope_fund_id, n.notification_category, n.notification_type,
           n.created_at
    FROM notifications n
    LEFT JOIN users sender ON sender.user_id = n.created_by
)
INSERT INTO notification_audit_events (
    request_id, sender_user_id, sender_role, recipient_user_id, scope_fund_id,
    notification_category, channels, notification_ids, authorization_outcome, created_at
)
SELECT request_id, created_by,
       CASE WHEN sender_role IN ('ADMIN', 'FUND_MANAGER', 'REGULATOR')
            THEN sender_role ELSE 'SYSTEM' END,
       user_id, scope_fund_id, notification_category,
       jsonb_agg(DISTINCT to_jsonb(notification_type)),
       jsonb_agg(to_jsonb(notification_id) ORDER BY notification_id),
       'AUTHORIZED', min(created_at)
FROM legacy_events
GROUP BY request_id, created_by, sender_role, user_id, scope_fund_id, notification_category;

CREATE FUNCTION reject_notification_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'notification audit events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notification_audit_append_only
    BEFORE UPDATE OR DELETE ON notification_audit_events
    FOR EACH ROW
    EXECUTE FUNCTION reject_notification_audit_mutation();

CREATE TABLE report_generation_history (
    report_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    generated_by VARCHAR(25)
        REFERENCES users (user_id) ON DELETE SET NULL,
    generator_role VARCHAR(20) NOT NULL
        CHECK (generator_role IN ('ADMIN', 'FUND_MANAGER', 'REGULATOR')),
    report_key VARCHAR(60) NOT NULL,
    export_format VARCHAR(10) NOT NULL
        CHECK (export_format IN ('CSV', 'XLSX', 'PDF')),
    applied_filters JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(applied_filters) = 'object'),
    scope_fund_ids JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(scope_fund_ids) = 'array'),
    generation_status VARCHAR(20) NOT NULL
        CHECK (generation_status IN ('SUCCEEDED', 'FAILED')),
    result_count INTEGER NOT NULL DEFAULT 0 CHECK (result_count >= 0),
    generated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_report_generation_history_user_created
    ON report_generation_history (generated_by, generated_at DESC);

CREATE TABLE report_download_events (
    download_event_id BIGSERIAL PRIMARY KEY,
    report_id UUID NOT NULL,
    downloaded_by VARCHAR(25),
    downloaded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    outcome VARCHAR(20) NOT NULL
        CHECK (outcome IN ('SUCCEEDED', 'DENIED', 'FAILED'))
);

CREATE INDEX idx_report_download_events_report
    ON report_download_events (report_id, downloaded_at DESC);

CREATE FUNCTION reject_report_download_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'report download events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_report_download_events_append_only
    BEFORE UPDATE OR DELETE ON report_download_events
    FOR EACH ROW
    EXECUTE FUNCTION reject_report_download_mutation();

COMMIT;
