import { useRef, useState } from "react";
import useApi from "../../hooks/useApi";
import { listUsers, updateUserRole } from "../../services/adminService";
import DataTable from "../../components/ui/DataTable";
import Button from "../../components/ui/Button";
import FormField from "../../components/ui/FormField";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../components/ui/ToastContext";
import { AdminCard, AdminPage } from "../../components/AdminPage";

const ROLE_OPTIONS = [
    { value: "WORKER", label: "Worker" },
    { value: "FUND_MANAGER", label: "Fund Manager" },
    { value: "REGULATOR", label: "Regulator" },
    { value: "ADMIN", label: "Administrator" },
];

const PERMISSIONS = [
    { capability: "Save and manage contributions", WORKER: true, FUND_MANAGER: false, REGULATOR: false, ADMIN: false },
    { capability: "Request a withdrawal", WORKER: true, FUND_MANAGER: false, REGULATOR: false, ADMIN: false },
    { capability: "Review withdrawal claims", WORKER: false, FUND_MANAGER: true, REGULATOR: false, ADMIN: false },
    { capability: "Manage assigned funds", WORKER: false, FUND_MANAGER: true, REGULATOR: false, ADMIN: false },
    { capability: "File compliance reports", WORKER: false, FUND_MANAGER: true, REGULATOR: true, ADMIN: false },
    { capability: "Read system audit logs", WORKER: false, FUND_MANAGER: false, REGULATOR: false, ADMIN: true },
    { capability: "Manage users and settings", WORKER: false, FUND_MANAGER: false, REGULATOR: false, ADMIN: true },
];

function RolesPermissions() {
    const { user: currentUser } = useAuth();
    const toast = useToast();
    const usersApi = useApi(listUsers, []);
    const [selectedUserId, setSelectedUserId] = useState("");
    const [role, setRole] = useState("WORKER");
    const [submitting, setSubmitting] = useState(false);
    const submissionInProgressRef = useRef(false);
    const selectableUsers = (usersApi.data || []).filter((user) => user.user_id !== currentUser?.user_id);
    const selectedUser = selectableUsers.find((user) => user.user_id === selectedUserId);

    async function handleSubmit(event) {
        event.preventDefault();
        if (!selectedUser || submissionInProgressRef.current) return;
        submissionInProgressRef.current = true;
        setSubmitting(true);
        try {
            const updatedUser = await updateUserRole(selectedUser.user_id, role);
            usersApi.setData((users) =>
                (users || []).map((user) => user.user_id === updatedUser.user_id ? updatedUser : user)
            );
            toast.success(`${updatedUser.full_name}'s role is now ${updatedUser.role}.`);
        } catch (error) {
            toast.error(error.message || "Failed to update user role.");
        } finally {
            submissionInProgressRef.current = false;
            setSubmitting(false);
        }
    }

    const userOptions = selectableUsers.map((user) => ({
        value: user.user_id,
        label: `${user.full_name} (${user.role.replace("_", " ")})`,
    }));

    const roleColumns = [
        { key: "full_name", header: "Name" },
        { key: "phone", header: "Phone" },
        { key: "role", header: "Current role" },
    ];

    const permissionColumns = [
        { key: "capability", header: "Capability" },
        ...ROLE_OPTIONS.map(({ value, label }) => ({
            key: value,
            header: label,
            render: (row) => row[value]
                ? <span className="admin-permission-yes">Yes</span>
                : <span className="admin-permission-no">No</span>,
        })),
    ];

    return (
        <AdminPage
            title="Roles and permissions"
            subtitle="Roles determine which actions are available. Changes are enforced by the API and recorded in the audit trail."
        >
            <div className="admin-stack">
                <AdminCard title="Change someone's role" description="Choose an account and assign a role supported by MicoPesa.">
                    <form className="admin-form-grid" onSubmit={handleSubmit}>
                        <FormField
                            id="role-person"
                            label="Person"
                            as="select"
                            options={[{ value: "", label: "Choose a person..." }, ...userOptions]}
                            value={selectedUserId}
                            onChange={(event) => {
                                const nextId = event.target.value;
                                setSelectedUserId(nextId);
                                const nextUser = selectableUsers.find((user) => user.user_id === nextId);
                                if (nextUser) setRole(nextUser.role);
                            }}
                            disabled={usersApi.loading || Boolean(usersApi.error) || submitting}
                            required
                        />
                        <FormField
                            id="role-selection"
                            label="New role"
                            as="select"
                            options={ROLE_OPTIONS}
                            value={role}
                            onChange={(event) => setRole(event.target.value)}
                            disabled={submitting}
                        />
                        <div className="admin-span-all admin-card-actions">
                            <Button type="submit" variant="primary" loading={submitting} disabled={!selectedUser || submitting}>
                                Change role
                            </Button>
                            <span className="admin-hint">Your own administrator role cannot be changed here.</span>
                        </div>
                        {usersApi.error && <p className="admin-inline-error admin-span-all" role="alert">{usersApi.error}</p>}
                    </form>
                </AdminCard>

                <AdminCard title="What each role can do">
                    <DataTable
                        columns={permissionColumns}
                        rows={PERMISSIONS}
                        rowKey="capability"
                    />
                </AdminCard>

                <AdminCard title="Current role assignments">
                    <DataTable
                        columns={roleColumns}
                        rows={usersApi.data}
                        rowKey="user_id"
                        loading={usersApi.loading}
                        refreshing={usersApi.refreshing}
                        error={usersApi.error}
                        onRetry={usersApi.refetch}
                    />
                </AdminCard>
            </div>
        </AdminPage>
    );
}

export default RolesPermissions;
