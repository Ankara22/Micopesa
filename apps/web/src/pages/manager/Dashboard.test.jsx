import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FundManagerDashboard from "./Dashboard";

const mocks = vi.hoisted(() => ({
    getFundPerformance: vi.fn(),
    useAuth: vi.fn(),
}));

vi.mock("../../services/fundManagerApi", () => ({ getFundPerformance: mocks.getFundPerformance }));
vi.mock("../../context/AuthContext", () => ({ useAuth: mocks.useAuth }));

function renderDashboard() {
    return render(<MemoryRouter><FundManagerDashboard /></MemoryRouter>);
}

describe("FundManagerDashboard", () => {
    afterEach(cleanup);

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.useAuth.mockReturnValue({ user: { full_name: "Wanjiku Manager" } });
        mocks.getFundPerformance.mockResolvedValue({
            total_assets: "825000.50",
            active_accounts: 84,
            funds_managed: 2,
            average_yield: "8.25",
        });
    });

    it("shows factual performance summaries and shortcuts rather than feature interfaces", async () => {
        renderDashboard();

        expect(await screen.findByRole("heading", { name: "Welcome, Wanjiku" })).toBeInTheDocument();
        expect(screen.getByText("KSh 825,000.50")).toBeInTheDocument();
        expect(screen.getByText("Active pension accounts").parentElement).toHaveTextContent("84");
        expect(screen.getByRole("link", { name: /Manage Funds/ })).toHaveAttribute("href", "/manager/funds");
        expect(screen.getByRole("link", { name: /Fund Analytics/ })).toHaveAttribute("href", "/manager/analytics");
        expect(screen.getByRole("link", { name: /Withdrawal Requests/ })).toHaveAttribute("href", "/manager/withdrawal-requests");
        expect(screen.getByRole("link", { name: /Reports/ })).toHaveAttribute("href", "/manager/reports");
        expect(screen.getByRole("link", { name: /Audit Logs/ })).toHaveAttribute("href", "/manager/audit-logs");
        expect(screen.queryByRole("heading", { name: "Fund Allocation History" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    });

    it("shows loading and retryable API error states", async () => {
        mocks.getFundPerformance.mockRejectedValue(new Error("Performance unavailable"));
        renderDashboard();

        expect(await screen.findByText("Performance unavailable")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    });
});
