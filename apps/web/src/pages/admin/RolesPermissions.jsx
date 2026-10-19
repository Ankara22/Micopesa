import { useState } from "react";
import useApi from "../../hooks/useApi";
import { listUsers, updateUserRole } from "../../services/adminService";
import DataTable from "../../components/ui/DataTable";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import FormField from "../../components/ui/FormField";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../components/ui/ToastContext";

const ROLE_OPTIONS = [
    { value: "WORKER", label: "Worker" },
    { value: "FUND_MANAGER", label: "Fund Manager" },
    { value: "REGULATOR", label: "Regulator" },
    { value: "ADMIN", label: "Admin" },
];

function RolesPermissions() {
    const { user: currentUser } = useAuth();
    const toast = useToast();
    const usersApi = useApi(listUsers, []);
    const [editingUser, setEditingUser] = useState(null);
    const [role, setRole] = useState("WORKER");
    const [submitting, setSubmitting] = useState(false);

    function openModal(user) {
        setEditingUser(user);
        setRole(user.role);
    }

    async function handleSubmit(e) {
        e.preventDefault();
        setSubmitting(true);
        try {
            const updatedUser = await updateUserRole(editingUser.user_id, role);
            usersApi.setData((users) =>
                (users || []).map((user) => user.user_id === updatedUser.user_id ? updatedUser : user)
            );
            setEditingUser(null);
            toast.success(`${updatedUser.full_name}'s role is now ${updatedUser.role}.`);
        } catch (err) {
            toast.error(err.message || "Failed to update user role.");
        } finally {
            setSubmitting(false);
        }
    }

    const columns = [
        { key: "full_name", header: "Name" },
        { key: "phone", header: "Phone" },
        { key: "role", header: "Current Role" },
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
                    Change role
                </Button>
            ),
        },
    ];

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Roles &amp; Permissions</h1>
                    <p className="page-subtitle">
                        Assign roles to users. WORKER, FUND_MANAGER, REGULATOR, and ADMIN are the only
                        valid roles.
                    </p>
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

            <Modal open={Boolean(editingUser)} title={`Change role - ${editingUser?.full_name || ""}`} onClose={() => setEditingUser(null)}>
                <form className="form-grid" onSubmit={handleSubmit}>
                    <FormField
                        id="role"
                        label="Role"
                        as="select"
                        options={ROLE_OPTIONS}
                        value={role}
                        onChange={(e) => setRole(e.target.value)}
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

export default RolesPermissions;
