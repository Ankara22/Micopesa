-- Add in-app event notifications and explicit opt-in preferences for
-- transactional SMS/email. Apply after migration_sms_persistent_delivery.sql
-- and migration_unified_notifications.sql. Never apply after schema.sql,
-- which already contains the same index and preferences table.
BEGIN;

DO $$
BEGIN
    IF to_regclass('notifications') IS NULL
       OR NOT EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'notifications'
             AND column_name = 'deduplication_key'
       ) THEN
        RAISE EXCEPTION
            'Incompatible schema: apply the persistent notification migration before transactional notifications';
    END IF;

    IF to_regclass('notification_preferences') IS NOT NULL
       OR to_regclass('uq_notifications_user_channel_event_key') IS NOT NULL THEN
        RAISE EXCEPTION
            'Transactional notification objects already exist; do not reapply this upgrade migration';
    END IF;
END $$;

ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS notifications_notification_type_check,
    ADD CONSTRAINT ck_notifications_notification_type
        CHECK (notification_type IN ('SMS', 'EMAIL', 'PUSH', 'USSD', 'IN_APP'));

CREATE UNIQUE INDEX uq_notifications_user_channel_event_key
    ON notifications (user_id, notification_type, deduplication_key)
    WHERE deduplication_key IS NOT NULL;

CREATE TABLE notification_preferences (
    user_id VARCHAR(25) PRIMARY KEY
        REFERENCES users (user_id) ON DELETE CASCADE,
    sms_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_notification_preferences_set_updated_at
    BEFORE UPDATE ON notification_preferences
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

COMMIT;
