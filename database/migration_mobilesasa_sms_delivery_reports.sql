-- Proposed prerequisite for Mobile Sasa SMS delivery-report webhooks.
-- Do not apply until reviewed and explicitly approved for a specific database.
-- Deleting a notification clears only the live FK; original_notification_id
-- and the callback evidence remain. This inbox has no automatic purge policy.
-- Rolling back by dropping this table permanently deletes all stored callbacks.
BEGIN;

DO $$
DECLARE
    required_column TEXT;
BEGIN
    IF to_regclass('notifications') IS NULL THEN
        RAISE EXCEPTION
            'Incompatible schema: notifications must exist before the Mobile Sasa callback inbox';
    END IF;
    IF to_regclass('mobilesasa_sms_delivery_callbacks') IS NOT NULL THEN
        RAISE EXCEPTION
            'Mobile Sasa callback inbox already exists; do not reapply this upgrade migration';
    END IF;

    FOREACH required_column IN ARRAY ARRAY[
        'notification_id',
        'notification_type',
        'delivery_status',
        'delivery_result',
        'provider_message_id'
    ]
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'notifications'
              AND column_name = required_column
        ) THEN
            RAISE EXCEPTION
                'Incompatible schema: notifications.% is required for delivery reports',
                required_column;
        END IF;
    END LOOP;
END $$;

CREATE TABLE mobilesasa_sms_delivery_callbacks (
    callback_id                 BIGSERIAL PRIMARY KEY,
    provider                    VARCHAR(20) NOT NULL DEFAULT 'MOBILE_SASA'
        CHECK (provider = 'MOBILE_SASA'),
    provider_message_reference  VARCHAR(128) NOT NULL
        CHECK (provider_message_reference <> ''),
    tracking_id                 VARCHAR(128),
    provider_dispatch_reference VARCHAR(128),
    delivery_status             VARCHAR(20) NOT NULL
        CHECK (delivery_status IN (
            'SENT', 'DELIVERED', 'FAILED', 'REJECTED', 'EXPIRED', 'UNREACHABLE'
        )),
    delivery_description        VARCHAR(255),
    delivery_code               VARCHAR(40),
    gateway                     VARCHAR(40),
    provider_delivery_time      VARCHAR(40),
    provider_delivered_at       TIMESTAMP WITH TIME ZONE,
    provider_reported_at        TIMESTAMP WITH TIME ZONE,
    notification_id             VARCHAR(25)
        REFERENCES notifications (notification_id) ON DELETE SET NULL,
    original_notification_id    VARCHAR(25),
    processing_status           VARCHAR(20) NOT NULL DEFAULT 'UNMATCHED'
        CHECK (processing_status IN (
            'UNMATCHED', 'CORRELATED', 'APPLIED', 'IGNORED', 'REJECTED'
        )),
    rejection_code              VARCHAR(64)
        CHECK (rejection_code IS NULL OR rejection_code ~ '^[A-Z0-9_]{1,64}$'),
    duplicate_count             INTEGER NOT NULL DEFAULT 0
        CHECK (duplicate_count >= 0),
    signature_verified_at       TIMESTAMP WITH TIME ZONE NOT NULL,
    received_at                 TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    correlated_at               TIMESTAMP WITH TIME ZONE,
    processed_at                TIMESTAMP WITH TIME ZONE,
    updated_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT uq_mobilesasa_callback_provider_reference_status
        UNIQUE (provider, provider_message_reference, delivery_status),
    CONSTRAINT ck_mobilesasa_callback_notification_reference CHECK (
        notification_id IS NULL
        OR (
            original_notification_id IS NOT NULL
            AND original_notification_id = notification_id
        )
    ),
    CONSTRAINT ck_mobilesasa_callback_lifecycle CHECK (
        (processing_status = 'UNMATCHED'
            AND notification_id IS NULL
            AND original_notification_id IS NULL
            AND correlated_at IS NULL
            AND processed_at IS NULL
            AND rejection_code IS NULL)
        OR (processing_status = 'CORRELATED'
            AND (notification_id IS NOT NULL OR original_notification_id IS NOT NULL)
            AND correlated_at IS NOT NULL
            AND processed_at IS NULL
            AND rejection_code IS NULL)
        OR (processing_status IN ('APPLIED', 'IGNORED')
            AND (notification_id IS NOT NULL OR original_notification_id IS NOT NULL)
            AND correlated_at IS NOT NULL
            AND processed_at IS NOT NULL
            AND rejection_code IS NULL)
        OR (processing_status = 'REJECTED'
            AND processed_at IS NOT NULL
            AND rejection_code IS NOT NULL)
    )
);

CREATE FUNCTION preserve_mobilesasa_callback_notification_reference()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.original_notification_id :=
            COALESCE(NEW.original_notification_id, NEW.notification_id);
    ELSIF OLD.notification_id IS NOT NULL AND NEW.notification_id IS NULL THEN
        NEW.original_notification_id :=
            COALESCE(NEW.original_notification_id, OLD.notification_id);
    ELSIF NEW.notification_id IS NOT NULL THEN
        IF OLD.original_notification_id IS NOT NULL
            AND OLD.original_notification_id <> NEW.notification_id THEN
            RAISE EXCEPTION 'A callback cannot be reassigned to another notification';
        END IF;
        NEW.original_notification_id :=
            COALESCE(NEW.original_notification_id, NEW.notification_id);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_mobilesasa_callbacks_preserve_notification_reference
    BEFORE INSERT OR UPDATE OF notification_id
    ON mobilesasa_sms_delivery_callbacks
    FOR EACH ROW
    EXECUTE FUNCTION preserve_mobilesasa_callback_notification_reference();

CREATE INDEX idx_mobilesasa_callbacks_unmatched
    ON mobilesasa_sms_delivery_callbacks (received_at, callback_id)
    WHERE processing_status = 'UNMATCHED';
CREATE INDEX idx_mobilesasa_callbacks_notification
    ON mobilesasa_sms_delivery_callbacks (notification_id, received_at DESC)
    WHERE notification_id IS NOT NULL;
CREATE INDEX idx_mobilesasa_callbacks_original_notification
    ON mobilesasa_sms_delivery_callbacks (original_notification_id, received_at DESC)
    WHERE original_notification_id IS NOT NULL;
CREATE INDEX idx_mobilesasa_callbacks_tracking_id
    ON mobilesasa_sms_delivery_callbacks (tracking_id)
    WHERE tracking_id IS NOT NULL;
CREATE INDEX idx_mobilesasa_callbacks_dispatch_reference
    ON mobilesasa_sms_delivery_callbacks (provider_dispatch_reference)
    WHERE provider_dispatch_reference IS NOT NULL;

CREATE TRIGGER trg_mobilesasa_callbacks_set_updated_at
    BEFORE UPDATE ON mobilesasa_sms_delivery_callbacks
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Rollback must drop the table, triggers, and helper function together.
-- Dropping the table irreversibly discards callback evidence and deduplication
-- history. Preserve or export records first if retention obligations require it.
COMMIT;
