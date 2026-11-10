-- Proposed prerequisite for administrator-initiated one-time external SMS.
-- Do not apply until Mobile Sasa has approved full sending access and this
-- migration has been reviewed for the target database.
--
-- External notifications keep user_id NULL rather than attributing the
-- recipient to an unrelated account. The notification ID remains compatible
-- with the existing Mobile Sasa delivery-report correlation flow.
BEGIN;

ALTER TABLE notifications
    ALTER COLUMN user_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS external_recipient_consent_at TIMESTAMPTZ;

ALTER TABLE notifications
    ADD CONSTRAINT ck_notifications_external_recipient CHECK (
        (
            user_id IS NOT NULL
            AND external_recipient_consent_at IS NULL
        )
        OR
        (
            user_id IS NULL
            AND notification_type = 'SMS'
            AND recipient_phone IS NOT NULL
            AND recipient_phone ~ '^[+]254[17][0-9]{8}$'
            AND admin_request_key IS NOT NULL
            AND external_recipient_consent_at IS NOT NULL
        )
    );

-- A deleted administrator should not prevent retention of an external
-- notification: created_by is already ON DELETE SET NULL and the audit event
-- retains the sender ID. The channel snapshot remains mandatory.
ALTER TABLE notifications
    DROP CONSTRAINT ck_notifications_admin_channel_snapshot,
    ADD CONSTRAINT ck_notifications_admin_channel_snapshot CHECK (
        admin_request_key IS NULL
        OR (
            (created_by IS NOT NULL OR user_id IS NULL)
            AND notification_type IN ('SMS', 'EMAIL', 'PUSH')
            AND (
                (notification_type = 'SMS' AND recipient_phone IS NOT NULL)
                OR (notification_type = 'EMAIL'
                    AND recipient_email IS NOT NULL
                    AND email_subject IS NOT NULL)
                OR (notification_type = 'PUSH' AND push_title IS NOT NULL)
            )
        )
    );

CREATE UNIQUE INDEX uq_notifications_external_request
    ON notifications (admin_request_key)
    WHERE user_id IS NULL;

CREATE INDEX idx_notifications_external_admin_created
    ON notifications (created_by, created_at DESC)
    WHERE user_id IS NULL;

-- Rollback must first retain any external SMS evidence required by policy.
-- Dropping the new columns/index and restoring user_id NOT NULL will fail if
-- external records remain, and deleting them would discard consent, delivery,
-- recipient, and idempotency evidence. Export/retain that evidence before
-- rollback. Audit events retain their notification IDs and link to that row.
COMMIT;
