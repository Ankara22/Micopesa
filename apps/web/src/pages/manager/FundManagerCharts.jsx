import {
    Cell,
    Pie,
    PieChart,
    ResponsiveContainer,
    Tooltip,
} from "recharts";
import DarkChartTooltip from "../../components/charts/DarkChartTooltip";
import "../../components/charts/charts.css";
import { getCurrentAllocationBreakdown } from "./fundAllocationUtils";

const CHART_COLORS = ["#059669", "#10b981", "#34d399", "#047857", "#6ee7b7", "#a7f3d0"];

function FundManagerCharts({ funds, allocationEntries }) {
    const breakdown = getCurrentAllocationBreakdown(funds, allocationEntries);
    const chartData = breakdown.filter((fund) => fund.percentagePoints > 0);

    return (
        <section className="dashboard-chart-grid" aria-label="Fund allocation overview">
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
                                        dataKey="percentagePoints"
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
                                                formatter={(value) => `${Number(value).toFixed(2)} percentage points`}
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
