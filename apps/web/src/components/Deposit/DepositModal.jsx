import { useEffect, useRef, useState } from "react";
import { getStkPushStatus, initiateStkPush } from "../../services/mpesaApi";
import { useToast } from "../ui/ToastContext";
import Button from "../ui/Button";
import FormField from "../ui/FormField";
import Modal from "../ui/Modal";
import "./deposit.css";

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40;

function DepositModal({ open, onClose, onCompleted }) {
    const toast = useToast();
    const [tab, setTab] = useState("mpesa");
    const [amount, setAmount] = useState("");
    const [phoneNumber, setPhoneNumber] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [payment, setPayment] = useState(null);
    const [pollMessage, setPollMessage] = useState("");
    const completedCheckoutRef = useRef(null);
    const callbacksRef = useRef({ onCompleted });

    useEffect(() => {
        callbacksRef.current = { onCompleted };
    }, [onCompleted]);

    useEffect(() => {
        const statusReference = payment?.checkout_request_id || payment?.transaction_id;
        if (!statusReference || payment?.transaction_status !== "PENDING") return undefined;

        let isActive = true;
        let timeoutId;
        let attempts = 0;

        async function poll() {
            try {
                const latest = await getStkPushStatus(statusReference);
                if (!isActive) return;
                setPayment((current) => ({ ...current, ...latest }));
                setPollMessage("");

                if (latest.transaction_status === "COMPLETED") {
                    if (completedCheckoutRef.current !== statusReference) {
                        completedCheckoutRef.current = statusReference;
                        toast.success("Deposit successful.");
                        callbacksRef.current.onCompleted?.(latest);
                    }
                    return;
                }
                if (latest.transaction_status === "CANCELLED") {
                    toast.info("Payment cancelled.");
                    return;
                }
                if (latest.transaction_status === "TIMED_OUT") {
                    toast.info(latest.mpesa_result_description || "No response was received before the M-Pesa prompt expired.");
                    return;
                }
                if (latest.transaction_status === "FAILED" || latest.transaction_status === "REVERSED") {
                    toast.error(latest.mpesa_result_description || "The M-Pesa payment was not completed.");
                    return;
                }

                attempts += 1;
                if (attempts >= MAX_POLL_ATTEMPTS) {
                    setPollMessage("The payment is still pending. You can close this window and check your contribution history later.");
                    return;
                }
                timeoutId = window.setTimeout(poll, POLL_INTERVAL_MS);
            } catch (error) {
                if (!isActive) return;
                setPollMessage(error.message || "Unable to check payment status. Retrying…");
                attempts += 1;
                if (attempts < MAX_POLL_ATTEMPTS) {
                    timeoutId = window.setTimeout(poll, POLL_INTERVAL_MS);
                }
            }
        }

        timeoutId = window.setTimeout(poll, POLL_INTERVAL_MS);
        return () => {
            isActive = false;
            window.clearTimeout(timeoutId);
        };
    }, [payment?.checkout_request_id, payment?.transaction_id, payment?.transaction_status, toast]);

    async function handleSubmit(event) {
        event.preventDefault();
        setSubmitting(true);
        setPollMessage("");
        try {
            const result = await initiateStkPush({ amount: Number(amount), phoneNumber });
            setPayment({
                ...result,
                transaction_status: result.transaction_status || "PENDING",
            });
            setAmount("");
            toast.info(result.confirmation_pending
                ? "M-Pesa has not confirmed whether the prompt was sent. Your deposit remains pending; do not retry yet."
                : "Sending STK Push prompt to your phone.");
        } catch (error) {
            toast.error(error.message || "Could not start the M-Pesa payment.");
        } finally {
            setSubmitting(false);
        }
    }

    const pending = payment?.transaction_status === "PENDING";
    const completed = payment?.transaction_status === "COMPLETED";
    const cancelled = payment?.transaction_status === "CANCELLED";
    const timedOut = payment?.transaction_status === "TIMED_OUT";
    const failed = ["FAILED", "REVERSED"].includes(payment?.transaction_status);
    const terminal = completed || cancelled || timedOut || failed;

    return (
        <Modal open={open} title="Add to your pension account" onClose={onClose}>
            <div className="deposit-modal-content">
                <div className="deposit-tabs" role="tablist" aria-label="Deposit method">
                    <button
                        type="button"
                        role="tab"
                        id="deposit-tab-mpesa"
                        aria-selected={tab === "mpesa"}
                        aria-controls="deposit-panel-mpesa"
                        className={`deposit-tab ${tab === "mpesa" ? "active" : ""}`}
                        onClick={() => setTab("mpesa")}
                    >
                        M-Pesa STK Push
                    </button>
                    <button
                        type="button"
                        role="tab"
                        id="deposit-tab-bank"
                        aria-selected={tab === "bank"}
                        aria-controls="deposit-panel-bank"
                        className={`deposit-tab ${tab === "bank" ? "active" : ""}`}
                        onClick={() => setTab("bank")}
                    >
                        Bank transfer / Paybill
                    </button>
                </div>

                {tab === "mpesa" ? (
                    <section id="deposit-panel-mpesa" role="tabpanel" aria-labelledby="deposit-tab-mpesa">
                        {payment ? (
                            <div className={`deposit-payment-state ${completed ? "success" : ""} ${cancelled || timedOut || failed ? "failure" : ""}`} role="status" aria-live="polite">
                                <span className="deposit-status-indicator" aria-hidden="true">
                                    {pending ? <span className="deposit-spinner" /> : completed ? "✓" : "!"}
                                </span>
                                <div>
                                    <h3>
                                        {pending && (payment.confirmation_pending ? "Awaiting provider confirmation..." : "Awaiting PIN entry...")}
                                        {completed && "Deposit Successful!"}
                                        {cancelled && "Payment Cancelled"}
                                        {timedOut && "Payment Timed Out"}
                                        {failed && "Payment Not Completed"}
                                    </h3>
                                    <p>
                                        {pending && (payment.confirmation_pending
                                            ? "M-Pesa did not return a definitive response. The transaction remains pending; no balance has been credited. Check your contribution history before retrying."
                                            : "Sending STK Push prompt to phone. Enter your M-Pesa PIN to authorize the deposit.")}
                                        {completed && `KSh ${Number(payment.amount).toLocaleString()} has been added to your pension account.`}
                                        {cancelled && (payment.mpesa_result_description || "The payment was cancelled. No funds were added.")}
                                        {timedOut && (payment.mpesa_result_description || "No response was received before the M-Pesa prompt expired. No funds were added.")}
                                        {failed && (payment.mpesa_result_description || "The payment could not be confirmed. No funds were added.")}
                                    </p>
                                    {pollMessage && <p className="deposit-poll-message">{pollMessage}</p>}
                                    {payment.mpesa_receipt && <p className="deposit-receipt">M-Pesa receipt: {payment.mpesa_receipt}</p>}
                                    {terminal && (
                                        <div className="deposit-new-payment">
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                onClick={() => {
                                                    setPayment(null);
                                                    setPollMessage("");
                                                    completedCheckoutRef.current = null;
                                                }}
                                            >
                                                Start another deposit
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <form className="form-grid" onSubmit={handleSubmit}>
                                <p className="deposit-intro">A secure payment prompt will be sent to your M-Pesa phone. Your balance updates after payment confirmation.</p>
                                <FormField
                                    id="deposit-amount"
                                    label="Amount (KES)"
                                    type="number"
                                    min="1"
                                    step="1"
                                    inputMode="numeric"
                                    required
                                    value={amount}
                                    onChange={(event) => setAmount(event.target.value)}
                                    disabled={submitting}
                                />
                                <FormField
                                    id="deposit-phone"
                                    label="M-Pesa phone number"
                                    type="tel"
                                    autoComplete="tel"
                                    placeholder="0712345678"
                                    required
                                    value={phoneNumber}
                                    onChange={(event) => setPhoneNumber(event.target.value)}
                                    disabled={submitting}
                                />
                                <Button type="submit" variant="primary" loading={submitting}>
                                    Send STK Push
                                </Button>
                            </form>
                        )}
                    </section>
                ) : (
                    <section id="deposit-panel-bank" role="tabpanel" aria-labelledby="deposit-tab-bank" className="deposit-bank-unavailable">
                        <span className="deposit-bank-icon" aria-hidden="true">▤</span>
                        <h3>Bank deposits are not available yet</h3>
                        <p>Verified bank account and Paybill instructions have not been configured. Please use M-Pesa STK Push for now.</p>
                    </section>
                )}
            </div>
        </Modal>
    );
}

export default DepositModal;
