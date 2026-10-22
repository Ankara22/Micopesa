import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FundManagerCharts from "./FundManagerCharts";
import { getCurrentAllocationBreakdown } from "./fundAllocationUtils";

vi.mock("recharts", () => ({
    Cell: () => null,
    Pie: ({ data }) => <div data-testid="allocation-pie" data-chart-data={JSON.stringify(data)} />,
    PieChart: ({ children }) => <div>{children}</div>,
    ResponsiveContainer: ({ children }) => <div>{children}</div>,
    Tooltip: () => null,
}));

describe("FundManagerCharts", () => {
    afterEach(cleanup);

    it("aggregates only current effective allocation percentages by fund", () => {
        const funds = [
            { fund_id: "growth", fund_name: "Growth" },
            { fund_id: "balanced", fund_name: "Balanced" },
        ];
        const allocations = [
            {
                fund: funds[0],
                allocations: [
                    { percentage: "60", effective_from: "2026-01-01", effective_to: null },
                    { percentage: "20", effective_from: "2026-10-23", effective_to: null },
                    { percentage: "10", effective_from: "2025-01-01", effective_to: "2026-10-21" },
                    { percentage: "-5", effective_from: "2026-01-01", effective_to: null },
                ],
            },
            {
                fund: funds[1],
                allocations: [{ percentage: "40", effective_from: "2026-01-01", effective_to: null }],
            },
        ];

        expect(getCurrentAllocationBreakdown(funds, allocations, new Date(2026, 9, 22))).toEqual([
            { fund_id: "growth", fund_name: "Growth", percentagePoints: 60, allocationShare: 60 },
            { fund_id: "balanced", fund_name: "Balanced", percentagePoints: 40, allocationShare: 40 },
        ]);
    });

    it("passes real current allocation totals to the chart and explains the percentage basis", () => {
        const funds = [
            { fund_id: "growth", fund_name: "Growth" },
            { fund_id: "balanced", fund_name: "Balanced" },
        ];
        const allocationEntries = [
            { fund: funds[0], allocations: [{ percentage: "60", effective_from: "2020-01-01", effective_to: null }] },
            { fund: funds[1], allocations: [{ percentage: "40", effective_from: "2020-01-01", effective_to: null }] },
        ];
        render(<FundManagerCharts funds={funds} allocationEntries={allocationEntries} />);

        const chartData = JSON.parse(screen.getByTestId("allocation-pie").getAttribute("data-chart-data"));
        expect(chartData.map(({ fund_name, percentagePoints }) => [fund_name, percentagePoints])).toEqual([
            ["Growth", 60],
            ["Balanced", 40],
        ]);
        expect(screen.getByText("Growth: 60.0%")).toBeInTheDocument();
        expect(screen.getByText(/not an asset-value or performance chart/i)).toBeInTheDocument();
    });

    it("shows an allocation empty state when no current allocation records exist", () => {
        render(
            <FundManagerCharts
                funds={[{ fund_id: "fund", fund_name: "Fund" }]}
                allocationEntries={[{
                    fund: { fund_id: "fund", fund_name: "Fund" },
                    allocations: [{ percentage: "50", effective_from: "2030-01-01", effective_to: null }],
                }]}
            />,
        );

        expect(screen.getByText("No current fund allocations are available.")).toBeInTheDocument();
        expect(screen.queryByTestId("allocation-pie")).not.toBeInTheDocument();
    });
});
