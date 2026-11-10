import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import WorkerDashboard from "./Dashboard";

const mocks = vi.hoisted(() => ({
    getMyBalance: vi.fn(),
    getMyContributions: vi.fn(),
    getRetirementPlan: vi.fn(),
    useAuth: vi.fn(),
}));

vi.mock("../../services/accountService", () => ({
    getMyBalance: mocks.getMyBalance,
    getMyContributions: mocks.getMyContributions,
}));
vi.mock("../../services/retirementApi", () => ({
    getRetirementPlan: mocks.getRetirementPlan,
}));
vi.mock("../../context/AuthContext", () => ({ useAuth: mocks.useAuth }));

function renderDashboard() {
    return render(<MemoryRouter><WorkerDashboard /></MemoryRouter>);
}

describe("WorkerDashboard", () => {
    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.useAuth.mockReturnValue({
            user: { full_name: "Amina Worker", user_id: "worker-1" },
            loginSessionId: "login-1",
        });
        mocks.getMyBalance.mockResolvedValue({ current_balance: "14850.00", account_status: "ACTIVE" });
        mocks.getMyContributions.mockResolvedValue([
            { contribution_id: "c1", amount: "2500.00", contribution_status: "COMPLETED" },
            { contribution_id: "c2", amount: "900.00", contribution_status: "PENDING" },
        ]);
        mocks.getRetirementPlan.mockResolvedValue({
            plan: { target_amount: "500000.00", target_age: 60, plan_status: "ACTIVE" },
            projection: { projected_amount: "420000.00" },
        });
    });

    it("shows concise summaries from existing account APIs and links to dedicated features", async () => {
        renderDashboard();

        expect(await screen.findByRole("heading", { name: /Good .*Amina/ })).toBeInTheDocument();
        expect(screen.getByText("KSh 14,850.00")).toBeInTheDocument();
        expect(screen.getByText("Completed contribution records").parentElement)
            .toHaveTextContent("1");
        expect(screen.getByText("Recorded total KSh 2,500.00")).toBeInTheDocument();
        expect(screen.getByText("Goal KSh 500,000.00")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /My Funds & Allocation/ })).toHaveAttribute("href", "/worker/funds");
        expect(screen.getByRole("link", { name: /My Analytics/ })).toHaveAttribute("href", "/worker/analytics");
        expect(screen.getByRole("link", { name: /Financial Literacy/ })).toHaveAttribute("href", "/worker/literacy");
        expect(screen.queryByRole("heading", { name: "My Fund Allocation" })).not.toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "Insights for your next step" })).not.toBeInTheDocument();
        expect(screen.queryByText("Retirement plan form")).not.toBeInTheDocument();
        expect(mocks.getMyBalance).toHaveBeenCalledTimes(1);
        expect(mocks.getMyContributions).toHaveBeenCalledTimes(1);
    });

    it("shows useful no-record summaries without inventing account data", async () => {
        mocks.getRetirementPlan.mockRejectedValue({ status: 404, message: "No plan" });
        mocks.getMyContributions.mockResolvedValue([]);
        renderDashboard();

        expect(await screen.findByText("Not set")).toBeInTheDocument();
        expect(screen.getByText("Recorded total KSh 0.00")).toBeInTheDocument();
        expect(screen.queryByText(/insights for your next step/i)).not.toBeInTheDocument();
    });

    it("surfaces API errors with recovery actions", async () => {
        mocks.getMyBalance.mockRejectedValue(new Error("Balance service unavailable"));
        renderDashboard();

        expect(await screen.findByText("Unable to load this information right now. Please try again.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    });

    it("renders worker dashboard labels in Kiswahili", async () => {
        await i18n.changeLanguage("sw");
        renderDashboard();

        expect(await screen.findByText("Salio la sasa la pensheni")).toBeInTheDocument();
        expect(screen.getByText("Rekodi za michango iliyokamilika")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /Hazina Zangu na Mgao/ })).toHaveAttribute("href", "/worker/funds");
    });
});
