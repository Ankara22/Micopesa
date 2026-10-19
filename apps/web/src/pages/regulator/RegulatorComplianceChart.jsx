import {
    Bar,
    BarChart,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import DarkChartTooltip from "../../components/charts/DarkChartTooltip";
import "../../components/charts/charts.css";

function RegulatorComplianceChart({ reportStatusData }) {
    return (
        <section className="dashboard-chart-grid" aria-label="RBA compliance status chart">
            <article className="dashboard-chart-panel">
                <h2 className="dashboard-chart-title">RBA Reports by Status</h2>
                <p className="dashboard-chart-subtitle">
                    Report counts grouped by their recorded regulatory review status.
                </p>
                {reportStatusData.length ? (
                    <div className="dashboard-chart">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={reportStatusData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                                <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                                <XAxis dataKey="status" tick={{ fill: "#cbd5e1", fontSize: 11 }} axisLine={{ stroke: "#334155" }} tickLine={false} />
                                <YAxis allowDecimals={false} tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} />
                                <Tooltip content={<DarkChartTooltip formatter={(value) => `${value} reports`} />} />
                                <Bar dataKey="reports" name="Reports" fill="#10b981" radius={[5, 5, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                ) : (
                    <div className="dashboard-chart-empty">No RBA report status data is available yet.</div>
                )}
            </article>
        </section>
    );
}

export default RegulatorComplianceChart;
