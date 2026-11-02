import { useRef, useState } from "react";
import useApi from "../../hooks/useApi";
import { listNotifications, createNotification, listUsers } from "../../services/adminService";
import DataTable from "../../components/ui/DataTable";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import LoadingState from "../../components/ui/LoadingState";
import ErrorState from "../../components/ui/ErrorState";
import { useToast } from "../../components/ui/ToastContext";
import { AdminCard, AdminPage } from "../../components/AdminPage";

const CHANNELS = ["SMS", "EMAIL", "PUSH", "USSD"];
const EMPTY_FORM = { user_id: "", notification_type: "SMS", message: "" };

function Notifications() {
    const notificationsApi = useApi(listNotifications, []);
    const usersApi = useApi(listUsers, []);
    const toast = useToast();
    const [form, setForm] = useState(EMPTY_FORM);
    const [submitting, setSubmitting] = useState(false);
    const submissionInProgressRef = useRef(false);
    const [viewingNotification, setViewingNotification] = useState(null);

    function handleChange(event) {
        const { name, value } = event.target;
        setForm((current) => ({ ...current, [name]: value }));
    }

    async function handleSubmit(event) {
        event.preventDefault();
        if (submissionInProgressRef.current || usersApi.loading || usersApi.error) return;
        submissionInProgressRef.current = true;
        setSubmitting(true);
        try {
            await createNotification(form);
            setForm(EMPTY_FORM);
            const notifications = await notificationsApi.refetch();
            toast.success(notifications
                ? "Notification queued. Delivery status will update when the provider reports it."
                : "Notification queued, but the delivery list could not be refreshed.");
        } catch (error) {
            toast.error(error.message || "Failed to queue notification.");
        } finally {
            submissionInProgressRef.current = false;
            setSubmitting(false);
        }
    }

    const userOptions = (usersApi.data || []).map((user) => ({
        value: user.user_id,
        label: `${user.full_name} (${user.role.replace("_", " ")})`,
    }));

    const columns = [
        { key: "notification_id", header: "Ref" },
        { key: "recipient_name", header: "To" },
        { key: "notification_type", header: "Channel" },
        {
            key: "message",
            header: "Message",
            render: (row) => <span className="admin-message-preview" title={row.message}>{row.message}</span>,
        },
        { key: "created_by_name", header: "Sent by", render: (row) => row.created_by_name || "System" },
        {
            key: "delivery_status",
            header: "Delivery",
            render: (row) => <span className="admin-status-pill" data-status={row.delivery_status}>{row.delivery_status}</span>,
        },
        {
            key: "actions",
            header: "Action",
            render: (row) => (
                <Button variant="secondary" size="sm" onClick={() => setViewingNotification(row)}>
                    View
                </Button>
            ),
        },
    ];

    return (
        <AdminPage
            title="Notifications"
            subtitle="Compose messages and review notifications that are queued or have a recorded delivery status."
        >
            <div className="admin-stack">
                <AdminCard
                    title="Send a notification"
                    description="Messages are queued in the platform. A queued record does not confirm delivery through an SMS, email, push, or USSD provider."
                >
                    {usersApi.loading && usersApi.data === null ? (
                        <LoadingState message="Loading recipient list..." />
                    ) : usersApi.error && usersApi.data === null ? (
                        <ErrorState message={usersApi.error} onRetry={usersApi.refetch} />
                    ) : (
                        <form className="admin-form-grid" onSubmit={handleSubmit}>
                            <div>
                                <label className="admin-field-label" htmlFor="notification-recipient">Recipient</label>
                                <select
                                    className="admin-control"
                                    id="notification-recipient"
                                    name="user_id"
                                    value={form.user_id}
                                    onChange={handleChange}
                                    disabled={submitting || usersApi.loading || Boolean(usersApi.error)}
                                    required
                                >
                                    <option value="">Select a recipient...</option>
                                    {userOptions.map((option) => (
                                        <option key={option.value} value={option.value}>{option.label}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <span className="admin-field-label">Channel</span>
                                <div className="admin-channel-pills" role="group" aria-label="Notification channel">
                                    {CHANNELS.map((channel) => (
                                        <button
                                            className="admin-channel-pill"
                                            type="button"
                                            key={channel}
                                            aria-pressed={form.notification_type === channel}
                                            disabled={submitting}
                                            onClick={() => setForm((current) => ({ ...current, notification_type: channel }))}
                                        >
                                            {channel}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div className="admin-span-all">
                                <label className="admin-field-label" htmlFor="notification-message">Message</label>
                                <textarea
                                    className="admin-control"
                                    id="notification-message"
                                    name="message"
                                    rows={4}
                                    maxLength={255}
                                    value={form.message}
                                    onChange={handleChange}
                                    disabled={submitting}
                                    required
                                />
                                <p className="admin-hint">{form.message.length}/255 characters. 255 characters at most.</p>
                            </div>
                            <div className="admin-span-all">
                                <Button type="submit" variant="primary" loading={submitting} disabled={usersApi.loading || Boolean(usersApi.error)}>
                                    Send
                                </Button>
                            </div>
                        </form>
                    )}
                </AdminCard>

                <AdminCard title="Sent and queued">
                    <DataTable
                        columns={columns}
                        rows={notificationsApi.data}
                        rowKey="notification_id"
                        loading={notificationsApi.loading}
                        refreshing={notificationsApi.refreshing}
                        error={notificationsApi.error}
                        onRetry={notificationsApi.refetch}
                        emptyMessage="No notifications have been queued."
                    />
                </AdminCard>
            </div>

            <Modal
                open={Boolean(viewingNotification)}
                title="Notification details"
                onClose={() => setViewingNotification(null)}
            >
                {viewingNotification && (
                    <div className="admin-stack">
                        <p><strong>Reference:</strong> {viewingNotification.notification_id}</p>
                        <p><strong>To:</strong> {viewingNotification.recipient_name}</p>
                        <p><strong>Channel:</strong> {viewingNotification.notification_type}</p>
                        <p><strong>Delivery:</strong> {viewingNotification.delivery_status}</p>
                        <p><strong>Message:</strong> {viewingNotification.message}</p>
                    </div>
                )}
            </Modal>
        </AdminPage>
    );
}

export default Notifications;
