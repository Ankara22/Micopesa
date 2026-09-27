import { useState } from "react";
import useApi from "../../hooks/useApi";
import { listUsers, updateUserStatus } from "../../services/adminService";
import DataTable from "../../components/ui/DataTable";
import StatusBadge from "../../components/ui/StatusBadge";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import FormField from "../../components/ui/FormField";
import { useAuth } from "../../context/AuthContext";

const STATUS_OPTIONS = [
    { value: "ACTIVE", label: "Active" },
    { value: "INACTIVE", label: "Inactive" },
    { value: "SUSPENDED", label: "Suspended" },
];

function UserManagement() {
    const { user: currentUser } = useAuth();
    const usersApi = useApi(listUsers, []);
    const [editingUser, setEditingUser] = useState(null);
    const [status, setStatus] = useState("ACTIVE");
    const [submitting, setSubmitting] = useState(false);
    const [formError, setFormError] = useState("");

    function openModal(user) {
        setEditingUser(user);
        setStatus(user.account_status);
        setFormError("");
    }

    async function handleSubmit(e) {
        e.preventDefault();
        setFormError("");
        setSubmitting(true);
        try {
            await updateUserStatus(editingUser.user_id, status);
            setEditingUser(null);
            usersApi.refetch();
        } catch (err) {
            setFormError(err.message || "Failed to update user status.");
        } finally {
            setSubmitting(false);
        }
    }

    const columns = [
        { key: "full_name", header: "Name" },
        { key: "phone", header: "Phone" },
        { key: "role", header: "Role" },
        { key: "occupation", header: "Occupation", render: (row) => row.occupation || "-" },
        { key: "account_status", header: "Status", render: (row) => <StatusBadge status={row.account_status} /> },
        {
            key: "actions",
            header: "",
            render: (row) => (
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => openModal(row)}
                    disabled={row.user_id === currentUser?.user_id}
                >
                    Change status
                </Button>
            ),
        },
    ];

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">User Management</h1>
                    <p className="page-subtitle">View all users and manage their account status.</p>
                </div>
            </div>

            <DataTable
                columns={columns}
                rows={usersApi.data}
                rowKey="user_id"
                loading={usersApi.loading}
                error={usersApi.error}
                onRetry={usersApi.refetch}
            />

            <Modal open={Boolean(editingUser)} title={`Update status - ${editingUser?.full_name || ""}`} onClose={() => setEditingUser(null)}>
                {formError && <div className="form-error" style={{ marginBottom: 12 }}>{formError}</div>}
                <form className="form-grid" onSubmit={handleSubmit}>
                    <FormField
                        id="account_status"
                        label="Account status"
                        as="select"
                        options={STATUS_OPTIONS}
                        value={status}
                        onChange={(e) => setStatus(e.target.value)}
                    />
                    <div className="form-actions">
                        <Button type="button" variant="secondary" onClick={() => setEditingUser(null)}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" loading={submitting}>
                            Save
                        </Button>
                    </div>
                </form>
            </Modal>
        </div>
    );
}

export default UserManagement;
