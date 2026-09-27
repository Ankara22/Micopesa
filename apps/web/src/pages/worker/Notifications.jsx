import useApi from "../../hooks/useApi";
import { getMyNotifications } from "../../services/notificationService";
import DataTable from "../../components/ui/DataTable";
import StatusBadge from "../../components/ui/StatusBadge";
import ErrorState from "../../components/ui/ErrorState";
import LoadingState from "../../components/ui/LoadingState";

const COLUMNS = [
    { key: "created_at", header: "Date", render: (row) => new Date(row.created_at).toLocaleString() },
    { key: "notification_type", header: "Type" },
    { key: "message", header: "Message" },
    { key: "delivery_status", header: "Status", render: (row) => <StatusBadge status={row.delivery_status} /> },
];

function Notifications() {
    const notificationsApi = useApi(getMyNotifications, []);

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Notifications</h1>
                    <p className="page-subtitle">Messages and alerts sent to you.</p>
                </div>
            </div>

            {notificationsApi.loading && <LoadingState message="Loading notifications..." />}
            {notificationsApi.error && <ErrorState message={notificationsApi.error} />}
            {!notificationsApi.loading && !notificationsApi.error && (
                <DataTable
                    columns={COLUMNS}
                    rows={notificationsApi.data}
                    rowKey="notification_id"
                    loading={notificationsApi.loading}
                    error={notificationsApi.error}
                    onRetry={notificationsApi.refetch}
                    emptyMessage="You have no notifications yet."
                />
            )}
        </div>
    );
}

export default Notifications;
