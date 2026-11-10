const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const RESULT_CODE_PATTERN = /^-?\d{1,30}$/;

function repositoryError(message, code, statusCode = 409) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function validateCallback(callback) {
    if (
        !callback ||
        typeof callback.fingerprint !== "string" ||
        !FINGERPRINT_PATTERN.test(callback.fingerprint) ||
        typeof callback.checkoutRequestId !== "string" ||
        !IDENTIFIER_PATTERN.test(callback.checkoutRequestId) ||
        typeof callback.merchantRequestId !== "string" ||
        !IDENTIFIER_PATTERN.test(callback.merchantRequestId) ||
        typeof callback.resultCode !== "string" ||
        !RESULT_CODE_PATTERN.test(callback.resultCode)
    ) {
        throw repositoryError("Callback inbox data is invalid.", "INVALID_CALLBACK_INBOX_INPUT", 400);
    }

    const metadata = callback.metadata;
    if (metadata !== null && metadata !== undefined && (
        !Number.isSafeInteger(metadata.amount) ||
        metadata.amount <= 0 ||
        typeof metadata.phone !== "string" ||
        !/^254[17]\d{8}$/.test(metadata.phone) ||
        typeof metadata.receipt !== "string" ||
        !/^[A-Za-z0-9]{1,25}$/.test(metadata.receipt)
    )) {
        throw repositoryError("Callback inbox payment metadata is invalid.", "INVALID_CALLBACK_INBOX_INPUT", 400);
    }
    if (callback.resultCode === "0" && !metadata) {
        throw repositoryError("Successful callbacks require payment metadata.", "INVALID_CALLBACK_INBOX_INPUT", 400);
    }

    return {
        callbackAmount: metadata?.amount ?? null,
        callbackPhone: metadata?.phone ?? null,
        callbackReceipt: metadata?.receipt ?? null,
        checkoutRequestId: callback.checkoutRequestId,
        fingerprint: callback.fingerprint,
        merchantRequestId: callback.merchantRequestId,
        resultCode: callback.resultCode,
    };
}

function createMpesaCallbackInboxRepository(databasePool) {
    if (!databasePool || typeof databasePool.query !== "function") {
        throw new TypeError("A database query interface is required for the callback inbox.");
    }

    async function storeCallback(callback) {
        const normalized = validateCallback(callback);
        const result = await databasePool.query(
            `INSERT INTO mpesa_callback_inbox
                (callback_fingerprint, checkout_request_id, merchant_request_id,
                 callback_result_code, callback_amount, callback_phone, callback_receipt)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (callback_fingerprint) DO UPDATE
                SET duplicate_count = mpesa_callback_inbox.duplicate_count + 1
                WHERE mpesa_callback_inbox.checkout_request_id = EXCLUDED.checkout_request_id
                  AND mpesa_callback_inbox.merchant_request_id = EXCLUDED.merchant_request_id
                  AND mpesa_callback_inbox.callback_result_code = EXCLUDED.callback_result_code
                  AND mpesa_callback_inbox.callback_amount IS NOT DISTINCT FROM EXCLUDED.callback_amount
                  AND mpesa_callback_inbox.callback_phone IS NOT DISTINCT FROM EXCLUDED.callback_phone
                  AND mpesa_callback_inbox.callback_receipt IS NOT DISTINCT FROM EXCLUDED.callback_receipt
             RETURNING callback_id, callback_fingerprint, checkout_request_id,
                       merchant_request_id, callback_result_code, callback_amount,
                       callback_phone, callback_receipt, callback_status, attempt_id,
                       verification_id, rejection_code, duplicate_count`,
            [
                normalized.fingerprint,
                normalized.checkoutRequestId,
                normalized.merchantRequestId,
                normalized.resultCode,
                normalized.callbackAmount,
                normalized.callbackPhone,
                normalized.callbackReceipt,
            ]
        );
        if (result.rows[0]) {
            return { callback: result.rows[0], duplicate: result.rows[0].duplicate_count > 0 };
        }
        throw repositoryError(
            "Callback fingerprint conflicts with previously stored callback data.",
            "CALLBACK_FINGERPRINT_CONFLICT"
        );
    }

    async function markCorrelated(callbackId, attemptId) {
        const result = await databasePool.query(
            `UPDATE mpesa_callback_inbox
             SET callback_status = 'CORRELATED',
                 attempt_id = $2,
                 correlated_at = COALESCE(correlated_at, now()),
                 updated_at = now()
             WHERE callback_id = $1
               AND callback_status = 'UNMATCHED'
             RETURNING callback_id, callback_status, attempt_id, verification_id`,
            [callbackId, attemptId]
        );
        if (result.rows[0]) return result.rows[0];
        const existing = await databasePool.query(
            `SELECT callback_id, callback_status, attempt_id, verification_id
             FROM mpesa_callback_inbox
             WHERE callback_id = $1`,
            [callbackId]
        );
        const record = existing.rows[0];
        if (
            record &&
            record.attempt_id === attemptId &&
            ["CORRELATED", "VERIFIED"].includes(record.callback_status)
        ) return record;
        throw repositoryError("Stored callback could not be correlated safely.", "CALLBACK_CORRELATION_CONFLICT");
    }

    async function markVerified(callbackId, attemptId, verificationId) {
        const result = await databasePool.query(
            `UPDATE mpesa_callback_inbox
             SET callback_status = 'VERIFIED',
                 verification_id = $3,
                 verified_at = now(),
                 updated_at = now()
             WHERE callback_id = $1
               AND attempt_id = $2
               AND callback_status = 'CORRELATED'
             RETURNING callback_id, callback_status, attempt_id, verification_id`,
            [callbackId, attemptId, verificationId]
        );
        if (result.rows[0]) return result.rows[0];
        const existing = await databasePool.query(
            `SELECT callback_id, callback_status, attempt_id, verification_id
             FROM mpesa_callback_inbox
             WHERE callback_id = $1`,
            [callbackId]
        );
        const record = existing.rows[0];
        if (
            record &&
            record.callback_status === "VERIFIED" &&
            record.attempt_id === attemptId &&
            String(record.verification_id) === String(verificationId)
        ) return record;
        throw repositoryError("Callback verification state could not be saved.", "CALLBACK_STATE_CONFLICT");
    }

    async function markRejected(callbackId, rejectionCode) {
        if (typeof rejectionCode !== "string" || !/^[A-Z0-9_]{1,64}$/.test(rejectionCode)) {
            throw repositoryError("Callback rejection code is invalid.", "INVALID_CALLBACK_INBOX_INPUT", 400);
        }
        const result = await databasePool.query(
            `UPDATE mpesa_callback_inbox
             SET callback_status = 'REJECTED',
                 rejection_code = $2,
                 updated_at = now()
             WHERE callback_id = $1
               AND callback_status IN ('UNMATCHED', 'CORRELATED')
             RETURNING callback_id, callback_status, attempt_id, verification_id`,
            [callbackId, rejectionCode]
        );
        if (result.rows[0]) return result.rows[0];
        const existing = await databasePool.query(
            `SELECT callback_id, callback_status, attempt_id, verification_id
             FROM mpesa_callback_inbox
             WHERE callback_id = $1`,
            [callbackId]
        );
        const record = existing.rows[0];
        if (record?.callback_status === "REJECTED") return record;
        throw repositoryError("Callback rejection state could not be saved.", "CALLBACK_STATE_CONFLICT");
    }

    async function listReplayable(limit = 100) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
            throw repositoryError("Callback replay limit is invalid.", "INVALID_CALLBACK_INBOX_INPUT", 400);
        }
        const result = await databasePool.query(
            `WITH replay_batch AS (
                 SELECT callback_id
                 FROM mpesa_callback_inbox
                 WHERE callback_status IN ('UNMATCHED', 'CORRELATED')
                 ORDER BY updated_at, received_at, callback_id
                 FOR UPDATE SKIP LOCKED
                 LIMIT $1
             )
             UPDATE mpesa_callback_inbox inbox
             SET updated_at = now()
             FROM replay_batch
             WHERE inbox.callback_id = replay_batch.callback_id
             RETURNING inbox.callback_id, inbox.callback_fingerprint, inbox.checkout_request_id,
                       inbox.merchant_request_id, inbox.callback_result_code, inbox.callback_amount,
                       inbox.callback_phone, inbox.callback_receipt, inbox.callback_status, inbox.attempt_id,
                       inbox.verification_id, inbox.rejection_code`,
            [limit]
        );
        return result.rows;
    }

    return { listReplayable, markCorrelated, markRejected, markVerified, storeCallback };
}

let defaultRepository;
function getDefaultRepository() {
    if (!defaultRepository) {
        defaultRepository = createMpesaCallbackInboxRepository(require("../db/database"));
    }
    return defaultRepository;
}

module.exports = {
    createMpesaCallbackInboxRepository,
    listReplayable: (...args) => getDefaultRepository().listReplayable(...args),
    markCorrelated: (...args) => getDefaultRepository().markCorrelated(...args),
    markRejected: (...args) => getDefaultRepository().markRejected(...args),
    markVerified: (...args) => getDefaultRepository().markVerified(...args),
    storeCallback: (...args) => getDefaultRepository().storeCallback(...args),
};
