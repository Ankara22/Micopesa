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

const AdminAnalyticsCharts = lazy(() => import("../analytics/AnalyticsCharts")
    .then(({ AdminAnalyticsCharts: Charts }) => ({ default: Charts })));

function AdminAnalytics() {
    const { t } = useTranslation();
    const [filters, setFilters] = useState({ start_date: "", end_date: "" });
    const fetchAnalytics = useCallback(() => getReportAnalytics(filters), [filters]);
    const analyticsApi = useApi(fetchAnalytics, [fetchAnalytics]);
    const analytics = analyticsApi.data || {};

    return (
        <div className="role-analytics-page">
            <header className="page-header">
                <div>
                    <h1 className="page-title">{t("analytics.adminTitle")}</h1>
                    <p className="page-subtitle">{t("analytics.adminSubtitle")}</p>
                </div>
            </header>
            <Link className="analytics-navigation" to="/admin/dashboard">{t("analytics.backDashboard")}</Link>

            <AnalyticsDateFilters filters={filters} setFilters={setFilters} />
            {analyticsApi.refreshing && <LoadingState message={t("analytics.refreshingAdmin")} />}
            {analyticsApi.loading && analyticsApi.data === null ? (
                <SkeletonLoader variant="chart" count={4} label={t("analytics.loadingAdmin")} />
            ) : analyticsApi.error && analyticsApi.data === null ? (
                <ErrorState title={t("analytics.errorTitle")} message={t("analytics.adminLoadError")} onRetry={analyticsApi.refetch} />
            ) : (
                <>
                    {analyticsApi.error && <ErrorState title={t("analytics.errorTitle")} message={t("analytics.adminLoadError")} onRetry={analyticsApi.refetch} />}
                    <Suspense fallback={<SkeletonLoader variant="chart" count={4} label={t("analytics.chartLoading")} />}>
                        <AdminAnalyticsCharts
                            notificationOutcomes={analytics.notification_outcomes || []}
                            mpesaStatuses={analytics.mpesa_statuses || []}
                            activity={analytics.activity || []}
                            userTrends={analytics.user_trends || []}
                        />
                    </Suspense>
                </>
            )}
        </div>
    );
}

export default AdminAnalytics;
