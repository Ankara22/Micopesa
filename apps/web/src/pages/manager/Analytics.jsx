import { lazy, Suspense, useCallback } from "react";
import { Link } from "react-router-dom";
import useApi from "../../hooks/useApi";
import { listFunds, getFundAllocations } from "../../services/fundService";
import ErrorState from "../../components/ui/ErrorState";
import LoadingState from "../../components/ui/LoadingState";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import "./fund-manager-dashboard.css";

const FundManagerCharts = lazy(() => import("./FundManagerCharts"));

function FundAnalytics() {
    const fetchChartData = useCallback(async () => {
        const funds = await listFunds();
        const allocationEntries = await Promise.all(
            funds.map(async (fund) => ({
                fund,
                allocations: await getFundAllocations(fund.fund_id),
            }))
        );
        return { funds, allocationEntries };
    }, []);
    const chartApi = useApi(fetchChartData, []);
    const funds = chartApi.data?.funds || [];
    const allocationEntries = chartApi.data?.allocationEntries || [];

    return (
        <div className="fund-manager-dashboard fund-manager-analytics">
            <header className="page-header fund-manager-dashboard-header">
                <div>
                    <p className="fund-manager-eyebrow">Fund analytics</p>
                    <h1 className="page-title">Fund Analytics</h1>
                    <p className="page-subtitle">
                        Explore currently effective allocation shares and history from recorded dated allocation entries.
                        Percentages are not asset values or investment performance.
                    </p>
                </div>
            </header>

            <p><Link className="fund-manager-link" to="/manager/funds">Manage funds</Link></p>
            {chartApi.refreshing && <LoadingState message="Refreshing fund analytics..." />}
            {chartApi.loading && chartApi.data === null ? (
                <SkeletonLoader variant="chart" label="Loading fund analytics" />
            ) : chartApi.error && chartApi.data === null ? (
                <ErrorState message={chartApi.error} onRetry={chartApi.refetch} />
            ) : (
                <>
                    {chartApi.error && <ErrorState message={chartApi.error} onRetry={chartApi.refetch} />}
                    <Suspense fallback={<SkeletonLoader variant="chart" label="Loading fund charts" />}>
                        <FundManagerCharts funds={funds} allocationEntries={allocationEntries} />
                    </Suspense>
                </>
            )}
        </div>
    );
}

export default FundAnalytics;
