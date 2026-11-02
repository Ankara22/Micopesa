import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import { getMyNotifications } from "../../services/notificationService";
import DataTable from "../../components/ui/DataTable";
import StatusBadge from "../../components/ui/StatusBadge";

function Notifications() {
    const { t, i18n } = useTranslation();
    const notificationsApi = useApi(getMyNotifications, []);
    const columns = [
        { key: "created_at", header: t("worker.notifications.date"), render: (row) => new Date(row.created_at).toLocaleString(i18n.language === "sw" ? "sw-KE" : "en-KE") },
        { key: "notification_type", header: t("worker.notifications.type"), render: (row) => t(`worker.common.notificationTypes.${row.notification_type}`, { defaultValue: row.notification_type }) },
        { key: "message", header: t("worker.notifications.message") },
        { key: "delivery_status", header: t("worker.notifications.status"), render: (row) => <StatusBadge status={row.delivery_status} label={t(`worker.common.statuses.${row.delivery_status}`, { defaultValue: row.delivery_status })} /> },
    ];

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">{t("worker.notifications.title")}</h1>
                    <p className="page-subtitle">{t("worker.notifications.subtitle")}</p>
                </div>
            </div>

            <DataTable
                columns={columns}
                rows={notificationsApi.data}
                rowKey="notification_id"
                loading={notificationsApi.loading}
                refreshing={notificationsApi.refreshing}
                error={notificationsApi.error ? t("worker.common.errors.load") : null}
                onRetry={notificationsApi.refetch}
                emptyMessage={t("worker.notifications.empty")}
                loadingLabel={t("worker.common.loadingRecords")}
                refreshingLabel={t("worker.common.refreshingRecords")}
                errorTitle={t("worker.common.unableToLoad")}
                retryLabel={t("worker.common.tryAgain")}
                unexpectedDataMessage={t("worker.common.unexpectedData")}
            />
        </div>
    );
}

export default Notifications;
