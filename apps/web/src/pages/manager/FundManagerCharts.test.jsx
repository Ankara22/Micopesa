import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FundManagerCharts from "./FundManagerCharts";
import { getAllocationTrend, getCurrentAllocationBreakdown } from "./fundAllocationUtils";

vi.mock("recharts", () => ({
    Area: (props) => <div data-testid="allocation-area-series" data-key={props.dataKey} />,
    AreaChart: ({ data, children }) => (
        <div data-testid="allocation-area-chart" data-chart-data={JSON.stringify(data)}>{children}</div>
    ),
    Cell: () => null,
    Pie: ({ data, dataKey }) => (
        <div data-testid="allocation-pie" data-chart-key={dataKey} data-chart-data={JSON.stringify(data)} />
    ),
    PieChart: ({ children }) => <div>{children}</div>,
    ResponsiveContainer: ({ children }) => <div>{children}</div>,
    Tooltip: () => null,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
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

    it("builds a 12-month trend only from dated allocation records active during each month", () => {
        const growth = { fund_id: "growth", fund_name: "Growth" };
        const trend = getAllocationTrend([{
            fund: growth,
            allocations: [
                { percentage: "60", effective_from: "2025-11-15", effective_to: "2026-03-31" },
                { percentage: "40", effective_from: "2026-04-01", effective_to: null },
                { percentage: "25", effective_from: "2024-01-01", effective_to: "2024-12-31" },
                { percentage: "invalid", effective_from: "2026-01-01", effective_to: null },
                { percentage: "100", effective_from: "2026-13-01", effective_to: null },
            ],
        }], new Date(2026, 9, 22));

        expect(trend).toHaveLength(12);
        expect(trend[0]).toMatchObject({ key: "2025-11", fund_growth: 60 });
        expect(trend[4]).toMatchObject({ key: "2026-03", fund_growth: 60 });
        expect(trend[5]).toMatchObject({ key: "2026-04", fund_growth: 40 });
        expect(trend[11]).toMatchObject({ key: "2026-10", fund_growth: 40 });
        expect(trend.every((point) => Number.isFinite(point.fund_growth))).toBe(true);
    });

    it("does not include allocation records before their effective date in the current month", () => {
        const trend = getAllocationTrend([{
            fund: { fund_id: "fund" },
            allocations: [
                { percentage: "50", effective_from: "2026-10-28", effective_to: null },
                { percentage: "40", effective_from: "2026-10-27T00:00:00.000Z", effective_to: null },
            ],
        }], new Date(2026, 9, 27));

        expect(trend.at(-1)).toMatchObject({ key: "2026-10", fund_fund: 40 });
    });

    it("ignores blank and out-of-range percentages in current allocation totals", () => {
        const funds = [{ fund_id: "fund", fund_name: "Fund" }];
        const entries = [{
            fund: funds[0],
            allocations: [
                { percentage: "  ", effective_from: "2026-01-01", effective_to: null },
                { percentage: "101", effective_from: "2026-01-01", effective_to: null },
                { percentage: "25.5", effective_from: "2026-01-01", effective_to: null },
            ],
        }];

        expect(getCurrentAllocationBreakdown(funds, entries, new Date(2026, 9, 22))[0])
            .toMatchObject({ percentagePoints: 25.5, allocationShare: 100 });
    });

    it("returns no trend when there are no valid recorded intervals in the period", () => {
        expect(getAllocationTrend([{
            fund: { fund_id: "fund" },
            allocations: [
                { percentage: "50", effective_from: "2024-01-01", effective_to: "2024-12-31" },
                { percentage: "40", effective_from: "2026-01-01", effective_to: "2025-12-31" },
                { percentage: "0", effective_from: "2026-01-01", effective_to: null },
            ],
        }], new Date(2026, 9, 22))).toEqual([]);
    });

    it("renders a separate history area chart using allocation records without changing the donut", () => {
        const funds = [
            { fund_id: "growth", fund_name: "Growth" },
            { fund_id: "balanced", fund_name: "Balanced" },
        ];
        const allocationEntries = [
            { fund: funds[0], allocations: [{ percentage: "60", effective_from: "2026-01-01", effective_to: null }] },
            { fund: funds[1], allocations: [{ percentage: "40", effective_from: "2026-01-01", effective_to: null }] },
        ];
        render(<FundManagerCharts funds={funds} allocationEntries={allocationEntries} />);

        const history = JSON.parse(screen.getByTestId("allocation-area-chart").getAttribute("data-chart-data"));
        expect(history.at(-1)).toMatchObject({ fund_growth: 60, fund_balanced: 40 });
        expect(screen.getAllByTestId("allocation-area-series")).toHaveLength(2);
        expect(screen.getByTestId("allocation-pie")).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Fund Allocation History" })).toBeInTheDocument();
        expect(screen.getByText(/not asset values or investment performance/i)).toBeInTheDocument();
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
        expect(screen.getByTestId("allocation-pie")).toHaveAttribute("data-chart-key", "allocationShare");
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

        expect(screen.getByText("No recorded allocation history is available for the past 12 months.")).toBeInTheDocument();
        expect(screen.getByText("No current fund allocations are available.")).toBeInTheDocument();
        expect(screen.queryByTestId("allocation-pie")).not.toBeInTheDocument();
        expect(screen.queryByTestId("allocation-area-chart")).not.toBeInTheDocument();
    });
});
