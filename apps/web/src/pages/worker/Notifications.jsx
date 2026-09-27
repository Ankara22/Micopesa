import useApi from "../../hooks/useApi";
import { getMyNotifications } from "../../services/notificationService";
import ErrorState from "../../components/ui/ErrorState";
import LoadingState from "../../components/ui/LoadingState";

/**
 * GAP: There is no backend endpoint for a worker to fetch their own
 * notifications (see services/notificationService.js). This page calls the
 * honest stub, which always fails, and surfaces that failure clearly via
 * ErrorState rather than displaying invented/fake notification data.
 */
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
        </div>
    );
}

export default Notifications;
