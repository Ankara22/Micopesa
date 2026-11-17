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
            account_status: "ACTIVE",
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

describe("UserManagement deletion confirmation", () => {
    afterEach(cleanup);

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.useAuth.mockReturnValue({ user: { user_id: "ADMIN-USER-123456789012" } });
        mocks.deleteUser.mockResolvedValue({ message: "User deleted permanently" });
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

    it("requires typing DELETE and refreshes the list only after successful deletion", async () => {
        render(<UserManagement />);

        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        expect(screen.getByRole("dialog", { name: "Permanently delete user" })).toHaveTextContent("Test User");
        expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument();

        const confirmButton = screen.getByRole("button", { name: "Delete permanently" });
        expect(confirmButton).toBeDisabled();
        expect(mocks.refetch).not.toHaveBeenCalled();

        fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
        expect(confirmButton).toBeEnabled();
        fireEvent.click(confirmButton);

        await waitFor(() => {
            expect(mocks.deleteUser).toHaveBeenCalledWith("TARGET-USER-123456789012");
            expect(mocks.refetch).toHaveBeenCalledTimes(1);
        });
        expect(mocks.toast.success).toHaveBeenCalledWith("Test User was permanently deleted.");
    });

    it("does not refresh the list after an unsuccessful deletion", async () => {
        mocks.deleteUser.mockRejectedValue(new Error("Deletion blocked"));
        render(<UserManagement />);

        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
        fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

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
        const confirmButton = screen.getByRole("button", { name: "Delete permanently" });
        fireEvent.click(confirmButton);

        await waitFor(() => expect(mocks.deleteUser).toHaveBeenCalledTimes(1));
        expect(confirmButton).toBeDisabled();
        fireEvent.click(confirmButton);
        expect(mocks.deleteUser).toHaveBeenCalledTimes(1);

        resolveDeletion({ message: "User deleted permanently" });
        await waitFor(() => expect(mocks.refetch).toHaveBeenCalledTimes(1));
    });
});
