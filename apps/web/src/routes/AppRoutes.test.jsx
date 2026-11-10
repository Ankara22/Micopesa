import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppRoutes from "./AppRoutes";

const mocks = vi.hoisted(() => ({
    useAuth: vi.fn(),
    listAvailableFunds: vi.fn(),
    getMyAllocations: vi.fn(),
    replaceMyAllocations: vi.fn(),
    listFunds: vi.fn(),
    getFundAllocations: vi.fn(),
    getMyContributions: vi.fn(),
    getMyBalance: vi.fn(),
    downloadMyStatement: vi.fn(),
    getReportFunds: vi.fn(),
    getActivitySummary: vi.fn(),
    listPendingKycApplications: vi.fn(),
    reviewKycApplication: vi.fn(),
    toast: { success: vi.fn(), error: vi.fn() },
    getMyProfile: vi.fn(),
    getMyProfilePhoto: vi.fn(),
    syncProfile: vi.fn(),
}));

vi.mock("../context/AuthContext", () => ({ useAuth: mocks.useAuth }));
vi.mock("../services/fundService", () => ({
    listAvailableFunds: mocks.listAvailableFunds,
    getMyAllocations: mocks.getMyAllocations,
    replaceMyAllocations: mocks.replaceMyAllocations,
    listFunds: mocks.listFunds,
    getFundAllocations: mocks.getFundAllocations,
}));
vi.mock("../services/accountService", () => ({
    getMyContributions: mocks.getMyContributions,
    getMyBalance: mocks.getMyBalance,
    downloadMyStatement: mocks.downloadMyStatement,
}));
vi.mock("../services/reportsApi", () => ({
    getReportFunds: mocks.getReportFunds,
}));
vi.mock("../services/adminService", () => ({
    getActivitySummary: mocks.getActivitySummary,
    listPendingKycApplications: mocks.listPendingKycApplications,
    reviewKycApplication: mocks.reviewKycApplication,
}));
vi.mock("../components/ui/ToastContext", () => ({ useToast: () => mocks.toast }));
vi.mock("../services/profileApi", () => ({
    getMyProfile: mocks.getMyProfile,
    getMyProfilePhoto: mocks.getMyProfilePhoto,
}));

function renderRoute(path, role) {
    mocks.useAuth.mockReturnValue({
        isAuthenticated: true,
        isLoading: false,
        loginSessionId: "session-1",
        user: { user_id: "test-user", role, full_name: "Test User" },
        logout: vi.fn(),
        beginProfileRequest: () => ({ userId: "test-user", generation: 1 }),
        isProfileRequestCurrent: () => true,
        syncProfile: mocks.syncProfile,
    });
    return render(<MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>);
}

describe("role feature routes", () => {
    afterEach(cleanup);

    it("renders the dedicated worker funds page under worker access", async () => {
        mocks.listAvailableFunds.mockResolvedValue([]);
        mocks.getMyAllocations.mockResolvedValue([]);
        renderRoute("/worker/funds", "WORKER");

        expect(await screen.findByRole("heading", { name: "My Funds & Allocation" })).toBeInTheDocument();
        expect(screen.getByText("No active funds are available for a new allocation distribution.")).toBeInTheDocument();
    });

    it("renders manager analytics on its dedicated manager route", async () => {
        mocks.listFunds.mockResolvedValue([]);
        renderRoute("/manager/analytics", "FUND_MANAGER");

        expect(await screen.findByRole("heading", { name: "Fund Analytics" })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Manage funds" })).toHaveAttribute("href", "/manager/funds");
    });

    it.each([
        ["/worker/analytics", "WORKER", "My Analytics", mocks.getMyContributions],
        ["/regulator/analytics", "REGULATOR", "Regulator Analytics", mocks.getReportFunds],
        ["/admin/analytics", "ADMIN", "Administrator Analytics", mocks.getActivitySummary],
    ])("renders %s as a dedicated role analytics route", async (path, role, heading, fetcher) => {
        fetcher.mockResolvedValue([]);
        mocks.getMyBalance.mockResolvedValue({ current_balance: "0.00" });
        mocks.downloadMyStatement.mockResolvedValue({ data: new Blob() });
        renderRoute(path, role);

        expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    });

    it("continues to reject cross-role direct access to manager analytics", async () => {
        renderRoute("/manager/analytics", "WORKER");
        expect(await screen.findByRole("heading", { name: "Access denied" })).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "Fund Analytics" })).not.toBeInTheDocument();
    });

    it.each(["WORKER", "FUND_MANAGER", "ADMIN"])(
        "denies %s direct access to regulator fund oversight",
        async (role) => {
            renderRoute("/regulator/funds", role);
            expect(await screen.findByRole("heading", { name: "Access denied" })).toBeInTheDocument();
            expect(screen.queryByRole("heading", { name: "Fund Oversight" })).not.toBeInTheDocument();
        }
    );

    it("allows administrators into KYC review and denies workers direct access", async () => {
        mocks.listPendingKycApplications.mockResolvedValue([]);
        const admin = renderRoute("/admin/kyc-review", "ADMIN");
        expect(await screen.findByRole("heading", { name: "KYC review" })).toBeInTheDocument();
        admin.unmount();

        renderRoute("/admin/kyc-review", "WORKER");
        expect(await screen.findByRole("heading", { name: "Access denied" })).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "KYC review" })).not.toBeInTheDocument();
    });

    it.each([
        ["/worker/profile", "WORKER"],
        ["/manager/profile", "FUND_MANAGER"],
        ["/regulator/profile", "REGULATOR"],
        ["/admin/profile", "ADMIN"],
    ])("%s exposes the shared verified phone-change experience", async (path, role) => {
        mocks.syncProfile.mockReturnValue(true);
        mocks.getMyProfile.mockResolvedValue({
            user_id: "test-user",
            full_name: "Test User",
            email: "test@example.com",
            phone: "+254700000001",
            role,
            account_status: "ACTIVE",
            created_at: "2025-01-01T00:00:00.000Z",
            profile_photo_available: false,
        });
        mocks.getMyProfilePhoto.mockRejectedValue({ status: 404 });
        renderRoute(path, role);

        expect(await screen.findByRole("heading", { name: "Test User" })).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Change registered phone" })).toBeInTheDocument();
        expect(screen.getByText("+254700000001")).toBeInTheDocument();
    });
});
