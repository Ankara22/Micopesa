-- Add admin email/push snapshots and durable browser push subscriptions.
-- Apply after migration_sms_persistent_delivery.sql; this migration is not
-- safe to apply to a schema that has not yet been upgraded for SMS delivery.
BEGIN;

ALTER TABLE notifications
    ALTER COLUMN message TYPE TEXT,
    ADD COLUMN recipient_email VARCHAR(254),
    ADD COLUMN email_subject VARCHAR(255),
    ADD COLUMN email_html_body TEXT,
    ADD COLUMN push_title VARCHAR(100),
    ADD COLUMN admin_request_key UUID,
    ADD COLUMN delivery_result JSONB;

ALTER TABLE notifications
    ADD CONSTRAINT ck_notifications_admin_channel_snapshot
    CHECK (
        admin_request_key IS NULL
        OR (
            created_by IS NOT NULL
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

CREATE UNIQUE INDEX uq_notifications_admin_request_channel
    ON notifications (admin_request_key, notification_type)
    WHERE admin_request_key IS NOT NULL;

CREATE TABLE push_subscriptions (
    subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(25) NOT NULL
        REFERENCES users (user_id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh_key VARCHAR(255) NOT NULL,
    auth_key VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT ck_push_subscriptions_endpoint CHECK (
        endpoint ~ '^https://'
    ),
    CONSTRAINT ck_push_subscriptions_keys CHECK (
        p256dh_key ~ '^[A-Za-z0-9_-]{40,200}$'
        AND auth_key ~ '^[A-Za-z0-9_-]{16,100}$'
    )
);

CREATE INDEX idx_push_subscriptions_user_id
    ON push_subscriptions (user_id);

CREATE TRIGGER trg_push_subscriptions_set_updated_at
    BEFORE UPDATE ON push_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

COMMIT;
