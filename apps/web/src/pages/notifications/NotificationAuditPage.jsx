import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import DataTable from "../../components/ui/DataTable";
import { normalizeNotificationStatus } from "../../components/ui/notificationStatus";
import { listNotificationAudit } from "../../services/notificationService";
import "./notifications.css";

function NotificationAuditPage() {
    const { t, i18n } = useTranslation();
    const auditApi = useApi(listNotificationAudit, []);
    const auditRows = useMemo(
        () => Array.isArray(auditApi.data) ? auditApi.data : [],
        [auditApi.data]
    );
    const auditSummary = useMemo(() => auditRows.reduce((summary, row) => {
        summary.total += 1;
        if (row.authorization_outcome === "AUTHORIZED") summary.authorized += 1;
        if (row.authorization_outcome === "DENIED") summary.denied += 1;
        return summary;
    }, { total: 0, authorized: 0, denied: 0 }), [auditRows]);
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

    return (
        <div className="page-content notification-page">
            <header className="page-header">
                <div>
                    <h1 className="page-title">{t("roleNotifications.auditTitle")}</h1>
                    <p className="page-subtitle">{t("roleNotifications.auditSubtitle")}</p>
                </div>
            </header>
            {Array.isArray(auditApi.data) && (
                <section className="notification-summary" aria-label={t("roleNotifications.summary")}>
                    {[
                        ["total", "summaryLabels.total", "•"],
                        ["authorized", "summaryLabels.authorized", "✓"],
                        ["denied", "summaryLabels.denied", "!"],
                    ].map(([key, label, icon]) => (
                        <article className="notification-summary-card" key={key}>
                            <span className={`notification-summary-icon notification-summary-icon--${key}`} aria-hidden="true">
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
            <DataTable
                columns={columns}
                rows={auditApi.data}
                rowKey="audit_event_id"
                loading={auditApi.loading}
                refreshing={auditApi.refreshing}
                error={auditApi.error}
                onRetry={auditApi.refetch}
                emptyMessage={t("roleNotifications.empty")}
            />
        </div>
    );
}

export default NotificationAuditPage;
