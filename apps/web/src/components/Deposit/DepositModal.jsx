import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatKes } from "../../i18n/formatters";
import { getStkPushStatus, initiateStkPush } from "../../services/mpesaApi";
import { useToast } from "../ui/ToastContext";
import Button from "../ui/Button";
import FormField from "../ui/FormField";
import Modal from "../ui/Modal";
import "./deposit.css";

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40;

function DepositModal({ open, onClose, onCompleted }) {
    const { t, i18n } = useTranslation();
    const toast = useToast();
    const [tab, setTab] = useState("mpesa");
    const [amount, setAmount] = useState("");
    const [phoneNumber, setPhoneNumber] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [payment, setPayment] = useState(null);
    const [pollMessageKey, setPollMessageKey] = useState("");
    const submissionInProgressRef = useRef(false);
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
                setPollMessageKey("");

                if (latest.transaction_status === "COMPLETED") {
                    if (completedCheckoutRef.current !== statusReference) {
                        completedCheckoutRef.current = statusReference;
                        toast.success(i18n.t("worker.depositModal.depositSuccessfulToast"));
                        callbacksRef.current.onCompleted?.(latest);
                    }
                    return;
                }
                if (latest.transaction_status === "CANCELLED") {
                    toast.info(i18n.t("worker.depositModal.paymentCancelledToast"));
                    return;
                }
                if (latest.transaction_status === "TIMED_OUT") {
                    toast.info(i18n.t("worker.depositModal.paymentTimedOutMessage"));
                    return;
                }
                if (latest.transaction_status === "FAILED" || latest.transaction_status === "REVERSED") {
                    toast.error(i18n.t("worker.depositModal.paymentNotCompletedMessage"));
                    return;
                }

                attempts += 1;
                if (attempts >= MAX_POLL_ATTEMPTS) {
                    setPollMessageKey("worker.depositModal.pollingPending");
                    return;
                }
                timeoutId = window.setTimeout(poll, POLL_INTERVAL_MS);
            } catch {
                if (!isActive) return;
                setPollMessageKey("worker.depositModal.pollingError");
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
    }, [payment?.checkout_request_id, payment?.transaction_id, payment?.transaction_status, i18n, toast]);

    async function handleSubmit(event) {
        event.preventDefault();
        if (submissionInProgressRef.current) return;
        submissionInProgressRef.current = true;
        setSubmitting(true);
        setPollMessageKey("");
        try {
            const result = await initiateStkPush({ amount: Number(amount), phoneNumber });
            setPayment({
                ...result,
                transaction_status: result.transaction_status || "PENDING",
            });
            setAmount("");
            toast.info(i18n.t(result.confirmation_pending
                ? "worker.depositModal.promptConfirmationPending"
                : "worker.depositModal.sendingPrompt"));
        } catch {
            toast.error(i18n.t("worker.depositModal.startPaymentError"));
        } finally {
            submissionInProgressRef.current = false;
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
        <Modal
            open={open}
            title={t("worker.depositModal.title")}
            closeLabel={t("worker.common.close")}
            onClose={onClose}
        >
            <div className="deposit-modal-content">
                <div className="deposit-tabs" role="tablist" aria-label={t("worker.depositModal.method")}>
                    <button
                        type="button"
                        role="tab"
                        id="deposit-tab-mpesa"
                        aria-selected={tab === "mpesa"}
                        aria-controls="deposit-panel-mpesa"
                        className={`deposit-tab ${tab === "mpesa" ? "active" : ""}`}
                        onClick={() => setTab("mpesa")}
                    >
                        {t("worker.depositModal.mpesaMethod")}
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
                        {t("worker.depositModal.bankMethod")}
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
                                        {pending && t(payment.confirmation_pending
                                            ? "worker.depositModal.awaitingProvider"
                                            : "worker.depositModal.awaitingPin")}
                                        {completed && t("worker.depositModal.depositSuccessfulHeading")}
                                        {cancelled && t("worker.depositModal.paymentCancelledHeading")}
                                        {timedOut && t("worker.depositModal.paymentTimedOut")}
                                        {failed && t("worker.depositModal.paymentNotCompleted")}
                                    </h3>
                                    <p>
                                        {pending && (payment.confirmation_pending
                                            ? t("worker.depositModal.confirmationPendingDetails")
                                            : t("worker.depositModal.pinPromptDetails"))}
                                        {completed && t("worker.depositModal.depositCompletedDetails", {
                                            amount: formatKes(payment.amount, i18n.language) || t("worker.common.notAvailable"),
                                        })}
                                        {cancelled && t("worker.depositModal.cancelledDetails")}
                                        {timedOut && t("worker.depositModal.timedOutDetails")}
                                        {failed && t("worker.depositModal.failedDetails")}
                                    </p>
                                    {pollMessageKey && <p className="deposit-poll-message">{t(pollMessageKey)}</p>}
                                    {payment.mpesa_receipt && <p className="deposit-receipt">{t("worker.depositModal.receipt")}: {payment.mpesa_receipt}</p>}
                                    {terminal && (
                                        <div className="deposit-new-payment">
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                onClick={() => {
                                                    setPayment(null);
                                                    setPollMessageKey("");
                                                    completedCheckoutRef.current = null;
                                                }}
                                            >
                                                {t("worker.depositModal.startAnother")}
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <form className="form-grid" onSubmit={handleSubmit}>
                                <p className="deposit-intro">{t("worker.depositModal.intro")}</p>
                                <FormField
                                    id="deposit-amount"
                                    label={t("worker.depositModal.amount")}
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
                                    label={t("worker.depositModal.phoneNumber")}
                                    type="tel"
                                    autoComplete="tel"
                                    placeholder="0712345678"
                                    required
                                    value={phoneNumber}
                                    onChange={(event) => setPhoneNumber(event.target.value)}
                                    disabled={submitting}
                                />
                                <Button type="submit" variant="primary" loading={submitting}>
                                    {t("worker.depositModal.sendPrompt")}
                                </Button>
                            </form>
                        )}
                    </section>
                ) : (
                    <section id="deposit-panel-bank" role="tabpanel" aria-labelledby="deposit-tab-bank" className="deposit-bank-unavailable">
                        <span className="deposit-bank-icon" aria-hidden="true">▤</span>
                        <h3>{t("worker.depositModal.bankUnavailable")}</h3>
                        <p>{t("worker.depositModal.bankUnavailableDetails")}</p>
                    </section>
                )}
            </div>
        </Modal>
    );
}

export default DepositModal;
