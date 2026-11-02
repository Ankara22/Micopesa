import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FundAnalytics from "./Analytics";

const mocks = vi.hoisted(() => ({
    getFundAllocations: vi.fn(),
    listFunds: vi.fn(),
}));

vi.mock("../../services/fundService", () => ({
    getFundAllocations: mocks.getFundAllocations,
    listFunds: mocks.listFunds,
}));
vi.mock("./FundManagerCharts", () => ({
    default: ({ funds, allocationEntries }) => (
        <div data-testid="fund-manager-charts">
            {funds.length} funds, {allocationEntries.length} allocation histories
        </div>
    ),
}));

function renderPage() {
    return render(<MemoryRouter><FundAnalytics /></MemoryRouter>);
}

describe("FundAnalytics", () => {
    afterEach(cleanup);

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.listFunds.mockResolvedValue([{ fund_id: "fund-1", fund_name: "Growth" }]);
        mocks.getFundAllocations.mockResolvedValue([
            { percentage: "100.00", effective_from: "2026-01-01", effective_to: null },
        ]);
    });

    it("loads real fund allocation records into the existing chart component", async () => {
        renderPage();

        expect(await screen.findByTestId("fund-manager-charts")).toHaveTextContent("1 funds, 1 allocation histories");
        expect(screen.getByRole("heading", { name: "Fund Analytics" })).toBeInTheDocument();
        expect(mocks.listFunds).toHaveBeenCalledOnce();
        expect(mocks.getFundAllocations).toHaveBeenCalledWith("fund-1");
        expect(screen.getByRole("link", { name: "Manage funds" })).toHaveAttribute("href", "/manager/funds");
    });

    it("shows a loading skeleton before chart data arrives", () => {
        mocks.listFunds.mockReturnValue(new Promise(() => {}));
        renderPage();
        expect(screen.getByRole("status", { name: "Loading fund analytics" })).toBeInTheDocument();
        expect(screen.queryByTestId("fund-manager-charts")).not.toBeInTheDocument();
    });

    it("surfaces API failures and retries loading chart data", async () => {
        mocks.listFunds
            .mockRejectedValueOnce(new Error("Fund analytics unavailable"))
            .mockResolvedValueOnce([{ fund_id: "fund-1", fund_name: "Growth" }]);
        renderPage();

        const alert = (await screen.findByText("Fund analytics unavailable")).closest('[role="alert"]');
        fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
        expect(await screen.findByTestId("fund-manager-charts")).toHaveTextContent("1 funds, 1 allocation histories");
        expect(mocks.listFunds).toHaveBeenCalledTimes(2);
    });

    it("passes empty successful data to the existing charts for their meaningful empty states", async () => {
        mocks.listFunds.mockResolvedValue([]);
        renderPage();
        expect(await screen.findByTestId("fund-manager-charts")).toHaveTextContent("0 funds, 0 allocation histories");
    });
});
