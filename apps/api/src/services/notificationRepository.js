const { randomUUID } = require("node:crypto");
const { writeAuditLog } = require("../utils/auditLog");

const CHANNELS = new Set(["SMS", "EMAIL", "PUSH"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?254[17]\d{8}$|^0[17]\d{8}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTERNAL_E164_PHONE_PATTERN = /^\+254[17]\d{8}$/;
const HEADER_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ADMIN_TEST_SMS_MESSAGE =
    "MicoPesa test notification: Your SMS notification service is working. This is a test message. No payment has been made.";
const CATEGORIES_BY_ROLE = {
    ADMIN: new Set(["GENERAL", "ANNOUNCEMENT", "CONTRIBUTION_REMINDER", "SCHEME_UPDATE",
        "ACCOUNT_SERVICE", "REGULATORY_ADVISORY", "COMPLIANCE_NOTICE", "DEADLINE_REMINDER",
        "WORKER_EDUCATION"]),
    FUND_MANAGER: new Set(["CONTRIBUTION_REMINDER", "SCHEME_UPDATE", "ACCOUNT_SERVICE"]),
    REGULATOR: new Set(["REGULATORY_ADVISORY", "COMPLIANCE_NOTICE", "DEADLINE_REMINDER",
        "WORKER_EDUCATION"]),
};

function repositoryError(message, code, statusCode) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function validateAdminNotification(input) {
    const { userId, channels, message, subject, title, html, requestId } = input || {};
    if (typeof userId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(userId)) {
        throw repositoryError("Select a valid recipient.", "INVALID_NOTIFICATION_INPUT", 400);
    }
    if (!Array.isArray(channels) || channels.length < 1 || channels.length > 3 ||
        channels.some((channel) => !CHANNELS.has(channel)) ||
        new Set(channels).size !== channels.length) {
        throw repositoryError("Select one or more valid notification channels.", "INVALID_NOTIFICATION_INPUT", 400);
    }
    if (typeof message !== "string" || !message.trim() || message.length > 5000) {
        throw repositoryError("Message must contain 1 to 5000 characters.", "INVALID_NOTIFICATION_INPUT", 400);
    }
    if (channels.includes("SMS") && message.length > 255) {
        throw repositoryError("SMS messages must not exceed 255 characters.", "INVALID_NOTIFICATION_INPUT", 400);
    }
    if (channels.includes("EMAIL") &&
        (typeof subject !== "string" || !subject.trim() || subject.length > 255 ||
            HEADER_CONTROL_CHARS.test(subject))) {
        throw repositoryError("Email subject must contain 1 to 255 characters.", "INVALID_NOTIFICATION_INPUT", 400);
    }
    if (html !== undefined && html !== null &&
        (typeof html !== "string" || html.length > 10000 ||
            (html.trim() && !channels.includes("EMAIL")))) {
        throw repositoryError("Email HTML must not exceed 10000 characters and requires the email channel.", "INVALID_NOTIFICATION_INPUT", 400);
    }
    if (channels.includes("PUSH") &&
        (typeof title !== "string" || !title.trim() || title.length > 100 ||
            HEADER_CONTROL_CHARS.test(title))) {
        throw repositoryError("Push title must contain 1 to 100 characters.", "INVALID_NOTIFICATION_INPUT", 400);
    }
    if (typeof requestId !== "string" || !UUID_PATTERN.test(requestId)) {
        throw repositoryError("A valid notification request ID is required.", "INVALID_NOTIFICATION_INPUT", 400);
    }
}

function createNotificationRepository(pool) {
    if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
        throw new TypeError("A PostgreSQL pool is required.");
    }

    async function listRecipients(search = "") {
        if (typeof search !== "string" || search.length > 100) {
            throw repositoryError("Recipient search must be 100 characters or fewer.", "INVALID_NOTIFICATION_INPUT", 400);
        }
        const searchPattern = search.trim()
            ? `%${search.trim().replace(/[\\%_]/g, "\\$&")}%`
            : null;
        const result = await pool.query(
            `SELECT u.user_id, u.full_name, u.role, u.phone,
                    CASE WHEN u.email_verified THEN u.email ELSE NULL END AS email,
                    u.email_verified,
                    (SELECT count(*)::integer FROM push_subscriptions ps
                     WHERE ps.user_id = u.user_id) AS push_subscription_count
             FROM users u
             WHERE u.account_status = 'ACTIVE'
               AND ($1::text IS NULL OR
                    u.full_name ILIKE $1 ESCAPE E'\\\\' OR
                    u.email ILIKE $1 ESCAPE E'\\\\' OR
                    u.phone ILIKE $1 ESCAPE E'\\\\' OR
                    u.user_id ILIKE $1 ESCAPE E'\\\\')
             ORDER BY u.full_name, u.user_id
             LIMIT 100`,
            [searchPattern]
        );
        return result.rows;
    }

    async function listRoleRecipients({ senderId, senderRole, search = "" }) {
        if (senderRole === "ADMIN") return listRecipients(search);
        if (!["FUND_MANAGER", "REGULATOR"].includes(senderRole)) {
            throw repositoryError("This role cannot send notifications.", "NOTIFICATION_FORBIDDEN", 403);
        }
        if (typeof search !== "string" || search.length > 100) {
            throw repositoryError("Recipient search must be 100 characters or fewer.", "INVALID_NOTIFICATION_INPUT", 400);
        }
        const searchPattern = search.trim()
            ? `%${search.trim().replace(/[\\%_]/g, "\\$&")}%`
            : null;
        const scopeQuery = senderRole === "FUND_MANAGER"
            ? `SELECT DISTINCT ON (u.user_id)
                    u.user_id, u.full_name, u.role,
                    CASE WHEN u.phone ~ '^0[17][0-9]{8}$' THEN TRUE ELSE FALSE END AS phone_available,
                    (u.email_verified AND u.email IS NOT NULL) AS email_available,
                    (SELECT count(*)::integer FROM push_subscriptions ps
                     WHERE ps.user_id = u.user_id) AS push_subscription_count,
                    f.fund_id AS scope_fund_id
               FROM users u
               JOIN pension_accounts pa ON pa.user_id = u.user_id
               JOIN fund_allocations fa ON fa.account_id = pa.account_id
               JOIN funds f ON f.fund_id = fa.fund_id
               WHERE u.role = 'WORKER' AND u.account_status = 'ACTIVE'
                 AND f.managed_by = $1 AND f.fund_status = 'ACTIVE'
                 AND fa.effective_from <= CURRENT_DATE
                 AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)
                 AND ($2::text IS NULL OR u.full_name ILIKE $2 ESCAPE E'\\\\'
                      OR u.user_id ILIKE $2 ESCAPE E'\\\\')
               ORDER BY u.user_id, f.fund_id
               LIMIT 100`
            : `WITH authorized_funds AS (
                    SELECT fund_id FROM regulator_fund_assignments
                    WHERE regulator_user_id = $1 AND active = TRUE
                 ), scoped_recipients AS (
                    SELECT u.user_id, u.full_name, u.role, min(af.fund_id) AS scope_fund_id
                    FROM authorized_funds af
                    JOIN funds f ON f.fund_id = af.fund_id AND f.fund_status = 'ACTIVE'
                    JOIN users u ON (
                        (u.role = 'FUND_MANAGER' AND u.user_id = f.managed_by)
                        OR
                        (u.role = 'WORKER' AND EXISTS (
                            SELECT 1 FROM pension_accounts pa
                            JOIN fund_allocations fa ON fa.account_id = pa.account_id
                            WHERE pa.user_id = u.user_id AND fa.fund_id = f.fund_id
                              AND fa.effective_from <= CURRENT_DATE
                              AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)
                        ))
                    )
                    WHERE u.account_status = 'ACTIVE'
                    GROUP BY u.user_id, u.full_name, u.role
                 )
               SELECT sr.user_id, sr.full_name, sr.role,
                    (u.phone ~ '^0[17][0-9]{8}$') AS phone_available,
                    (u.email_verified AND u.email IS NOT NULL) AS email_available,
                    (SELECT count(*)::integer FROM push_subscriptions ps
                     WHERE ps.user_id = u.user_id) AS push_subscription_count,
                    sr.scope_fund_id
               FROM scoped_recipients sr
               JOIN users u ON u.user_id = sr.user_id
               WHERE ($2::text IS NULL OR sr.full_name ILIKE $2 ESCAPE E'\\\\'
                      OR sr.user_id ILIKE $2 ESCAPE E'\\\\')
               ORDER BY sr.full_name, sr.user_id
               LIMIT 100`;
        const result = await pool.query(scopeQuery, [senderId, searchPattern]);
        return result.rows;
    }

    async function queueRoleNotifications({
        senderId,
        senderRole,
        userId,
        userIds,
        channels,
        message,
        subject = null,
        title = null,
        html = null,
        requestId,
        idempotencyKey = requestId,
        skipRateLimit = false,
        category,
        fundId = null,
        testSms = false,
    }) {
        if (!Object.hasOwn(CATEGORIES_BY_ROLE, senderRole) ||
            !CATEGORIES_BY_ROLE[senderRole].has(category)) {
            throw repositoryError("This notification category is not permitted for this role.", "NOTIFICATION_CATEGORY_FORBIDDEN", 403);
        }
        if (testSms && (
            senderRole !== "ADMIN" ||
            userId !== senderId ||
            userIds !== undefined ||
            channels?.length !== 1 ||
            channels[0] !== "SMS" ||
            message !== ADMIN_TEST_SMS_MESSAGE ||
            category !== "ACCOUNT_SERVICE" ||
            subject !== null ||
            title !== null ||
            html !== null ||
            fundId !== null
        )) {
            throw repositoryError(
                "The administrator test SMS request is invalid.",
                "INVALID_NOTIFICATION_INPUT",
                400
            );
        }
        if (userIds !== undefined) {
            if (senderRole !== "ADMIN") {
                throw repositoryError("Only administrators can notify multiple recipients.", "NOTIFICATION_FORBIDDEN", 403);
            }
            if (!Array.isArray(userIds) || userIds.length < 1 || userIds.length > 100 ||
                new Set(userIds).size !== userIds.length) {
                throw repositoryError("Select between 1 and 100 unique recipients.", "INVALID_NOTIFICATION_INPUT", 400);
            }
            for (const recipientId of userIds) {
                validateAdminNotification({
                    userId: recipientId, channels, message, subject, title, html, requestId,
                });
            }
            const recipientResult = await pool.query(
                `SELECT u.user_id, u.phone, u.email, u.email_verified,
                        EXISTS (
                            SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = u.user_id
                        ) AS has_push_subscription
                 FROM users u
                 WHERE u.user_id = ANY($1::varchar[]) AND u.account_status = 'ACTIVE'`,
                [userIds]
            );
            const recipientById = new Map(
                recipientResult.rows.map((recipient) => [recipient.user_id, recipient])
            );
            if (recipientById.size !== userIds.length) {
                throw repositoryError("One or more active recipients were not found.", "NOTIFICATION_RECIPIENT_NOT_FOUND", 404);
            }
            for (const recipient of recipientById.values()) {
                if (channels.includes("SMS") && !PHONE_PATTERN.test(recipient.phone || "")) {
                    throw repositoryError("A recipient does not have a valid mobile number.", "NOTIFICATION_CONTACT_UNAVAILABLE", 422);
                }
                if (channels.includes("EMAIL") &&
                    (!recipient.email_verified || !EMAIL_PATTERN.test(recipient.email || ""))) {
                    throw repositoryError("A recipient does not have a verified email address.", "NOTIFICATION_CONTACT_UNAVAILABLE", 422);
                }
                if (channels.includes("PUSH") && !recipient.has_push_subscription) {
                    throw repositoryError("A recipient has no registered push subscription.", "NOTIFICATION_CONTACT_UNAVAILABLE", 422);
                }
            }
            const prior = await pool.query(
                `SELECT DISTINCT recipient_user_id
                 FROM notification_audit_events
                 WHERE request_id = $1 AND sender_user_id = $2
                   AND authorization_outcome = 'AUTHORIZED'`,
                [requestId, senderId]
            );
            const priorIds = prior.rows.map((row) => row.recipient_user_id).filter(Boolean).sort();
            if (priorIds.length && JSON.stringify(priorIds) !== JSON.stringify([...userIds].sort())) {
                throw repositoryError(
                    "This request ID was already used for a different recipient list.",
                    "NOTIFICATION_IDEMPOTENCY_CONFLICT",
                    409
                );
            }
            const results = [];
            for (const [index, recipientId] of userIds.entries()) {
                const recipientResults = await queueRoleNotifications({
                    senderId,
                    senderRole,
                    userId: recipientId,
                    channels,
                    message,
                    subject,
                    title,
                    html,
                    requestId,
                    idempotencyKey: requestId,
                    skipRateLimit: index > 0,
                    category,
                    fundId,
                });
                results.push(...recipientResults);
            }
            return results;
        }
        validateAdminNotification({ userId, channels, message, subject, title, html, requestId });

        const client = await pool.connect();
        let transactionStarted = false;
        try {
            await client.query("BEGIN");
            transactionStarted = true;
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [senderId]);
            if (testSms) {
                const existing = await client.query(
                    `SELECT notification_id
                     FROM notifications
                     WHERE admin_request_key = $1 AND user_id = $2
                       AND created_by = $2 AND notification_type = 'SMS'
                       AND message = $3
                     FOR UPDATE`,
                    [requestId, senderId, ADMIN_TEST_SMS_MESSAGE]
                );
                if (!existing.rows[0]) {
                    const recentTests = await client.query(
                        `SELECT count(*)::integer AS request_count
                         FROM notifications
                         WHERE created_by = $1
                           AND notification_type = 'SMS'
                           AND message = $2
                           AND created_at >= now() - interval '15 minutes'`,
                        [senderId, ADMIN_TEST_SMS_MESSAGE]
                    );
                    if (Number(recentTests.rows[0]?.request_count || 0) >= 1) {
                        await client.query(
                            `INSERT INTO notification_audit_events (
                                request_id, sender_user_id, sender_role, notification_category,
                                channels, authorization_outcome, outcome_code
                             ) VALUES ($1, $2, 'ADMIN', 'ACCOUNT_SERVICE', '["SMS"]'::jsonb,
                                       'DENIED', 'RATE_LIMIT_EXCEEDED')`,
                            [requestId, senderId]
                        );
                        await client.query("COMMIT");
                        transactionStarted = false;
                        throw repositoryError(
                            "A test SMS was already queued recently. Try again later.",
                            "NOTIFICATION_RATE_LIMITED",
                            429
                        );
                    }
                }
            }
            if (!skipRateLimit && !testSms) {
                const rateResult = await client.query(
                    `SELECT count(DISTINCT request_id)::integer AS request_count
                     FROM notification_audit_events
                     WHERE sender_user_id = $1
                       AND created_at >= now() - interval '15 minutes'`,
                    [senderId]
                );
                if (Number(rateResult.rows[0]?.request_count || 0) >= 20) {
                    await client.query(
                        `INSERT INTO notification_audit_events (
                            request_id, sender_user_id, sender_role, notification_category,
                            channels, authorization_outcome, outcome_code
                         ) VALUES ($1, $2, $3, $4, $5::jsonb, 'DENIED', 'RATE_LIMIT_EXCEEDED')`,
                        [requestId, senderId, senderRole, category, JSON.stringify(channels)]
                    );
                    await client.query("COMMIT");
                    transactionStarted = false;
                    throw repositoryError(
                        "The notification rate limit has been reached. Try again later.",
                        "NOTIFICATION_RATE_LIMITED",
                        429
                    );
                }
            }
            let scopeResult;
            if (senderRole === "FUND_MANAGER") {
                scopeResult = await client.query(
                    `SELECT f.fund_id
                     FROM users u
                     JOIN pension_accounts pa ON pa.user_id = u.user_id
                     JOIN fund_allocations fa ON fa.account_id = pa.account_id
                     JOIN funds f ON f.fund_id = fa.fund_id
                     WHERE u.user_id = $1 AND u.role = 'WORKER'
                       AND u.account_status = 'ACTIVE'
                       AND f.managed_by = $2 AND f.fund_status = 'ACTIVE'
                       AND ($3::text IS NULL OR f.fund_id = $3)
                       AND fa.effective_from <= CURRENT_DATE
                       AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)
                     ORDER BY f.fund_id LIMIT 1
                     FOR SHARE OF u, f`,
                    [userId, senderId, fundId]
                );
            } else if (senderRole === "REGULATOR") {
                scopeResult = await client.query(
                    `SELECT f.fund_id
                     FROM regulator_fund_assignments rfa
                     JOIN funds f ON f.fund_id = rfa.fund_id
                     JOIN users u ON u.user_id = $1 AND u.account_status = 'ACTIVE'
                     WHERE rfa.regulator_user_id = $2 AND rfa.active = TRUE
                       AND f.fund_status = 'ACTIVE'
                       AND ($3::text IS NULL OR f.fund_id = $3)
                       AND (
                            (u.role = 'FUND_MANAGER' AND f.managed_by = u.user_id)
                            OR
                            (u.role = 'WORKER' AND EXISTS (
                                SELECT 1 FROM pension_accounts pa
                                JOIN fund_allocations fa ON fa.account_id = pa.account_id
                                WHERE pa.user_id = u.user_id AND fa.fund_id = f.fund_id
                                  AND fa.effective_from <= CURRENT_DATE
                                  AND (fa.effective_to IS NULL OR fa.effective_to >= CURRENT_DATE)
                            ))
                       )
                     ORDER BY f.fund_id LIMIT 1
                     FOR SHARE OF u, f`,
                    [userId, senderId, fundId]
                );
            } else {
                scopeResult = fundId
                    ? await client.query(
                        `SELECT fund_id FROM funds
                         WHERE fund_id = $1 AND fund_status = 'ACTIVE'
                         FOR SHARE`,
                        [fundId]
                    )
                    : { rows: [{ fund_id: null }] };
            }

            const scopeFundId = scopeResult.rows[0]?.fund_id || null;
            if (senderRole === "ADMIN" && fundId && !scopeFundId) {
                throw repositoryError("The selected fund was not found.", "NOTIFICATION_SCOPE_NOT_FOUND", 404);
            }
            const recipientResult = await client.query(
                `SELECT user_id, full_name, phone, email, email_verified, role
                 FROM users
                 WHERE user_id = $1 AND account_status = 'ACTIVE'
                 FOR SHARE`,
                [userId]
            );
            const user = recipientResult.rows[0];
            const recipientAllowed = user && (
                senderRole === "ADMIN" ||
                (senderRole === "FUND_MANAGER" && user.role === "WORKER" && scopeFundId) ||
                (senderRole === "REGULATOR" &&
                    ["WORKER", "FUND_MANAGER"].includes(user.role) && scopeFundId)
            );
            if (!recipientAllowed) {
                await client.query(
                    `INSERT INTO notification_audit_events (
                        request_id, sender_user_id, sender_role, notification_category,
                        channels, authorization_outcome, outcome_code
                     ) VALUES ($1, $2, $3, $4, $5::jsonb, 'DENIED', 'RECIPIENT_OUT_OF_SCOPE')`,
                    [requestId, senderId, senderRole, category, JSON.stringify(channels)]
                );
                await client.query("COMMIT");
                transactionStarted = false;
                throw repositoryError("The selected recipient is outside your authorized scope.", "NOTIFICATION_FORBIDDEN", 403);
            }
            if (channels.includes("SMS") && !PHONE_PATTERN.test(user.phone || "")) {
                throw repositoryError("The recipient does not have a valid mobile number.", "NOTIFICATION_CONTACT_UNAVAILABLE", 422);
            }
            if (channels.includes("EMAIL") &&
                (!user.email_verified || !EMAIL_PATTERN.test(user.email || ""))) {
                throw repositoryError("The recipient does not have a verified email address.", "NOTIFICATION_CONTACT_UNAVAILABLE", 422);
            }
            if (channels.includes("PUSH")) {
                const subscriptions = await client.query(
                    "SELECT 1 FROM push_subscriptions WHERE user_id = $1 LIMIT 1",
                    [userId]
                );
                if (!subscriptions.rows[0]) {
                    throw repositoryError("The recipient has no registered push subscription.", "NOTIFICATION_CONTACT_UNAVAILABLE", 422);
                }
            }

            let insertedNotification = false;
            for (const channel of channels) {
                const inserted = await client.query(
                    `INSERT INTO notifications (
                        user_id, created_by, notification_type, message,
                        recipient_phone, recipient_email, email_subject, email_html_body, push_title,
                        admin_request_key, notification_category, scope_fund_id, delivery_status
                     )
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'PENDING')
                     ON CONFLICT (admin_request_key, user_id, notification_type)
                     WHERE admin_request_key IS NOT NULL DO NOTHING`,
                    [
                        user.user_id, senderId, channel, message,
                        channel === "SMS" ? user.phone : null,
                        channel === "EMAIL" ? user.email : null,
                        channel === "EMAIL" ? subject.trim() : null,
                        channel === "EMAIL" && typeof html === "string" && html.trim() ? html : null,
                        channel === "PUSH" ? title.trim() : null,
                        idempotencyKey, category, scopeFundId,
                    ]
                );
                insertedNotification ||= inserted.rowCount === 1;
            }
            const recordResult = await client.query(
                `SELECT notification_id, user_id, created_by, notification_type,
                        message, email_subject, email_html_body, push_title,
                        notification_category, scope_fund_id, delivery_status
                 FROM notifications
                 WHERE admin_request_key = $1 AND user_id = $2
                 ORDER BY notification_type`,
                [idempotencyKey, user.user_id]
            );
            const records = recordResult.rows;
            const sameRequest = records.length === channels.length &&
                channels.every((channel) => {
                    const record = records.find((item) => item.notification_type === channel);
                    return record && record.user_id === user.user_id &&
                        record.created_by === senderId && record.message === message &&
                        record.notification_category === category &&
                        record.scope_fund_id === scopeFundId &&
                        record.email_subject === (channel === "EMAIL" ? subject.trim() : null) &&
                        record.email_html_body === (
                            channel === "EMAIL" && typeof html === "string" && html.trim() ? html : null
                        ) &&
                        record.push_title === (channel === "PUSH" ? title.trim() : null);
                });
            if (!sameRequest) {
                throw repositoryError(
                    "This request ID was already used for a different notification.",
                    "NOTIFICATION_IDEMPOTENCY_CONFLICT",
                    409
                );
            }
            if (insertedNotification) {
                await client.query(
                    `INSERT INTO notification_audit_events (
                        request_id, sender_user_id, sender_role, recipient_user_id,
                        scope_fund_id, notification_category, channels, notification_ids,
                        authorization_outcome
                     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 'AUTHORIZED')`,
                    [requestId, senderId, senderRole, user.user_id, scopeFundId,
                        category, JSON.stringify([...channels].sort()),
                        JSON.stringify(records.map((record) => record.notification_id))]
                );
                await writeAuditLog(client, {
                    userId: senderId,
                    actionType: "CREATE",
                    entityName: "ROLE_NOTIFICATION",
                    entityId: records[0].notification_id,
                    details: {
                        senderRole,
                        recipientUserId: user.user_id,
                        scopeFundId,
                        category,
                        channels: [...channels].sort(),
                    },
                });
            }
            await client.query("COMMIT");
            transactionStarted = false;
            return records.map((record) => ({
                notification_id: record.notification_id,
                notification_type: record.notification_type,
                delivery_status: record.delivery_status,
                notification_category: category,
                scope_fund_id: scopeFundId,
                recipient_name: user.full_name,
                recipient_user_id: user.user_id,
            }));
        } catch (error) {
            if (transactionStarted) await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async function queueAdminTestSms({ adminId, requestId }) {
        return queueRoleNotifications({
            senderId: adminId,
            senderRole: "ADMIN",
            userId: adminId,
            channels: ["SMS"],
            message: ADMIN_TEST_SMS_MESSAGE,
            requestId,
            category: "ACCOUNT_SERVICE",
            testSms: true,
        });
    }

    async function isExternalSmsSchemaAvailable() {
        const result = await pool.query(
            `SELECT
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'notifications'
                      AND column_name = 'user_id'
                      AND is_nullable = 'YES'
                )
                AND EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'notifications'
                      AND column_name = 'external_recipient_consent_at'
                )
                AND EXISTS (
                    SELECT 1 FROM pg_indexes
                    WHERE schemaname = current_schema()
                      AND indexname = 'uq_notifications_external_request'
                )
                AND EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'notifications'::regclass
                      AND conname = 'ck_notifications_external_recipient'
                ) AS available`
        );
        return result.rows[0]?.available === true;
    }

    async function queueExternalAdminSms({
        adminId,
        recipientPhone,
        message,
        requestId,
        recipientConsented,
    }) {
        if (typeof adminId !== "string" || !adminId ||
            typeof recipientPhone !== "string" ||
            !EXTERNAL_E164_PHONE_PATTERN.test(recipientPhone) ||
            typeof message !== "string" || !message.trim() ||
            message.length > 255 ||
            typeof requestId !== "string" || !UUID_PATTERN.test(requestId) ||
            recipientConsented !== true) {
            throw repositoryError(
                "A valid E.164 recipient, message, consent confirmation, and request ID are required.",
                "INVALID_NOTIFICATION_INPUT",
                400
            );
        }
        const normalizedMessage = message;

        const client = await pool.connect();
        let transactionStarted = false;
        try {
            await client.query("BEGIN");
            transactionStarted = true;
            await client.query(
                "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
                [adminId]
            );

            const adminResult = await client.query(
                `SELECT user_id
                 FROM users
                 WHERE user_id = $1 AND role = 'ADMIN' AND account_status = 'ACTIVE'
                 FOR SHARE`,
                [adminId]
            );
            if (!adminResult.rows[0]) {
                throw repositoryError(
                    "An active administrator account is required.",
                    "NOTIFICATION_FORBIDDEN",
                    403
                );
            }

            const existing = await client.query(
                `SELECT notification_id, notification_type, delivery_status,
                        message, recipient_phone, provider_message_id,
                        provider_accepted_at, delivered_at, delivery_result,
                        last_error_code, created_at
                 FROM notifications
                 WHERE user_id IS NULL
                   AND created_by = $1 AND admin_request_key = $2
                 FOR UPDATE`,
                [adminId, requestId]
            );
            if (existing.rows[0]) {
                const notification = existing.rows[0];
                if (notification.recipient_phone !== recipientPhone ||
                    notification.message !== normalizedMessage) {
                    throw repositoryError(
                        "This request ID was already used for a different recipient or message.",
                        "NOTIFICATION_IDEMPOTENCY_CONFLICT",
                        409
                    );
                }
                await client.query("COMMIT");
                transactionStarted = false;
                return { notification, created: false };
            }

            const recentRequests = await client.query(
                `SELECT count(*)::integer AS request_count
                 FROM notifications
                 WHERE user_id IS NULL
                   AND created_by = $1
                   AND created_at >= now() - interval '15 minutes'`,
                [adminId]
            );
            if (Number(recentRequests.rows[0]?.request_count || 0) >= 1) {
                await client.query(
                    `INSERT INTO notification_audit_events (
                        request_id, sender_user_id, sender_role,
                        notification_category, channels, authorization_outcome,
                        outcome_code
                    ) VALUES (
                        $1, $2, 'ADMIN', 'ACCOUNT_SERVICE', '["SMS"]'::jsonb,
                        'DENIED', 'RATE_LIMIT_EXCEEDED'
                    )`,
                    [requestId, adminId]
                );
                await client.query("COMMIT");
                transactionStarted = false;
                throw repositoryError(
                    "An external-recipient SMS was sent recently. Try again later.",
                    "NOTIFICATION_RATE_LIMITED",
                    429
                );
            }

            const inserted = await client.query(
                `INSERT INTO notifications (
                    user_id, created_by, notification_type, message,
                    recipient_phone, notification_category, admin_request_key,
                    external_recipient_consent_at,
                    delivery_status
                ) VALUES (
                    NULL, $1, 'SMS', $2, $3, 'ACCOUNT_SERVICE', $4,
                    now(), 'PENDING'
                )
                RETURNING notification_id, notification_type, delivery_status,
                          message, recipient_phone, provider_message_id,
                          provider_accepted_at, delivered_at, delivery_result,
                          last_error_code, created_at`,
                [adminId, normalizedMessage, recipientPhone, requestId]
            );
            const notification = inserted.rows[0];
            await client.query(
                `INSERT INTO notification_audit_events (
                    request_id, sender_user_id, sender_role,
                    notification_category, channels, notification_ids,
                    authorization_outcome
                ) VALUES (
                    $1, $2, 'ADMIN', 'ACCOUNT_SERVICE', '["SMS"]'::jsonb,
                    $3::jsonb, 'AUTHORIZED'
                )`,
                [
                    requestId,
                    adminId,
                    JSON.stringify([notification.notification_id]),
                ]
            );
            await client.query("COMMIT");
            transactionStarted = false;
            return { notification, created: true };
        } catch (error) {
            if (transactionStarted) await client.query("ROLLBACK");
            if (error?.code === "23505") {
                throw repositoryError(
                    "This external SMS request was already recorded.",
                    "NOTIFICATION_IDEMPOTENCY_CONFLICT",
                    409
                );
            }
            throw error;
        } finally {
            client.release();
        }
    }

    async function claimExternalAdminSms({ adminId, requestId }) {
        const claimToken = randomUUID();
        await pool.query(
            `UPDATE notifications
             SET delivery_status = 'UNKNOWN',
                 claimed_at = NULL,
                 claim_token = NULL,
                 last_error_code = 'SMS_EXTERNAL_OUTCOME_UNKNOWN'
             WHERE user_id IS NULL
               AND created_by = $1
               AND admin_request_key = $2
               AND delivery_status = 'PROCESSING'
               AND claimed_at <= now() - interval '60 seconds'`,
            [adminId, requestId]
        );
        const result = await pool.query(
            `UPDATE notifications
             SET delivery_status = 'PROCESSING',
                 claimed_at = now(),
                 claim_token = $1,
                 attempt_count = attempt_count + 1,
                 last_attempt_at = now(),
                 last_error_code = NULL
             WHERE user_id IS NULL
               AND created_by = $2
               AND admin_request_key = $3
               AND notification_type = 'SMS'
               AND delivery_status = 'PENDING'
             RETURNING notification_id, recipient_phone, message,
                       attempt_count, claim_token`,
            [claimToken, adminId, requestId]
        );
        return result.rows[0] || null;
    }

    async function getExternalAdminSmsStatus({ adminId, requestId }) {
        const result = await pool.query(
            `SELECT notification_id, notification_type, delivery_status,
                    recipient_phone, message, delivery_result,
                    provider_message_id, provider_accepted_at,
                    delivered_at, last_error_code, created_at
             FROM notifications
             WHERE user_id IS NULL
               AND created_by = $1 AND admin_request_key = $2`,
            [adminId, requestId]
        );
        return result.rows[0] || null;
    }

    async function updateExternalAdminSmsClaim(notification, {
        deliveryStatus,
        messageId = null,
        deliveryResult = null,
        errorCode = null,
    }) {
        const result = await pool.query(
            `UPDATE notifications
             SET delivery_status = $1,
                 provider_message_id = CASE
                     WHEN $1 = 'PROVIDER_ACCEPTED' THEN $4
                     ELSE provider_message_id
                 END,
                 provider_accepted_at = CASE
                     WHEN $1 = 'PROVIDER_ACCEPTED' THEN now()
                     ELSE provider_accepted_at
                 END,
                 delivery_result = CASE
                     WHEN $3::jsonb IS NOT NULL THEN $3::jsonb
                     ELSE delivery_result
                 END,
                 last_error_code = $5,
                 claimed_at = NULL,
                 claim_token = NULL
             WHERE notification_id = $2
               AND user_id IS NULL
               AND claim_token = $6
               AND delivery_status = 'PROCESSING'
             RETURNING notification_id, notification_type, delivery_status,
                       recipient_phone, message, delivery_result,
                       provider_message_id, provider_accepted_at,
                       delivered_at, last_error_code, created_at`,
            [
                deliveryStatus,
                notification.notification_id,
                deliveryResult === null ? null : JSON.stringify(deliveryResult),
                messageId,
                errorCode,
                notification.claim_token,
            ]
        );
        if (!result.rows[0]) {
            throw repositoryError(
                "The external SMS claim is no longer active.",
                "NOTIFICATION_EXTERNAL_SMS_CLAIM_LOST",
                409
            );
        }
        return result.rows[0];
    }

    async function markExternalAdminSmsAccepted(notification, result) {
        return updateExternalAdminSmsClaim(notification, {
            deliveryStatus: "PROVIDER_ACCEPTED",
            messageId: result.messageId || null,
            deliveryResult: result.deliveryResult || { provider: "MOBILE_SASA" },
        });
    }

    async function markExternalAdminSmsFailed(notification, errorCode) {
        return updateExternalAdminSmsClaim(notification, {
            deliveryStatus: "FAILED",
            errorCode,
        });
    }

    async function markExternalAdminSmsUnknown(notification, errorCode) {
        return updateExternalAdminSmsClaim(notification, {
            deliveryStatus: "UNKNOWN",
            errorCode,
        });
    }

    async function claimAdminTestSms({ adminId, requestId }) {
        const claimToken = randomUUID();
        const result = await pool.query(
            `UPDATE notifications
             SET delivery_status = 'PROCESSING',
                 claimed_at = now(),
                 claim_token = $1,
                 attempt_count = attempt_count + 1,
                 last_attempt_at = now(),
                 last_error_code = NULL
             WHERE user_id = $2
               AND created_by = $2
               AND admin_request_key = $3
               AND notification_type = 'SMS'
               AND notification_category = 'ACCOUNT_SERVICE'
               AND message = $4
               AND delivery_status = 'PENDING'
             RETURNING notification_id, recipient_phone, message, attempt_count, claim_token`,
            [claimToken, adminId, requestId, ADMIN_TEST_SMS_MESSAGE]
        );
        return result.rows[0] || null;
    }

    async function getAdminTestSmsStatus({ adminId, requestId }) {
        const result = await pool.query(
            `SELECT notification_id, notification_type, delivery_status,
                    delivery_result, provider_message_id, provider_accepted_at,
                    delivered_at, last_error_code
             FROM notifications
             WHERE user_id = $1
               AND created_by = $1
               AND admin_request_key = $2
               AND notification_type = 'SMS'
               AND notification_category = 'ACCOUNT_SERVICE'
               AND message = $3`,
            [adminId, requestId, ADMIN_TEST_SMS_MESSAGE]
        );
        return result.rows[0] || null;
    }

    async function updateAdminTestSmsClaim(notification, {
        deliveryStatus,
        messageId = null,
        deliveryResult = null,
        errorCode = null,
    }) {
        const result = await pool.query(
            `UPDATE notifications
             SET delivery_status = $1,
                 provider_message_id = CASE
                     WHEN $1 = 'PROVIDER_ACCEPTED' THEN $4
                     ELSE provider_message_id
                 END,
                 provider_accepted_at = CASE
                     WHEN $1 = 'PROVIDER_ACCEPTED' THEN now()
                     ELSE provider_accepted_at
                 END,
                 delivery_result = CASE
                     WHEN $3::jsonb IS NOT NULL THEN $3::jsonb
                     ELSE delivery_result
                 END,
                 last_error_code = $5,
                 claimed_at = NULL,
                 claim_token = NULL
             WHERE notification_id = $2
               AND claim_token = $6
               AND delivery_status = 'PROCESSING'
             RETURNING notification_id, notification_type, delivery_status,
                       delivery_result, provider_message_id, provider_accepted_at,
                       delivered_at, last_error_code`,
            [
                deliveryStatus,
                notification.notification_id,
                deliveryResult === null ? null : JSON.stringify(deliveryResult),
                messageId,
                errorCode,
                notification.claim_token,
            ]
        );
        if (!result.rows[0]) {
            throw repositoryError(
                "The test SMS claim is no longer active.",
                "NOTIFICATION_TEST_SMS_CLAIM_LOST",
                409
            );
        }
        return result.rows[0];
    }

    async function markAdminTestSmsAccepted(notification, result) {
        return updateAdminTestSmsClaim(notification, {
            deliveryStatus: "PROVIDER_ACCEPTED",
            messageId: result.messageId || null,
            deliveryResult: result.deliveryResult || { provider: "MOBILE_SASA" },
        });
    }

    async function markAdminTestSmsFailed(notification, errorCode) {
        return updateAdminTestSmsClaim(notification, {
            deliveryStatus: "FAILED",
            errorCode,
        });
    }

    async function markAdminTestSmsUnknown(notification, errorCode) {
        return updateAdminTestSmsClaim(notification, {
            deliveryStatus: "UNKNOWN",
            errorCode,
        });
    }

    async function listNotificationAudit({ userId, role }) {
        let scope = "";
        const params = [];
        if (role === "ADMIN") {
            scope = "";
        } else if (role === "FUND_MANAGER") {
            params.push(userId);
            scope = `WHERE (
                (nae.scope_fund_id IS NULL AND nae.sender_user_id = $1)
                OR EXISTS (
                    SELECT 1 FROM funds f
                    WHERE f.fund_id = nae.scope_fund_id AND f.managed_by = $1
                )
            )`;
        } else if (role === "REGULATOR") {
            params.push(userId);
            scope = `WHERE (
                (nae.scope_fund_id IS NULL AND nae.sender_user_id = $1)
                OR EXISTS (
                    SELECT 1 FROM regulator_fund_assignments rfa
                    WHERE rfa.regulator_user_id = $1 AND rfa.active = TRUE
                      AND rfa.fund_id = nae.scope_fund_id
                )
            )`;
        } else {
            throw repositoryError("This role cannot view notification audit records.", "NOTIFICATION_FORBIDDEN", 403);
        }
        const result = await pool.query(
            `SELECT nae.audit_event_id, nae.request_id, nae.sender_user_id,
                    su.full_name AS sender_name, nae.sender_role,
                    nae.recipient_user_id, ru.full_name AS recipient_name,
                    CASE WHEN ru.email IS NOT NULL THEN
                        left(ru.email, 1) || '***' || substring(ru.email from position('@' in ru.email))
                        ELSE NULL END AS recipient_email_masked,
                    CASE WHEN ru.phone IS NOT NULL THEN
                        left(ru.phone, 3) || '***' || right(ru.phone, 2)
                        ELSE NULL END AS recipient_phone_masked,
                    nae.scope_fund_id, f.fund_name, nae.notification_category,
                    nae.channels, nae.authorization_outcome, nae.outcome_code,
                    nae.created_at,
                    COALESCE((
                        SELECT jsonb_agg(jsonb_build_object(
                            'notification_id', n.notification_id,
                            'channel', n.notification_type,
                            'delivery_status', n.delivery_status,
                            'created_at', n.created_at
                        ) ORDER BY n.notification_type)
                        FROM jsonb_array_elements_text(nae.notification_ids)
                            AS audit_notification_id(notification_id)
                        JOIN notifications n
                          ON n.notification_id = audit_notification_id.notification_id
                    ), '[]'::jsonb) AS delivery_results
             FROM notification_audit_events nae
             LEFT JOIN users su ON su.user_id = nae.sender_user_id
             LEFT JOIN users ru ON ru.user_id = nae.recipient_user_id
             LEFT JOIN funds f ON f.fund_id = nae.scope_fund_id
             ${scope}
             ORDER BY nae.created_at DESC
             LIMIT 500`,
            params
        );
        return result.rows;
    }

    async function queueAdminNotifications({
        adminId,
        userId,
        channels,
        message,
        subject = null,
        title = null,
        html = null,
        requestId,
    }) {
        validateAdminNotification({ userId, channels, message, subject, title, html, requestId });
        const client = await pool.connect();
        let transactionStarted = false;
        try {
            await client.query("BEGIN");
            transactionStarted = true;
            const userResult = await client.query(
                `SELECT user_id, full_name, phone, email, email_verified, account_status
                 FROM users
                 WHERE user_id = $1 AND account_status = 'ACTIVE'
                 FOR SHARE`,
                [userId]
            );
            const user = userResult.rows[0];
            if (!user) {
                throw repositoryError("An active recipient was not found.", "NOTIFICATION_RECIPIENT_NOT_FOUND", 404);
            }
            if (channels.includes("SMS") && !PHONE_PATTERN.test(user.phone || "")) {
                throw repositoryError("The recipient does not have a valid mobile number.", "NOTIFICATION_CONTACT_UNAVAILABLE", 422);
            }
            if (channels.includes("EMAIL") &&
                (!user.email_verified || !EMAIL_PATTERN.test(user.email || ""))) {
                throw repositoryError("The recipient does not have a verified email address.", "NOTIFICATION_CONTACT_UNAVAILABLE", 422);
            }
            if (channels.includes("PUSH")) {
                const subscriptions = await client.query(
                    "SELECT 1 FROM push_subscriptions WHERE user_id = $1 LIMIT 1",
                    [userId]
                );
                if (!subscriptions.rows[0]) {
                    throw repositoryError("The recipient has no registered push subscription.", "NOTIFICATION_CONTACT_UNAVAILABLE", 422);
                }
            }

            let insertedNotification = false;
            for (const channel of channels) {
                const insertResult = await client.query(
                    `INSERT INTO notifications (
                        user_id, created_by, notification_type, message,
                        recipient_phone, recipient_email, email_subject, email_html_body, push_title,
                        admin_request_key, delivery_status
                     )
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING')
                     ON CONFLICT (admin_request_key, user_id, notification_type)
                     WHERE admin_request_key IS NOT NULL
                     DO NOTHING`,
                    [
                        user.user_id,
                        adminId,
                        channel,
                        message,
                        channel === "SMS" ? user.phone : null,
                        channel === "EMAIL" ? user.email : null,
                        channel === "EMAIL" ? subject.trim() : null,
                        channel === "EMAIL" && typeof html === "string" && html.trim()
                            ? html
                            : null,
                        channel === "PUSH" ? title.trim() : null,
                        requestId,
                    ]
                );
                insertedNotification ||= insertResult.rowCount === 1;
            }

            const existing = await client.query(
                `SELECT notification_id, user_id, created_by, notification_type,
                        message, email_subject, email_html_body, push_title, delivery_status
                 FROM notifications
                 WHERE admin_request_key = $1 AND user_id = $2
                 ORDER BY notification_type`,
                [requestId, user.user_id]
            );
            const records = existing.rows;
            const sameRequest = records.length === channels.length &&
                channels.every((channel) => {
                    const record = records.find((item) => item.notification_type === channel);
                    return record &&
                        record.user_id === user.user_id &&
                        record.created_by === adminId &&
                        record.message === message &&
                        record.email_subject === (channel === "EMAIL" ? subject.trim() : null) &&
                        record.email_html_body === (
                            channel === "EMAIL" && typeof html === "string" && html.trim()
                                ? html
                                : null
                        ) &&
                        record.push_title === (channel === "PUSH" ? title.trim() : null);
                });
            if (!sameRequest) {
                throw repositoryError(
                    "This request ID was already used for a different notification.",
                    "NOTIFICATION_IDEMPOTENCY_CONFLICT",
                    409
                );
            }

            if (insertedNotification) {
                await writeAuditLog(client, {
                    userId: adminId,
                    actionType: "CREATE",
                    entityName: "ADMIN_NOTIFICATION",
                    entityId: records[0].notification_id,
                    details: {
                        recipientUserId: user.user_id,
                        channels: [...channels].sort(),
                        notificationIds: records.map((record) => record.notification_id),
                    },
                });
            }
            await client.query("COMMIT");
            transactionStarted = false;
            return records.map((record) => ({
                notification_id: record.notification_id,
                notification_type: record.notification_type,
                delivery_status: record.delivery_status,
                created_by: record.created_by,
                message: record.message,
                email_subject: record.email_subject,
                email_html_body: record.email_html_body,
                push_title: record.push_title,
                recipient_name: user.full_name,
            }));
        } catch (error) {
            if (transactionStarted) await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async function listAdminNotifications() {
        const result = await pool.query(
            `SELECT n.notification_id, n.user_id,
                    COALESCE(u.full_name,
                        CASE WHEN n.user_id IS NULL THEN n.recipient_phone END
                    ) AS recipient_name,
                    (n.user_id IS NULL) AS is_external_recipient, n.recipient_phone,
                    n.created_by, cu.full_name AS created_by_name,
                    n.notification_type, n.message, n.email_subject, n.email_html_body, n.push_title,
                    n.notification_category, n.scope_fund_id,
                    n.delivery_status, n.delivery_result, n.created_at,
                    COALESCE(n.sent_at, n.provider_accepted_at) AS sent_at,
                    n.provider_accepted_at, n.provider_message_id, n.delivered_at,
                    n.last_error_code
             FROM notifications n
             LEFT JOIN users u ON u.user_id = n.user_id
             LEFT JOIN users cu ON cu.user_id = n.created_by
             ORDER BY n.created_at DESC`
        );
        return result.rows;
    }

    async function listUserNotifications(userId) {
        const result = await pool.query(
            `SELECT notification_id, notification_type, message, email_subject,
                    push_title, delivery_status, created_at,
                    COALESCE(sent_at, provider_accepted_at) AS sent_at,
                    provider_accepted_at
             FROM notifications
             WHERE user_id = $1
             ORDER BY created_at DESC`,
            [userId]
        );
        return result.rows;
    }

    async function upsertPushSubscription(userId, subscription) {
        const result = await pool.query(
            `INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_key)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (endpoint) DO UPDATE
             SET user_id = EXCLUDED.user_id,
                 p256dh_key = EXCLUDED.p256dh_key,
                 auth_key = EXCLUDED.auth_key,
                 updated_at = now()
             RETURNING subscription_id`,
            [userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
        );
        return result.rows[0].subscription_id;
    }

    async function deletePushSubscription(userId, subscriptionId) {
        const result = await pool.query(
            `DELETE FROM push_subscriptions
             WHERE subscription_id = $1 AND user_id = $2
             RETURNING subscription_id`,
            [subscriptionId, userId]
        );
        return Boolean(result.rows[0]);
    }

    async function listPushSubscriptions(userId) {
        const result = await pool.query(
            `SELECT subscription_id, endpoint, p256dh_key, auth_key
             FROM push_subscriptions
             WHERE user_id = $1`,
            [userId]
        );
        return result.rows;
    }

    async function removePushSubscription(subscriptionId) {
        await pool.query(
            "DELETE FROM push_subscriptions WHERE subscription_id = $1",
            [subscriptionId]
        );
    }

    return {
        deletePushSubscription,
        listAdminNotifications,
        listNotificationAudit,
        listPushSubscriptions,
        listRoleRecipients,
        listRecipients,
        listUserNotifications,
        isExternalSmsSchemaAvailable,
        claimAdminTestSms,
        claimExternalAdminSms,
        getExternalAdminSmsStatus,
        getAdminTestSmsStatus,
        markAdminTestSmsAccepted,
        markAdminTestSmsFailed,
        markAdminTestSmsUnknown,
        markExternalAdminSmsAccepted,
        markExternalAdminSmsFailed,
        markExternalAdminSmsUnknown,
        queueAdminNotifications,
        queueRoleNotifications,
        queueAdminTestSms,
        queueExternalAdminSms,
        removePushSubscription,
        upsertPushSubscription,
    };
}

module.exports = {
    createNotificationRepository,
    validateAdminNotification,
};
