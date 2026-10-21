const pool = require("../db/database");
const { initiateStkPush, normalizePhoneNumber, assertConfigured, maskPhoneNumber } = require("../services/mpesaService");

const MAX_CONTRIBUTION_AMOUNT = 9999999999;

function getCallbackMetadata(callback) {
    const items = callback?.CallbackMetadata?.Item;
    if (!Array.isArray(items)) return {};
    return Object.fromEntries(items.filter((item) => item && typeof item.Name === "string").map((item) => [item.Name, item.Value]));
}

function callbackResponse(res) {
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
}

async function recordInitiationOutcome(transactionId, { status, resultCode = null, description }) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(
            `UPDATE transactions
             SET transaction_status = $2, mpesa_result_code = $3,
                 mpesa_result_description = $4,
                 completed_at = CASE WHEN $5 THEN now() ELSE NULL END
             WHERE transaction_id = $1 AND transaction_status = 'PENDING'`,
            [transactionId, status, resultCode, String(description).slice(0, 255), status !== "PENDING"]
        );
        if (status !== "PENDING") {
            await client.query(
                "UPDATE contributions SET contribution_status = $2 WHERE transaction_id = $1 AND contribution_status = 'PENDING'",
                [transactionId, status]
            );
        }
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function startStkPush(req, res) {
    const { userId } = req.user;
    const { amount, phoneNumber } = req.body || {};
    const amountText = String(amount ?? "");
    if (!/^\d+$/.test(amountText)) {
        return res.status(400).json({ status: "error", message: "amount must be a whole number of Kenyan shillings" });
    }
    const parsedAmount = Number(amountText);
    if (!Number.isSafeInteger(parsedAmount) || parsedAmount < 1 || parsedAmount > MAX_CONTRIBUTION_AMOUNT) {
        return res.status(400).json({ status: "error", message: "amount must be a positive whole number within the supported limit" });
    }

    let normalizedPhone;
    try {
        normalizedPhone = normalizePhoneNumber(phoneNumber);
    } catch (error) {
        return res.status(400).json({ status: "error", message: error.message });
    }

    try {
        assertConfigured();
    } catch {
        return res.status(503).json({ status: "error", message: "M-Pesa payments are not configured yet." });
    }

    const client = await pool.connect();
    let transaction;
    try {
        await client.query("BEGIN");
        const accountResult = await client.query(
            `SELECT p.account_id
             FROM pension_accounts p
             JOIN users u ON u.user_id = p.user_id
             WHERE p.user_id = $1 AND p.account_status = 'ACTIVE'
               AND u.role = 'WORKER' AND u.account_status = 'ACTIVE'
             FOR UPDATE OF p, u`,
            [userId]
        );
        if (!accountResult.rowCount) {
            await client.query("ROLLBACK");
            return res.status(409).json({ status: "error", message: "No active pension account is available for deposits" });
        }

        const transactionResult = await client.query(
            `INSERT INTO transactions (transaction_type, amount, transaction_status, mpesa_phone)
             VALUES ('CONTRIBUTION', $1, 'PENDING', $2)
             RETURNING transaction_id, amount, transaction_status, initiated_at`,
            [parsedAmount, normalizedPhone]
        );
        transaction = transactionResult.rows[0];
        await client.query(
            `INSERT INTO contributions (account_id, transaction_id, amount, channel, contribution_status)
             VALUES ($1, $2, $3, 'MPESA', 'PENDING')`,
            [accountResult.rows[0].account_id, transaction.transaction_id, parsedAmount]
        );
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("Failed to create pending M-Pesa contribution:", error);
        return res.status(500).json({ status: "error", message: "Could not start the deposit. Please try again." });
    } finally {
        client.release();
    }

    let stkPush;
    try {
        stkPush = await initiateStkPush({ userId, phoneNumber: normalizedPhone, amount: parsedAmount });
    } catch (error) {
        const outcomeUnknown = Boolean(error.paymentOutcomeUnknown);
        const status = outcomeUnknown ? "PENDING" : "FAILED";
        const description = outcomeUnknown
            ? "No definitive response was received from M-Pesa; awaiting provider confirmation."
            : "M-Pesa rejected or could not authenticate the payment request.";
        const providerCode = error.providerResultCode;
        const resultCode = providerCode !== null && providerCode !== undefined &&
            /^\d+$/.test(String(providerCode)) ? Number(providerCode) : null;
        try {
            await recordInitiationOutcome(transaction.transaction_id, {
                status,
                resultCode,
                description,
            });
        } catch (databaseError) {
            console.error(JSON.stringify({
                event: "mpesa.initiation_outcome_persistence_failed",
                transaction_id: transaction.transaction_id,
                error_name: databaseError.name,
                database_error_code: databaseError.code || null,
            }));
        }
        console.warn(JSON.stringify({
            event: "mpesa.stk_push.initiation_failed",
            transaction_id: transaction.transaction_id,
            amount: parsedAmount,
            phone_masked: maskPhoneNumber(normalizedPhone),
            request_stage: error.requestStage || "unknown",
            provider_http_status: error.providerHttpStatus || null,
            provider_result_code: providerCode ?? null,
            payment_outcome: outcomeUnknown ? "unknown_pending" : "rejected",
        }));
        if (outcomeUnknown) {
            return res.status(202).json({
                status: "success",
                message: "No definitive M-Pesa response was received. The payment remains pending confirmation; do not retry yet.",
                data: {
                    transaction_id: transaction.transaction_id,
                    checkout_request_id: null,
                    transaction_status: "PENDING",
                    confirmation_pending: true,
                },
            });
        }
        const statusCode = [503, 504].includes(error.statusCode) ? error.statusCode : 502;
        return res.status(statusCode).json({
            status: "error",
            message: statusCode === 503
                ? "M-Pesa payments are not configured yet."
                : "M-Pesa could not start the payment. Please try again.",
        });
    }

    try {
        const result = await pool.query(
            `UPDATE transactions
             SET checkout_request_id = $1
             WHERE transaction_id = $2 AND transaction_status = 'PENDING'
             RETURNING checkout_request_id`,
            [stkPush.checkoutRequestId, transaction.transaction_id]
        );
        if (!result.rowCount) throw new Error("Pending transaction was not available for STK Push association");
    } catch (error) {
        console.error(JSON.stringify({
            event: "mpesa.checkout_request_id_persistence_failed",
            transaction_id: transaction.transaction_id,
            checkout_request_id: stkPush.checkoutRequestId,
            error_name: error.name,
        }));
        return res.status(202).json({
            status: "success",
            message: "The payment prompt may have been sent, but confirmation is still pending. Do not retry yet.",
            data: {
                transaction_id: transaction.transaction_id,
                checkout_request_id: null,
                transaction_status: "PENDING",
                confirmation_pending: true,
            },
        });
    }

    return res.status(202).json({
        status: "success",
        message: "STK Push sent. Enter your M-Pesa PIN to complete the deposit.",
        data: {
            transaction_id: transaction.transaction_id,
            checkout_request_id: stkPush.checkoutRequestId,
            transaction_status: "PENDING",
        },
    });
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

async function handleStkCallback(req, res) {
    const callback = req.body?.Body?.stkCallback;
    const checkoutRequestId = callback?.CheckoutRequestID;
    const rawResultCode = callback?.ResultCode;
    const resultCode = typeof rawResultCode === "number" ? rawResultCode : Number(rawResultCode);
    if (
        typeof checkoutRequestId !== "string" ||
        !checkoutRequestId ||
        !Number.isInteger(resultCode) ||
        (typeof rawResultCode !== "number" && (typeof rawResultCode !== "string" || !/^\d+$/.test(rawResultCode)))
    ) {
        console.warn(JSON.stringify({
            event: "mpesa.callback.invalid_payload",
            has_checkout_request_id: typeof checkoutRequestId === "string",
            has_result_code: Number.isInteger(resultCode),
        }));
        return res.status(400).json({ ResultCode: 1, ResultDesc: "Invalid STK callback payload" });
    }

    const metadata = getCallbackMetadata(callback);
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const transactionResult = await client.query(
            `SELECT t.transaction_id, t.amount, t.transaction_status, t.mpesa_phone,
                    c.account_id, c.contribution_status
             FROM transactions t
             JOIN contributions c ON c.transaction_id = t.transaction_id
             WHERE t.checkout_request_id = $1 AND t.transaction_type = 'CONTRIBUTION'
             FOR UPDATE OF t, c`,
            [checkoutRequestId]
        );
        if (!transactionResult.rowCount) {
            await client.query("ROLLBACK");
            console.warn("Received M-Pesa callback for an unknown checkout request");
            return callbackResponse(res);
        }

        const transaction = transactionResult.rows[0];
        if (transaction.transaction_status !== "PENDING" || transaction.contribution_status !== "PENDING") {
            console.info(JSON.stringify({
                event: "mpesa.callback.duplicate_or_out_of_order",
                checkout_request_id: checkoutRequestId,
                existing_status: transaction.transaction_status,
            }));
            await client.query("COMMIT");
            return callbackResponse(res);
        }

        let status = "FAILED";
        let description = String(callback.ResultDesc || "Payment failed").slice(0, 255);
        let receipt = null;
        let shouldCredit = false;

        if (resultCode === 0) {
            const amount = Number(metadata.Amount);
            const receiptValue = metadata.MpesaReceiptNumber;
            let callbackPhone;
            try {
                callbackPhone = normalizePhoneNumber(String(metadata.PhoneNumber ?? ""));
            } catch {
                callbackPhone = null;
            }

            const amountMatches = Number.isFinite(amount) && amount === Number(transaction.amount);
            const receiptIsValid = typeof receiptValue === "string" && receiptValue.length > 0 && receiptValue.length <= 25;
            const phoneMatches = callbackPhone !== null && callbackPhone === transaction.mpesa_phone;
            if (amountMatches && receiptIsValid && phoneMatches) {
                status = "COMPLETED";
                description = "Payment completed";
                receipt = receiptValue;
                shouldCredit = true;
            } else {
                description = !amountMatches
                    ? "Payment amount did not match the pending deposit"
                    : !receiptIsValid
                        ? "Payment confirmation did not include a valid receipt"
                        : "Payment phone number did not match the pending deposit";
            }
        } else if (resultCode === 1032) {
            status = "CANCELLED";
            description = String(callback.ResultDesc || "Payment cancelled by the customer").slice(0, 255);
        } else if (resultCode === 1037) {
            status = "TIMED_OUT";
            description = String(callback.ResultDesc || "No response from user.").slice(0, 255);
        }

        if (shouldCredit) {
            const accountResult = await client.query(
                "SELECT account_id FROM pension_accounts WHERE account_id = $1 FOR UPDATE",
                [transaction.account_id]
            );
            if (!accountResult.rowCount) throw new Error("Pension account for confirmed payment no longer exists");
        }

        await client.query(
            `UPDATE transactions
             SET transaction_status = $1, mpesa_receipt = $2, mpesa_result_code = $3,
                 mpesa_result_description = $4, completed_at = now()
             WHERE transaction_id = $5 AND transaction_status = 'PENDING'`,
            [status, receipt, resultCode, description, transaction.transaction_id]
        );
        await client.query(
            `UPDATE contributions
             SET contribution_status = $1
             WHERE transaction_id = $2 AND contribution_status = 'PENDING'`,
            [status, transaction.transaction_id]
        );
        if (shouldCredit) {
            await client.query(
                "UPDATE pension_accounts SET current_balance = current_balance + $1 WHERE account_id = $2",
                [transaction.amount, transaction.account_id]
            );
        }

        await client.query("COMMIT");
        console.info(JSON.stringify({
            event: "mpesa.callback.processed",
            checkout_request_id: checkoutRequestId,
            provider_result_code: resultCode,
            transaction_status: status,
            transaction_id: transaction.transaction_id,
            balance_credited: shouldCredit,
        }));
        return callbackResponse(res);
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("Failed to process M-Pesa callback:", error);
        return res.status(500).json({ ResultCode: 1, ResultDesc: "Callback processing failed" });
    } finally {
        client.release();
    }
}

module.exports = { startStkPush, getStkPushStatus, handleStkCallback };
