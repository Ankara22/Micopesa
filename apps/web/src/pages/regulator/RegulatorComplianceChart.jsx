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
                                <CartesianGrid stroke="#e5e4e7" strokeDasharray="3 3" vertical={false} />
                                <XAxis dataKey="status" tick={{ fill: "#6b6375", fontSize: 11 }} axisLine={{ stroke: "#e5e4e7" }} tickLine={false} />
                                <YAxis allowDecimals={false} tick={{ fill: "#6b6375", fontSize: 11 }} axisLine={false} tickLine={false} />
                                <Tooltip content={<DarkChartTooltip formatter={(value) => `${value} reports`} />} />
                                <Bar dataKey="reports" name="Reports" fill="#059669" radius={[5, 5, 0, 0]} />
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
