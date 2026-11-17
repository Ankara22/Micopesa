import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import DataTable from "../../components/ui/DataTable";
import Button from "../../components/ui/Button";
import { normalizeNotificationStatus } from "../../components/ui/notificationStatus";
import { listNotificationAudit } from "../../services/notificationService";
import "./notifications.css";

const CHANNELS = ["SMS", "EMAIL", "PUSH"];
const DELIVERY_STATUSES = ["PENDING", "PROVIDER_ACCEPTED", "DELIVERED", "FAILED", "UNKNOWN", "SKIPPED"];
const EMPTY_FILTERS = {
    start_date: "",
    end_date: "",
    channel: "",
    authorization_outcome: "",
    delivery_status: "",
};

function NotificationAuditPage() {
    const { t, i18n } = useTranslation();
    const [filters, setFilters] = useState(EMPTY_FILTERS);
    const [appliedFilters, setAppliedFilters] = useState({});
    const [page, setPage] = useState(1);
    const fetchAudit = useCallback(
        () => listNotificationAudit({ ...appliedFilters, page, page_size: 25 }),
        [appliedFilters, page]
    );
    const auditApi = useApi(fetchAudit, [fetchAudit]);
    const records = auditApi.data?.records;
    const pagination = auditApi.data?.pagination;
    const summary = auditApi.data?.summary;

    const columns = useMemo(() => [
        {
            key: "created_at",
            header: t("roleNotifications.date"),
            render: (row) => new Date(row.created_at).toLocaleString(
                i18n.language === "sw" ? "sw-KE" : "en-KE"
            ),
        },
        { key: "sender_name", header: t("roleNotifications.sender") },
        {
            key: "sender_role",
            header: t("roleNotifications.senderRole"),
            render: (row) => t(`roles.${row.sender_role}`, { defaultValue: row.sender_role }),
        },
        { key: "recipient_name", header: t("roleNotifications.recipient") },
        {
            key: "contact",
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
            key: "channels",
            header: t("roleNotifications.channels"),
            render: (row) => Array.isArray(row.channels) ? row.channels.join(", ") : "",
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

    function updateFilter(event) {
        const { name, value } = event.target;
        setFilters((current) => ({ ...current, [name]: value }));
    }

    function applyFilters(event) {
        event.preventDefault();
        setPage(1);
        setAppliedFilters(Object.fromEntries(
            Object.entries(filters).filter(([, value]) => value.trim() !== "")
        ));
    }

    return (
        <div className="page-content notification-page">
            <header className="page-header">
                <div>
                    <h1 className="page-title">{t("roleNotifications.auditTitle")}</h1>
                    <p className="page-subtitle">{t("roleNotifications.auditSubtitle")}</p>
                </div>
            </header>
            {auditApi.data && summary && (
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
                                <strong>{summary[key]}</strong>
                            </div>
                        </article>
                    ))}
                </section>
            )}
            <form className="notification-audit-filters" onSubmit={applyFilters}>
                <label className="form-field">
                    <span>{t("roleNotifications.dateFrom")}</span>
                    <input type="date" name="start_date" value={filters.start_date} onChange={updateFilter} />
                </label>
                <label className="form-field">
                    <span>{t("roleNotifications.dateTo")}</span>
                    <input type="date" name="end_date" value={filters.end_date} onChange={updateFilter} />
                </label>
                <label className="form-field">
                    <span>{t("roleNotifications.channelFilter")}</span>
                    <select name="channel" value={filters.channel} onChange={updateFilter}>
                        <option value="">{t("roleNotifications.allChannels")}</option>
                        {CHANNELS.map((channel) => <option key={channel} value={channel}>{channel}</option>)}
                    </select>
                </label>
                <label className="form-field">
                    <span>{t("roleNotifications.authorizationFilter")}</span>
                    <select name="authorization_outcome" value={filters.authorization_outcome} onChange={updateFilter}>
                        <option value="">{t("roleNotifications.allOutcomes")}</option>
                        <option value="AUTHORIZED">{t("roleNotifications.authorized")}</option>
                        <option value="DENIED">{t("roleNotifications.denied")}</option>
                    </select>
                </label>
                <label className="form-field">
                    <span>{t("roleNotifications.deliveryStatusFilter")}</span>
                    <select name="delivery_status" value={filters.delivery_status} onChange={updateFilter}>
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
                            setFilters(EMPTY_FILTERS);
                            setAppliedFilters({});
                            setPage(1);
                        }}
                    >
                        {t("roleNotifications.clearFilters")}
                    </Button>
                </div>
            </form>
            <DataTable
                columns={columns}
                rows={auditApi.data === null ? null : records}
                rowKey="audit_event_id"
                loading={auditApi.loading}
                refreshing={auditApi.refreshing}
                error={auditApi.error}
                onRetry={auditApi.refetch}
                emptyMessage={t("roleNotifications.empty")}
            />
            {pagination?.total_pages > 1 && (
                <div className="notification-audit-pagination" aria-label={t("roleNotifications.pagination")}>
                    <Button variant="secondary" disabled={page <= 1 || auditApi.loading} onClick={() => setPage((current) => current - 1)}>
                        {t("roleNotifications.previous")}
                    </Button>
                    <span>{t("roleNotifications.pageOf", { page, pages: pagination.total_pages })}</span>
                    <Button variant="secondary" disabled={page >= pagination.total_pages || auditApi.loading} onClick={() => setPage((current) => current + 1)}>
                        {t("roleNotifications.next")}
                    </Button>
                </div>
            )}
        </div>
    );
}

export default NotificationAuditPage;
