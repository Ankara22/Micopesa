import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SystemSettings from "./SystemSettings";

const mocks = vi.hoisted(() => ({
    updateOperationalSettings: vi.fn(),
    toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("../../services/adminService", () => ({
    getOperationalSettings: vi.fn(),
    updateOperationalSettings: mocks.updateOperationalSettings,
}));
vi.mock("../../hooks/useApi", () => ({
    default: () => ({
        data: {
            assumed_yearly_growth: 8,
            max_failed_login_attempts: 5,
            account_lockout_duration_minutes: 15,
            require_otp_on_withdrawal: true,
        },
        loading: false,
        refreshing: false,
        error: null,
        refetch: vi.fn(),
    }),
}));
vi.mock("../../components/ui/ToastContext", () => ({ useToast: () => mocks.toast }));

describe("SystemSettings", () => {
    afterEach(cleanup);

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.updateOperationalSettings.mockImplementation(async (settings) => settings);
    });

    it("saves the validated operational setting values", async () => {
        render(<SystemSettings />);
        fireEvent.change(screen.getByLabelText("Assumed yearly growth percentage"), {
            target: { value: "9.5" },
        });
        fireEvent.change(screen.getByLabelText("Account lockout threshold after wrong passwords"), {
            target: { value: "7" },
        });
        fireEvent.click(screen.getByRole("checkbox", { name: /Ask for a one-time code on every withdrawal/ }));
        fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

        await waitFor(() => {
            expect(mocks.updateOperationalSettings).toHaveBeenCalledWith({
                assumed_yearly_growth: 9.5,
                max_failed_login_attempts: 7,
                account_lockout_duration_minutes: 15,
                require_otp_on_withdrawal: false,
            });
        });
        expect(mocks.toast.success).toHaveBeenCalled();
        expect(screen.getByText(/M-Pesa payout dispatch is currently disabled/)).toBeInTheDocument();
    });
});
