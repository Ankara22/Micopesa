import { useState } from "react";
import useApi from "../../hooks/useApi";
import { listNotifications, createNotification, listUsers } from "../../services/adminService";
import DataTable from "../../components/ui/DataTable";
import StatusBadge from "../../components/ui/StatusBadge";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import FormField from "../../components/ui/FormField";

const TYPE_OPTIONS = [
    { value: "SMS", label: "SMS" },
    { value: "EMAIL", label: "Email" },
    { value: "PUSH", label: "Push" },
    { value: "USSD", label: "USSD" },
];

const EMPTY_FORM = { user_id: "", notification_type: "SMS", message: "" };

function Notifications() {
    const notificationsApi = useApi(listNotifications, []);
    const usersApi = useApi(listUsers, []);
    const [modalOpen, setModalOpen] = useState(false);
    const [form, setForm] = useState(EMPTY_FORM);
    const [submitting, setSubmitting] = useState(false);
    const [formError, setFormError] = useState("");

    function handleChange(e) {
        const { name, value } = e.target;
        setForm((prev) => ({ ...prev, [name]: value }));
    }

    async function handleSubmit(e) {
        e.preventDefault();
        setFormError("");
        setSubmitting(true);
        try {
            await createNotification(form);
            setModalOpen(false);
            setForm(EMPTY_FORM);
            notificationsApi.refetch();
        } catch (err) {
            setFormError(err.message || "Failed to send notification.");
        } finally {
            setSubmitting(false);
        }
    }

    const userOptions = (usersApi.data || []).map((u) => ({
        value: u.user_id,
        label: `${u.full_name} (${u.role})`,
    }));

    const columns = [
        { key: "recipient_name", header: "Recipient" },
        { key: "created_by_name", header: "Sent By", render: (row) => row.created_by_name || "System" },
        { key: "notification_type", header: "Type" },
        { key: "message", header: "Message" },
        { key: "delivery_status", header: "Delivery", render: (row) => <StatusBadge status={row.delivery_status} /> },
        { key: "created_at", header: "Created", render: (row) => new Date(row.created_at).toLocaleString() },
    ];

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Notifications</h1>
                    <p className="page-subtitle">Compose and monitor platform notifications.</p>
                </div>
                <Button variant="primary" onClick={() => setModalOpen(true)}>
                    + Send Notification
                </Button>
            </div>

            <DataTable
                columns={columns}
                rows={notificationsApi.data}
                rowKey="notification_id"
                loading={notificationsApi.loading}
                error={notificationsApi.error}
                onRetry={notificationsApi.refetch}
                emptyMessage="No notifications have been sent yet."
            />

            <Modal open={modalOpen} title="Send a notification" onClose={() => setModalOpen(false)}>
                {formError && <div className="form-error" style={{ marginBottom: 12 }}>{formError}</div>}
                <form className="form-grid" onSubmit={handleSubmit}>
                    <FormField
                        id="user_id"
                        label="Recipient"
                        as="select"
                        options={[{ value: "", label: "Select a user..." }, ...userOptions]}
                        value={form.user_id}
                        onChange={handleChange}
                        required
                    />
                    <FormField
                        id="notification_type"
                        label="Type"
                        as="select"
                        options={TYPE_OPTIONS}
                        value={form.notification_type}
                        onChange={handleChange}
                    />
                    <FormField id="message" label="Message" as="textarea" value={form.message} onChange={handleChange} required />
                    <div className="form-actions">
                        <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" loading={submitting}>
                            Send
                        </Button>
                    </div>
                </form>
            </Modal>
        </div>
    );
}

export default Notifications;
