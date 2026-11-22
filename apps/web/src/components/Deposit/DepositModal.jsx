import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDateTime, formatKes } from "../../i18n/formatters";
import { getMyBalance, getMyContributions } from "../../services/accountService";
import {
    confirmSimulatedPayment,
    getPaymentProvider,
    getStkPushStatus,
    getStkPushStatusByIdempotencyKey,
    initiateStkPush,
} from "../../services/mpesaApi";
import { getMyProfile } from "../../services/profileApi";
import { useToast } from "../ui/ToastContext";
import Button from "../ui/Button";
import FormField from "../ui/FormField";
import Modal from "../ui/Modal";
import useApi from "../../hooks/useApi";
import "./deposit.css";

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40;
const terminalAttemptStatuses = new Set(["FAILED", "CANCELLED", "TIMED_OUT"]);
const LAST_STATUS_REFERENCE_KEY = "micopesa.mpesa.lastPaymentAttempt";
const PAYMENT_IDEMPOTENCY_KEY = "micopesa.mpesa.paymentIdempotencyKey";
const initiationErrorKeysByCode = {
    MPESA_VERIFIED_PHONE_REQUIRED: "worker.depositModal.verifiedPhoneRequired",
    MPESA_ALLOCATION_INVALID: "worker.depositModal.allocationInvalid",
    MPESA_ACCOUNT_NOT_AVAILABLE: "worker.depositModal.accountUnavailable",
    MPESA_CONTRIBUTION_NOT_ELIGIBLE: "worker.depositModal.contributionNotEligible",
    MPESA_IDEMPOTENCY_CONFLICT: "worker.depositModal.idempotencyConflict",
    MPESA_PROVIDER_MISMATCH: "worker.depositModal.providerMismatch",
    MPESA_SIMULATOR_UNAVAILABLE: "worker.depositModal.paymentDisabled",
    MPESA_SIMULATOR_FORBIDDEN: "worker.depositModal.startForbidden",
    MPESA_LEDGER_NOT_READY: "worker.depositModal.ledgerNotReady",
    MPESA_REQUEST_CONFLICT: "worker.depositModal.requestConflict",
    MPESA_REQUEST_NOT_FOUND: "worker.depositModal.requestNotFound",
    MPESA_INVALID_REQUEST: "worker.depositModal.invalidRequest",
    MPESA_INITIATION_UNAVAILABLE: "worker.depositModal.initiationUnavailable",
};
const preDispatchErrorCodes = new Set([
    "MPESA_VERIFIED_PHONE_REQUIRED",
    "MPESA_ALLOCATION_INVALID",
    "MPESA_ACCOUNT_NOT_AVAILABLE",
    "MPESA_CONTRIBUTION_NOT_ELIGIBLE",
    "MPESA_PROVIDER_MISMATCH",
    "MPESA_SIMULATOR_UNAVAILABLE",
    "MPESA_SIMULATOR_FORBIDDEN",
    "MPESA_LEDGER_NOT_READY",
    "MPESA_INVALID_REQUEST",
]);

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
    const profileApi = useApi(
        () => open ? getMyProfile() : Promise.resolve(null),
        [open]
    );
    const [tab, setTab] = useState("mpesa");
    const [amount, setAmount] = useState("");
    const [confirmedPhone, setConfirmedPhone] = useState("");
    const [payment, setPayment] = useState(null);
    const [pollMessageKey, setPollMessageKey] = useState("");
    const [startErrorKey, setStartErrorKey] = useState("");
    const [submissionUnknown, setSubmissionUnknown] = useState(false);
    const [settlementConfirmed, setSettlementConfirmed] = useState(false);
    const [settlementRefreshError, setSettlementRefreshError] = useState(false);
    const [pollingStopped, setPollingStopped] = useState(false);
    const [checkingStatus, setCheckingStatus] = useState(false);
    const [restoringStatus, setRestoringStatus] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [missingAttemptForKey, setMissingAttemptForKey] = useState(false);
    const submissionInProgressRef = useRef(false);
    const statusCheckInProgressRef = useRef(false);
    const simulatorConfirmationInProgressRef = useRef(false);
    const idempotencyKeyRef = useRef(null);
    const completedTransactionRef = useRef(null);
    const callbacksRef = useRef({ onCompleted });
    const providerApi = useApi(
        () => open ? getPaymentProvider() : Promise.resolve(null),
        [open]
    );
    const providerIsSimulator = providerApi.data?.provider === "SIMULATOR";
    const paymentEnabled = providerIsSimulator &&
        providerApi.data?.payment_enabled === true;
    const providerLoading = providerApi.loading;
    const providerError = Boolean(providerApi.error);

    useEffect(() => {
        callbacksRef.current = { onCompleted };
    }, [onCompleted]);

    const statusReference = statusReferenceFor(payment);
    const paymentNeedsPolling = isPendingPayment(payment);
    const verifiedPhone = typeof profileApi.data?.phone === "string" &&
        profileApi.data.phone.trim().length > 0 &&
        typeof profileApi.data.phone_verified_at === "string" &&
        profileApi.data.phone_verified_at.length > 0;
    const phoneNumber = verifiedPhone ? profileApi.data.phone : "";
    const phoneConfirmed = verifiedPhone && confirmedPhone === phoneNumber;

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
        if (
            !paymentEnabled ||
            !verifiedPhone ||
            !phoneConfirmed ||
            submitting ||
            submissionInProgressRef.current ||
            restoringStatus
        ) return;

        const amountText = amount.trim();
        const parsedAmount = Number(amountText);
        if (!/^\d+$/.test(amountText) ||
            !Number.isSafeInteger(parsedAmount) ||
            parsedAmount <= 0) {
            setStartErrorKey("worker.depositModal.invalidAmount");
            return;
        }

        const idempotencyKey = window.crypto?.randomUUID?.();
        if (!idempotencyKey) {
            setStartErrorKey("worker.depositModal.statusRecoveryUnavailable");
            return;
        }

        try {
            window.sessionStorage.setItem(PAYMENT_IDEMPOTENCY_KEY, idempotencyKey);
        } catch {
            setStartErrorKey("worker.depositModal.statusRecoveryUnavailable");
            return;
        }

        submissionInProgressRef.current = true;
        idempotencyKeyRef.current = idempotencyKey;
        setSubmitting(true);
        setStartErrorKey("");
        setPollMessageKey("");
        setSubmissionUnknown(false);
        const provider = providerApi.data.provider;
        void initiateStkPush({
            amount: parsedAmount,
            phoneNumber,
            idempotencyKey,
            provider,
        })
            .then((result) => {
                const submittedPayment = {
                    ...result,
                    simulated: provider === "SIMULATOR" || result.simulated === true,
                };
                setPayment(submittedPayment);
                setSubmissionUnknown(false);
                setMissingAttemptForKey(false);
                try {
                    window.sessionStorage.setItem(
                        LAST_STATUS_REFERENCE_KEY,
                        statusReferenceFor(submittedPayment)
                    );
                } catch {
                    setPollMessageKey("worker.depositModal.statusRecoveryUnavailable");
                }
                if (provider === "SIMULATOR") {
                    void checkPaymentStatus(
                        statusReferenceFor(submittedPayment),
                        submittedPayment
                    );
                }
            })
            .catch((error) => {
                const messageKey = error?.data?.message_key;
                const rejectedBeforeDispatch = [400, 401, 403, 422, 429]
                    .includes(error?.status) ||
                    preDispatchErrorCodes.has(messageKey);
                if (!rejectedBeforeDispatch) {
                    setSubmissionUnknown(true);
                    setPollMessageKey("worker.depositModal.unknownSubmissionDetails");
                    return;
                }
                try {
                    window.sessionStorage.removeItem(PAYMENT_IDEMPOTENCY_KEY);
                    idempotencyKeyRef.current = null;
                } catch {
                    setPollMessageKey("worker.depositModal.statusRecoveryUnavailable");
                }
                const startMessageKey = initiationErrorKeysByCode[messageKey];
                setStartErrorKey(startMessageKey || (error?.status === 403
                    ? "worker.depositModal.startForbidden"
                    : error?.status === 503
                        ? "worker.depositModal.paymentDisabled"
                        : "worker.depositModal.startPaymentError"));
            })
            .finally(() => {
                submissionInProgressRef.current = false;
                setSubmitting(false);
            });
    }

    async function handleManualStatusCheck() {
        setPollingStopped(false);
        setPollMessageKey("");
        if (
            payment?.simulated &&
            ["PENDING", "UNKNOWN"].includes(payment.payment_outcome) &&
            typeof payment.attempt_id === "string"
        ) {
            if (
                statusCheckInProgressRef.current ||
                simulatorConfirmationInProgressRef.current
            ) return;
            simulatorConfirmationInProgressRef.current = true;
            setCheckingStatus(true);
            try {
                const latest = await confirmSimulatedPayment(payment.attempt_id);
                const normalizedLatest = {
                    ...latest,
                    simulated: true,
                    payment_status: latest.attempt_status,
                };
                setPayment((current) => ({ ...current, ...normalizedLatest }));
                if (isSettled(latest)) {
                    await checkPaymentStatus(
                        statusReferenceFor(normalizedLatest),
                        normalizedLatest
                    );
                }
            } catch (error) {
                const messageKey = error?.status === 401
                    ? "worker.depositModal.sessionExpired"
                    : error?.status === 403
                        ? "worker.depositModal.statusForbidden"
                        : error?.status === 404
                            ? "worker.depositModal.statusNotFound"
                            : "worker.depositModal.pollingError";
                setPollMessageKey(messageKey);
            } finally {
                simulatorConfirmationInProgressRef.current = false;
                setCheckingStatus(false);
            }
            return;
        }
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
                        {t(providerIsSimulator
                            ? "worker.depositModal.simulatorMethod"
                            : "worker.depositModal.mpesaMethod")}
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
                                        {pending && t(payment.simulated &&
                                            payment.payment_outcome === "UNKNOWN"
                                            ? "worker.depositModal.simulatorUnknownDetails"
                                            : outcomeUnknown
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
                                                disabled={checkingStatus}
                                                onClick={handleManualStatusCheck}
                                            >
                                                {t(payment.simulated &&
                                                    payment.payment_outcome === "PENDING"
                                                    ? "worker.depositModal.retrySimulatorConfirmation"
                                                    : payment.simulated &&
                                                        payment.payment_outcome === "UNKNOWN"
                                                        ? "worker.depositModal.retrySimulatorVerification"
                                                        : "worker.depositModal.checkStatus")}
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
                                {providerIsSimulator && (
                                    <p className="deposit-simulator-notice" role="note">
                                        <strong>{t("worker.depositModal.simulatedLabel")}</strong>{" "}
                                        {t("worker.depositModal.noRealMoneyNotice")}
                                    </p>
                                )}
                                {paymentEnabled
                                    ? <p className="deposit-intro">{t(providerIsSimulator
                                        ? "worker.depositModal.simulatorIntro"
                                        : "worker.depositModal.intro")}</p>
                                    : <p className="deposit-intro" role="status">
                                        {providerApi.data?.message_key === "MPESA_LEDGER_NOT_READY"
                                            ? t("worker.depositModal.ledgerNotReady")
                                            : ["MPESA_CONFIGURATION_INCOMPLETE", "MPESA_CONFIGURATION_INVALID"]
                                                .includes(providerApi.data?.message_key)
                                                ? t("worker.depositModal.providerUnavailable")
                                                : t("worker.depositModal.paymentDisabled")}
                                    </p>}
                                {providerLoading && <p role="status">{t("worker.depositModal.loadingProvider")}</p>}
                                {providerError && (
                                    <div className="deposit-poll-message" role="alert">
                                        <p>{t("worker.depositModal.providerUnavailable")}</p>
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            onClick={providerApi.refetch}
                                        >
                                            {t("worker.common.tryAgain")}
                                        </Button>
                                    </div>
                                )}
                                {profileApi.loading && <p role="status">{t("worker.depositModal.loadingVerifiedPhone")}</p>}
                                {!profileApi.loading && profileApi.error && (
                                    <p className="deposit-poll-message" role="alert">
                                        {t("worker.depositModal.verifiedPhoneLoadError")}
                                    </p>
                                )}
                                {!profileApi.loading && profileApi.error && (
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={profileApi.refetch}
                                    >
                                        {t("worker.common.tryAgain")}
                                    </Button>
                                )}
                                {!profileApi.loading && !profileApi.error && !verifiedPhone && (
                                    <p className="deposit-poll-message" role="alert">
                                        {t("worker.depositModal.verifiedPhoneRequired")}
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
                                    disabled={!paymentEnabled || submitting || !verifiedPhone}
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
                                    readOnly
                                    disabled={!verifiedPhone}
                                    hint={verifiedPhone
                                        ? t("worker.depositModal.verifiedPhoneHint")
                                        : undefined}
                                />
                                {verifiedPhone && paymentEnabled && (
                                    <label className="deposit-phone-confirmation">
                                        <input
                                            type="checkbox"
                                            checked={phoneConfirmed}
                                            onChange={(event) => setConfirmedPhone(
                                                event.target.checked ? phoneNumber : ""
                                            )}
                                            disabled={submitting}
                                        />
                                        <span>{t("worker.depositModal.confirmVerifiedPhone")}</span>
                                    </label>
                                )}
                                <Button
                                    type="submit"
                                    variant="primary"
                                    loading={submitting}
                                    disabled={
                                        !paymentEnabled ||
                                        !verifiedPhone ||
                                        !phoneConfirmed ||
                                        !amount ||
                                        submitting ||
                                        restoringStatus
                                    }
                                >
                                    {paymentEnabled
                                        ? t(providerIsSimulator
                                            ? "worker.depositModal.runSimulation"
                                            : "worker.depositModal.sendPrompt")
                                        : t("worker.depositModal.paymentDisabledButton")}
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
