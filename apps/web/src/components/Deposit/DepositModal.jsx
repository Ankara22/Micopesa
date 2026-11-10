import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDateTime, formatKes } from "../../i18n/formatters";
import { getMyBalance, getMyContributions } from "../../services/accountService";
import {
    getPaymentProvider,
    getStkPushStatus,
    getStkPushStatusByIdempotencyKey,
} from "../../services/mpesaApi";
import { useToast } from "../ui/ToastContext";
import Button from "../ui/Button";
import FormField from "../ui/FormField";
import Modal from "../ui/Modal";
import "./deposit.css";

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40;
const terminalAttemptStatuses = new Set(["FAILED", "CANCELLED", "TIMED_OUT"]);
const LAST_STATUS_REFERENCE_KEY = "micopesa.mpesa.lastPaymentAttempt";
const PAYMENT_IDEMPOTENCY_KEY = "micopesa.mpesa.paymentIdempotencyKey";

function getAttemptStatus(payment) {
    return payment?.attempt_status ?? payment?.payment_status;
}

function statusReferenceFor(payment) {
    return payment?.attempt_id || payment?.checkout_request_id || payment?.transaction_id;
}

function isSettled(payment) {
    return payment?.settlement_confirmed === true &&
        payment?.transaction_status === "COMPLETED" &&
        payment?.contribution_status === "COMPLETED";
}

function isPendingPayment(payment) {
    const attemptStatus = getAttemptStatus(payment);
    return !isSettled(payment) &&
        !terminalAttemptStatuses.has(attemptStatus) && (
        ["PENDING", "PROMPT_ACCEPTED", "OUTCOME_UNKNOWN"].includes(attemptStatus) ||
        payment?.transaction_status === "PENDING" ||
        (payment?.transaction_status === "COMPLETED" && payment?.contribution_status !== "COMPLETED")
    );
}

function DepositModal({ open, onClose, onCompleted }) {
    const { t, i18n } = useTranslation();
    const toast = useToast();
    const [tab, setTab] = useState("mpesa");
    const [amount, setAmount] = useState("");
    const [phoneNumber, setPhoneNumber] = useState("");
    const [payment, setPayment] = useState(null);
    const [pollMessageKey, setPollMessageKey] = useState("");
    const [startErrorKey, setStartErrorKey] = useState("");
    const [submissionUnknown, setSubmissionUnknown] = useState(false);
    const [settlementConfirmed, setSettlementConfirmed] = useState(false);
    const [settlementRefreshError, setSettlementRefreshError] = useState(false);
    const [pollingStopped, setPollingStopped] = useState(false);
    const [checkingStatus, setCheckingStatus] = useState(false);
    const [restoringStatus, setRestoringStatus] = useState(false);
    const [paymentProvider, setPaymentProvider] = useState("DARAJA");
    const [providerLoading, setProviderLoading] = useState(true);
    const [providerError, setProviderError] = useState(false);
    const [missingAttemptForKey, setMissingAttemptForKey] = useState(false);
    const submissionInProgressRef = useRef(false);
    const statusCheckInProgressRef = useRef(false);
    const idempotencyKeyRef = useRef(null);
    const completedTransactionRef = useRef(null);
    const callbacksRef = useRef({ onCompleted });

    useEffect(() => {
        callbacksRef.current = { onCompleted };
    }, [onCompleted]);

    const statusReference = statusReferenceFor(payment);
    const paymentNeedsPolling = isPendingPayment(payment);

    useEffect(() => {
        let active = true;
        getPaymentProvider()
            .then((configuration) => {
                if (active) setPaymentProvider(configuration.provider);
            })
            .catch(() => {
                if (active) setProviderError(true);
            })
            .finally(() => {
                if (active) setProviderLoading(false);
            });
        return () => {
            active = false;
        };
    }, [open]);

    const checkPaymentStatus = useCallback(async (
        referenceOverride,
        paymentSnapshot = payment
    ) => {
        const statusReference = referenceOverride || statusReferenceFor(paymentSnapshot);
        if (!statusReference || statusCheckInProgressRef.current) return { kind: "busy" };

        statusCheckInProgressRef.current = true;
        setCheckingStatus(true);
        try {
            const attemptStatus = getAttemptStatus(paymentSnapshot);
            const latest = await getStkPushStatus(statusReference);
            const latestAttemptStatus = latest.attempt_status;
            const normalizedLatest = {
                ...latest,
                simulated: latest.payment_provider === "SIMULATED" || paymentSnapshot?.simulated === true,
                payment_status: latestAttemptStatus,
            };
            setPayment((current) => ({ ...current, ...normalizedLatest }));
            setPollMessageKey("");

            if (isSettled(latest)) {
                try {
                    window.sessionStorage.removeItem(LAST_STATUS_REFERENCE_KEY);
                    window.sessionStorage.removeItem(PAYMENT_IDEMPOTENCY_KEY);
                    idempotencyKeyRef.current = null;
                } catch {
                    setPollMessageKey("worker.depositModal.statusRecoveryUnavailable");
                }
                setSettlementConfirmed(true);
                if (completedTransactionRef.current !== latest.transaction_id) {
                    completedTransactionRef.current = latest.transaction_id;
                    const [balanceResult, contributionsResult] = await Promise.allSettled([
                        getMyBalance(),
                        getMyContributions(),
                    ]);
                    const refreshedData = {
                        balance: balanceResult.status === "fulfilled" ? balanceResult.value : null,
                        contributions: contributionsResult.status === "fulfilled"
                            ? contributionsResult.value
                            : null,
                    };
                    setSettlementRefreshError(
                        balanceResult.status === "rejected" || contributionsResult.status === "rejected"
                    );
                    callbacksRef.current.onCompleted?.(latest, refreshedData);
                    toast.success(i18n.t("worker.depositModal.depositSuccessfulToast"));
                }
                return { kind: "settled" };
            }

            if (
                latest.transaction_status === "CANCELLED" ||
                latest.transaction_status === "TIMED_OUT" ||
                latest.transaction_status === "FAILED" ||
                latest.transaction_status === "REVERSED" ||
                terminalAttemptStatuses.has(attemptStatus)
            ) {
                try {
                    window.sessionStorage.removeItem(LAST_STATUS_REFERENCE_KEY);
                } catch {
                    setPollMessageKey("worker.depositModal.statusRecoveryUnavailable");
                }
                return { kind: "terminal" };
            }
            if (latest.transaction_status === "COMPLETED") {
                setPollMessageKey("worker.depositModal.statusUpdating");
            }
            return { kind: "pending" };
        } catch (error) {
            const messageKey = error?.status === 401
                ? "worker.depositModal.sessionExpired"
                : error?.status === 403
                    ? "worker.depositModal.statusForbidden"
                    : error?.status === 404
                        ? "worker.depositModal.statusNotFound"
                        : "worker.depositModal.pollingError";
            setPollMessageKey(messageKey);
            setMissingAttemptForKey(error?.status === 404);
            return { kind: "error", stop: [401, 403, 404].includes(error?.status) };
        } finally {
            statusCheckInProgressRef.current = false;
            setCheckingStatus(false);
        }
    }, [i18n, payment, toast]);

    useEffect(() => {
        if (!open || payment || submissionUnknown || submissionInProgressRef.current) return;
        let savedReference;
        let savedIdempotencyKey;
        try {
            savedReference = window.sessionStorage.getItem(LAST_STATUS_REFERENCE_KEY);
            savedIdempotencyKey = window.sessionStorage.getItem(PAYMENT_IDEMPOTENCY_KEY);
        } catch {
            console.warn("Unable to read saved M-Pesa payment recovery data.");
            return;
        }
        if (!savedReference && !savedIdempotencyKey) return;

        if (savedIdempotencyKey) idempotencyKeyRef.current = savedIdempotencyKey;
        if (savedReference) {
            // Restore the saved attempt before rendering a form that could start another request.
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setPayment({
                attempt_id: savedReference,
                attempt_status: "OUTCOME_UNKNOWN",
                payment_status: "OUTCOME_UNKNOWN",
                transaction_status: "PENDING",
                contribution_status: "PENDING",
            });
            void (async () => {
                setRestoringStatus(true);
                try {
                    const result = await checkPaymentStatus(savedReference);
                    if (result?.stop) setPollingStopped(true);
                } finally {
                    setRestoringStatus(false);
                }
            })();
            return;
        }

        void (async () => {
            setRestoringStatus(true);
            try {
                const latest = await getStkPushStatusByIdempotencyKey(savedIdempotencyKey);
                const reference = statusReferenceFor(latest);
                if (!reference) return;
                try {
                    window.sessionStorage.setItem(LAST_STATUS_REFERENCE_KEY, reference);
                } catch {
                    setPollMessageKey("worker.depositModal.statusRecoveryUnavailable");
                }
                setPayment({
                    ...latest,
                    simulated: latest.payment_provider === "SIMULATED",
                    payment_status: latest.attempt_status,
                });
                const result = await checkPaymentStatus(reference);
                if (result?.stop) setPollingStopped(true);
            } catch (error) {
                setSubmissionUnknown(true);
                setMissingAttemptForKey(error?.status === 404);
                setPollMessageKey(error?.status === 401
                    ? "worker.depositModal.sessionExpired"
                    : error?.status === 404
                        ? "worker.depositModal.statusNotFound"
                        : "worker.depositModal.pollingError");
            } finally {
                setRestoringStatus(false);
            }
        })();
    }, [open, payment, submissionUnknown, checkPaymentStatus]);

    useEffect(() => {
        if (!statusReference || !paymentNeedsPolling || pollingStopped || payment?.simulated) {
            return undefined;
        }

        let isActive = true;
        let timeoutId;
        let attempts = 0;

        async function poll() {
            const result = await checkPaymentStatus();
            if (!isActive || result?.kind === "settled" || result?.kind === "terminal") return;
            if (result?.stop) {
                setPollingStopped(true);
                return;
            }
            attempts += 1;
            if (attempts >= MAX_POLL_ATTEMPTS) {
                setPollingStopped(true);
                setPollMessageKey("worker.depositModal.pollingPending");
                return;
            }
            timeoutId = window.setTimeout(poll, POLL_INTERVAL_MS);
        }

        timeoutId = window.setTimeout(poll, POLL_INTERVAL_MS);
        return () => {
            isActive = false;
            window.clearTimeout(timeoutId);
        };
    }, [
        statusReference,
        paymentNeedsPolling,
        pollingStopped,
        payment?.simulated,
        checkPaymentStatus,
    ]);

    function handleSubmit(event) {
        event.preventDefault();
        setStartErrorKey("worker.depositModal.paymentDisabled");
    }

    async function handleManualStatusCheck() {
        setPollingStopped(false);
        setPollMessageKey("");
        await checkPaymentStatus();
    }

    async function handleUnknownSubmissionStatusCheck() {
        let idempotencyKey = idempotencyKeyRef.current;
        try {
            if (!idempotencyKey) {
                idempotencyKey = window.sessionStorage.getItem(PAYMENT_IDEMPOTENCY_KEY);
            }
        } catch {
            setPollMessageKey("worker.depositModal.statusRecoveryUnavailable");
            return;
        }
        if (!idempotencyKey || restoringStatus) {
            setPollMessageKey("worker.depositModal.statusRecoveryUnavailable");
            return;
        }

        setRestoringStatus(true);
        setPollMessageKey("");
        setMissingAttemptForKey(false);
        try {
            const latest = await getStkPushStatusByIdempotencyKey(idempotencyKey);
            const reference = statusReferenceFor(latest);
            if (!reference) {
                setPollMessageKey("worker.depositModal.statusRecoveryUnavailable");
                return;
            }
            try {
                window.sessionStorage.setItem(LAST_STATUS_REFERENCE_KEY, reference);
            } catch {
                setPollMessageKey("worker.depositModal.statusRecoveryUnavailable");
            }
            const recoveredPayment = {
                ...latest,
                simulated: latest.payment_provider === "SIMULATED",
                payment_status: latest.attempt_status,
            };
            setPayment(recoveredPayment);
            setSubmissionUnknown(false);
            setMissingAttemptForKey(false);
            await checkPaymentStatus(reference, recoveredPayment);
        } catch (error) {
            setMissingAttemptForKey(error?.status === 404);
            setPollMessageKey(error?.status === 401
                ? "worker.depositModal.sessionExpired"
                : error?.status === 403
                    ? "worker.depositModal.statusForbidden"
                    : error?.status === 404
                        ? "worker.depositModal.statusNotFound"
                        : "worker.depositModal.pollingError");
        } finally {
            setRestoringStatus(false);
        }
    }

    function clearMissingAttemptReference() {
        try {
            window.sessionStorage.removeItem(LAST_STATUS_REFERENCE_KEY);
            window.sessionStorage.removeItem(PAYMENT_IDEMPOTENCY_KEY);
        } catch {
            setPollMessageKey("worker.depositModal.statusRecoveryUnavailable");
            return;
        }
        idempotencyKeyRef.current = null;
        setPayment(null);
        setSubmissionUnknown(false);
        setMissingAttemptForKey(false);
        setSettlementConfirmed(false);
        setSettlementRefreshError(false);
        setPollingStopped(false);
        completedTransactionRef.current = null;
        setPollMessageKey("");
        setStartErrorKey("");
    }

    const pending = isPendingPayment(payment);
    const completed = settlementConfirmed;
    const cancelled = payment?.transaction_status === "CANCELLED" || payment?.payment_status === "CANCELLED";
    const timedOut = payment?.transaction_status === "TIMED_OUT" || payment?.payment_status === "TIMED_OUT";
    const failed = ["FAILED", "REVERSED"].includes(payment?.transaction_status) ||
        getAttemptStatus(payment) === "FAILED";
    const terminal = completed || cancelled || timedOut || failed;
    const promptAccepted = getAttemptStatus(payment) === "PROMPT_ACCEPTED";
    const outcomeUnknown = payment?.payment_outcome === "UNKNOWN" ||
        (getAttemptStatus(payment) === "OUTCOME_UNKNOWN" &&
            !(payment?.simulated && payment?.payment_outcome === "PENDING"));

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
                        {paymentProvider === "SIMULATOR"
                            ? t("worker.depositModal.simulatorMethod")
                            : t("worker.depositModal.mpesaMethod")}
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
                        {submissionUnknown ? (
                            <div className="deposit-payment-state failure" role="alert">
                                <span className="deposit-status-indicator" aria-hidden="true">!</span>
                                <div>
                                    <h3>{t("worker.depositModal.outcomeUnknownHeading")}</h3>
                                    <p>{t("worker.depositModal.unknownSubmissionDetails")}</p>
                                    {pollMessageKey && <p className="deposit-poll-message">{t(pollMessageKey)}</p>}
                                    {missingAttemptForKey && (
                                        <>
                                            <p className="deposit-poll-message" role="note">
                                                {t("worker.depositModal.missingAttemptRecoveryDetails")}
                                            </p>
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                disabled={restoringStatus}
                                                onClick={clearMissingAttemptReference}
                                            >
                                                {t("worker.depositModal.clearMissingAttempt")}
                                            </Button>
                                        </>
                                    )}
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        loading={restoringStatus}
                                        onClick={handleUnknownSubmissionStatusCheck}
                                    >
                                        {t("worker.depositModal.checkStatus")}
                                    </Button>
                                    <Button variant="secondary" size="sm" onClick={onClose}>
                                        {t("worker.common.close")}
                                    </Button>
                                </div>
                            </div>
                        ) : payment ? (
                            <div className={`deposit-payment-state ${completed ? "success" : ""} ${cancelled || timedOut || failed ? "failure" : ""}`} role="status" aria-live="polite">
                                <span className="deposit-status-indicator" aria-hidden="true">
                                    {pending ? <span className="deposit-spinner" /> : completed ? "✓" : "!"}
                                </span>
                                <div>
                                    <h3>
                                        {pending && t(outcomeUnknown
                                            ? "worker.depositModal.outcomeUnknownHeading"
                                            : payment.simulated && payment.payment_outcome === "PENDING"
                                                ? "worker.depositModal.simulatorPendingHeading"
                                            : promptAccepted
                                                ? "worker.depositModal.promptAcceptedHeading"
                                                : "worker.depositModal.awaitingProvider")}
                                        {completed && t("worker.depositModal.depositSuccessfulHeading")}
                                        {cancelled && t("worker.depositModal.paymentCancelledHeading")}
                                        {timedOut && t("worker.depositModal.paymentTimedOut")}
                                        {failed && t("worker.depositModal.paymentNotCompleted")}
                                    </h3>
                                    {payment.simulated && (
                                        <p className="deposit-simulator-notice" role="note">
                                            <strong>{t("worker.depositModal.simulatedLabel")}</strong>{" "}
                                            {t("worker.depositModal.noRealMoneyNotice")}
                                        </p>
                                    )}
                                    <p>
                                        {pending && t(outcomeUnknown
                                            ? "worker.depositModal.outcomeUnknownDetails"
                                            : payment.simulated && payment.payment_outcome === "PENDING"
                                                ? "worker.depositModal.simulatorPendingDetails"
                                            : promptAccepted
                                                ? "worker.depositModal.promptAcceptedDetails"
                                                : "worker.depositModal.confirmationPendingDetails")}
                                        {completed && t("worker.depositModal.depositCompletedDetails", {
                                            amount: formatKes(payment.amount, i18n.language) || t("worker.common.notAvailable"),
                                        })}
                                        {cancelled && t("worker.depositModal.cancelledDetails")}
                                        {timedOut && t("worker.depositModal.timedOutDetails")}
                                        {failed && t("worker.depositModal.failedDetails")}
                                    </p>
                                    {pollMessageKey && <p className="deposit-poll-message">{t(pollMessageKey)}</p>}
                                    {missingAttemptForKey && (
                                        <>
                                            <p className="deposit-poll-message" role="note">
                                                {t("worker.depositModal.missingAttemptRecoveryDetails")}
                                            </p>
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                disabled={checkingStatus}
                                                onClick={clearMissingAttemptReference}
                                            >
                                                {t("worker.depositModal.clearMissingAttempt")}
                                            </Button>
                                        </>
                                    )}
                                    {settlementRefreshError && (
                                        <p className="deposit-poll-message" role="status">
                                            {t("worker.depositModal.settlementRefreshError")}
                                        </p>
                                    )}
                                    {(payment.receipt_reference || payment.mpesa_receipt ||
                                        (payment.simulated && payment.checkout_request_id)) && (
                                        <p className="deposit-receipt">
                                            {payment.simulated
                                                ? t("worker.contributions.syntheticReference")
                                                : t("worker.depositModal.receipt")}: {payment.receipt_reference ||
                                                payment.mpesa_receipt || payment.checkout_request_id}
                                        </p>
                                    )}
                                    {payment.settled_at && (
                                        <p className="deposit-receipt">
                                            {t("worker.depositModal.settledAt")}: {formatDateTime(payment.settled_at, i18n.language)}
                                        </p>
                                    )}
                                    {pending && (
                                        <div className="deposit-new-payment">
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                loading={checkingStatus}
                                                onClick={handleManualStatusCheck}
                                            >
                                                {t("worker.depositModal.checkStatus")}
                                            </Button>
                                        </div>
                                    )}
                                    {terminal && (
                                        <div className="deposit-new-payment">
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                onClick={() => {
                                                    setPayment(null);
                                                    try {
                                                        window.sessionStorage.removeItem(LAST_STATUS_REFERENCE_KEY);
                                                        window.sessionStorage.removeItem(PAYMENT_IDEMPOTENCY_KEY);
                                                        idempotencyKeyRef.current = null;
                                                    } catch {
                                                        setPollMessageKey("worker.depositModal.statusRecoveryUnavailable");
                                                    }
                                                    if (payment.amount !== undefined && payment.amount !== null) {
                                                        setAmount(String(payment.amount));
                                                    }
                                                    setPollMessageKey("");
                                                    setStartErrorKey("");
                                                    setSettlementConfirmed(false);
                                                    setSettlementRefreshError(false);
                                                    setPollingStopped(false);
                                                    completedTransactionRef.current = null;
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
                                <p className="deposit-intro" role="status">
                                    {t("worker.depositModal.paymentDisabled")}
                                </p>
                                {providerLoading && <p role="status">{t("worker.depositModal.loadingProvider")}</p>}
                                {providerError && (
                                    <p className="deposit-poll-message" role="alert">
                                        {t("worker.depositModal.providerUnavailable")}
                                    </p>
                                )}
                                {startErrorKey && <p className="deposit-poll-message" role="alert">{t(startErrorKey)}</p>}
                                <FormField
                                    id="deposit-amount"
                                    label={t("worker.depositModal.amount")}
                                    type="number"
                                    min="1"
                                    step="1"
                                    inputMode="numeric"
                                    required
                                    value={amount}
                                    onChange={(event) => {
                                        setAmount(event.target.value);
                                        idempotencyKeyRef.current = null;
                                        try {
                                            window.sessionStorage.removeItem(PAYMENT_IDEMPOTENCY_KEY);
                                        } catch {
                                            setStartErrorKey("worker.depositModal.statusRecoveryUnavailable");
                                        }
                                    }}
                                    disabled
                                />
                                <FormField
                                    id="deposit-phone"
                                    label={t("worker.depositModal.phoneNumber")}
                                    type="tel"
                                    autoComplete="tel"
                                    placeholder="0712345678"
                                    pattern={String.raw`(?:\s*(?:0[17]|\+?254[17])(?:[\s\(\)\-]*[0-9]){8}\s*)`}
                                    title={t("worker.depositModal.phoneNumberValidation")}
                                    required
                                    value={phoneNumber}
                                    onChange={(event) => {
                                        setPhoneNumber(event.target.value);
                                        idempotencyKeyRef.current = null;
                                        try {
                                            window.sessionStorage.removeItem(PAYMENT_IDEMPOTENCY_KEY);
                                        } catch {
                                            setStartErrorKey("worker.depositModal.statusRecoveryUnavailable");
                                        }
                                    }}
                                    disabled
                                />
                                <Button
                                    type="submit"
                                    variant="primary"
                                    disabled
                                >
                                    {t("worker.depositModal.paymentDisabledButton")}
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
