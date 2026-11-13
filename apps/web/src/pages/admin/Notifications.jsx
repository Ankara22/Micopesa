import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import DOMPurify from "dompurify";
import useApi from "../../hooks/useApi";
import {
    createNotification,
    getExternalSmsAvailability,
    listNotificationRecipients,
    listNotifications,
    sendExternalRecipientSms,
    sendAdminTestSms,
} from "../../services/adminService";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import LoadingState from "../../components/ui/LoadingState";
import ErrorState from "../../components/ui/ErrorState";
import StatusBadge from "../../components/ui/StatusBadge";
import { useToast } from "../../components/ui/ToastContext";
import { AdminCard, AdminPage } from "../../components/AdminPage";
import PushSubscriptionControl from "../../components/Notifications/PushSubscriptionControl";
import ChannelNotificationPreferences from "../../components/Notifications/ChannelNotificationPreferences";
import {
    getCombinedNotificationStatus,
    normalizeNotificationStatus,
} from "../../components/ui/notificationStatus";
import "../notifications/notifications.css";

const CHANNELS = ["SMS", "EMAIL", "PUSH"];
const HISTORY_STATUSES = ["PENDING", "PROVIDER_ACCEPTED", "DELIVERED", "FAILED", "UNKNOWN"];
const DISPATCH_PENDING_STATUSES = new Set(["PENDING", "PROCESSING"]);
const ADMIN_TEST_SMS_MESSAGE =
    "MicoPesa test notification: Your SMS notification service is working. This is a test message. No payment has been made.";
const EMPTY_FORM = {
    user_ids: [],
    channels: [],
    category: "ANNOUNCEMENT",
    message: "",
    emailHtml: "",
    subject: "",
    title: "",
};

function Notifications() {
    const { t, i18n } = useTranslation();
    const [recipientSearch, setRecipientSearch] = useState("");
    const notificationsApi = useApi(listNotifications, []);
    const recipientsApi = useApi(
        () => listNotificationRecipients(recipientSearch),
        [recipientSearch]
    );
    const toast = useToast();
    const [form, setForm] = useState(EMPTY_FORM);
    const [submitting, setSubmitting] = useState(false);
    const [previewOpen, setPreviewOpen] = useState(false);
    const [messageTooLong, setMessageTooLong] = useState(false);
    const [selectedRecipientSnapshots, setSelectedRecipientSnapshots] = useState([]);
    const [lastResults, setLastResults] = useState([]);
    const [testSmsPreviewOpen, setTestSmsPreviewOpen] = useState(false);
    const [testSmsSubmitting, setTestSmsSubmitting] = useState(false);
    const [testSmsResult, setTestSmsResult] = useState(null);
    const externalSmsAvailabilityApi = useApi(getExternalSmsAvailability, []);
    const [externalSmsRecipient, setExternalSmsRecipient] = useState("");
    const [externalSmsMessage, setExternalSmsMessage] = useState("");
    const [externalSmsConsent, setExternalSmsConsent] = useState(false);
    const [externalSmsPreviewOpen, setExternalSmsPreviewOpen] = useState(false);
    const [externalSmsSubmitting, setExternalSmsSubmitting] = useState(false);
    const [externalSmsResult, setExternalSmsResult] = useState(null);
    const [historySearch, setHistorySearch] = useState("");
    const [historyChannel, setHistoryChannel] = useState("");
    const [historyStatus, setHistoryStatus] = useState("");
    const [viewingNotification, setViewingNotification] = useState(null);
    const submissionInProgressRef = useRef(false);
    const testSmsInProgressRef = useRef(false);
    const externalSmsInProgressRef = useRef(false);
    const externalSmsRequestIdRef = useRef(null);
    const requestIdRef = useRef(null);

    const currentRecipients = recipientsApi.data || [];
    const selectedRecipients = form.user_ids.map((userId) =>
        currentRecipients.find((recipient) => recipient.user_id === userId) ||
        selectedRecipientSnapshots.find((recipient) => recipient.user_id === userId)
    ).filter(Boolean);
    const recipientOptions = [
        ...selectedRecipientSnapshots.filter((snapshot) =>
            !currentRecipients.some((recipient) => recipient.user_id === snapshot.user_id)
        ),
        ...currentRecipients,
    ];
    const messageMaxLength = form.channels.includes("SMS") ? 255 : 5000;
    const historyRows = useMemo(
        () => Array.isArray(notificationsApi.data) ? notificationsApi.data : [],
        [notificationsApi.data]
    );
    const filteredHistoryRows = useMemo(() => {
        const query = historySearch.trim().toLocaleLowerCase(i18n.language === "sw" ? "sw-KE" : "en-KE");
        return historyRows.filter((row) => {
            const matchesSearch = !query ||
                [row.recipient_name, row.message, row.notification_type, row.created_by_name]
                    .some((value) => String(value || "").toLocaleLowerCase().includes(query));
            const matchesChannel = !historyChannel || row.notification_type === historyChannel;
            const matchesStatus = !historyStatus ||
                normalizeNotificationStatus(row.delivery_status) === historyStatus;
            return matchesSearch && matchesChannel && matchesStatus;
        });
    }, [historyChannel, historyRows, historySearch, historyStatus, i18n.language]);
    const historySummary = useMemo(() => historyRows.reduce((summary, row) => {
        const status = normalizeNotificationStatus(row.delivery_status);
        summary.total += 1;
        if (status === "PENDING") summary.pending += 1;
        if (status === "PROVIDER_ACCEPTED") summary.accepted += 1;
        if (status === "DELIVERED") summary.delivered += 1;
        if (status === "FAILED" || status === "UNKNOWN") summary.needsAttention += 1;
        return summary;
    }, { total: 0, pending: 0, accepted: 0, delivered: 0, needsAttention: 0 }), [historyRows]);

    function handleChange(event) {
        const { name, value } = event.target;
        requestIdRef.current = null;
        setForm((current) => ({ ...current, [name]: value }));
        if (name === "message") setMessageTooLong(false);
    }

    function toggleChannel(channel) {
        requestIdRef.current = null;
        setForm((current) => ({
            ...current,
            channels: current.channels.includes(channel)
                ? current.channels.filter((item) => item !== channel)
                : [...current.channels, channel],
        }));
    }

    function toggleRecipient(recipient) {
        if (!form.user_ids.includes(recipient.user_id) && form.user_ids.length >= 100) {
            toast.error(t("adminNotifications.recipientLimit"));
            return;
        }
        requestIdRef.current = null;
        setForm((current) => {
            const userIds = current.user_ids.includes(recipient.user_id)
                ? current.user_ids.filter((userId) => userId !== recipient.user_id)
                : [...current.user_ids, recipient.user_id];
            return { ...current, user_ids: userIds, channels: [] };
        });
        setSelectedRecipientSnapshots((current) => [
            ...current.filter((item) => item.user_id !== recipient.user_id),
            recipient,
        ]);
    }

    function isChannelAvailable(channel) {
        if (!selectedRecipients.length) return false;
        if (channel === "SMS") return selectedRecipients.some((recipient) => Boolean(recipient.phone));
        if (channel === "EMAIL") return selectedRecipients.some((recipient) => Boolean(recipient.email));
        return selectedRecipients.some((recipient) => Number(recipient.push_subscription_count) > 0);
    }

    function handlePreview(event) {
        event.preventDefault();
        if (!form.channels.length || !selectedRecipients.length) return;
        if (form.message.length > messageMaxLength) {
            setMessageTooLong(true);
            return;
        }
        setPreviewOpen(true);
    }

    async function refreshStatuses() {
        const rows = await notificationsApi.refetch();
        if (!Array.isArray(rows)) return;
        setLastResults((current) => current.map((result) => {
            const latest = rows.find((row) => row.notification_id === result.notification_id);
            return latest ? { ...result, ...latest } : result;
        }));
        setTestSmsResult((current) => {
            if (!current) return current;
            const latest = rows.find((row) => row.notification_id === current.notification_id);
            return latest ? { ...current, ...latest } : current;
        });
        setExternalSmsResult((current) => {
            if (!current) return current;
            const latest = rows.find((row) => row.notification_id === current.notification_id);
            return latest ? { ...current, ...latest } : current;
        });
    }

    async function watchQueuedDeliveryResults(results) {
        const dispatchResults = results.filter((result) =>
            ["SMS", "EMAIL"].includes(result.notification_type)
        );
        if (!dispatchResults.length) return;
        const notificationIds = new Set(dispatchResults.map((result) => result.notification_id));

        for (let attempt = 0; attempt < 6; attempt += 1) {
            if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
            const rows = await notificationsApi.refetch(true);
            if (!Array.isArray(rows)) return;
            const latestResults = dispatchResults.map((result) =>
                rows.find((row) => notificationIds.has(row.notification_id) &&
                    row.notification_id === result.notification_id) || result
            );
            setLastResults((current) => current.map((result) =>
                latestResults.find((latest) => latest.notification_id === result.notification_id) || result
            ));

            if (latestResults.every((result) =>
                !DISPATCH_PENDING_STATUSES.has(normalizeNotificationStatus(result.delivery_status))
            )) {
                const hasFailure = latestResults.some((result) =>
                    ["FAILED", "UNKNOWN", "SKIPPED"].includes(normalizeNotificationStatus(result.delivery_status))
                );
                const hasAcceptance = latestResults.some((result) =>
                    ["PROVIDER_ACCEPTED", "DELIVERED"].includes(normalizeNotificationStatus(result.delivery_status))
                );
                toast[hasFailure ? "error" : "info"](
                    t(hasFailure
                        ? "adminNotifications.dispatchNeedsAttention"
                        : hasAcceptance
                            ? "adminNotifications.dispatchAccepted"
                            : "adminNotifications.dispatchFinished")
                );
                return;
            }
        }
        toast.info(t("adminNotifications.dispatchStillPending"));
    }

    async function confirmTestSms() {
        if (testSmsInProgressRef.current) return;
        testSmsInProgressRef.current = true;
        setTestSmsSubmitting(true);
        try {
            const requestId = window.crypto?.randomUUID?.();
            if (!requestId) throw new Error("A secure request identifier is unavailable.");
            const results = await sendAdminTestSms(requestId);
            if (!Array.isArray(results) || results.length !== 1) {
                toast.error(t("adminNotifications.testSmsUnavailable"));
                return;
            }
            setTestSmsResult(results[0]);
            setTestSmsPreviewOpen(false);
            const outcomeKey = {
                PENDING: "testSmsQueued",
                PROVIDER_ACCEPTED: "testSmsAccepted",
                DELIVERED: "testSmsDelivered",
                FAILED: "testSmsFailed",
                UNKNOWN: "testSmsUnknown",
            }[normalizeNotificationStatus(results[0].delivery_status)] || "testSmsUnknown";
            const outcomeMessage = t(`adminNotifications.${outcomeKey}`);
            if (normalizeNotificationStatus(results[0].delivery_status) === "FAILED") {
                toast.error(outcomeMessage);
            } else if (normalizeNotificationStatus(results[0].delivery_status) === "UNKNOWN") {
                toast.info(outcomeMessage);
            } else {
                toast.success(outcomeMessage);
            }
        } catch (error) {
            const code = error?.response?.data?.code;
            toast.error(code === "NOTIFICATION_RATE_LIMITED"
                ? t("adminNotifications.testSmsRateLimited")
                : code === "NOTIFICATION_SMS_UNAVAILABLE"
                    ? t("adminNotifications.testSmsUnavailable")
                    : t("adminNotifications.queueError"));
        } finally {
            testSmsInProgressRef.current = false;
            setTestSmsSubmitting(false);
        }
    }

    function statusLabel(status) {
        const normalized = normalizeNotificationStatus(status);
        return t(`adminNotifications.statusLabels.${normalized}`, {
            defaultValue: t(`worker.common.statuses.${normalized}`, { defaultValue: normalized }),
        });
    }

    function getResultGroup(rows, row) {
        const requestKey = row.admin_request_key || row.request_id;
        const recipientId = row.recipient_user_id || row.user_id || row.recipient_phone;
        if (!requestKey || !recipientId) return [];
        return rows.filter((item) =>
            (item.admin_request_key || item.request_id) === requestKey &&
            (item.recipient_user_id || item.user_id || item.recipient_phone) === recipientId
        );
    }

    function testSmsStatusMessage(result) {
        const status = normalizeNotificationStatus(result.delivery_status);
        if (status === "PENDING") return t("adminNotifications.testSmsPending");
        if (status === "DELIVERED") return t("adminNotifications.testSmsDelivered");
        if (status === "PROVIDER_ACCEPTED" &&
            result.delivery_result?.provider === "MOBILE_SASA") {
            return t("adminNotifications.testSmsAcceptedByMobileSasa");
        }
        return t("adminNotifications.testSmsStatusDescription", { status: statusLabel(status) });
    }

    function externalSmsStatusMessage(result) {
        const status = normalizeNotificationStatus(result.delivery_status);
        const key = {
            PENDING: "externalSmsQueued",
            PROCESSING: "externalSmsProcessing",
            PROVIDER_ACCEPTED: "externalSmsAccepted",
            DELIVERED: "externalSmsDelivered",
            FAILED: "externalSmsFailed",
            UNKNOWN: "externalSmsUnknown",
        }[status];
        return key
            ? t(`adminNotifications.${key}`)
            : t("adminNotifications.testSmsStatusDescription", { status: statusLabel(status) });
    }

    function handleExternalSmsPreview(event) {
        event.preventDefault();
        if (!/^\+254[17]\d{8}$/.test(externalSmsRecipient) ||
            !externalSmsMessage.trim() || externalSmsMessage.length > 255 ||
            !externalSmsConsent) {
            return;
        }
        setExternalSmsPreviewOpen(true);
    }

    async function confirmExternalSms() {
        if (externalSmsInProgressRef.current) return;
        externalSmsInProgressRef.current = true;
        setExternalSmsSubmitting(true);
        try {
            if (!externalSmsRequestIdRef.current) {
                externalSmsRequestIdRef.current = window.crypto?.randomUUID?.();
                if (!externalSmsRequestIdRef.current) {
                    throw new Error("A secure request identifier is unavailable.");
                }
            }
            const result = await sendExternalRecipientSms({
                recipient_phone: externalSmsRecipient,
                message: externalSmsMessage,
                recipient_consented: true,
                confirmed: true,
                request_id: externalSmsRequestIdRef.current,
            });
            setExternalSmsResult(result);
            setExternalSmsPreviewOpen(false);
            externalSmsRequestIdRef.current = null;
            const status = normalizeNotificationStatus(result.delivery_status);
            const outcomeKey = {
                PENDING: "externalSmsQueued",
                PROCESSING: "externalSmsProcessing",
                PROVIDER_ACCEPTED: "externalSmsAccepted",
                DELIVERED: "externalSmsDelivered",
                FAILED: "externalSmsFailed",
                UNKNOWN: "externalSmsUnknown",
            }[status] || "externalSmsUnknown";
            const outcomeMessage = t(`adminNotifications.${outcomeKey}`);
            if (status === "FAILED") toast.error(outcomeMessage);
            else if (status === "UNKNOWN" || status === "PROCESSING") toast.info(outcomeMessage);
            else toast.success(outcomeMessage);
            await refreshStatuses();
        } catch (error) {
            const code = error?.response?.data?.code;
            toast.error(code === "NOTIFICATION_RATE_LIMITED"
                ? t("adminNotifications.externalSmsRateLimited")
                : code === "NOTIFICATION_EXTERNAL_SMS_UNAVAILABLE"
                    ? t("adminNotifications.externalSmsUnavailable")
                    : t("adminNotifications.queueError"));
        } finally {
            externalSmsInProgressRef.current = false;
            setExternalSmsSubmitting(false);
        }
    }

    async function handleConfirm() {
        if (submissionInProgressRef.current || !selectedRecipients.length) return;
        submissionInProgressRef.current = true;
        setSubmitting(true);
        try {
            if (!requestIdRef.current) {
                requestIdRef.current = window.crypto?.randomUUID?.();
                if (!requestIdRef.current) throw new Error("A secure request identifier is unavailable.");
            }
            const results = await createNotification({
                user_ids: form.user_ids,
                channels: form.channels,
                message: form.message,
                category: form.category,
                ...(form.channels.includes("EMAIL") ? { subject: form.subject } : {}),
                ...(form.channels.includes("EMAIL") && form.emailHtml.trim()
                    ? { html: form.emailHtml }
                    : {}),
                ...(form.channels.includes("PUSH") ? { title: form.title } : {}),
                request_id: requestIdRef.current,
            });
            const queuedResults = Array.isArray(results) ? results : [];
            setLastResults(queuedResults);
            setPreviewOpen(false);
            requestIdRef.current = null;
            setForm(EMPTY_FORM);
            setMessageTooLong(false);
            await refreshStatuses();
            toast.info(t("adminNotifications.queuedSuccess"));
            void watchQueuedDeliveryResults(queuedResults);
        } catch {
            toast.error(t("adminNotifications.queueError"));
        } finally {
            submissionInProgressRef.current = false;
            setSubmitting(false);
        }
    }

    return (
        <AdminPage
            title={t("adminNotifications.title")}
            subtitle={t("adminNotifications.subtitle")}
        >
            <div className="admin-stack notification-page notification-page--admin">
                {Array.isArray(notificationsApi.data) && (
                    <section className="notification-summary" aria-label={t("adminNotifications.summary")}>
                        {[
                            ["total", "total"],
                            ["pending", "pending"],
                            ["accepted", "accepted"],
                            ["delivered", "delivered"],
                            ["needsAttention", "needsAttention"],
                        ].map(([key, label]) => (
                            <article className="notification-summary-card" key={key}>
                                <span className={`notification-summary-icon notification-summary-icon--${key}`} aria-hidden="true">
                                    {key === "total" ? "•" : key === "pending" ? "◷"
                                        : key === "accepted" ? "✓" : key === "delivered" ? "↗" : "!"}
                                </span>
                                <div>
                                    <span className="notification-summary-label">
                                        {t(`adminNotifications.summaryLabels.${label}`)}
                                    </span>
                                    <strong>{historySummary[key]}</strong>
                                </div>
                            </article>
                        ))}
                    </section>
                )}

                <section className="notification-test-banner" aria-labelledby="test-sms-heading">
                    <div className="notification-test-copy">
                        <span className="notification-eyebrow">{t("adminNotifications.testSmsEyebrow")}</span>
                        <h2 id="test-sms-heading">{t("adminNotifications.testSmsTitle")}</h2>
                        <p>{t("adminNotifications.testSmsDescription")}</p>
                    </div>
                    <Button variant="primary" onClick={() => setTestSmsPreviewOpen(true)}>
                        {t("adminNotifications.testSmsAction")}
                    </Button>
                </section>

                {testSmsResult && (
                    <section className="notification-test-result" role="status" aria-live="polite">
                        <div>
                            <strong>{t("adminNotifications.testSmsLatest")}</strong>
                            <p>{testSmsStatusMessage(testSmsResult)}</p>
                        </div>
                        <StatusBadge
                            status={normalizeNotificationStatus(testSmsResult.delivery_status)}
                            label={statusLabel(testSmsResult.delivery_status)}
                        />
                    </section>
                )}

                <AdminCard
                    title={t("adminNotifications.externalSmsTitle")}
                    description={t("adminNotifications.externalSmsDescription")}
                >
                    {externalSmsAvailabilityApi.loading &&
                    externalSmsAvailabilityApi.data === null ? (
                        <LoadingState message={t("worker.common.loadingRecords")} />
                    ) : externalSmsAvailabilityApi.error &&
                    externalSmsAvailabilityApi.data === null ? (
                        <ErrorState
                            message={t("adminNotifications.externalSmsAvailabilityError")}
                            onRetry={externalSmsAvailabilityApi.refetch}
                        />
                    ) : !externalSmsAvailabilityApi.data?.enabled ? (
                        <p role="status">{t("adminNotifications.externalSmsUnavailable")}</p>
                    ) : (
                        <form className="admin-form-grid" onSubmit={handleExternalSmsPreview}>
                            <div>
                                <label className="admin-field-label" htmlFor="external-sms-recipient">
                                    {t("adminNotifications.externalSmsRecipient")}
                                </label>
                                <input
                                    className="admin-control"
                                    id="external-sms-recipient"
                                    type="tel"
                                    inputMode="tel"
                                    autoComplete="tel"
                                    pattern="\+254[17]\d{8}"
                                    maxLength={13}
                                    placeholder="+254712345678"
                                    value={externalSmsRecipient}
                                    onChange={(event) => {
                                        externalSmsRequestIdRef.current = null;
                                        setExternalSmsRecipient(event.target.value);
                                    }}
                                    required
                                />
                            </div>
                            <div className="admin-span-all">
                                <label className="admin-field-label" htmlFor="external-sms-message">
                                    {t("adminNotifications.externalSmsMessage")}
                                </label>
                                <textarea
                                    className="admin-control"
                                    id="external-sms-message"
                                    rows={4}
                                    maxLength={255}
                                    value={externalSmsMessage}
                                    onChange={(event) => {
                                        externalSmsRequestIdRef.current = null;
                                        setExternalSmsMessage(event.target.value);
                                    }}
                                    required
                                />
                                <p className="admin-hint">
                                    {t("adminNotifications.messageHint", {
                                        count: externalSmsMessage.length,
                                        max: 255,
                                    })}
                                </p>
                            </div>
                            <label className="admin-field-label admin-span-all">
                                <input
                                    type="checkbox"
                                    checked={externalSmsConsent}
                                    onChange={(event) => setExternalSmsConsent(event.target.checked)}
                                    required
                                />
                                <span>{t("adminNotifications.externalSmsConsent")}</span>
                            </label>
                            <div className="admin-span-all">
                                <Button
                                    type="submit"
                                    variant="primary"
                                    disabled={!externalSmsRecipient || !externalSmsMessage.trim() ||
                                        externalSmsMessage.length > 255 || !externalSmsConsent}
                                >
                                    {t("adminNotifications.externalSmsPreview")}
                                </Button>
                            </div>
                        </form>
                    )}
                    {externalSmsResult && (
                        <section className="notification-test-result" role="status" aria-live="polite">
                            <div>
                                <strong>{t("adminNotifications.externalSmsLatest")}</strong>
                                <p>{externalSmsStatusMessage(externalSmsResult)}</p>
                            </div>
                            <StatusBadge
                                status={normalizeNotificationStatus(externalSmsResult.delivery_status)}
                                label={statusLabel(externalSmsResult.delivery_status)}
                            />
                        </section>
                    )}
                </AdminCard>

                <AdminCard
                    title={t("adminNotifications.composeTitle")}
                    description={t("adminNotifications.composeDescription")}
                >
                    {recipientsApi.loading && recipientsApi.data === null ? (
                        <LoadingState message={t("worker.common.loadingRecords")} />
                    ) : recipientsApi.error && recipientsApi.data === null ? (
                        <ErrorState message={t("worker.common.errors.load")} onRetry={recipientsApi.refetch} />
                    ) : (
                        <form className="admin-form-grid" onSubmit={handlePreview}>
                            <div className="admin-span-all">
                                <label className="admin-field-label" htmlFor="notification-recipient-search">
                                    {t("adminNotifications.searchRecipients")}
                                </label>
                                <input
                                    className="admin-control"
                                    id="notification-recipient-search"
                                    type="search"
                                    value={recipientSearch}
                                    onChange={(event) => setRecipientSearch(event.target.value)}
                                    disabled={submitting}
                                    autoComplete="off"
                                />
                            </div>
                            <fieldset className="admin-span-all">
                                <legend className="admin-field-label">
                                    {t("adminNotifications.recipient")}
                                </legend>
                                {recipientOptions.length === 0 ? (
                                    <p className="admin-hint">{t("adminNotifications.noRecipients")}</p>
                                ) : (
                                    <div className="admin-stack">
                                        {recipientOptions.map((recipient) => (
                                            <label className="admin-channel-pill" key={recipient.user_id}>
                                                <input
                                                    type="checkbox"
                                                    checked={form.user_ids.includes(recipient.user_id)}
                                                    onChange={() => toggleRecipient(recipient)}
                                                    disabled={submitting}
                                                />
                                                {recipient.full_name} ({t(`roles.${recipient.role}`, {
                                                    defaultValue: recipient.role,
                                                })})
                                            </label>
                                        ))}
                                    </div>
                                )}
                                <p className="admin-hint">
                                    {t("adminNotifications.recipientsSelected", { count: form.user_ids.length })}
                                </p>
                            </fieldset>

                            <div className="admin-span-all">
                                <label className="admin-field-label" htmlFor="notification-category">
                                    {t("adminNotifications.category")}
                                </label>
                                <select
                                    className="admin-control"
                                    id="notification-category"
                                    name="category"
                                    value={form.category}
                                    onChange={handleChange}
                                    disabled={submitting}
                                >
                                    {[
                                        "GENERAL", "ANNOUNCEMENT", "CONTRIBUTION_REMINDER",
                                        "SCHEME_UPDATE", "ACCOUNT_SERVICE", "REGULATORY_ADVISORY",
                                        "COMPLIANCE_NOTICE", "DEADLINE_REMINDER", "WORKER_EDUCATION",
                                    ].map((category) => (
                                        <option key={category} value={category}>
                                            {t(`roleNotifications.categories.${category}`, { defaultValue: category })}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <fieldset className="admin-span-all">
                                <legend className="admin-field-label">{t("adminNotifications.channel")}</legend>
                                <div className="admin-channel-pills">
                                    {CHANNELS.map((channel) => (
                                        <label className="admin-channel-pill" key={channel}>
                                            <input
                                                type="checkbox"
                                                value={channel}
                                                checked={form.channels.includes(channel)}
                                                disabled={!isChannelAvailable(channel) || submitting}
                                                onChange={() => toggleChannel(channel)}
                                            />
                                            {t(`adminNotifications.${channel.toLowerCase()}`)}
                                        </label>
                                    ))}
                                </div>
                                {selectedRecipients.length > 0 && (
                                    <ul className="admin-hint">
                                        {selectedRecipients.map((recipient) => (
                                            <li key={recipient.user_id}>
                                                {recipient.full_name}:{" "}
                                                {form.channels.map((channel) => (
                                                    <span key={channel}>
                                                        {channel === "EMAIL" ? recipient.email
                                                            : channel === "SMS" ? recipient.phone
                                                                : t("adminNotifications.pushDeviceCount", {
                                                                    count: recipient.push_subscription_count,
                                                                })}
                                                        {" "}
                                                    </span>
                                                ))}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {form.channels.includes("EMAIL") && (
                                    <div className="admin-span-all">
                                        <label className="admin-field-label" htmlFor="notification-email-html">
                                            {t("adminNotifications.emailHtml")}
                                        </label>
                                        <textarea
                                            className="admin-control"
                                            id="notification-email-html"
                                            name="emailHtml"
                                            rows={6}
                                            maxLength={10000}
                                            value={form.emailHtml}
                                            onChange={handleChange}
                                            disabled={submitting}
                                        />
                                        <p className="admin-hint">{t("adminNotifications.emailHtmlHint")}</p>
                                    </div>
                                )}
                            </fieldset>

                            {form.channels.includes("EMAIL") && (
                                <div className="admin-span-all">
                                    <label className="admin-field-label" htmlFor="notification-subject">
                                        {t("adminNotifications.subject")}
                                    </label>
                                    <input
                                        className="admin-control"
                                        id="notification-subject"
                                        name="subject"
                                        maxLength={255}
                                        value={form.subject}
                                        onChange={handleChange}
                                        disabled={submitting}
                                        required
                                    />
                                </div>
                            )}
                            {form.channels.includes("PUSH") && (
                                <div className="admin-span-all">
                                    <label className="admin-field-label" htmlFor="notification-push-title">
                                        {t("adminNotifications.pushTitle")}
                                    </label>
                                    <input
                                        className="admin-control"
                                        id="notification-push-title"
                                        name="title"
                                        maxLength={100}
                                        value={form.title}
                                        onChange={handleChange}
                                        disabled={submitting}
                                        required
                                    />
                                </div>
                            )}
                            <div className="admin-span-all">
                                <label className="admin-field-label" htmlFor="notification-message">
                                    {t("adminNotifications.message")}
                                </label>
                                <textarea
                                    className="admin-control"
                                    id="notification-message"
                                    name="message"
                                    rows={4}
                                    maxLength={messageMaxLength}
                                    value={form.message}
                                    onChange={handleChange}
                                    disabled={submitting}
                                    required
                                />
                                <p className="admin-hint">
                                    {t("adminNotifications.messageHint", {
                                        count: form.message.length,
                                        max: messageMaxLength,
                                    })}
                                </p>
                                {messageTooLong && (
                                    <p className="admin-hint" role="alert">
                                        {t("adminNotifications.messageTooLong")}
                                    </p>
                                )}
                            </div>
                            <div className="admin-span-all">
                                <Button
                                    type="submit"
                                    variant="primary"
                                    disabled={submitting || !form.channels.length || !selectedRecipients.length}
                                >
                                    {t("adminNotifications.preview")}
                                </Button>
                            </div>
                        </form>
                    )}
                </AdminCard>

                {lastResults.length > 0 && (
                    <AdminCard title={t("adminNotifications.result")}>
                        <ul aria-live="polite">
                            {lastResults.map((result) => {
                                const resultStatus = normalizeNotificationStatus(result.delivery_status);
                                const resultGroup = getResultGroup(lastResults, result);
                                return (
                                <li key={result.notification_id}>
                                    {t(`worker.common.notificationTypes.${result.notification_type}`, {
                                        defaultValue: result.notification_type,
                                    })} {result.recipient_name ? `— ${result.recipient_name}: ` : ": "}
                                    {statusLabel(resultStatus)}
                                    {resultGroup.length > 1 && (
                                        <> — {t("adminNotifications.overallStatus")}:{" "}
                                            {statusLabel(getCombinedNotificationStatus(resultGroup))}
                                        </>
                                    )}
                                    {normalizeNotificationStatus(result.delivery_status) === "SKIPPED" &&
                                        ` — ${t(`adminNotifications.skipReasons.${result.last_error_code}`, {
                                            defaultValue: t("adminNotifications.skipped"),
                                        })}`}
                                    {["FAILED", "UNKNOWN"].includes(normalizeNotificationStatus(result.delivery_status)) &&
                                        result.last_error_code &&
                                        ` — ${t(`adminNotifications.failureCodes.${result.last_error_code}`, {
                                            defaultValue: `${t("adminNotifications.failureCode")}: ${result.last_error_code}`,
                                        })}`}
                                    {normalizeNotificationStatus(result.delivery_status) === "PROVIDER_ACCEPTED" &&
                                        ` — ${t("adminNotifications.providerAccepted")}`}
                                    {result.provider_accepted_at &&
                                        ` — ${t("adminNotifications.providerAcceptedAt")}: ${new Date(result.provider_accepted_at).toLocaleString(
                                            i18n.language === "sw" ? "sw-KE" : "en-KE"
                                        )}`}
                                    {result.provider_message_id &&
                                        ` — ${t("adminNotifications.providerReference")}: ${result.provider_message_id}`}
                                    {result.delivery_result?.provider &&
                                        ` — ${t("adminNotifications.provider")}: ${result.delivery_result.provider}`}
                                </li>
                                );
                            })}
                        </ul>
                    </AdminCard>
                )}

                <AdminCard
                    title={t("adminNotifications.sentAndQueued")}
                    actions={(
                        <Button
                            variant="secondary"
                            loading={notificationsApi.refreshing}
                            onClick={refreshStatuses}
                        >
                            {t("adminNotifications.refreshStatus")}
                        </Button>
                    )}
                >
                    <div className="notification-filters">
                        <label className="notification-filter-field">
                            <span>{t("adminNotifications.historySearch")}</span>
                            <input
                                type="search"
                                value={historySearch}
                                onChange={(event) => setHistorySearch(event.target.value)}
                                autoComplete="off"
                            />
                        </label>
                        <label className="notification-filter-field">
                            <span>{t("adminNotifications.channel")}</span>
                            <select value={historyChannel} onChange={(event) => setHistoryChannel(event.target.value)}>
                                <option value="">{t("adminNotifications.allChannels")}</option>
                                {CHANNELS.map((channel) => (
                                    <option key={channel} value={channel}>
                                        {t(`adminNotifications.${channel.toLowerCase()}`)}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className="notification-filter-field">
                            <span>{t("adminNotifications.delivery")}</span>
                            <select value={historyStatus} onChange={(event) => setHistoryStatus(event.target.value)}>
                                <option value="">{t("adminNotifications.allStatuses")}</option>
                                {HISTORY_STATUSES.map((status) => (
                                    <option key={status} value={status}>{statusLabel(status)}</option>
                                ))}
                            </select>
                        </label>
                    </div>
                    {notificationsApi.error && notificationsApi.data !== null && (
                        <div className="notification-refresh-error" role="alert">
                            <span>{t("worker.common.errors.load")}</span>
                            <Button variant="secondary" onClick={notificationsApi.refetch}>
                                {t("worker.common.tryAgain")}
                            </Button>
                        </div>
                    )}
                    {notificationsApi.loading && notificationsApi.data === null ? (
                        <LoadingState message={t("worker.common.loadingRecords")} />
                    ) : notificationsApi.error && notificationsApi.data === null ? (
                        <ErrorState message={t("worker.common.errors.load")} onRetry={notificationsApi.refetch} />
                    ) : filteredHistoryRows.length ? (
                        <ol className="notification-timeline notification-timeline--admin">
                            {filteredHistoryRows.map((row) => {
                                const normalizedStatus = normalizeNotificationStatus(row.delivery_status);
                                const rowGroup = getResultGroup(historyRows, row);
                                return (
                                    <li className="notification-timeline-item" key={row.notification_id}>
                                        <span className="notification-timeline-marker" aria-hidden="true" />
                                        <article className="notification-message-card">
                                            <div className="notification-message-meta">
                                                <div className="notification-admin-meta">
                                                    <span className="notification-channel">
                                                        {t(`worker.common.notificationTypes.${row.notification_type}`, {
                                                            defaultValue: row.notification_type,
                                                        })}
                                                    </span>
                                                    <span>{row.recipient_name}</span>
                                                    <span>{row.created_by_name || t("adminNotifications.system")}</span>
                                                </div>
                                                <StatusBadge status={normalizedStatus} label={statusLabel(normalizedStatus)} />
                                            </div>
                                            {rowGroup.length > 1 && (
                                                <p><strong>{t("adminNotifications.overallStatus")}:</strong>{" "}
                                                    {statusLabel(getCombinedNotificationStatus(rowGroup))}
                                                </p>
                                            )}
                                            <p className="notification-message-content">{row.message}</p>
                                            {normalizedStatus === "PROVIDER_ACCEPTED" && (
                                                <p>{t("adminNotifications.providerAccepted")}</p>
                                            )}
                                            {row.provider_accepted_at && (
                                                <p><strong>{t("adminNotifications.providerAcceptedAt")}:</strong>{" "}
                                                    {new Date(row.provider_accepted_at).toLocaleString(
                                                        i18n.language === "sw" ? "sw-KE" : "en-KE"
                                                    )}
                                                </p>
                                            )}
                                            {row.provider_message_id && (
                                                <p><strong>{t("adminNotifications.providerReference")}:</strong>{" "}
                                                    {row.provider_message_id}
                                                </p>
                                            )}
                                            {normalizedStatus === "DELIVERED" && row.delivered_at && (
                                                <p><strong>{t("adminNotifications.deliveredAt")}:</strong>{" "}
                                                    {new Date(row.delivered_at).toLocaleString(
                                                        i18n.language === "sw" ? "sw-KE" : "en-KE"
                                                    )}
                                                </p>
                                            )}
                                            {["FAILED", "UNKNOWN"].includes(normalizedStatus) && row.last_error_code && (
                                                <p>{t(`adminNotifications.failureCodes.${row.last_error_code}`, {
                                                    defaultValue: `${t("adminNotifications.failureCode")}: ${row.last_error_code}`,
                                                })}</p>
                                            )}
                                            <div className="notification-message-footer">
                                                <time dateTime={row.created_at}>
                                                    {new Date(row.created_at).toLocaleString(
                                                        i18n.language === "sw" ? "sw-KE" : "en-KE"
                                                    )}
                                                </time>
                                                <Button variant="secondary" size="sm" onClick={() => setViewingNotification(row)}>
                                                    {t("adminNotifications.view")}
                                                </Button>
                                            </div>
                                        </article>
                                    </li>
                                );
                            })}
                        </ol>
                    ) : (
                        <p className="notification-state">
                            {historyRows.length ? t("adminNotifications.noHistoryMatches") : t("adminNotifications.empty")}
                        </p>
                    )}
                </AdminCard>
            </div>

            <Modal
                open={testSmsPreviewOpen}
                title={t("adminNotifications.testSmsPreviewTitle")}
                onClose={() => {
                    if (!testSmsSubmitting) setTestSmsPreviewOpen(false);
                }}
            >
                <div className="notification-test-preview">
                    <p><strong>{t("adminNotifications.testSmsRecipient")}:</strong>{" "}
                        {t("adminNotifications.testSmsOwnNumber")}</p>
                    <p><strong>{t("adminNotifications.message")}:</strong></p>
                    <blockquote>{ADMIN_TEST_SMS_MESSAGE}</blockquote>
                    <p className="notification-test-warning">{t("adminNotifications.testSmsWarning")}</p>
                    <div className="admin-actions">
                        <Button
                            variant="secondary"
                            disabled={testSmsSubmitting}
                            onClick={() => setTestSmsPreviewOpen(false)}
                        >
                            {t("adminNotifications.cancel")}
                        </Button>
                        <Button variant="primary" loading={testSmsSubmitting} onClick={confirmTestSms}>
                            {t("adminNotifications.testSmsConfirm")}
                        </Button>
                    </div>
                </div>
            </Modal>

            <Modal
                open={externalSmsPreviewOpen}
                title={t("adminNotifications.externalSmsPreviewTitle")}
                onClose={() => {
                    if (!externalSmsSubmitting) setExternalSmsPreviewOpen(false);
                }}
            >
                <div className="notification-test-preview">
                    <p><strong>{t("adminNotifications.externalSmsRecipient")}:</strong>{" "}
                        {externalSmsRecipient}</p>
                    <p><strong>{t("adminNotifications.externalSmsMessage")}:</strong></p>
                    <blockquote className="notification-external-message-preview">
                        {externalSmsMessage}
                    </blockquote>
                    <p className="notification-test-warning">
                        {t("adminNotifications.externalSmsConfirmation")}
                    </p>
                    <div className="admin-actions">
                        <Button
                            variant="secondary"
                            disabled={externalSmsSubmitting}
                            onClick={() => setExternalSmsPreviewOpen(false)}
                        >
                            {t("adminNotifications.cancel")}
                        </Button>
                        <Button
                            variant="primary"
                            loading={externalSmsSubmitting}
                            onClick={confirmExternalSms}
                        >
                            {t("adminNotifications.externalSmsConfirm")}
                        </Button>
                    </div>
                </div>
            </Modal>

            <Modal
                open={previewOpen}
                title={t("adminNotifications.previewTitle")}
                onClose={() => {
                    if (!submitting) setPreviewOpen(false);
                }}
            >
                {selectedRecipients.length > 0 && (
                    <div className="admin-stack">
                        <p>{t("adminNotifications.previewOnly")}</p>
                        <div>
                            <strong>{t("adminNotifications.to")} ({selectedRecipients.length}):</strong>
                            <ul>
                                {selectedRecipients.map((recipient) => (
                                    <li key={recipient.user_id}>
                                        {recipient.full_name} — {form.channels.map((channel) => (
                                            <span key={channel}>
                                                {channel === "SMS" ? recipient.phone
                                                    : channel === "EMAIL" ? recipient.email
                                                        : t("adminNotifications.push")}
                                                {" "}
                                            </span>
                                        ))}
                                    </li>
                                ))}
                            </ul>
                        </div>
                        <p><strong>{t("adminNotifications.category")}:</strong>{" "}
                            {t(`roleNotifications.categories.${form.category}`, { defaultValue: form.category })}
                        </p>
                        <div>
                            <strong>{t("adminNotifications.recipientContact")}:</strong>
                            <ul>
                                {selectedRecipients.map((recipient) => (
                                    <li key={recipient.user_id}>
                                        {recipient.full_name}: {form.channels.map((channel) => (
                                            <span key={channel}>
                                                {channel === "SMS" ? recipient.phone
                                                    : channel === "EMAIL" ? recipient.email
                                                        : t("adminNotifications.push")}
                                                {" "}
                                            </span>
                                        ))}
                                    </li>
                                ))}
                            </ul>
                        </div>
                        <p><strong>{t("adminNotifications.channel")}:</strong>{" "}
                            {form.channels.map((channel) => t(`adminNotifications.${channel.toLowerCase()}`)).join(", ")}
                        </p>
                        {form.channels.includes("EMAIL") && (
                            <>
                                <p><strong>{t("adminNotifications.subject")}:</strong> {form.subject}</p>
                                <p><strong>{t("adminNotifications.message")}:</strong> {form.message}</p>
                                {form.emailHtml.trim() && (
                                    <div>
                                        <strong>{t("adminNotifications.emailHtmlPreview")}:</strong>
                                        <div
                                            className="admin-email-preview"
                                            dangerouslySetInnerHTML={{
                                                __html: DOMPurify.sanitize(form.emailHtml, {
                                                    ALLOWED_TAGS: [
                                                        "a", "b", "blockquote", "br", "code", "div", "em",
                                                        "h1", "h2", "h3", "hr", "i", "li", "ol", "p",
                                                        "strong", "u", "ul",
                                                    ],
                                                    ALLOWED_ATTR: ["href", "title"],
                                                }),
                                            }}
                                        />
                                    </div>
                                )}
                            </>
                        )}
                        {form.channels.includes("PUSH") && (
                            <p><strong>{t("adminNotifications.pushTitle")}:</strong> {form.title}</p>
                        )}
                        {!form.channels.includes("EMAIL") && (
                            <>
                                <p><strong>{t("adminNotifications.message")}:</strong></p>
                                <p>{form.message}</p>
                            </>
                        )}
                        <div className="admin-actions">
                            <Button variant="secondary" disabled={submitting} onClick={() => setPreviewOpen(false)}>
                                {t("adminNotifications.cancel")}
                            </Button>
                            <Button variant="primary" loading={submitting} onClick={handleConfirm}>
                                {t("adminNotifications.confirm")}
                            </Button>
                        </div>
                    </div>
                )}
            </Modal>

            <Modal
                open={Boolean(viewingNotification)}
                title={t("adminNotifications.details")}
                onClose={() => setViewingNotification(null)}
            >
                {viewingNotification && (
                    <div className="admin-stack">
                        <p><strong>{t("adminNotifications.reference")}:</strong> {viewingNotification.notification_id}</p>
                        <p><strong>{t("adminNotifications.to")}:</strong> {viewingNotification.recipient_name}</p>
                        <p><strong>{t("adminNotifications.category")}:</strong>{" "}
                            {t(`roleNotifications.categories.${viewingNotification.notification_category || "GENERAL"}`, {
                                defaultValue: viewingNotification.notification_category || "GENERAL",
                            })}
                        </p>
                        <p><strong>{t("adminNotifications.channel")}:</strong>{" "}
                            {t(`worker.common.notificationTypes.${viewingNotification.notification_type}`, {
                                defaultValue: viewingNotification.notification_type,
                            })}
                        </p>
                        <p><strong>{t("adminNotifications.delivery")}:</strong>{" "}
                            {statusLabel(viewingNotification.delivery_status)}
                        </p>
                        {normalizeNotificationStatus(viewingNotification.delivery_status) === "PROVIDER_ACCEPTED" && (
                            <p>{t("adminNotifications.providerAccepted")}</p>
                        )}
                        {viewingNotification.delivery_result?.provider && (
                            <p><strong>{t("adminNotifications.provider")}:</strong>{" "}
                                {viewingNotification.delivery_result.provider}
                            </p>
                        )}
                        {viewingNotification.provider_message_id && (
                            <p><strong>{t("adminNotifications.providerReference")}:</strong>{" "}
                                {viewingNotification.provider_message_id}
                            </p>
                        )}
                        {viewingNotification.provider_accepted_at && (
                            <p><strong>{t("adminNotifications.providerAcceptedAt")}:</strong>{" "}
                                {new Date(viewingNotification.provider_accepted_at).toLocaleString(
                                    i18n.language === "sw" ? "sw-KE" : "en-KE"
                                )}
                            </p>
                        )}
                        {viewingNotification.delivered_at && (
                            <p><strong>{t("adminNotifications.deliveredAt")}:</strong>{" "}
                                {new Date(viewingNotification.delivered_at).toLocaleString(
                                    i18n.language === "sw" ? "sw-KE" : "en-KE"
                                )}
                            </p>
                        )}
                        {viewingNotification.last_error_code && (
                            <p><strong>{t("adminNotifications.failureCode")}:</strong>{" "}
                                {viewingNotification.last_error_code}
                            </p>
                        )}
                        {Number.isSafeInteger(viewingNotification.delivery_result?.smsParts) && (
                            <p><strong>{t("adminNotifications.smsParts")}:</strong>{" "}
                                {viewingNotification.delivery_result.smsParts}
                            </p>
                        )}
                        {viewingNotification.email_subject && (
                            <p><strong>{t("adminNotifications.subject")}:</strong> {viewingNotification.email_subject}</p>
                        )}
                        {viewingNotification.push_title && (
                            <p><strong>{t("adminNotifications.pushTitle")}:</strong> {viewingNotification.push_title}</p>
                        )}
                        <p><strong>{t("adminNotifications.message")}:</strong> {viewingNotification.message}</p>
                    </div>
                )}
            </Modal>
            <ChannelNotificationPreferences />
            <PushSubscriptionControl />
        </AdminPage>
    );
}

export default Notifications;
