const crypto = require("crypto");
const pool = require("../db/database");
const { initiateStkPush, queryStkPushStatus, normalizePhoneNumber, maskPhoneNumber } = require("../services/mpesaService");
const { createPendingContribution, parseAmountCents } = require("../services/contributionService");
const { writeAuditLog } = require("../utils/auditLog");

const MIN_SECRET_LENGTH = 24;
const MAX_STK_AMOUNT = 150000;
const RECEIPT_PATTERN = /^[A-Z0-9]{8,15}$/;
const CANCELLED_CODE = 1032;
const TIMED_OUT_CODE = 1037;

function callbackResponse(res) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Notification received; payment outcome not verified" });
}

// STK Push is opt-in. It stays off unless an operator sets MPESA_STK_ENABLED=true
// and a callback secret, so a half-configured deployment can never credit money.
function isStkEnabled() {
    const secret = process.env.MPESA_CALLBACK_SECRET || "";
    return process.env.MPESA_STK_ENABLED === "true" && secret.length >= MIN_SECRET_LENGTH;
}

function secretMatches(provided) {
    const expected = process.env.MPESA_CALLBACK_SECRET || "";
    if (typeof provided !== "string" || !provided || !expected) return false;
    const a = crypto.createHash("sha256").update(provided).digest();
    const b = crypto.createHash("sha256").update(expected).digest();
    return crypto.timingSafeEqual(a, b);
}

function minimumAmount() {
    const configured = Number(process.env.MPESA_MIN_AMOUNT);
    return Number.isInteger(configured) && configured > 0 ? configured : 50;
}

function parseFundIds(value) {
    if (value === undefined || value === null) return { fundIds: null };
    if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some((id) => typeof id !== "string" || !id || id.length > 25 || id.trim() !== id)
    ) {
        return { error: "fund_ids must contain one or more valid fund IDs" };
    }
    if (new Set(value).size !== value.length) return { error: "fund_ids must not contain duplicates" };
    return { fundIds: value };
}

async function markPaymentUnsuccessful(transactionId, status, resultCode, resultDescription) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const locked = await client.query(
            `SELECT t.transaction_status, c.contribution_id, p.user_id
             FROM transactions t
             JOIN contributions c ON c.transaction_id = t.transaction_id
             JOIN pension_accounts p ON p.account_id = c.account_id
             WHERE t.transaction_id = $1
             FOR UPDATE OF t, c`,
            [transactionId]
        );
        if (!locked.rowCount || locked.rows[0].transaction_status !== "PENDING") {
            await client.query("ROLLBACK");
            return false;
        }
        const { contribution_id: contributionId, user_id: userId } = locked.rows[0];
        await client.query(
            `UPDATE transactions
             SET transaction_status = $2, mpesa_result_code = $3, mpesa_result_description = $4
             WHERE transaction_id = $1`,
            [transactionId, status, resultCode, resultDescription ? resultDescription.slice(0, 255) : null]
        );
        await client.query(
            "UPDATE contributions SET contribution_status = $2 WHERE contribution_id = $1",
            [contributionId, status]
        );
        await writeAuditLog(client, {
            userId,
            actionType: "UPDATE",
            entityName: "TRANSACTIONS",
            entityId: transactionId,
            details: { outcome: status, result_code: resultCode },
        });
        await client.query(
            `INSERT INTO notifications (user_id, notification_type, message)
             VALUES ($1, 'PUSH', $2)`,
            [userId, "Your M-Pesa contribution was not completed. No money was added to your pension account."]
        );
        await client.query("COMMIT");
        return true;
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function startStkPush(req, res) {
    if (!isStkEnabled()) {
        return res.status(503).json({
            status: "error",
            message: "M-Pesa deposits are temporarily unavailable while payment verification is being secured.",
        });
    }

    const { userId } = req.user;
    const body = req.body || {};
    const parsedAmount = parseAmountCents(body.amount);
    if (!parsedAmount || parsedAmount.cents % 100n !== 0n) {
        return res.status(400).json({ status: "error", message: "Enter a whole-shilling amount, for example 100." });
    }
    const shillings = Number(parsedAmount.cents / 100n);
    if (shillings < minimumAmount() || shillings > MAX_STK_AMOUNT) {
        return res.status(400).json({
            status: "error",
            message: `Amount must be between KES ${minimumAmount()} and KES ${MAX_STK_AMOUNT.toLocaleString("en-KE")}.`,
        });
    }
    const { fundIds, error: fundError } = parseFundIds(body.fund_ids);
    if (fundError) return res.status(400).json({ status: "error", message: fundError });

    let phoneNumber = body.phoneNumber;
    try {
        if (phoneNumber === undefined || phoneNumber === null || phoneNumber === "") {
            const profile = await pool.query("SELECT phone FROM users WHERE user_id = $1", [userId]);
            phoneNumber = profile.rows[0]?.phone;
        }
        phoneNumber = normalizePhoneNumber(phoneNumber);
    } catch (error) {
        return res.status(400).json({ status: "error", message: error.message });
    }

    const client = await pool.connect();
    let created;
    let transactionStarted = false;
    try {
        await client.query("BEGIN");
        transactionStarted = true;
        created = await createPendingContribution(client, {
            userId,
            parsedAmount,
            channel: "MPESA",
            fundIds,
            mpesaPhone: phoneNumber,
        });
        if (!created.ok) {
            await client.query("ROLLBACK");
            transactionStarted = false;
            return res.status(created.statusCode).json({ status: "error", message: created.message });
        }
        await client.query("COMMIT");
        transactionStarted = false;
    } catch (error) {
        if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
        console.error("Failed to create pending M-Pesa contribution:", error);
        return res.status(500).json({ status: "error", message: "Could not start the payment due to a server error" });
    } finally {
        client.release();
    }

    const { contribution, transaction } = created;
    try {
        const { checkoutRequestId } = await initiateStkPush({ phoneNumber, amount: shillings });
        await pool.query(
            "UPDATE transactions SET checkout_request_id = $2 WHERE transaction_id = $1",
            [transaction.transaction_id, checkoutRequestId]
        );
        return res.status(202).json({
            status: "success",
            message: "Check your phone and enter your M-Pesa PIN to complete the payment.",
            data: {
                contribution,
                transaction,
                checkout_request_id: checkoutRequestId,
                payment_status: "PENDING",
            },
        });
    } catch (error) {
        console.error("STK Push request failed:", {
            stage: error.requestStage,
            status: error.statusCode,
            phone: maskPhoneNumber(phoneNumber),
        });
        if (!error.paymentOutcomeUnknown) {
            await markPaymentUnsuccessful(transaction.transaction_id, "FAILED", null, "STK Push request was not accepted")
                .catch((markError) => console.error("Could not mark payment failed:", markError));
        }
        return res.status(error.statusCode === 503 ? 503 : 502).json({
            status: "error",
            message: error.paymentOutcomeUnknown
                ? "We could not confirm the payment request was sent. Check your phone and your payment status before trying again."
                : "The M-Pesa payment request could not be started. Please try again shortly.",
            data: { transaction_id: transaction.transaction_id, payment_status: error.paymentOutcomeUnknown ? "PENDING" : "FAILED" },
        });
    }
}

async function getStkPushStatus(req, res) {
    const { userId } = req.user;
    const { checkoutRequestId: statusReference } = req.params;
    try {
        const result = await pool.query(
            `SELECT t.transaction_id, t.amount, t.transaction_status, t.mpesa_receipt,
                    t.mpesa_result_code, t.mpesa_result_description, t.completed_at,
                    c.contribution_status, p.current_balance AS account_balance
             FROM transactions t
             JOIN contributions c ON c.transaction_id = t.transaction_id
             JOIN pension_accounts p ON p.account_id = c.account_id
             WHERE (t.checkout_request_id = $1 OR t.transaction_id = $1)
               AND t.transaction_type = 'CONTRIBUTION'
               AND p.user_id = $2`,
            [statusReference, userId]
        );
        if (!result.rowCount) {
            return res.status(404).json({ status: "error", message: "Payment was not found for this account" });
        }
        return res.status(200).json({ status: "success", data: result.rows[0] });
    } catch (error) {
        console.error("Failed to retrieve M-Pesa payment status:", error);
        return res.status(500).json({ status: "error", message: "Could not retrieve payment status" });
    }
}

function readCallback(body) {
    const callback = body?.Body?.stkCallback;
    if (!callback || typeof callback.CheckoutRequestID !== "string" || !callback.CheckoutRequestID) return null;
    const resultCode = Number(callback.ResultCode);
    if (!Number.isInteger(resultCode)) return null;
    const items = Array.isArray(callback.CallbackMetadata?.Item) ? callback.CallbackMetadata.Item : [];
    const metadata = Object.fromEntries(
        items.filter((item) => item && typeof item.Name === "string").map((item) => [item.Name, item.Value])
    );
    return {
        checkoutRequestId: callback.CheckoutRequestID,
        resultCode,
        resultDescription: typeof callback.ResultDesc === "string" ? callback.ResultDesc : null,
        metadata,
    };
}

async function completePayment(payment, receipt, resultDescription) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const locked = await client.query(
            "SELECT transaction_status FROM transactions WHERE transaction_id = $1 FOR UPDATE",
            [payment.transaction_id]
        );
        if (!locked.rowCount || locked.rows[0].transaction_status !== "PENDING") {
            await client.query("ROLLBACK");
            return false;
        }
        await client.query(
            `UPDATE transactions
             SET transaction_status = 'COMPLETED', mpesa_receipt = $2, mpesa_result_code = 0,
                 mpesa_result_description = $3, completed_at = now()
             WHERE transaction_id = $1`,
            [payment.transaction_id, receipt, resultDescription ? resultDescription.slice(0, 255) : null]
        );
        await client.query(
            "UPDATE contributions SET contribution_status = 'COMPLETED' WHERE contribution_id = $1",
            [payment.contribution_id]
        );
        await client.query(
            "UPDATE pension_accounts SET current_balance = current_balance + $2 WHERE account_id = $1",
            [payment.account_id, payment.amount]
        );
        await writeAuditLog(client, {
            userId: payment.user_id,
            actionType: "UPDATE",
            entityName: "TRANSACTIONS",
            entityId: payment.transaction_id,
            details: { outcome: "COMPLETED", amount: payment.amount, receipt },
        });
        await client.query(
            `INSERT INTO notifications (user_id, notification_type, message)
             VALUES ($1, 'PUSH', $2)`,
            [payment.user_id, `Your contribution of KES ${payment.amount} was received. M-Pesa receipt ${receipt}.`]
        );
        await client.query("COMMIT");
        return true;
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if (error.code === "23505") return false; // receipt already recorded for another payment
        throw error;
    } finally {
        client.release();
    }
}

async function processCallback(payload) {
    const callback = readCallback(payload);
    if (!callback) return;

    const found = await pool.query(
        `SELECT t.transaction_id, t.amount::text AS amount, t.transaction_status, t.mpesa_phone,
                c.contribution_id, c.account_id, p.user_id
         FROM transactions t
         JOIN contributions c ON c.transaction_id = t.transaction_id
         JOIN pension_accounts p ON p.account_id = c.account_id
         WHERE t.checkout_request_id = $1 AND t.transaction_type = 'CONTRIBUTION'`,
        [callback.checkoutRequestId]
    );
    const payment = found.rows[0];
    if (!payment || payment.transaction_status !== "PENDING") return;

    // Never trust the callback body alone: ask Daraja for the real outcome.
    let verified;
    try {
        verified = await queryStkPushStatus({ checkoutRequestId: callback.checkoutRequestId });
    } catch (error) {
        console.error("Could not verify M-Pesa callback; payment left PENDING:", error.requestStage, error.statusCode);
        return;
    }
    if (verified.resultCode !== callback.resultCode) {
        console.error("M-Pesa callback disagreed with verification; payment left PENDING");
        return;
    }

    if (verified.resultCode === 0) {
        const paidAmount = Math.round(Number(callback.metadata.Amount) * 100);
        const expectedAmount = Math.round(Number(payment.amount) * 100);
        const receipt = String(callback.metadata.MpesaReceiptNumber || "");
        const paidPhone = String(callback.metadata.PhoneNumber || "");
        const phoneComparable = /^254\d{9}$/.test(paidPhone) && payment.mpesa_phone;
        if (
            paidAmount !== expectedAmount ||
            !RECEIPT_PATTERN.test(receipt) ||
            (phoneComparable && paidPhone !== payment.mpesa_phone)
        ) {
            console.error("M-Pesa success callback details did not match the pending payment; left PENDING for review");
            return;
        }
        await completePayment(payment, receipt, verified.resultDescription || callback.resultDescription);
        return;
    }

    const status = verified.resultCode === CANCELLED_CODE ? "CANCELLED"
        : verified.resultCode === TIMED_OUT_CODE ? "TIMED_OUT"
        : "FAILED";
    await markPaymentUnsuccessful(
        payment.transaction_id,
        status,
        verified.resultCode,
        verified.resultDescription || callback.resultDescription
    );
}

async function handleStkCallback(req, res) {
    // Always acknowledge so Daraja does not retry; the money state only changes
    // when the secret matches AND Daraja's query API confirms the outcome.
    if (isStkEnabled() && secretMatches(req.params?.secret)) {
        try {
            await processCallback(req.body);
        } catch (error) {
            console.error("M-Pesa callback processing failed:", error);
        }
    }
    return callbackResponse(res);
}

module.exports = { startStkPush, getStkPushStatus, handleStkCallback };
