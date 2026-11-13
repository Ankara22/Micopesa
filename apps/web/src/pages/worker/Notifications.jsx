import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import { getMyNotifications } from "../../services/notificationService";
import StatusBadge from "../../components/ui/StatusBadge";
import Button from "../../components/ui/Button";
import { normalizeNotificationStatus } from "../../components/ui/notificationStatus";
import PushSubscriptionControl from "../../components/Notifications/PushSubscriptionControl";
import ChannelNotificationPreferences from "../../components/Notifications/ChannelNotificationPreferences";
import "../notifications/notifications.css";

const STATUSES = ["PENDING", "PROVIDER_ACCEPTED", "DELIVERED", "FAILED", "UNKNOWN"];
const CHANNELS = ["SMS", "EMAIL", "PUSH"];

function Notifications() {
    const { t, i18n } = useTranslation();
    const notificationsApi = useApi(getMyNotifications, []);
    const [search, setSearch] = useState("");
    const [channel, setChannel] = useState("");
    const [status, setStatus] = useState("");
    const rows = useMemo(
        () => Array.isArray(notificationsApi.data) ? notificationsApi.data : [],
        [notificationsApi.data]
    );
    const filteredRows = useMemo(() => {
        const query = search.trim().toLocaleLowerCase(i18n.language === "sw" ? "sw-KE" : "en-KE");
        return rows.filter((row) => {
            const matchesSearch = !query ||
                [row.message, row.notification_type, row.delivery_status]
                    .some((value) => String(value || "").toLocaleLowerCase().includes(query));
            const matchesChannel = !channel || row.notification_type === channel;
            const matchesStatus = !status || normalizeNotificationStatus(row.delivery_status) === status;
            return matchesSearch && matchesChannel && matchesStatus;
        });
    }, [channel, i18n.language, rows, search, status]);
    const counts = useMemo(() => rows.reduce((summary, row) => {
        const normalized = normalizeNotificationStatus(row.delivery_status);
        summary.total += 1;
        if (normalized === "PROVIDER_ACCEPTED") summary.accepted += 1;
        if (normalized === "DELIVERED") summary.delivered += 1;
        if (normalized === "PENDING") summary.pending += 1;
        return summary;
    }, { total: 0, accepted: 0, delivered: 0, pending: 0 }), [rows]);

    function formatDate(value) {
        return new Date(value).toLocaleString(i18n.language === "sw" ? "sw-KE" : "en-KE");
    }

    return (
        <div className="page-content notification-page">
            <header className="page-header notification-page-header">
                <div>
                    <p className="notification-eyebrow">{t("worker.notifications.inAppTitle")}</p>
                    <h1 className="page-title">{t("worker.notifications.title")}</h1>
                    <p className="page-subtitle">{t("worker.notifications.subtitle")}</p>
                </div>
                <Button variant="secondary" loading={notificationsApi.refreshing} onClick={notificationsApi.refetch}>
                    {t("worker.notifications.refresh")}
                </Button>
            </header>

            {Array.isArray(notificationsApi.data) && (
                <section className="notification-summary" aria-label={t("worker.notifications.summary")}>
                    {[
                        ["total", "total"],
                        ["pending", "pending"],
                        ["accepted", "accepted"],
                        ["delivered", "delivered"],
                    ].map(([key, label]) => (
                        <article className="notification-summary-card" key={key}>
                            <span className={`notification-summary-icon notification-summary-icon--${key}`} aria-hidden="true">
                                {key === "total" ? "•" : key === "pending" ? "◷" : key === "accepted" ? "✓" : "↗"}
                            </span>
                            <div>
                                <span className="notification-summary-label">
                                    {t(`worker.notifications.summaryLabels.${label}`)}
                                </span>
                                <strong>{counts[key]}</strong>
                            </div>
                        </article>
                    ))}
                </section>
            )}

            <section className="notification-panel" aria-label={t("worker.notifications.inAppTitle")}>
                <div className="notification-panel-heading">
                    <div>
                        <h2>{t("worker.notifications.activityTitle")}</h2>
                        <p>{t("worker.notifications.activitySubtitle")}</p>
                    </div>
                    <span className="notification-count">{filteredRows.length}</span>
                </div>
                <div className="notification-filters">
                    <label className="notification-filter-field">
                        <span>{t("worker.notifications.search")}</span>
                        <input
                            type="search"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            autoComplete="off"
                        />
                    </label>
                    <label className="notification-filter-field">
                        <span>{t("worker.notifications.type")}</span>
                        <select value={channel} onChange={(event) => setChannel(event.target.value)}>
                            <option value="">{t("worker.notifications.allChannels")}</option>
                            {CHANNELS.map((item) => (
                                <option key={item} value={item}>
                                    {t(`worker.common.notificationTypes.${item}`, { defaultValue: item })}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="notification-filter-field">
                        <span>{t("worker.notifications.status")}</span>
                        <select value={status} onChange={(event) => setStatus(event.target.value)}>
                            <option value="">{t("worker.notifications.allStatuses")}</option>
                            {STATUSES.map((item) => (
                                <option key={item} value={item}>
                                    {t(`worker.notifications.statusLabels.${item}`, {
                                        defaultValue: t(`worker.common.statuses.${item}`, { defaultValue: item }),
                                    })}
                                </option>
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
                    <p
                        className="notification-state"
                        role="status"
                        aria-label={t("worker.common.loadingRecords")}
                    >
                        {t("worker.common.loadingRecords")}
                    </p>
                ) : notificationsApi.error && notificationsApi.data === null ? (
                    <div className="notification-state" role="alert">
                        <p>{t("worker.common.errors.load")}</p>
                        <Button variant="secondary" onClick={notificationsApi.refetch}>
                            {t("worker.common.tryAgain")}
                        </Button>
                    </div>
                ) : filteredRows.length ? (
                    <ol className="notification-timeline">
                        {filteredRows.map((row) => {
                            const normalizedStatus = normalizeNotificationStatus(row.delivery_status);
                            return (
                                <li className="notification-timeline-item" key={row.notification_id}>
                                    <span className="notification-timeline-marker" aria-hidden="true" />
                                    <article className="notification-message-card">
                                        <div className="notification-message-meta">
                                            <span className="notification-channel">
                                                {t(`worker.common.notificationTypes.${row.notification_type}`, {
                                                    defaultValue: row.notification_type,
                                                })}
                                            </span>
                                            <StatusBadge
                                                status={normalizedStatus}
                                                label={t(`worker.notifications.statusLabels.${normalizedStatus}`, {
                                                    defaultValue: t(`worker.common.statuses.${normalizedStatus}`, {
                                                        defaultValue: normalizedStatus,
                                                    }),
                                                })}
                                            />
                                        </div>
                                        <p className="notification-message-content">{row.message}</p>
                                        <time dateTime={row.created_at}>{formatDate(row.created_at)}</time>
                                    </article>
                                </li>
                            );
                        })}
                    </ol>
                ) : (
                    <p className="notification-state">
                        {rows.length ? t("worker.notifications.noMatches") : t("worker.notifications.empty")}
                    </p>
                )}
            </section>
            <ChannelNotificationPreferences />
            <PushSubscriptionControl />
        </div>
    );
}

export default Notifications;
