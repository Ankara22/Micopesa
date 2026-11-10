const STATUS_MAP = new Map([
    ["Sent", "SENT"],
    ["Delivered", "DELIVERED"],
    ["Failed", "FAILED"],
    ["Rejected", "REJECTED"],
    ["Expired", "EXPIRED"],
    ["Unreachable", "UNREACHABLE"],
]);
const LEGACY_STATUS_MAP = new Map([
    ["deliveredtoterminal", "DELIVERED"],
    ["delivrd", "DELIVERED"],
    ["absentsubscriber", "UNREACHABLE"],
    ["deliveryimpossible", "FAILED"],
    ["sendername blacklisted", "REJECTED"],
    ["sent", "SENT"],
    ["delivered", "DELIVERED"],
    ["failed", "FAILED"],
    ["rejected", "REJECTED"],
    ["expired", "EXPIRED"],
    ["unreachable", "UNREACHABLE"],
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function repositoryError(message, code, statusCode = 503) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function sanitizedDescription(value) {
    if (typeof value !== "string") return null;
    return value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
        .replace(/(?:\+?254|0)[17]\d{8}\b/g, "[phone]")
        .slice(0, 255);
}

function parseProviderDeliveryTime(value) {
    if (typeof value !== "string") return null;
    const nairobiTime = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
    if (nairobiTime) {
        const [, yearText, monthText, dayText, hourText, minuteText, secondText] = nairobiTime;
        const parts = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
        const [year, month, day, hour, minute, second] = parts;
        const calendarDate = new Date(Date.UTC(year, month - 1, day));
        if (
            calendarDate.getUTCFullYear() !== year ||
            calendarDate.getUTCMonth() !== month - 1 ||
            calendarDate.getUTCDate() !== day ||
            hour > 23 || minute > 59 || second > 59
        ) {
            return null;
        }
        return new Date(`${value.replace(" ", "T")}+03:00`).toISOString();
    }
    if (/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value))) {
        return new Date(value).toISOString();
    }
    return null;
}

function normalizeDeliveryReport(report, receivedAt = new Date()) {
    const rawStatus = typeof report?.status === "string" && report.status
        ? report.status
        : report?.deliveryStatus;
    const status = typeof rawStatus === "string"
        ? STATUS_MAP.get(rawStatus) || LEGACY_STATUS_MAP.get(rawStatus.toLowerCase())
        : null;
    const providerMessageReference = typeof report?.reference === "string" &&
        IDENTIFIER_PATTERN.test(report.reference)
        ? report.reference
        : null;
    const trackingId = report?.trackingId === undefined || report.trackingId === ""
        ? null
        : typeof report.trackingId === "string" && IDENTIFIER_PATTERN.test(report.trackingId)
            ? report.trackingId
            : null;
    const providerDispatchReference =
        typeof report?.dlr?.tracking_id === "string" &&
        IDENTIFIER_PATTERN.test(report.dlr.tracking_id)
            ? report.dlr.tracking_id
            : null;

    if (!status || !providerMessageReference) {
        throw repositoryError("The Mobile Sasa delivery report is invalid.", "MOBILE_SASA_DLR_INVALID", 400);
    }
    if (report.trackingId !== undefined && report.trackingId !== "" && !trackingId) {
        throw repositoryError("The Mobile Sasa delivery report is invalid.", "MOBILE_SASA_DLR_INVALID", 400);
    }

    const providerReportedAt = typeof report?.dlr?.updated_at === "string" &&
        /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(report.dlr.updated_at) &&
        Number.isFinite(Date.parse(report.dlr.updated_at))
        ? new Date(report.dlr.updated_at).toISOString()
        : null;
    const deliveryCode = typeof report?.dlr?.delivery_code === "string" &&
        /^[A-Za-z0-9_-]{0,40}$/.test(report.dlr.delivery_code)
        ? report.dlr.delivery_code || null
        : null;
    const gateway = typeof report?.dlr?.gateway === "string" &&
        /^[A-Za-z0-9_-]{1,40}$/.test(report.dlr.gateway)
        ? report.dlr.gateway
        : null;
    const rawDeliveryTime = report?.deliveryTime || report?.dlr?.delivered_at;
    const providerDeliveryTime = typeof rawDeliveryTime === "string" &&
        rawDeliveryTime.length <= 40 &&
        !/[\u0000-\u001f\u007f]/.test(rawDeliveryTime)
        ? rawDeliveryTime
        : null;

    return {
        provider: "MOBILE_SASA",
        providerMessageReference,
        trackingId,
        providerDispatchReference,
        deliveryStatus: status,
        deliveryDescription: sanitizedDescription(
            report?.dlr?.description || report?.deliveryStatus
        ),
        deliveryCode,
        gateway,
        providerDeliveryTime,
        providerDeliveredAt: parseProviderDeliveryTime(providerDeliveryTime),
        providerReportedAt,
        receivedAt: receivedAt.toISOString(),
    };
}

function notificationDeliveryResult(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value === "string") {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        throw repositoryError(
            "Stored notification delivery metadata is invalid.",
            "MOBILE_SASA_DLR_STORED_DATA_INVALID"
        );
    }
    return {};
}

function createMobileSasaDlrRepository(pool) {
    if (!pool || typeof pool.connect !== "function") {
        throw new TypeError("A PostgreSQL pool is required for Mobile Sasa delivery reports.");
    }

    async function findNotification(client, callback) {
        const result = await client.query(
            `SELECT notification_id, delivery_status, delivery_result,
                    provider_message_id, provider_accepted_at, delivered_at
             FROM notifications
             WHERE notification_type = 'SMS'
               AND (
                    ($1::text IS NOT NULL AND provider_message_id = $1)
                    OR ($2::text IS NOT NULL AND notification_id = $2)
                    OR ($2::text IS NOT NULL AND delivery_result->>'trackingId' = $2)
                    OR ($3::text IS NOT NULL AND delivery_result->>'providerDispatchReference' = $3)
               )
             ORDER BY notification_id
             FOR UPDATE`,
            [
                callback.provider_message_reference,
                callback.tracking_id,
                callback.provider_dispatch_reference,
            ]
        );
        return result.rows;
    }

    async function processCallback(client, callback) {
        if (callback.processing_status === "APPLIED" ||
            callback.processing_status === "IGNORED" ||
            callback.processing_status === "REJECTED") {
            return { duplicate: true, matched: Boolean(callback.notification_id), status: callback.processing_status };
        }

        const matches = await findNotification(client, callback);
        const distinctMatches = new Map(matches.map((row) => [row.notification_id, row]));
        if (distinctMatches.size > 1) {
            await client.query(
                `UPDATE mobilesasa_sms_delivery_callbacks
                 SET processing_status = 'REJECTED',
                     rejection_code = 'AMBIGUOUS_NOTIFICATION_MATCH',
                     processed_at = COALESCE(processed_at, now())
                 WHERE callback_id = $1`,
                [callback.callback_id]
            );
            return { duplicate: false, matched: false, status: "REJECTED" };
        }
        const notification = [...distinctMatches.values()][0];
        if (!notification) {
            return { duplicate: false, matched: false, status: "UNMATCHED" };
        }

        const deliveryResult = notificationDeliveryResult(notification.delivery_result);
        if (
            (notification.provider_message_id &&
                callback.provider_message_reference &&
                notification.provider_message_id !== callback.provider_message_reference) ||
            (deliveryResult.provider && deliveryResult.provider !== "MOBILE_SASA")
        ) {
            await client.query(
                `UPDATE mobilesasa_sms_delivery_callbacks
                 SET processing_status = 'REJECTED',
                     notification_id = $2,
                     rejection_code = 'PROVIDER_REFERENCE_CONFLICT',
                     processed_at = COALESCE(processed_at, now())
                 WHERE callback_id = $1`,
                [callback.callback_id, notification.notification_id]
            );
            return { duplicate: false, matched: true, status: "REJECTED" };
        }

        const existingFinal = ["DELIVERED", "FAILED"].includes(notification.delivery_status);
        const mappedStatus = callback.delivery_status === "SENT"
            ? "PROVIDER_ACCEPTED"
            : callback.delivery_status === "DELIVERED" ? "DELIVERED" : "FAILED";
        const reportEvent = {
            status: callback.delivery_status,
            ...(callback.deliveryDescription ? { description: callback.deliveryDescription } : {}),
            ...(callback.deliveryCode ? { deliveryCode: callback.deliveryCode } : {}),
            ...(callback.gateway ? { gateway: callback.gateway } : {}),
            ...(callback.providerReportedAt ? { providerReportedAt: callback.providerReportedAt } : {}),
            ...(callback.providerDeliveryTime ? { deliveryTime: callback.providerDeliveryTime } : {}),
            receivedAt: callback.receivedAt instanceof Date
                ? callback.receivedAt.toISOString()
                : new Date(callback.received_at).toISOString(),
        };
        const reports = Array.isArray(deliveryResult.deliveryReports)
            ? deliveryResult.deliveryReports
            : [];
        const nextDeliveryResult = {
            ...deliveryResult,
            provider: "MOBILE_SASA",
            ...(callback.tracking_id ? { trackingId: callback.tracking_id } : {}),
            deliveryReports: [...reports, reportEvent],
        };

        await client.query(
            `UPDATE notifications
             SET provider_message_id = COALESCE(provider_message_id, $1),
                 delivery_status = CASE
                     WHEN $3::boolean THEN delivery_status
                     ELSE $4
                 END,
                 delivered_at = CASE
                     WHEN NOT $3::boolean AND $5 = 'DELIVERED'
                     THEN COALESCE(delivered_at, $2::timestamptz)
                     ELSE delivered_at
                 END,
                 delivery_result = $6::jsonb,
                 last_error_code = CASE
                     WHEN NOT $3::boolean AND $5 IN ('FAILED', 'REJECTED', 'EXPIRED', 'UNREACHABLE')
                     THEN 'SMS_PROVIDER_REJECTED'
                     WHEN NOT $3::boolean AND $5 = 'DELIVERED' THEN NULL
                     ELSE last_error_code
                 END,
                 claimed_at = NULL,
                 claim_token = NULL
             WHERE notification_id = $7`,
            [
                callback.provider_message_reference,
                callback.provider_delivered_at,
                existingFinal,
                mappedStatus,
                callback.delivery_status,
                JSON.stringify(nextDeliveryResult),
                notification.notification_id,
            ]
        );

        const processingStatus = existingFinal ? "IGNORED" : "APPLIED";
        await client.query(
            `UPDATE mobilesasa_sms_delivery_callbacks
             SET notification_id = $2,
                 processing_status = $3,
                 correlated_at = COALESCE(correlated_at, now()),
                 processed_at = COALESCE(processed_at, now())
             WHERE callback_id = $1`,
            [callback.callback_id, notification.notification_id, processingStatus]
        );
        return { duplicate: false, matched: true, status: processingStatus };
    }

    async function withTransaction(operation) {
        const client = await pool.connect();
        let started = false;
        try {
            await client.query("BEGIN");
            started = true;
            const result = await operation(client);
            await client.query("COMMIT");
            started = false;
            return result;
        } catch (error) {
            if (started) await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async function ingestDeliveryReport(report, signatureVerifiedAt) {
        if (!(signatureVerifiedAt instanceof Date) || !Number.isFinite(signatureVerifiedAt.getTime())) {
            throw repositoryError(
                "A verified Mobile Sasa webhook timestamp is required.",
                "MOBILE_SASA_DLR_AUTH_REQUIRED",
                401
            );
        }
        const callback = normalizeDeliveryReport(report);
        return withTransaction(async (client) => {
            const inserted = await client.query(
                `INSERT INTO mobilesasa_sms_delivery_callbacks (
                    provider, provider_message_reference, tracking_id,
                   provider_dispatch_reference,
                   delivery_status, delivery_description,
                   delivery_code, gateway, provider_delivery_time,
                   provider_delivered_at, provider_reported_at, signature_verified_at
                ) VALUES ('MOBILE_SASA', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                 ON CONFLICT (provider, provider_message_reference, delivery_status) DO NOTHING
                 RETURNING *`,
                [
                    callback.providerMessageReference,
                    callback.trackingId,
                    callback.providerDispatchReference,
                    callback.deliveryStatus,
                    callback.deliveryDescription,
                    callback.deliveryCode,
                    callback.gateway,
                    callback.providerDeliveryTime,
                    callback.providerDeliveredAt,
                    callback.providerReportedAt,
                    signatureVerifiedAt,
                ]
            );
            const duplicate = inserted.rows.length === 0;
            const stored = duplicate
                ? await client.query(
                    `SELECT * FROM mobilesasa_sms_delivery_callbacks
                     WHERE provider = 'MOBILE_SASA'
                       AND provider_message_reference = $1
                       AND delivery_status = $2
                     FOR UPDATE`,
                    [callback.providerMessageReference, callback.deliveryStatus]
                )
                : { rows: inserted.rows };
            const record = stored.rows[0];
            if (!record) {
                throw repositoryError("The Mobile Sasa delivery report could not be stored.", "MOBILE_SASA_DLR_STORE_FAILED");
            }
            if (record.provider_message_reference !== callback.providerMessageReference) {
                throw repositoryError("The Mobile Sasa delivery report reference conflicts with stored evidence.", "MOBILE_SASA_DLR_CONFLICT", 400);
            }
            if (duplicate) {
                await client.query(
                    `UPDATE mobilesasa_sms_delivery_callbacks
                     SET duplicate_count = duplicate_count + 1
                     WHERE callback_id = $1`,
                    [record.callback_id]
                );
            }
            const result = await processCallback(client, record);
            return { ...result, duplicate };
        });
    }

    async function reconcileUnmatched(limit = 100) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
            throw repositoryError("The Mobile Sasa replay limit is invalid.", "MOBILE_SASA_DLR_INVALID", 400);
        }
        return withTransaction(async (client) => {
            const pending = await client.query(
                `SELECT *
                 FROM mobilesasa_sms_delivery_callbacks
                 WHERE processing_status = 'UNMATCHED'
                 ORDER BY received_at, callback_id
                 FOR UPDATE SKIP LOCKED
                 LIMIT $1`,
                [limit]
            );
            const summary = { checked: pending.rows.length, applied: 0, ignored: 0, unmatched: 0, rejected: 0 };
            for (const callback of pending.rows) {
                const result = await processCallback(client, callback);
                if (result.status === "APPLIED") summary.applied += 1;
                else if (result.status === "IGNORED") summary.ignored += 1;
                else if (result.status === "REJECTED") summary.rejected += 1;
                else summary.unmatched += 1;
            }
            return summary;
        });
    }

    return { ingestDeliveryReport, reconcileUnmatched };
}

module.exports = {
    createMobileSasaDlrRepository,
    normalizeDeliveryReport,
};
