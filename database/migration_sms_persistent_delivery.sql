-- Add durable SMS delivery state and safe multi-instance worker claiming.
-- Existing SENT records are conservatively treated as provider acceptance,
-- not proof of handset delivery.
BEGIN;

ALTER TABLE notifications
    ADD COLUMN recipient_phone VARCHAR(16),
    ADD COLUMN deduplication_key VARCHAR(128),
    ADD COLUMN provider_message_id VARCHAR(128),
    ADD COLUMN provider_accepted_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN delivered_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    ADD COLUMN claimed_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN claim_token UUID,
    ADD COLUMN last_attempt_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN last_error_code VARCHAR(64);

ALTER TABLE notifications
    DROP CONSTRAINT notifications_delivery_status_check;

ALTER TABLE notifications
    ALTER COLUMN delivery_status TYPE VARCHAR(20);

UPDATE notifications
SET delivery_status = 'PROVIDER_ACCEPTED',
    provider_accepted_at = COALESCE(sent_at, updated_at)
WHERE delivery_status = 'SENT';

ALTER TABLE notifications
    ADD CONSTRAINT ck_notifications_delivery_status
        CHECK (delivery_status IN (
            'PENDING',
            'PROCESSING',
            'PROVIDER_ACCEPTED',
            'DELIVERED',
            'FAILED',
            'UNKNOWN'
        )),
    ADD CONSTRAINT ck_notifications_attempt_count
        CHECK (attempt_count >= 0),
    ADD CONSTRAINT ck_notifications_claim_fields
        CHECK (
            (delivery_status = 'PROCESSING'
                AND claimed_at IS NOT NULL
                AND claim_token IS NOT NULL)
            OR
            (delivery_status <> 'PROCESSING'
                AND claimed_at IS NULL
                AND claim_token IS NULL)
        ),
    ADD CONSTRAINT ck_notifications_delivery_timestamps
        CHECK (
            (delivery_status NOT IN ('PROVIDER_ACCEPTED', 'DELIVERED')
                OR provider_accepted_at IS NOT NULL)
            AND
            (delivery_status <> 'DELIVERED' OR delivered_at IS NOT NULL)
        );

CREATE UNIQUE INDEX uq_notifications_sms_deduplication_key
    ON notifications (deduplication_key)
    WHERE notification_type = 'SMS' AND deduplication_key IS NOT NULL;

CREATE UNIQUE INDEX uq_notifications_provider_message_id
    ON notifications (provider_message_id)
    WHERE provider_message_id IS NOT NULL;

CREATE UNIQUE INDEX uq_notifications_claim_token
    ON notifications (claim_token)
    WHERE claim_token IS NOT NULL;

CREATE INDEX idx_notifications_sms_pending_schedule
    ON notifications (next_attempt_at, created_at)
    WHERE notification_type = 'SMS' AND delivery_status = 'PENDING';

CREATE INDEX idx_notifications_sms_processing_claim
    ON notifications (claimed_at)
    WHERE notification_type = 'SMS' AND delivery_status = 'PROCESSING';

COMMIT;
