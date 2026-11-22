import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FundAnalytics from "./Analytics";

const mocks = vi.hoisted(() => ({
    getReportAnalytics: vi.fn(),
}));

vi.mock("../../services/reportsApi", () => ({
    getReportAnalytics: mocks.getReportAnalytics,
}));
vi.mock("../analytics/AnalyticsCharts", () => ({
    FundManagerAnalyticsCharts: ({ trends, performance }) => (
        <div data-testid="fund-manager-charts">
            {trends.length} contribution trends; {performance.length} funds
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
        mocks.getReportAnalytics.mockReset();
        mocks.getReportAnalytics.mockResolvedValue({
            contribution_trends: [
                { period: "2026-09-30T21:00:00.000Z", status: "PENDING", contribution_count: 1, allocated_amount: "0.00" },
                { period: "2026-10-31T21:00:00.000Z", status: "COMPLETED", contribution_count: 3, allocated_amount: "4700.70" },
            ],
            fund_summary: { managed_funds: 3, allocated_workers: 4 },
            fund_performance: [
                {
                    fund_id: "fund-1",
                    fund_name: "MICOPESSA",
                    risk_level: "MEDIUM",
                    expected_return: "7.52",
                    settled_contributions: "2200.70",
                    settled_contribution_count: 3,
                },
                {
                    fund_id: "fund-2",
                    fund_name: "MICOPESSA09",
                    risk_level: "MEDIUM",
                    expected_return: "6.00",
                    settled_contributions: "2000.00",
                    settled_contribution_count: 1,
                },
                {
                    fund_id: "fund-3",
                    fund_name: "POI Fund",
                    risk_level: "LOW",
                    expected_return: "7.00",
                    settled_contributions: "500.00",
                    settled_contribution_count: 1,
                },
            ],
        });
    });

    it("loads scoped contribution aggregates into the analytics charts", async () => {
        renderPage();

        expect(await screen.findByTestId("fund-manager-charts")).toHaveTextContent("2 contribution trends; 3 funds");
        expect(screen.getByRole("heading", { name: "Fund Analytics" })).toBeInTheDocument();
        expect(screen.getByText("Managed funds").parentElement).toHaveTextContent("3");
        expect(screen.getByText("Workers with an active fund allocation").parentElement).toHaveTextContent("4");
        expect(screen.getByText("Verified settled contributions").parentElement)
            .toHaveTextContent("KSh 4,700.70");
        expect(mocks.getReportAnalytics).toHaveBeenCalledWith({ start_date: "", end_date: "" });
        expect(screen.getByRole("link", { name: "Manage funds" })).toHaveAttribute("href", "/manager/funds");
    });

    it("shows a loading skeleton before chart data arrives", () => {
        mocks.getReportAnalytics.mockReturnValue(new Promise(() => {}));
        renderPage();
        expect(screen.getByRole("status", { name: "Loading fund analytics" })).toBeInTheDocument();
        expect(screen.queryByTestId("fund-manager-charts")).not.toBeInTheDocument();
    });

    it("surfaces API failures and retries loading chart data", async () => {
        mocks.getReportAnalytics
            .mockRejectedValueOnce(new Error("Fund analytics unavailable"))
            .mockResolvedValueOnce({
                contribution_trends: [],
                fund_summary: { managed_funds: 0, allocated_workers: 0 },
                fund_performance: [],
            });
        renderPage();

        const alert = (await screen.findByText("Unable to load fund analytics right now. Please try again.")).closest('[role="alert"]');
        fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
        expect(await screen.findByTestId("fund-manager-charts")).toHaveTextContent("0 contribution trends; 0 funds");
        expect(mocks.getReportAnalytics).toHaveBeenCalledTimes(2);
    });

    it("passes empty successful aggregates to charts with meaningful empty states", async () => {
        mocks.getReportAnalytics.mockResolvedValue({
            contribution_trends: [],
            fund_summary: { managed_funds: 0, allocated_workers: 0 },
            fund_performance: [],
        });
        renderPage();
        expect(await screen.findByTestId("fund-manager-charts")).toHaveTextContent("0 contribution trends; 0 funds");
        expect(screen.getByText("Verified settled contributions").parentElement).toHaveTextContent("KSh 0.00");
    });

    it("applies the selected date range without losing other filter values", async () => {
        renderPage();
        await screen.findByTestId("fund-manager-charts");
        fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-01-01" } });
        await screen.findByTestId("fund-manager-charts");

        expect(mocks.getReportAnalytics).toHaveBeenLastCalledWith({
            start_date: "2026-01-01",
            end_date: "",
        });

        fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026-03-31" } });
        await screen.findByTestId("fund-manager-charts");
        expect(mocks.getReportAnalytics).toHaveBeenLastCalledWith({
            start_date: "2026-01-01",
            end_date: "2026-03-31",
        });

        fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
        await screen.findByTestId("fund-manager-charts");
        expect(mocks.getReportAnalytics).toHaveBeenLastCalledWith({
            start_date: "",
            end_date: "",
        });
    });
});
