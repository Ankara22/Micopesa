import { lazy, Suspense, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import { getReportAnalytics } from "../../services/reportsApi";
import ErrorState from "../../components/ui/ErrorState";
import LoadingState from "../../components/ui/LoadingState";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import AnalyticsDateFilters from "../analytics/AnalyticsDateFilters";
import "../analytics/analytics.css";
import { Link } from "react-router-dom";

const RegulatorAnalyticsCharts = lazy(() => import("../analytics/AnalyticsCharts")
    .then(({ RegulatorAnalyticsCharts: Charts }) => ({ default: Charts })));

function RegulatorAnalytics() {
    const { t } = useTranslation();
    const [filters, setFilters] = useState({ start_date: "", end_date: "" });
    const fetchAnalytics = useCallback(() => getReportAnalytics(filters), [filters]);
    const analyticsApi = useApi(fetchAnalytics, [fetchAnalytics]);
    const analytics = analyticsApi.data || {};
    const fundComparison = analytics.fund_comparison || [];
    const complianceTrends = analytics.compliance_trends || [];
    const complianceEvidence = analytics.compliance_evidence || [];
    const complianceActivity = analytics.compliance_activity || [];
    const riskSummary = analytics.risk_summary || [];

    return (
        <div className="role-analytics-page">
            <header className="page-header">
                <div>
                    <h1 className="page-title">{t("analytics.regulatorTitle")}</h1>
                    <p className="page-subtitle">{t("analytics.regulatorSubtitle")}</p>
                </div>
            </header>
            <Link className="analytics-navigation" to="/regulator/dashboard">{t("analytics.backDashboard")}</Link>

            <AnalyticsDateFilters filters={filters} setFilters={setFilters} />
            {analyticsApi.refreshing && <LoadingState message={t("analytics.refreshingRegulator")} />}
            {analyticsApi.loading && analyticsApi.data === null ? (
                <SkeletonLoader variant="chart" count={5} label={t("analytics.loadingRegulator")} />
            ) : analyticsApi.error && analyticsApi.data === null ? (
                <ErrorState title={t("analytics.errorTitle")} message={t("analytics.regulatorLoadError")} onRetry={analyticsApi.refetch} />
            ) : (
                <>
                    {analyticsApi.error && <ErrorState title={t("analytics.errorTitle")} message={t("analytics.regulatorLoadError")} onRetry={analyticsApi.refetch} />}
                    <Suspense fallback={<SkeletonLoader variant="chart" count={5} label={t("analytics.chartLoading")} />}>
                        <RegulatorAnalyticsCharts
                            fundComparison={fundComparison}
                            complianceTrends={complianceTrends}
                            complianceEvidence={complianceEvidence}
                            complianceActivity={complianceActivity}
                            riskSummary={riskSummary}
                        />
                    </Suspense>
                </>
            )}
        </div>
    );
}

export default RegulatorAnalytics;
