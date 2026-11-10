import { lazy, Suspense, useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import { getReportAnalytics } from "../../services/reportsApi";
import ErrorState from "../../components/ui/ErrorState";
import LoadingState from "../../components/ui/LoadingState";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import { StatCard } from "../../components/ui/Card";
import { formatKes } from "../../i18n/formatters";
import AnalyticsDateFilters from "../analytics/AnalyticsDateFilters";
import "../analytics/analytics.css";

const FundManagerAnalyticsCharts = lazy(() => import("../analytics/AnalyticsCharts")
    .then(({ FundManagerAnalyticsCharts: Charts }) => ({ default: Charts })));

function FundAnalytics() {
    const { t, i18n } = useTranslation();
    const [filters, setFilters] = useState({ start_date: "", end_date: "" });
    const fetchAnalytics = useCallback(() => getReportAnalytics(filters), [filters]);
    const analyticsApi = useApi(fetchAnalytics, [fetchAnalytics]);
    const trends = analyticsApi.data?.contribution_trends || [];
    const summary = analyticsApi.data?.fund_summary || {};
    const fundPerformance = analyticsApi.data?.fund_performance || [];
    const settledTotal = fundPerformance.reduce((total, fund) => total + (Number(fund.settled_contributions) || 0), 0);

    return (
        <div className="role-analytics-page">
            <header className="page-header">
                <div>
                    <h1 className="page-title">{t("analytics.managerTitle")}</h1>
                    <p className="page-subtitle">{t("analytics.managerSubtitle")}</p>
                </div>
            </header>

            <p><Link className="analytics-navigation" to="/manager/funds">{t("analytics.manageFunds")}</Link></p>
            <AnalyticsDateFilters filters={filters} setFilters={setFilters} />
            {analyticsApi.refreshing && <LoadingState message={t("analytics.refreshingManager")} />}
            {analyticsApi.loading && analyticsApi.data === null ? (
                <SkeletonLoader variant="chart" count={4} label={t("analytics.loadingManager")} />
            ) : analyticsApi.error && analyticsApi.data === null ? (
                <ErrorState title={t("analytics.errorTitle")} message={t("analytics.managerLoadError")} onRetry={analyticsApi.refetch} />
            ) : (
                <>
                    {analyticsApi.error && <ErrorState title={t("analytics.errorTitle")} message={t("analytics.managerLoadError")} onRetry={analyticsApi.refetch} />}
                    <div className="stat-card-grid">
                        <StatCard label={t("analytics.managerFunds")} value={summary.managed_funds ?? 0} />
                        <StatCard label={t("analytics.allocatedWorkers")} value={summary.allocated_workers ?? 0} />
                        <StatCard
                            label={t("analytics.settledFundTotal")}
                            value={formatKes(settledTotal, i18n.resolvedLanguage) || "KSh 0.00"}
                        />
                    </div>
                    <Suspense fallback={<SkeletonLoader variant="chart" count={4} label={t("analytics.chartLoading")} />}>
                        <FundManagerAnalyticsCharts trends={trends} performance={fundPerformance} />
                    </Suspense>
                </>
            )}
        </div>
    );
}

export default FundAnalytics;
