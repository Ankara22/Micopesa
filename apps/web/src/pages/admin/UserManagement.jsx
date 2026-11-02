import { useRef, useState } from "react";
import useApi from "../../hooks/useApi";
import {
    createStaffAccount,
    deleteUser,
    listUsers,
    resendStaffOnboarding,
    updateUserStatus,
} from "../../services/adminService";
import DataTable from "../../components/ui/DataTable";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import FormField from "../../components/ui/FormField";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../components/ui/ToastContext";
import { AdminCard, AdminPage } from "../../components/AdminPage";

const STAFF_ROLES = [
    { value: "FUND_MANAGER", label: "Fund Manager" },
    { value: "REGULATOR", label: "Regulator" },
    { value: "ADMIN", label: "Administrator" },
];

function UserManagement() {
    const { user: currentUser } = useAuth();
    const toast = useToast();
    const usersApi = useApi(listUsers, []);
    const [staffForm, setStaffForm] = useState({
        full_name: "",
        phone: "",
        role: "FUND_MANAGER",
    });
    const [staffSubmitting, setStaffSubmitting] = useState(false);
    const staffSubmissionRef = useRef(false);
    const [statusSubmittingId, setStatusSubmittingId] = useState(null);
    const [resendingId, setResendingId] = useState(null);
    const [deletingUser, setDeletingUser] = useState(null);
    const [deleteConfirmation, setDeleteConfirmation] = useState("");
    const [deleteSubmitting, setDeleteSubmitting] = useState(false);
    const deletionInProgressRef = useRef(false);

    async function handleStaffSubmit(e) {
        e.preventDefault();
        if (staffSubmissionRef.current) return;
        staffSubmissionRef.current = true;
        setStaffSubmitting(true);
        try {
            const result = await createStaffAccount(staffForm);
            if (result.data.sms_accepted) {
                toast.success(result.message);
            } else {
                toast.error(result.message);
            }
            setStaffForm({ full_name: "", phone: "", role: "FUND_MANAGER" });
            await usersApi.refetch();
        } catch (err) {
            toast.error(err.message || "Failed to create staff account.");
        } finally {
            staffSubmissionRef.current = false;
            setStaffSubmitting(false);
        }
    }

    async function handleStatusToggle(user) {
        if (statusSubmittingId) return;
        setStatusSubmittingId(user.user_id);
        const account_status = user.account_status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
        try {
            const updatedUser = await updateUserStatus(user.user_id, account_status);
            usersApi.setData((users) =>
                (users || []).map((item) => item.user_id === updatedUser.user_id ? updatedUser : item)
            );
            toast.success(`${updatedUser.full_name}'s account is ${updatedUser.account_status.toLowerCase()}.`);
        } catch (error) {
            toast.error(error.message || "Failed to update user status.");
        } finally {
            setStatusSubmittingId(null);
        }
    }

    async function handleResendOnboarding(user) {
        if (resendingId) return;
        setResendingId(user.user_id);
        try {
            const result = await resendStaffOnboarding(user.user_id);
            toast.success(result.message);
            await usersApi.refetch();
        } catch (error) {
            toast.error(error.message || "Unable to resend the onboarding SMS.");
        } finally {
            setResendingId(null);
        }
    }

    function openDeleteModal(user) {
        setDeletingUser(user);
        setDeleteConfirmation("");
    }

    async function handleDeleteSubmit(event) {
        event.preventDefault();
        if (
            deletionInProgressRef.current ||
            deleteConfirmation !== "DELETE" ||
            !deletingUser
        ) return;
        deletionInProgressRef.current = true;
        setDeleteSubmitting(true);
        try {
            await deleteUser(deletingUser.user_id);
            const deletedName = deletingUser.full_name;
            setDeletingUser(null);
            setDeleteConfirmation("");
            toast.success(`${deletedName} was permanently deleted.`);
            const refreshedUsers = await usersApi.refetch();
            if (!refreshedUsers) {
                toast.error("The user was deleted, but the list could not be refreshed.");
            }
        } catch (error) {
            toast.error(error.message || "Failed to delete this user.");
        } finally {
            deletionInProgressRef.current = false;
            setDeleteSubmitting(false);
        }
    }

    const columns = [
        { key: "full_name", header: "Name" },
        { key: "phone", header: "Phone" },
        { key: "role", header: "Role" },
        {
            key: "account_status",
            header: "Status",
            render: (row) => <span className="admin-status-pill" data-status={row.account_status}>{row.account_status}</span>,
        },
        {
            key: "actions",
            header: "Action",
            render: (row) => (
                <div className="table-actions">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleStatusToggle(row)}
                        disabled={row.user_id === currentUser?.user_id || statusSubmittingId === row.user_id || Boolean(statusSubmittingId)}
                        loading={statusSubmittingId === row.user_id}
                    >
                        {row.account_status === "ACTIVE" ? "Suspend" : "Activate"}
                    </Button>
                    {row.force_password_change && (
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleResendOnboarding(row)}
                            disabled={Boolean(resendingId)}
                            loading={resendingId === row.user_id}
                        >
                            Retry invite
                        </Button>
                    )}
                    <Button
                        variant="danger"
                        size="sm"
                        onClick={() => openDeleteModal(row)}
                        disabled={row.user_id === currentUser?.user_id}
                    >
                        Delete
                    </Button>
                </div>
            ),
        },
    ];

    return (
        <AdminPage
            title="User management"
            subtitle="Create staff accounts, review account access, and manage onboarding."
        >
            <div className="admin-stack">
                <AdminCard
                    title="Create a staff account"
                    description="A temporary password is sent through the configured SMS gateway. The staff member must change it at first sign-in."
                >
                    <form className="admin-form-grid" onSubmit={handleStaffSubmit}>
                        <FormField
                            id="staff-full-name"
                            label="Full name"
                            value={staffForm.full_name}
                            onChange={(event) => setStaffForm((form) => ({ ...form, full_name: event.target.value }))}
                            disabled={staffSubmitting}
                            autoComplete="name"
                            required
                        />
                        <FormField
                            id="staff-phone"
                            label="Phone number"
                            type="tel"
                            placeholder="+254 700 000 000"
                            value={staffForm.phone}
                            onChange={(event) => setStaffForm((form) => ({ ...form, phone: event.target.value }))}
                            disabled={staffSubmitting}
                            autoComplete="tel"
                            required
                        />
                        <div className="admin-span-all">
                            <span className="admin-field-label">Staff role</span>
                            <div className="admin-role-pills" role="group" aria-label="Staff role">
                                {STAFF_ROLES.map((option) => (
                                    <button
                                        className="admin-role-pill"
                                        type="button"
                                        key={option.value}
                                        aria-pressed={staffForm.role === option.value}
                                        disabled={staffSubmitting}
                                        onClick={() => setStaffForm((form) => ({ ...form, role: option.value }))}
                                    >
                                        {option.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="admin-span-all">
                            <Button type="submit" variant="primary" loading={staffSubmitting}>
                                Create account
                            </Button>
                        </div>
                    </form>
                </AdminCard>

                <AdminCard title="All accounts" description="Suspend or reactivate access, retry pending staff invitations, or permanently remove an account.">
                    <DataTable
                        columns={columns}
                        rows={usersApi.data}
                        rowKey="user_id"
                        loading={usersApi.loading}
                        refreshing={usersApi.refreshing}
                        error={usersApi.error}
                        onRetry={usersApi.refetch}
                    />
                </AdminCard>
            </div>

            <Modal
                open={Boolean(deletingUser)}
                title="Permanently delete user"
                onClose={() => {
                    if (!deleteSubmitting) {
                        setDeletingUser(null);
                        setDeleteConfirmation("");
                    }
                }}
            >
                {deletingUser && (
                    <form className="form-grid" onSubmit={handleDeleteSubmit}>
                        <div>
                            <p>
                                You are about to permanently delete <strong>{deletingUser.full_name}</strong>
                                {" "}({deletingUser.user_id}).
                            </p>
                            <p role="alert">
                                This cannot be undone. The user account and associated personal records will be removed.
                            </p>
                        </div>
                        <FormField
                            id="delete-confirmation"
                            label='Type DELETE to confirm'
                            value={deleteConfirmation}
                            onChange={(event) => setDeleteConfirmation(event.target.value)}
                            disabled={deleteSubmitting}
                            autoComplete="off"
                        />
                        <div className="form-actions">
                            <Button
                                type="button"
                                variant="secondary"
                                disabled={deleteSubmitting}
                                onClick={() => {
                                    setDeletingUser(null);
                                    setDeleteConfirmation("");
                                }}
                            >
                                Cancel
                            </Button>
                            <Button
                                type="submit"
                                variant="danger"
                                loading={deleteSubmitting}
                                disabled={deleteSubmitting || deleteConfirmation !== "DELETE"}
                            >
                                Delete permanently
                            </Button>
                        </div>
                    </form>
                )}
            </Modal>
        </AdminPage>
    );
}

export default UserManagement;
