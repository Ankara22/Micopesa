import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UserManagement from "./UserManagement";

const mocks = vi.hoisted(() => ({
    createStaffAccount: vi.fn(),
    deleteUser: vi.fn(),
    listUsers: vi.fn(),
    resendStaffOnboarding: vi.fn(),
    refetch: vi.fn(),
    setData: vi.fn(),
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
    updateUserStatus: vi.fn(),
    useAuth: vi.fn(),
    targetIsDeleted: false,
    userStatus: "ACTIVE",
}));

vi.mock("../../services/adminService", () => ({
    createStaffAccount: mocks.createStaffAccount,
    deleteUser: mocks.deleteUser,
    listUsers: mocks.listUsers,
    resendStaffOnboarding: mocks.resendStaffOnboarding,
    updateUserStatus: mocks.updateUserStatus,
}));
vi.mock("../../context/AuthContext", () => ({ useAuth: mocks.useAuth }));
vi.mock("../../components/ui/ToastContext", () => ({ useToast: () => mocks.toast }));
vi.mock("../../hooks/useApi", () => ({
    default: () => ({
        data: [{
                user_id: "TARGET-USER-123456789012",
                full_name: "Test User",
                phone: "07000000002",
                role: "WORKER",
                account_status: mocks.userStatus,
                is_deleted: mocks.targetIsDeleted,
                email_verified: false,
                phone_verified_at: null,
            }],
        error: null,
        loading: false,
        refreshing: false,
        refetch: mocks.refetch,
        setData: mocks.setData,
    }),
}));

describe("UserManagement account actions", () => {
    afterEach(cleanup);

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.userStatus = "ACTIVE";
        mocks.targetIsDeleted = false;
        mocks.useAuth.mockReturnValue({ user: { user_id: "ADMIN-USER-123456789012" } });
        mocks.deleteUser.mockResolvedValue({
            message: "Historical records are protected. The account was anonymized.",
        });
        mocks.updateUserStatus.mockResolvedValue({
            user_id: "TARGET-USER-123456789012",
            full_name: "Test User",
            account_status: "SUSPENDED",
        });
        mocks.createStaffAccount.mockResolvedValue({
            status: "success",
            message: "Messages accepted; the account remains inactive until email verification.",
            data: {
                sms_accepted: true,
                verification_email_accepted: true,
                account_active: false,
            },
        });
        mocks.refetch.mockResolvedValue([]);
    });

    it("shows staff email and phone verification status and reports pending email verification", async () => {
        render(<UserManagement />);

        expect(screen.getByText("Email pending; phone pending")).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "New Staff" } });
        fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "+254 712 345 678" } });
        fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "staff@example.test" } });
        fireEvent.click(screen.getByRole("button", { name: "Regulator" }));
        fireEvent.click(screen.getByRole("button", { name: "Create account" }));

        await waitFor(() => {
            expect(mocks.createStaffAccount).toHaveBeenCalledWith({
                full_name: "New Staff",
                phone: "+254 712 345 678",
                email: "staff@example.test",
                role: "REGULATOR",
            });
            expect(mocks.refetch).toHaveBeenCalledOnce();
        });
        expect(mocks.toast.info).toHaveBeenCalledWith(
            "Messages accepted; the account remains inactive until email verification.",
        );
    });

    it("does not report staff onboarding as complete when email dispatch failed", async () => {
        mocks.createStaffAccount.mockResolvedValueOnce({
            status: "success",
            message: "SMS was accepted, but the verification email was not accepted.",
            data: {
                sms_accepted: true,
                verification_email_accepted: false,
                account_active: false,
            },
        });
        render(<UserManagement />);
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "New Staff" } });
        fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "+254 712 345 678" } });
        fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "staff@example.test" } });
        fireEvent.click(screen.getByRole("button", { name: "Create account" }));

        await waitFor(() => {
            expect(mocks.toast.error).toHaveBeenCalledWith(
                "SMS was accepted, but the verification email was not accepted.",
            );
        });
        expect(mocks.toast.success).not.toHaveBeenCalled();
        expect(mocks.toast.info).not.toHaveBeenCalled();
    });

    it("keeps one status toggle and one Delete action", async () => {
        render(<UserManagement />);

        expect(screen.getByRole("button", { name: "Suspend" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(1);
        expect(screen.queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Reactivate" })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Suspend" }));

        await waitFor(() => {
            expect(mocks.updateUserStatus).toHaveBeenCalledWith(
                "TARGET-USER-123456789012",
                "SUSPENDED",
            );
        });
    });

    it("uses a single Activate action for a non-active account", async () => {
        mocks.userStatus = "SUSPENDED";
        mocks.updateUserStatus.mockResolvedValueOnce({
            user_id: "TARGET-USER-123456789012",
            full_name: "Test User",
            account_status: "ACTIVE",
        });
        render(<UserManagement />);

        expect(screen.getByRole("button", { name: "Activate" })).toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(1);
        expect(screen.queryByRole("button", { name: "Reactivate" })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Activate" }));

        await waitFor(() => {
            expect(mocks.updateUserStatus).toHaveBeenCalledWith(
                "TARGET-USER-123456789012",
                "ACTIVE",
            );
        });
    });

    it("keeps anonymized historical accounts visible but prevents reactivation or deletion", () => {
        mocks.targetIsDeleted = true;
        mocks.userStatus = "SUSPENDED";
        render(<UserManagement />);

        expect(screen.getByText("DELETED")).toBeInTheDocument();
        expect(screen.getByText("History retained")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Activate" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    });

    it("does not show worker applications or account approval controls", () => {
        render(<UserManagement />);

        expect(screen.queryByText("Worker applications")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Approve application" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Reject application" })).not.toBeInTheDocument();
    });

    it("requires typing DELETE and refreshes after account deletion", async () => {
        render(<UserManagement />);

        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        expect(screen.getByRole("dialog", { name: "Delete user account" })).toHaveTextContent("Test User");
        expect(screen.getByText(/accounts without protected history are permanently deleted/i)).toBeInTheDocument();
        expect(screen.getByText(/a later signup creates a separate account with no inherited financial or KYC records/i)).toBeInTheDocument();

        const confirmButton = screen.getByRole("button", { name: "Delete account" });
        expect(confirmButton).toBeDisabled();
        expect(mocks.refetch).not.toHaveBeenCalled();

        fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
        expect(confirmButton).toBeEnabled();
        fireEvent.click(confirmButton);

        await waitFor(() => {
            expect(mocks.deleteUser).toHaveBeenCalledWith("TARGET-USER-123456789012");
            expect(mocks.refetch).toHaveBeenCalledTimes(1);
        });
        expect(mocks.toast.success).toHaveBeenCalledWith(
            "Historical records are protected. The account was anonymized."
        );
    });

    it("does not refresh the list after deletion fails", async () => {
        mocks.deleteUser.mockRejectedValue(new Error("Deletion blocked"));
        render(<UserManagement />);

        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
        fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

        await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("Deletion blocked"));
        expect(mocks.refetch).not.toHaveBeenCalled();
    });

    it("prevents repeated submissions while deletion is pending", async () => {
        let resolveDeletion;
        mocks.deleteUser.mockReturnValueOnce(new Promise((resolve) => {
            resolveDeletion = resolve;
        }));
        render(<UserManagement />);

        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
        const confirmButton = screen.getByRole("button", { name: "Delete account" });
        fireEvent.click(confirmButton);

        await waitFor(() => expect(mocks.deleteUser).toHaveBeenCalledTimes(1));
        expect(confirmButton).toBeDisabled();
        fireEvent.click(confirmButton);
        expect(mocks.deleteUser).toHaveBeenCalledTimes(1);

        resolveDeletion({ message: "Account deleted." });
        await waitFor(() => expect(mocks.refetch).toHaveBeenCalledTimes(1));
    });
});
