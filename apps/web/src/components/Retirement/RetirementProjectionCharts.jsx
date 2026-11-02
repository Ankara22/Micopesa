import {
    CartesianGrid,
    Legend,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import DarkChartTooltip from "../charts/DarkChartTooltip";
import { useTranslation } from "react-i18next";
import { formatKes, formatNumber } from "../../i18n/formatters";
import "../charts/charts.css";
import "./retirement-projection-charts.css";

function RetirementProjectionCharts({ projection }) {
    const { t, i18n } = useTranslation();
    const data = projection.yearly_projection;
    return (
        <section className="dashboard-chart-grid retirement-projection-charts" aria-label={t("worker.retirement.chartAnalysis")}>
            <article className="dashboard-chart-panel retirement-projection-chart-panel">
                <h2 className="dashboard-chart-title">{t("worker.retirement.chartTitle")}</h2>
                <p className="dashboard-chart-subtitle">
                    {t("worker.retirement.chartSubtitle")}
                </p>
                <div className="dashboard-chart retirement-projection-chart">
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={data} margin={{ top: 8, right: 20, bottom: 4, left: 8 }}>
                            <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" />
                            <XAxis
                                dataKey="year"
                                tick={{ fill: "var(--chart-axis)", fontSize: 11 }}
                                axisLine={{ stroke: "var(--chart-grid)" }}
                                tickLine={false}
                                label={{ value: t("worker.retirement.yearsFromNow"), position: "insideBottom", offset: -2 }}
                            />
                            <YAxis
                                tick={{ fill: "var(--chart-axis)", fontSize: 11 }}
                                axisLine={false}
                                tickLine={false}
                                tickFormatter={(value) => formatNumber(value, i18n.language, {
                                    notation: "compact",
                                    maximumFractionDigits: 1,
                                })}
                            />
                            <Tooltip content={<DarkChartTooltip formatter={(value) => formatKes(value, i18n.language)} />} />
                            <Legend />
                            <Line
                                type="monotone"
                                dataKey="projectedBalance"
                                name={t("worker.retirement.estimatedBalance")}
                                stroke="var(--chart-series-1)"
                                strokeWidth={3}
                                dot={false}
                                activeDot={{ r: 5 }}
                            />
                            <Line
                                type="monotone"
                                dataKey="totalContributions"
                                name={t("worker.retirement.plannedContributions")}
                                stroke="var(--chart-series-2)"
                                strokeWidth={2}
                                dot={false}
                                activeDot={{ r: 4 }}
                            />
                        </LineChart>
                    </ResponsiveContainer>
                </div>
            </article>
        </section>
    );
}

export default RetirementProjectionCharts;
