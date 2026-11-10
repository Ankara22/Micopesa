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
    FundManagerAnalyticsCharts: ({ trends }) => (
        <div data-testid="fund-manager-charts">{trends.length} contribution trends</div>
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
                { period: "2026-01-01", status: "COMPLETED", contribution_count: 2, allocated_amount: "100.00" },
            ],
        });
    });

    it("loads scoped contribution aggregates into the analytics charts", async () => {
        renderPage();

        expect(await screen.findByTestId("fund-manager-charts")).toHaveTextContent("1 contribution trends");
        expect(screen.getByRole("heading", { name: "Fund Analytics" })).toBeInTheDocument();
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
            .mockResolvedValueOnce({ contribution_trends: [{ period: "2026-01-01" }] });
        renderPage();

        const alert = (await screen.findByText("Unable to load fund analytics right now. Please try again.")).closest('[role="alert"]');
        fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
        expect(await screen.findByTestId("fund-manager-charts")).toHaveTextContent("1 contribution trends");
        expect(mocks.getReportAnalytics).toHaveBeenCalledTimes(2);
    });

    it("passes empty successful aggregates to charts with meaningful empty states", async () => {
        mocks.getReportAnalytics.mockResolvedValue({ contribution_trends: [] });
        renderPage();
        expect(await screen.findByTestId("fund-manager-charts")).toHaveTextContent("0 contribution trends");
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
    });
});
