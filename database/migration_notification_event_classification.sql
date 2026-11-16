BEGIN;

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS notification_event_type VARCHAR(40);

ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS ck_notifications_event_type;

COMMIT;
