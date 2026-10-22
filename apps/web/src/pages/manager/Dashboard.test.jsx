import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FundManagerDashboard from "./Dashboard";

const mocks = vi.hoisted(() => ({
    getFundPerformance: vi.fn(),
    getWithdrawalClaims: vi.fn(),
    reviewWithdrawal: vi.fn(),
    listFunds: vi.fn(),
    getFundAllocations: vi.fn(),
    useAuth: vi.fn(),
    toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../../services/fundManagerApi", () => ({
    getFundPerformance: mocks.getFundPerformance,
    getWithdrawalClaims: mocks.getWithdrawalClaims,
    reviewWithdrawal: mocks.reviewWithdrawal,
}));
vi.mock("../../services/fundService", () => ({
    listFunds: mocks.listFunds,
    getFundAllocations: mocks.getFundAllocations,
}));
vi.mock("../../context/AuthContext", () => ({
    useAuth: mocks.useAuth,
}));
vi.mock("../../components/ui/ToastContext", () => ({
    useToast: () => mocks.toast,
}));
vi.mock("./FundManagerCharts", () => ({
    default: ({ funds, allocationEntries }) => (
        <div data-testid="allocation-chart-input">
            {funds.length} funds; {allocationEntries.length} allocation datasets
        </div>
    ),
}));

function renderDashboard() {
    return render(
        <MemoryRouter>
            <FundManagerDashboard />
        </MemoryRouter>,
    );
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
        mocks.getWithdrawalClaims.mockResolvedValue([
            {
                claim_id: "claim-pending",
                full_name: "Worker A",
                amount_requested: "2500.00",
                requested_at: "2026-10-20T10:00:00.000Z",
                claim_status: "PENDING",
            },
            {
                claim_id: "claim-approved",
                full_name: "Worker B",
                amount_requested: "5000.00",
                requested_at: "2026-10-19T10:00:00.000Z",
                claim_status: "APPROVED",
            },
        ]);
        mocks.listFunds.mockResolvedValue([
            {
                fund_id: "fund-1",
                fund_name: "Growth Fund",
                administrator_name: "MicoPesa",
                fund_status: "ACTIVE",
                risk_level: "MEDIUM",
                expected_return: "8.50",
            },
            {
                fund_id: "fund-2",
                fund_name: "Conservative Fund",
                administrator_name: "MicoPesa",
                fund_status: "SUSPENDED",
                risk_level: "LOW",
                expected_return: "6.25",
            },
        ]);
        mocks.getFundAllocations.mockImplementation(async (fundId) => (
            fundId === "fund-1"
                ? [{ percentage: "60", effective_from: "2026-01-01", effective_to: null }]
                : [{ percentage: "40", effective_from: "2026-01-01", effective_to: null }]
        ));
        mocks.reviewWithdrawal.mockResolvedValue({ claim_status: "APPROVED" });
    });

    it("shows the authenticated manager identity while data is loading", () => {
        mocks.getFundPerformance.mockReturnValue(new Promise(() => {}));
        mocks.getWithdrawalClaims.mockReturnValue(new Promise(() => {}));
        mocks.listFunds.mockReturnValue(new Promise(() => {}));
        renderDashboard();

        expect(screen.getByRole("heading", { name: "Welcome, Wanjiku" })).toBeInTheDocument();
        expect(screen.getByRole("status", { name: "Loading fund summary" })).toBeInTheDocument();
    });

    it("renders API-backed account metrics, fund details, allocation data, and pending withdrawal status", async () => {
        renderDashboard();

        expect(await screen.findByText("KSh 825,000.50")).toBeInTheDocument();
        expect(screen.getByText("Active pension accounts").parentElement).toHaveTextContent("84");
        expect(screen.getByText("Managed funds", { selector: ".stat-card-label" }).parentElement)
            .toHaveTextContent("2");
        expect(screen.getByText("Average expected return").parentElement).toHaveTextContent("8.25%");
        expect(screen.getByRole("heading", { name: "Growth Fund" })).toBeInTheDocument();
        expect(screen.getByText("MEDIUM")).toBeInTheDocument();
        expect(screen.getByText("ACTIVE")).toBeInTheDocument();
        expect(screen.getByText("8.50%")).toBeInTheDocument();
        expect(screen.getByText("60.0%")).toBeInTheDocument();
        expect(await screen.findByTestId("allocation-chart-input"))
            .toHaveTextContent("2 funds; 2 allocation datasets");
        expect(screen.getByText("Worker A")).toBeInTheDocument();
        expect(screen.getByText(/KSh 2,500\.00 · Requested/)).toBeInTheDocument();
        expect(screen.getByText("PENDING")).toBeInTheDocument();
        expect(screen.queryByText("Worker B")).not.toBeInTheDocument();
        expect(screen.getByText(/not realized investment performance/i)).toBeInTheDocument();
    });

    it("shows explicit empty states for funds, allocations, and pending reviews", async () => {
        mocks.listFunds.mockResolvedValue([]);
        mocks.getWithdrawalClaims.mockResolvedValue([{ claim_status: "APPROVED" }]);
        renderDashboard();

        expect(await screen.findByText("No managed funds are available.")).toBeInTheDocument();
        expect(screen.getByText("There are no pending withdrawal requests.")).toBeInTheDocument();
        expect(await screen.findByTestId("allocation-chart-input"))
            .toHaveTextContent("0 funds; 0 allocation datasets");
    });

    it("surfaces each API failure instead of presenting it as a zero value or empty response", async () => {
        mocks.getFundPerformance.mockRejectedValue(new Error("Performance data unavailable"));
        mocks.getWithdrawalClaims.mockRejectedValue(new Error("Withdrawal queue unavailable"));
        mocks.listFunds.mockRejectedValue(new Error("Managed funds unavailable"));
        renderDashboard();

        expect(await screen.findByText("Performance data unavailable")).toBeInTheDocument();
        expect(screen.getByText("Withdrawal queue unavailable")).toBeInTheDocument();
        expect(screen.getAllByText("Managed funds unavailable")).toHaveLength(2);
    });

    it("links to the existing fund manager pages", async () => {
        renderDashboard();

        expect(await screen.findByRole("link", { name: /Funds/ })).toHaveAttribute("href", "/manager/funds");
        expect(screen.getByRole("link", { name: /Withdrawal Requests/ })).toHaveAttribute("href", "/manager/withdrawal-requests");
        expect(screen.getByRole("link", { name: /Operational Reports/ })).toHaveAttribute("href", "/manager/reports");
        expect(screen.getByRole("link", { name: /Audit Logs/ })).toHaveAttribute("href", "/manager/audit-logs");
    });

    it("preserves claim review actions without representing approval as payout success", async () => {
        renderDashboard();
        fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
        expect(screen.getByText(/does not pay the claim/i)).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

        await waitFor(() => expect(mocks.reviewWithdrawal).toHaveBeenCalledWith("claim-pending", "APPROVED"));
        expect(screen.queryByText(/paid|payout completed|payment successful/i)).not.toBeInTheDocument();
    });

    it("does not display unsupported investment, compliance, or payout metrics", async () => {
        renderDashboard();

        expect(await screen.findByText("KSh 825,000.50")).toBeInTheDocument();
        expect(screen.queryByText(/investment gain|loss percentage|liquidity reserve|compliance rate|benchmark|payout total|historical yield/i)).not.toBeInTheDocument();
    });
});
