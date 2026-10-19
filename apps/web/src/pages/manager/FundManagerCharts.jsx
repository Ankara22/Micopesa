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

const RISK_COLORS = {
    LOW: "#10b981",
    MEDIUM: "#34d399",
    HIGH: "#6ee7b7",
};
const CHART_COLORS = ["#10b981", "#34d399", "#6ee7b7", "#059669", "#a7f3d0", "#047857"];
const CHART_MARGIN = { top: 8, right: 12, bottom: 4, left: 0 };

function getAllocationTrend(allocationEntries) {
    const now = new Date();
    const months = Array.from({ length: 12 }, (_, index) => {
        const date = new Date(now.getFullYear(), now.getMonth() - 11 + index, 1);
        return {
            date,
            key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`,
            month: date.toLocaleDateString(undefined, { month: "short", year: "2-digit" }),
        };
    });

    return months.map(({ date, key, month }) => {
        const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0);
        const point = { month, key };
        allocationEntries.forEach(({ fund, allocations }) => {
            const dataKey = `fund_${fund.fund_id}`;
            point[dataKey] = allocations.reduce((total, allocation) => {
                const starts = new Date(`${allocation.effective_from}T00:00:00`);
                const ends = allocation.effective_to ? new Date(`${allocation.effective_to}T23:59:59`) : null;
                return starts <= monthEnd && (!ends || ends >= date)
                    ? total + Number(allocation.percentage)
                    : total;
            }, 0);
        });
        return point;
    });
}

function FundManagerCharts({ funds, allocationEntries }) {
    const allocationTrend = getAllocationTrend(allocationEntries);
    const riskDistribution = Object.entries(
        funds.reduce((counts, fund) => {
            counts[fund.risk_level] = (counts[fund.risk_level] || 0) + 1;
            return counts;
        }, {})
    ).map(([name, value]) => ({ name, value }));
    const hasAllocations = allocationEntries.some(({ allocations }) => allocations.length > 0);

    return (
        <section className="dashboard-chart-grid" aria-label="Fund performance charts">
            <article className="dashboard-chart-panel">
                <h2 className="dashboard-chart-title">Fund Allocation History</h2>
                <p className="dashboard-chart-subtitle">
                    Monthly sum of recorded account allocation percentages across managed funds. This is allocation history, not asset value.
                </p>
                {hasAllocations ? (
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
                                <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                                <XAxis dataKey="month" tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={{ stroke: "#334155" }} tickLine={false} />
                                <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} />
                                <Tooltip content={<DarkChartTooltip formatter={(value) => `${Number(value).toFixed(2)}%`} />} />
                                {funds.map((fund, index) => (
                                    <Area
                                        key={fund.fund_id}
                                        type="monotone"
                                        dataKey={`fund_${fund.fund_id}`}
                                        name={fund.fund_name}
                                        stackId="allocations"
                                        stroke={CHART_COLORS[index % CHART_COLORS.length]}
                                        fill={`url(#allocation-${fund.fund_id})`}
                                    />
                                ))}
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>
                ) : (
                    <div className="dashboard-chart-empty">No fund allocation history is available yet.</div>
                )}
            </article>

            <article className="dashboard-chart-panel">
                <h2 className="dashboard-chart-title">Managed Portfolio Mix</h2>
                <p className="dashboard-chart-subtitle">
                    Number of managed funds by risk tier; this breakdown represents fund count, not assets under management.
                </p>
                {riskDistribution.length ? (
                    <div className="dashboard-chart">
                        <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                                <Pie
                                    data={riskDistribution}
                                    dataKey="value"
                                    nameKey="name"
                                    innerRadius="58%"
                                    outerRadius="82%"
                                    paddingAngle={3}
                                >
                                    {riskDistribution.map((entry) => (
                                        <Cell key={entry.name} fill={RISK_COLORS[entry.name] || "#34d399"} />
                                    ))}
                                </Pie>
                                <Tooltip content={<DarkChartTooltip formatter={(value) => `${value} funds`} />} />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>
                ) : (
                    <div className="dashboard-chart-empty">No managed funds are available.</div>
                )}
                {riskDistribution.length > 0 && (
                    <div className="dashboard-chart-legend">
                        {riskDistribution.map((item) => (
                            <span key={item.name}>
                                <i style={{ background: RISK_COLORS[item.name] || "#34d399" }} />
                                {item.name}: {item.value}
                            </span>
                        ))}
                    </div>
                )}
            </article>
        </section>
    );
}

export default FundManagerCharts;
