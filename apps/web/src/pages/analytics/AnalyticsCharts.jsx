import {
    Bar,
    BarChart,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import { useTranslation } from "react-i18next";
import DarkChartTooltip from "../../components/charts/DarkChartTooltip";
import { formatKes, formatNumber } from "../../i18n/formatters";
import "../../components/charts/charts.css";
import "./analytics.css";

function ChartPanel({
    title,
    description,
    data,
    dataKey,
    emptyMessage,
    formatter,
    labelKey = "label",
    allowDecimals = false,
}) {
    return (
        <article className="dashboard-chart-panel">
            <h2 className="dashboard-chart-title">{title}</h2>
            <p className="dashboard-chart-subtitle">{description}</p>
            {data.length ? (
                <div className="dashboard-chart">
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                            <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
                            <XAxis
                                dataKey={labelKey}
                                tick={{ fill: "var(--chart-axis)", fontSize: 11 }}
                                axisLine={{ stroke: "var(--chart-grid)" }}
                                tickLine={false}
                            />
                            <YAxis
                                allowDecimals={allowDecimals}
                                tick={{ fill: "var(--chart-axis)", fontSize: 11 }}
                                axisLine={false}
                                tickLine={false}
                            />
                            <Tooltip content={<DarkChartTooltip formatter={formatter} />} />
                            <Bar dataKey={dataKey} name={title} fill="var(--chart-series-1)" radius={[5, 5, 0, 0]} />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            ) : (
                <div className="dashboard-chart-empty">{emptyMessage}</div>
            )}
        </article>
    );
}

function numericValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function nullableNumericValue(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function sumBy(rows, key, labelKey, valueKey) {
    const totals = new Map();
    rows.forEach((row) => {
        const label = row?.[labelKey];
        if (typeof label !== "string" || !label) return;
        totals.set(label, (totals.get(label) || 0) + numericValue(row[valueKey]));
    });
    return [...totals.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([label, value]) => ({ label, value }));
}

function statusName(t, status) {
    return t(`analytics.status.${status}`, { defaultValue: status || t("analytics.noContributions") });
}

function monthLabel(value, language) {
    const date = new Date(`${value}-01T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(language === "sw" ? "sw-KE" : "en-KE", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
    }).format(date);
}

function sumFundManagerTrends(trends) {
    const byPeriod = new Map();
    trends.forEach((row) => {
        if (typeof row?.period !== "string") return;
        const period = row.period.slice(0, 7);
        const total = byPeriod.get(period) || { label: period, count: 0, amount: 0 };
        total.count += numericValue(row.contribution_count);
        total.amount += numericValue(row.allocated_amount);
        byPeriod.set(period, total);
    });
    return [...byPeriod.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export function FundManagerAnalyticsCharts({ trends, performance = [] }) {
    const { t, i18n } = useTranslation();
    const monthly = sumFundManagerTrends(trends);
    const statuses = sumBy(trends, "status", "status", "contribution_count");
    const fundPerformance = performance.map((fund) => ({
        label: fund.fund_name,
        amount: numericValue(fund.settled_contributions),
    }));
    const expectedReturns = performance
        .map((fund) => ({
            label: fund.fund_name,
            value: nullableNumericValue(fund.expected_return),
        }))
        .filter((fund) => fund.value !== null);
    return (
        <section className="dashboard-chart-grid analytics-chart-grid" aria-label={t("analytics.fundManagerCharts")}>
            <ChartPanel
                title={t("analytics.contributionsByMonth")}
                description={t("analytics.contributionsByMonthDescription")}
                data={monthly.map((item) => ({ ...item, label: monthLabel(item.label, i18n.resolvedLanguage) }))}
                dataKey="count"
                labelKey="label"
                formatter={(value) => t("analytics.contributions", { count: formatNumber(value, i18n.resolvedLanguage) })}
                emptyMessage={t("analytics.noTrend")}
            />
            <ChartPanel
                title={t("analytics.allocatedByMonth")}
                description={t("analytics.allocatedByMonthDescription")}
                data={monthly.map((item) => ({ ...item, label: monthLabel(item.label, i18n.resolvedLanguage) }))}
                dataKey="amount"
                labelKey="label"
                allowDecimals
                formatter={(value) => formatKes(value, i18n.resolvedLanguage)}
                emptyMessage={t("analytics.noAllocatedByMonth")}
            />
            <ChartPanel
                title={t("analytics.contributionsByStatus")}
                description={t("analytics.statusDescription")}
                data={statuses.map((item) => ({ ...item, label: statusName(t, item.label) }))}
                dataKey="value"
                formatter={(value) => t("analytics.contributions", { count: formatNumber(value, i18n.resolvedLanguage) })}
                emptyMessage={t("analytics.noStatuses")}
            />
            <ChartPanel
                title={t("analytics.settledContributionsByFund")}
                description={t("analytics.settledFundTotal")}
                data={fundPerformance}
                dataKey="amount"
                allowDecimals
                formatter={(value) => formatKes(value, i18n.resolvedLanguage)}
                emptyMessage={t("analytics.noAllocatedByMonth")}
            />
            <ChartPanel
                title={t("analytics.expectedReturnByFund")}
                description={t("analytics.expectedReturnDescription")}
                data={expectedReturns}
                dataKey="value"
                allowDecimals
                formatter={(value) => t("analytics.expectedReturnValue", {
                    value: formatNumber(value, i18n.resolvedLanguage),
                })}
                emptyMessage={t("analytics.noExpectedReturns")}
            />
        </section>
    );
}

export function WorkerAnalyticsCharts({ monthlyTotals, statusCounts }) {
    const { t, i18n } = useTranslation();
    return (
        <section className="dashboard-chart-grid analytics-chart-grid" aria-label={t("analytics.workerCharts")}>
            <ChartPanel
                title={t("analytics.workerContributionsByMonth")}
                description={t("analytics.workerContributionsByMonthDescription")}
                data={monthlyTotals.map((item) => ({ ...item, month: monthLabel(item.month, i18n.resolvedLanguage) }))}
                dataKey="amount"
                labelKey="month"
                formatter={(value) => formatKes(value, i18n.resolvedLanguage)}
                emptyMessage={t("analytics.noCompletedAmounts")}
            />
            <ChartPanel
                title={t("analytics.workerStatuses")}
                description={t("analytics.workerStatusDescription")}
                data={statusCounts.map((item) => ({ ...item, label: statusName(t, item.label) }))}
                dataKey="count"
                formatter={(value) => t("analytics.records", { count: formatNumber(value, i18n.resolvedLanguage) })}
                emptyMessage={t("analytics.noContributionStatuses")}
            />
        </section>
    );
}

export function RegulatorAnalyticsCharts({
    fundComparison,
    complianceTrends,
    complianceEvidence,
    complianceActivity = [],
    riskSummary = [],
}) {
    const { t, i18n } = useTranslation();
    const contributionsByFund = fundComparison.map((row) => ({
        label: `${row.fund_name} / ${statusName(t, row.status)}`,
        count: numericValue(row.contribution_count),
    }));
    const allocationsByFund = fundComparison.map((row) => ({
        label: `${row.fund_name} / ${statusName(t, row.status)}`,
        amount: numericValue(row.allocated_amount),
    }));
    const reportsByPeriod = complianceTrends.map((row) => ({
        label: `${monthLabel(String(row.period).slice(0, 7), i18n.resolvedLanguage)} / ${statusName(t, row.status)}`,
        count: numericValue(row.report_count),
    }));
    const evidence = complianceEvidence.map((row) => ({
        label: t(`analytics.status.${row.section}`, { defaultValue: row.section }),
        count: numericValue(row.report_count),
    }));
    const activity = complianceActivity.map((row) => ({
        label: `${monthLabel(String(row.period).slice(0, 7), i18n.resolvedLanguage)} / ${statusName(t, row.action_type)}`,
        count: numericValue(row.event_count),
    }));
    const risks = riskSummary.map((row) => ({
        label: statusName(t, row.risk_level),
        count: numericValue(row.fund_count),
    }));
    return (
        <section className="dashboard-chart-grid analytics-chart-grid" aria-label={t("analytics.regulatorCharts")}>
            <ChartPanel
                title={t("analytics.contributionsByFund")}
                description={t("analytics.activeAssignedFunds")}
                data={contributionsByFund}
                dataKey="count"
                formatter={(value) => t("analytics.contributions", { count: formatNumber(value, i18n.resolvedLanguage) })}
                emptyMessage={t("analytics.noFundContributions")}
            />
            <ChartPanel
                title={t("analytics.allocatedByFund")}
                description={t("analytics.allocatedByFundDescription")}
                data={allocationsByFund}
                dataKey="amount"
                allowDecimals
                formatter={(value) => formatKes(value, i18n.resolvedLanguage)}
                emptyMessage={t("analytics.noFundAllocations")}
            />
            <ChartPanel
                title={t("analytics.complianceByMonth")}
                description={t("analytics.complianceByMonthDescription")}
                data={reportsByPeriod}
                dataKey="count"
                formatter={(value) => t("analytics.records", { count: formatNumber(value, i18n.resolvedLanguage) })}
                emptyMessage={t("analytics.noComplianceReports")}
            />
            <ChartPanel
                title={t("analytics.evidenceBySection")}
                description={t("analytics.evidenceDescription")}
                data={evidence}
                dataKey="count"
                formatter={(value) => t("analytics.records", { count: formatNumber(value, i18n.resolvedLanguage) })}
                emptyMessage={t("analytics.noComplianceEvidence")}
            />
            <ChartPanel
                title={t("analytics.complianceActivity")}
                description={t("analytics.auditActivityDescription")}
                data={activity}
                dataKey="count"
                formatter={(value) => t("analytics.records", { count: formatNumber(value, i18n.resolvedLanguage) })}
                emptyMessage={t("analytics.noAuditActivity")}
            />
            <ChartPanel
                title={t("analytics.configuredRiskProfile")}
                description={t("analytics.configuredRiskDescription")}
                data={risks}
                dataKey="count"
                formatter={(value) => t("analytics.funds", { count: formatNumber(value, i18n.resolvedLanguage) })}
                emptyMessage={t("analytics.noRiskData")}
            />
        </section>
    );
}

export function AdminAnalyticsCharts({ notificationOutcomes, mpesaStatuses, activity, userTrends = [] }) {
    const { t, i18n } = useTranslation();
    const notifications = notificationOutcomes.map((row) => ({
        label: `${statusName(t, row.channel)} / ${statusName(t, row.status)}`,
        count: numericValue(row.notification_count),
    }));
    const channels = sumBy(notificationOutcomes, "channel", "channel", "notification_count")
        .map((row) => ({ ...row, label: statusName(t, row.label) }));
    const payments = mpesaStatuses.map((row) => ({
        label: `${statusName(t, row.category)} / ${statusName(t, row.status)}`,
        count: numericValue(row.item_count),
    }));
    const auditActions = activity.map((row) => ({
        label: `${statusName(t, row.entity_name)} / ${statusName(t, row.action_type)}`,
        count: numericValue(row.event_count),
    }));
    const registrations = userTrends.map((row) => ({
        label: `${monthLabel(String(row.period).slice(0, 7), i18n.resolvedLanguage)} / ${statusName(t, row.account_status)}`,
        count: numericValue(row.user_count),
    }));
    return (
        <>
        <section className="dashboard-chart-grid analytics-chart-grid" aria-label={t("analytics.adminCharts")}>
            <ChartPanel
                title={t("analytics.channelDistribution")}
                description={t("analytics.channelDistributionDescription")}
                data={channels}
                dataKey="value"
                formatter={(value) => t("analytics.records", { count: formatNumber(value, i18n.resolvedLanguage) })}
                emptyMessage={t("analytics.noNotificationOutcomes")}
            />
            <ChartPanel
                title={t("analytics.notificationOutcomes")}
                description={t("analytics.notificationOutcomesDescription")}
                data={notifications}
                dataKey="count"
                formatter={(value) => t("analytics.records", { count: formatNumber(value, i18n.resolvedLanguage) })}
                emptyMessage={t("analytics.noNotificationOutcomes")}
            />
            <ChartPanel
                title={t("analytics.paymentStatuses")}
                description={t("analytics.paymentStatusesDescription")}
                data={payments}
                dataKey="count"
                formatter={(value) => t("analytics.records", { count: formatNumber(value, i18n.resolvedLanguage) })}
                emptyMessage={t("analytics.noPaymentStatuses")}
            />
            <ChartPanel
                title={t("analytics.auditActivity")}
                description={t("analytics.auditActivityDescription")}
                data={auditActions}
                dataKey="count"
                formatter={(value) => t("analytics.records", { count: formatNumber(value, i18n.resolvedLanguage) })}
                emptyMessage={t("analytics.noAuditActivity")}
            />
            <ChartPanel
                title={t("analytics.userTrends")}
                description={t("analytics.userTrendsDescription")}
                data={registrations}
                dataKey="count"
                formatter={(value) => t("analytics.records", { count: formatNumber(value, i18n.resolvedLanguage) })}
                emptyMessage={t("analytics.noUserTrends")}
            />
        </section>
        <p className="analytics-data-note">{t("analytics.adminCoverageNote")}</p>
        </>
    );
}
