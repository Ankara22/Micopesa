import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../context/AuthContext";
import useApi from "../../hooks/useApi";
import DataTable from "../../components/ui/DataTable";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import PushSubscriptionControl from "../../components/Notifications/PushSubscriptionControl";
import ChannelNotificationPreferences from "../../components/Notifications/ChannelNotificationPreferences";
import { normalizeNotificationStatus } from "../../components/ui/notificationStatus";
import { useToast } from "../../components/ui/ToastContext";
import {
    createRoleNotification,
    listNotificationAudit,
    listRoleNotificationRecipients,
} from "../../services/notificationService";
import "./notifications.css";

const CHANNELS = ["SMS", "EMAIL", "PUSH"];
const DELIVERY_STATUSES = ["PENDING", "PROVIDER_ACCEPTED", "DELIVERED", "FAILED", "UNKNOWN", "SKIPPED"];
const EMPTY_AUDIT_FILTERS = {
    start_date: "",
    end_date: "",
    channel: "",
    authorization_outcome: "",
    delivery_status: "",
};
const CATEGORIES_BY_ROLE = {
    FUND_MANAGER: ["CONTRIBUTION_REMINDER", "SCHEME_UPDATE", "ACCOUNT_SERVICE"],
    REGULATOR: ["REGULATORY_ADVISORY", "COMPLIANCE_NOTICE", "DEADLINE_REMINDER", "WORKER_EDUCATION"],
};

function RoleNotifications() {
    const { t, i18n } = useTranslation();
    const { user } = useAuth();
    const role = user?.role;
    const categories = CATEGORIES_BY_ROLE[role] || [];
    const [search, setSearch] = useState("");
    const [form, setForm] = useState({
        user_id: "",
        channels: [],
        category: categories[0] || "",
        message: "",
        subject: "",
        title: "",
    });
    const [previewOpen, setPreviewOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const submissionInProgress = useRef(false);
    const [auditFilters, setAuditFilters] = useState(EMPTY_AUDIT_FILTERS);
    const [appliedAuditFilters, setAppliedAuditFilters] = useState({});
    const [auditPage, setAuditPage] = useState(1);
    const toast = useToast();
    const recipientsApi = useApi(() => listRoleNotificationRecipients(search), [search]);
    const fetchAudit = useCallback(
        () => listNotificationAudit({ ...appliedAuditFilters, page: auditPage, page_size: 25 }),
        [appliedAuditFilters, auditPage]
    );
    const auditApi = useApi(fetchAudit, [fetchAudit]);
    const recipient = (recipientsApi.data || []).find((item) => item.user_id === form.user_id);
    const auditRows = useMemo(() => {
        if (Array.isArray(auditApi.data)) return auditApi.data;
        return Array.isArray(auditApi.data?.records) ? auditApi.data.records : [];
    }, [auditApi.data]);
    const auditPagination = auditApi.data?.pagination || { page: 1, total_pages: 0 };
    const auditSummary = auditApi.data?.summary || {
        total_count: 0,
        authorized_count: 0,
        denied_count: 0,
    };

    const columns = useMemo(() => [
        {
            key: "created_at",
            header: t("roleNotifications.date"),
            render: (row) => new Date(row.created_at).toLocaleString(
                i18n.language === "sw" ? "sw-KE" : "en-KE"
            ),
        },
        { key: "sender_name", header: t("roleNotifications.sender") },
        { key: "recipient_name", header: t("roleNotifications.recipient") },
        {
            key: "contacts",
            header: t("roleNotifications.maskedContact"),
            render: (row) => [row.recipient_phone_masked, row.recipient_email_masked]
                .filter(Boolean).join(" · ") || "—",
        },
        {
            key: "notification_category",
            header: t("roleNotifications.category"),
            render: (row) => t(`roleNotifications.categories.${row.notification_category}`, {
                defaultValue: row.notification_category,
            }),
        },
        {
            key: "delivery_results",
            header: t("roleNotifications.delivery"),
            render: (row) => row.delivery_results?.length
                ? row.delivery_results.map((item) =>
                    `${item.channel}: ${t(`worker.common.statuses.${normalizeNotificationStatus(item.delivery_status)}`, {
                        defaultValue: normalizeNotificationStatus(item.delivery_status),
                    })}`
                ).join(", ")
                : row.authorization_outcome,
        },
    ], [i18n.language, t]);

    function updateForm(event) {
        const { name, value } = event.target;
        setForm((current) => ({ ...current, [name]: value }));
    }

    function updateAuditFilter(event) {
        const { name, value } = event.target;
        setAuditFilters((current) => ({ ...current, [name]: value }));
    }

    function applyAuditFilters(event) {
        event.preventDefault();
        setAuditPage(1);
        setAppliedAuditFilters(Object.fromEntries(
            Object.entries(auditFilters).filter(([, value]) => value.trim() !== "")
        ));
    }

    function toggleChannel(channel) {
        setForm((current) => ({
            ...current,
            channels: current.channels.includes(channel)
                ? current.channels.filter((item) => item !== channel)
                : [...current.channels, channel],
        }));
    }

    function channelAvailable(channel) {
        if (!recipient) return false;
        if (channel === "SMS") {
            return recipient.phone_available &&
                recipient.sms_enabled === true &&
                recipient.sms_delivery_enabled === true;
        }
        if (channel === "EMAIL") {
            return recipient.email_available &&
                recipient.email_enabled === true &&
                recipient.email_delivery_enabled === true;
        }
        return Number(recipient.push_subscription_count) > 0;
    }

    function channelStatus(channel) {
        if (!recipient) return "";
        if (channel === "SMS") {
            const reasons = [];
            if (!recipient.phone_registered) reasons.push(t("adminNotifications.phoneUnavailable"));
            else if (!recipient.phone_verified) reasons.push(t("adminNotifications.phoneUnverified"));
            if (recipient.sms_enabled !== true) reasons.push(t("adminNotifications.smsPreferenceDisabled"));
            if (recipient.sms_delivery_enabled !== true) reasons.push(t("adminNotifications.smsProviderDisabled"));
            return reasons.length
                ? reasons.join("; ")
                : t("adminNotifications.verifiedPhoneAvailable");
        }
        if (channel === "EMAIL") {
            const reasons = [];
            if (!recipient.email_registered) reasons.push(t("adminNotifications.emailUnavailable"));
            else if (recipient.email_verified !== true) reasons.push(t("adminNotifications.emailUnverified"));
            if (recipient.email_enabled !== true) reasons.push(t("adminNotifications.emailPreferenceDisabled"));
            if (recipient.email_delivery_enabled !== true) reasons.push(t("adminNotifications.emailProviderDisabled"));
            return reasons.length
                ? reasons.join("; ")
                : t("adminNotifications.verifiedEmailAvailable");
        }
        const count = Number(recipient.push_subscription_count);
        return count > 0
            ? t("adminNotifications.pushDeviceCount", { count })
            : t("adminNotifications.pushUnavailable");
    }

    async function confirmNotification() {
        if (submissionInProgress.current || !recipient) return;
        submissionInProgress.current = true;
        setSubmitting(true);
        try {
            const requestId = window.crypto?.randomUUID?.();
            if (!requestId) throw new Error("A secure request identifier is unavailable.");
            await createRoleNotification({
                user_id: recipient.user_id,
                fund_id: recipient.scope_fund_id,
                category: form.category,
                channels: form.channels,
                message: form.message,
                ...(form.channels.includes("EMAIL") ? { subject: form.subject } : {}),
                ...(form.channels.includes("PUSH") ? { title: form.title } : {}),
                request_id: requestId,
            });
            setPreviewOpen(false);
            setForm({
                user_id: "",
                channels: [],
                category: categories[0] || "",
                message: "",
                subject: "",
                title: "",
            });
            await auditApi.refetch();
            toast.success(t("roleNotifications.queued"));
        } catch (error) {
            const code = error?.response?.data?.code;
            const messageKey = code === "NOTIFICATION_PREFERENCE_DISABLED"
                ? "adminNotifications.preferenceChanged"
                : code === "NOTIFICATION_CONTACT_UNAVAILABLE"
                    ? "adminNotifications.contactChanged"
                    : code === "NOTIFICATION_SMS_UNAVAILABLE"
                        ? "adminNotifications.smsProviderDisabled"
                        : code === "NOTIFICATION_EMAIL_UNAVAILABLE"
                            ? "adminNotifications.emailProviderDisabled"
                            : "roleNotifications.queueError";
            toast.error(t(messageKey));
        } finally {
            submissionInProgress.current = false;
            setSubmitting(false);
        }
    }

    return (
        <div className="page-content notification-page">
            <header className="page-header">
                <div>
                    <h1 className="page-title">{t(`roleNotifications.title.${role}`)}</h1>
                    <p className="page-subtitle">{t("roleNotifications.subtitle")}</p>
                </div>
            </header>

            {auditApi.data !== null && !Array.isArray(auditApi.data) && (
                <section className="notification-summary" aria-label={t("roleNotifications.summary")}>
                    {[
                        ["total_count", "summaryLabels.total", "•", "total"],
                        ["authorized_count", "summaryLabels.authorized", "✓", "authorized"],
                        ["denied_count", "summaryLabels.denied", "!", "denied"],
                    ].map(([key, label, icon, variant]) => (
                        <article className="notification-summary-card" key={key}>
                            <span className={`notification-summary-icon notification-summary-icon--${variant}`} aria-hidden="true">
                                {icon}
                            </span>
                            <div>
                                <span className="notification-summary-label">{t(`roleNotifications.${label}`)}</span>
                                <strong>{auditSummary[key]}</strong>
                            </div>
                        </article>
                    ))}
                </section>
            )}

            <section className="card notification-compose-panel" aria-labelledby="role-notification-compose">
                <h2 id="role-notification-compose">{t("roleNotifications.compose")}</h2>
                <div className="form-grid">
                    <label className="form-field">
                        <span>{t("roleNotifications.search")}</span>
                        <input
                            type="search"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            autoComplete="off"
                        />
                    </label>
                    <label className="form-field">
                        <span>{t("roleNotifications.recipient")}</span>
                        <select name="user_id" value={form.user_id} onChange={updateForm}>
                            <option value="">{t("roleNotifications.selectRecipient")}</option>
                            {(recipientsApi.data || []).map((item) => (
                                <option key={item.user_id} value={item.user_id}>
                                    {item.full_name} — {t(`roles.${item.role}`, { defaultValue: item.role })}
                                </option>
                            ))}
                        </select>
                    </label>
                    {recipientsApi.loading && <p role="status">{t("worker.common.loadingRecords")}</p>}
                    {recipientsApi.error && recipientsApi.data === null && (
                        <p role="alert">{t("worker.common.errors.load")}</p>
                    )}
                    <label className="form-field">
                        <span>{t("roleNotifications.category")}</span>
                        <select name="category" value={form.category} onChange={updateForm}>
                            {categories.map((category) => (
                                <option key={category} value={category}>
                                    {t(`roleNotifications.categories.${category}`)}
                                </option>
                            ))}
                        </select>
                    </label>
                    <fieldset className="form-field">
                        <legend>{t("roleNotifications.channels")}</legend>
                        {CHANNELS.map((channel) => (
                            <label key={channel}>
                                <input
                                    type="checkbox"
                                    checked={form.channels.includes(channel)}
                                    disabled={!channelAvailable(channel)}
                                    onChange={() => toggleChannel(channel)}
                                />
                                {t(`roleNotifications.channelNames.${channel}`)}
                            </label>
                        ))}
                        {recipient && (
                            <ul aria-label={t("adminNotifications.channelAvailability")}>
                                {CHANNELS.map((channel) => (
                                    <li key={channel}>
                                        {t(`roleNotifications.channelNames.${channel}`)} — {channelStatus(channel)}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </fieldset>
                    {form.channels.includes("EMAIL") && (
                        <label className="form-field">
                            <span>{t("roleNotifications.emailSubject")}</span>
                            <input name="subject" value={form.subject} onChange={updateForm} maxLength={255} />
                        </label>
                    )}
                    {form.channels.includes("PUSH") && (
                        <label className="form-field">
                            <span>{t("roleNotifications.pushTitle")}</span>
                            <input name="title" value={form.title} onChange={updateForm} maxLength={100} />
                        </label>
                    )}
                    <label className="form-field">
                        <span>{t("roleNotifications.message")}</span>
                        <textarea name="message" value={form.message} onChange={updateForm} maxLength={5000} rows={5} />
                    </label>
                    <Button
                        disabled={!recipient || !form.channels.length || !form.category || !form.message.trim()}
                        onClick={() => setPreviewOpen(true)}
                    >
                        {t("roleNotifications.preview")}
                    </Button>
                </div>
            </section>

            <section className="card notification-audit-panel" aria-labelledby="notification-audit-heading">
                <h2 id="notification-audit-heading">{t("roleNotifications.history")}</h2>
                <form className="notification-audit-filters" onSubmit={applyAuditFilters}>
                    <label className="form-field">
                        <span>{t("roleNotifications.dateFrom")}</span>
                        <input type="date" name="start_date" value={auditFilters.start_date} onChange={updateAuditFilter} />
                    </label>
                    <label className="form-field">
                        <span>{t("roleNotifications.dateTo")}</span>
                        <input type="date" name="end_date" value={auditFilters.end_date} onChange={updateAuditFilter} />
                    </label>
                    <label className="form-field">
                        <span>{t("roleNotifications.channelFilter")}</span>
                        <select name="channel" value={auditFilters.channel} onChange={updateAuditFilter}>
                            <option value="">{t("roleNotifications.allChannels")}</option>
                            {CHANNELS.map((channel) => <option key={channel} value={channel}>{channel}</option>)}
                        </select>
                    </label>
                    <label className="form-field">
                        <span>{t("roleNotifications.authorizationFilter")}</span>
                        <select name="authorization_outcome" value={auditFilters.authorization_outcome} onChange={updateAuditFilter}>
                            <option value="">{t("roleNotifications.allOutcomes")}</option>
                            <option value="AUTHORIZED">{t("roleNotifications.authorized")}</option>
                            <option value="DENIED">{t("roleNotifications.denied")}</option>
                        </select>
                    </label>
                    <label className="form-field">
                        <span>{t("roleNotifications.deliveryStatusFilter")}</span>
                        <select name="delivery_status" value={auditFilters.delivery_status} onChange={updateAuditFilter}>
                            <option value="">{t("roleNotifications.allStatuses")}</option>
                            {DELIVERY_STATUSES.map((status) => (
                                <option key={status} value={status}>
                                    {t(`worker.common.statuses.${normalizeNotificationStatus(status)}`, { defaultValue: status })}
                                </option>
                            ))}
                        </select>
                    </label>
                    <div className="notification-audit-filter-actions">
                        <Button type="submit">{t("roleNotifications.applyFilters")}</Button>
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => {
                                setAuditFilters(EMPTY_AUDIT_FILTERS);
                                setAppliedAuditFilters({});
                                setAuditPage(1);
                            }}
                        >
                            {t("roleNotifications.clearFilters")}
                        </Button>
                    </div>
                </form>
                <DataTable
                    columns={columns}
                    rows={auditApi.data === null ? null : auditRows}
                    rowKey="audit_event_id"
                    loading={auditApi.loading}
                    refreshing={auditApi.refreshing}
                    error={auditApi.error}
                    onRetry={auditApi.refetch}
                    emptyMessage={t("roleNotifications.empty")}
                />
                {auditPagination.total_pages > 1 && (
                    <div className="notification-audit-pagination" aria-label={t("roleNotifications.pagination")}>
                        <Button variant="secondary" disabled={auditPage <= 1 || auditApi.loading} onClick={() => setAuditPage((current) => current - 1)}>
                            {t("roleNotifications.previous")}
                        </Button>
                        <span>{t("roleNotifications.pageOf", { page: auditPage, pages: auditPagination.total_pages })}</span>
                        <Button variant="secondary" disabled={auditPage >= auditPagination.total_pages || auditApi.loading} onClick={() => setAuditPage((current) => current + 1)}>
                            {t("roleNotifications.next")}
                        </Button>
                    </div>
                )}
            </section>

            <ChannelNotificationPreferences />
            <PushSubscriptionControl />

            <Modal
                open={previewOpen}
                title={t("roleNotifications.previewTitle")}
                closeLabel={t("worker.common.close")}
                onClose={() => !submitting && setPreviewOpen(false)}
            >
                {recipient && (
                    <div className="form-grid">
                        <p><strong>{t("roleNotifications.recipient")}:</strong> {recipient.full_name}</p>
                        <p><strong>{t("roleNotifications.category")}:</strong> {t(`roleNotifications.categories.${form.category}`)}</p>
                        <p><strong>{t("roleNotifications.channels")}:</strong> {form.channels.join(", ")}</p>
                        {form.subject && <p><strong>{t("roleNotifications.emailSubject")}:</strong> {form.subject}</p>}
                        {form.title && <p><strong>{t("roleNotifications.pushTitle")}:</strong> {form.title}</p>}
                        <p>{form.message}</p>
                        <div>
                            <Button loading={submitting} onClick={confirmNotification}>
                                {t("roleNotifications.confirm")}
                            </Button>
                            <Button variant="secondary" disabled={submitting} onClick={() => setPreviewOpen(false)}>
                                {t("roleNotifications.cancel")}
                            </Button>
                        </div>
                    </div>
                )}
            </Modal>
        </div>
    );
}

export default RoleNotifications;
