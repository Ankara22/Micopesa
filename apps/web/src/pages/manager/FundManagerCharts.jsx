import {
    Area,
    AreaChart,
    CartesianGrid,
    Cell,
    Pie,
    PieChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import DarkChartTooltip from "../../components/charts/DarkChartTooltip";
import "../../components/charts/charts.css";
import { getCurrentAllocationBreakdown, getAllocationTrend } from "./fundAllocationUtils";

const CHART_COLORS = [
    "var(--chart-series-1)",
    "var(--chart-series-2)",
    "var(--chart-series-3)",
    "var(--chart-series-4)",
    "var(--chart-series-5)",
    "var(--chart-series-6)",
];
const CHART_MARGIN = { top: 8, right: 12, bottom: 4, left: 0 };

function FundManagerCharts({ funds, allocationEntries }) {
    const breakdown = getCurrentAllocationBreakdown(funds, allocationEntries);
    const chartData = breakdown.filter((fund) => fund.percentagePoints > 0);
    const allocationTrend = getAllocationTrend(allocationEntries);
    return (
        <section className="dashboard-chart-grid" aria-label="Fund allocation overview">
            <article className="dashboard-chart-panel">
                <h2 className="dashboard-chart-title">Fund Allocation History</h2>
                <p className="dashboard-chart-subtitle">
                    Monthly sum of recorded account allocation percentages active during each month across managed funds
                    (through today for the current month).
                    Values are percentage points, not asset values or investment performance.
                </p>
                {allocationTrend.length ? (
                    <div className="dashboard-chart">
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={allocationTrend} margin={CHART_MARGIN}>
                                <defs>
                                    {funds.map((fund, index) => (
                                        <linearGradient
                                            id={`allocation-${fund.fund_id}`}
                                            key={fund.fund_id}
                                            x1="0"
                                            y1="0"
                                            x2="0"
                                            y2="1"
                                        >
                                            <stop offset="5%" stopColor={CHART_COLORS[index % CHART_COLORS.length]} stopOpacity={0.4} />
                                            <stop offset="95%" stopColor={CHART_COLORS[index % CHART_COLORS.length]} stopOpacity={0.03} />
                                        </linearGradient>
                                    ))}
                                </defs>
                                <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
                                <XAxis
                                    dataKey="month"
                                    tick={{ fill: "var(--chart-axis)", fontSize: 11 }}
                                    axisLine={{ stroke: "var(--chart-grid)" }}
                                    tickLine={false}
                                />
                                <YAxis
                                    tick={{ fill: "var(--chart-axis)", fontSize: 11 }}
                                    axisLine={false}
                                    tickLine={false}
                                    tickFormatter={(value) => `${value} pp`}
                                />
                                <Tooltip content={<DarkChartTooltip formatter={(value) => `${Number(value).toFixed(2)} percentage points`} />} />
                                {funds.map((fund, index) => (
                                    <Area
                                        key={fund.fund_id}
                                        type="monotone"
                                        dataKey={`fund_${fund.fund_id}`}
                                        name={fund.fund_name}
                                        stackId="allocations"
                                        stroke={CHART_COLORS[index % CHART_COLORS.length]}
                                        fill={`url(#allocation-${fund.fund_id})`}
                                        connectNulls={false}
                                    />
                                ))}
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>
                ) : (
                    <div className="dashboard-chart-empty">
                        No recorded allocation history is available for the past 12 months.
                    </div>
                )}
                {allocationTrend.length > 0 && (
                    <ul className="dashboard-chart-legend" aria-label="Allocation history by fund">
                        {funds.map((fund, index) => (
                            <li key={fund.fund_id}>
                                <i style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />
                                <span>{fund.fund_name}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </article>
            <article className="dashboard-chart-panel">
                <h2 className="dashboard-chart-title">Current recorded fund allocations</h2>
                <p className="dashboard-chart-subtitle">
                    Share of currently effective allocation percentage points by fund. This is not an asset-value or performance chart.
                </p>
                {chartData.length ? (
                    <>
                        <div className="dashboard-chart">
                            <ResponsiveContainer width="100%" height="100%">
                                <PieChart>
                                    <Pie
                                        data={chartData}
                                        dataKey="allocationShare"
                                        nameKey="fund_name"
                                        innerRadius="58%"
                                        outerRadius="82%"
                                        paddingAngle={3}
                                    >
                                        {chartData.map((entry, index) => (
                                            <Cell
                                                key={entry.fund_id}
                                                fill={CHART_COLORS[index % CHART_COLORS.length]}
                                            />
                                        ))}
                                    </Pie>
                                    <Tooltip
                                        content={
                                            <DarkChartTooltip
                                                formatter={(value) => `${Number(value).toFixed(2)}% of current allocation`}
                                            />
                                        }
                                    />
                                </PieChart>
                            </ResponsiveContainer>
                        </div>
                        <ul className="dashboard-chart-legend" aria-label="Allocation share by fund">
                            {chartData.map((item, index) => (
                                <li key={item.fund_id}>
                                    <i style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />
                                    <span>{item.fund_name}: {item.allocationShare.toFixed(1)}%</span>
                                </li>
                            ))}
                        </ul>
                    </>
                ) : (
                    <div className="dashboard-chart-empty">No current fund allocations are available.</div>
                )}
            </article>
        </section>
    );
}

export default FundManagerCharts;
