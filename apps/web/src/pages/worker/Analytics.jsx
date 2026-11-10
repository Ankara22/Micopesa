import { lazy, Suspense, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import { downloadMyStatement, getMyBalance, getMyContributions } from "../../services/accountService";
import ErrorState from "../../components/ui/ErrorState";
import LoadingState from "../../components/ui/LoadingState";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import { StatCard } from "../../components/ui/Card";
import Button from "../../components/ui/Button";
import { formatKes } from "../../i18n/formatters";
import "../analytics/analytics.css";

const WorkerAnalyticsCharts = lazy(() => import("../analytics/AnalyticsCharts")
    .then(({ WorkerAnalyticsCharts: Charts }) => ({ default: Charts })));

function getContributionDate(contribution) {
    const value = contribution?.created_at;
    if (typeof value !== "string" || !value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function WorkerAnalytics() {
    const { t, i18n } = useTranslation();
    const balanceApi = useApi(getMyBalance, []);
    const contributionsApi = useApi(getMyContributions, []);
    const [filters, setFilters] = useState({ startDate: "", endDate: "", status: "" });
    const [downloading, setDownloading] = useState(false);
    const [statementError, setStatementError] = useState("");
    const contributions = useMemo(
        () => Array.isArray(contributionsApi.data) ? contributionsApi.data : [],
        [contributionsApi.data]
    );
    const statuses = [...new Set(contributions
        .map((item) => item.contribution_status)
        .filter((status) => typeof status === "string" && status.length > 0))];
    const filteredContributions = useMemo(() => contributions.filter((contribution) => {
        const date = getContributionDate(contribution);
        const dateKey = date?.toISOString().slice(0, 10);
        if (filters.startDate && (!dateKey || dateKey < filters.startDate)) return false;
        if (filters.endDate && (!dateKey || dateKey > filters.endDate)) return false;
        if (filters.status && contribution.contribution_status !== filters.status) return false;
        return true;
    }), [contributions, filters]);
    const monthlyTotals = useMemo(() => {
        const monthly = new Map();
        filteredContributions
            .filter((item) =>
                item.contribution_status === "COMPLETED" && item.transaction_status === "COMPLETED"
            )
            .forEach((item) => {
                const date = getContributionDate(item);
                const amount = Number(item.amount);
                if (!date || !Number.isFinite(amount)) return;
                const month = date.toISOString().slice(0, 7);
                monthly.set(month, (monthly.get(month) || 0) + amount);
            });
        return [...monthly.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([month, amount]) => ({ month, amount }));
    }, [filteredContributions]);
    const statusCounts = useMemo(() => {
        const counts = new Map();
        filteredContributions.forEach(({ contribution_status }) => {
            if (typeof contribution_status !== "string" || !contribution_status) return;
            counts.set(contribution_status, (counts.get(contribution_status) || 0) + 1);
        });
        return [...counts.entries()].map(([label, count]) => ({ label, count }));
    }, [filteredContributions]);
    const completedContributions = filteredContributions.filter((item) =>
        item.contribution_status === "COMPLETED" && item.transaction_status === "COMPLETED"
    );
    const completedTotal = completedContributions.reduce((total, item) => {
        const amount = Number(item.amount);
        return total + (Number.isFinite(amount) ? amount : 0);
    }, 0);

    async function downloadStatement(format) {
        setDownloading(true);
        setStatementError("");
        try {
            const response = await downloadMyStatement(format, {
                ...(filters.startDate ? { start_date: filters.startDate } : {}),
                ...(filters.endDate ? { end_date: filters.endDate } : {}),
                ...(filters.status ? { contribution_status: filters.status } : {}),
            });
            const url = URL.createObjectURL(response.data);
            const link = document.createElement("a");
            link.href = url;
            link.download = `micopesa-my-statement.${format.toLowerCase()}`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch {
            setStatementError(t("analytics.statementError"));
        } finally {
            setDownloading(false);
        }
    }

    return (
        <div className="role-analytics-page">
            <header className="page-header">
                <div>
                    <h1 className="page-title">{t("analytics.workerTitle")}</h1>
                    <p className="page-subtitle">{t("analytics.workerSubtitle")}</p>
                </div>
            </header>
            <Link className="analytics-navigation" to="/worker/dashboard">{t("analytics.backDashboard")}</Link>

            {contributionsApi.refreshing && <LoadingState message={t("analytics.refreshingWorker")} />}
            {contributionsApi.loading && contributionsApi.data === null ? (
                <SkeletonLoader variant="chart" count={2} label={t("analytics.loadingWorker")} />
            ) : contributionsApi.error && contributionsApi.data === null ? (
                <ErrorState title={t("analytics.errorTitle")} message={t("analytics.workerLoadError")} onRetry={contributionsApi.refetch} />
            ) : (
                <>
                    {contributionsApi.error && <ErrorState title={t("analytics.errorTitle")} message={t("analytics.workerLoadError")} onRetry={contributionsApi.refetch} />}
                    {balanceApi.loading && balanceApi.data === null ? (
                        <SkeletonLoader variant="metrics" count={3} label={t("analytics.financialSummaryLoading")} />
                    ) : balanceApi.error && balanceApi.data === null ? (
                        <ErrorState title={t("analytics.errorTitle")} message={t("analytics.balanceUnavailable")} onRetry={balanceApi.refetch} />
                    ) : (
                        <div className="stat-card-grid">
                            <StatCard
                                label={t("analytics.availableBalance")}
                                value={formatKes(balanceApi.data?.current_balance, i18n.resolvedLanguage) || t("analytics.unavailable")}
                            />
                            <StatCard
                                label={t("analytics.completedCount")}
                                value={completedContributions.length}
                            />
                            <StatCard
                                label={t("analytics.completedAmount")}
                                value={formatKes(completedTotal, i18n.resolvedLanguage) || "KSh 0.00"}
                            />
                        </div>
                    )}
                    <section className="analytics-filter-bar" aria-label={t("analytics.filterWorker")}>
                        <label>
                            <span>{t("analytics.fromDate")}</span>
                            <input
                                type="date"
                                value={filters.startDate}
                                onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value }))}
                            />
                        </label>
                        <label>
                            <span>{t("analytics.toDate")}</span>
                            <input
                                type="date"
                                value={filters.endDate}
                                onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value }))}
                            />
                        </label>
                        <label>
                            <span>{t("analytics.contributionStatus")}</span>
                            <select
                                value={filters.status}
                                onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
                            >
                                <option value="">{t("analytics.allStatuses")}</option>
                                {statuses.map((status) => (
                                    <option key={status} value={status}>
                                        {t(`analytics.status.${status}`, { defaultValue: status })}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <button
                            className="analytics-filter-reset"
                            type="button"
                            onClick={() => setFilters({ startDate: "", endDate: "", status: "" })}
                        >
                            {t("analytics.clearFilters")}
                        </button>
                    </section>
                    <section aria-label={t("analytics.downloadSection")} className="analytics-filter-bar">
                        {["CSV", "XLSX", "PDF"].map((format) => (
                            <Button
                                key={format}
                                variant="secondary"
                                disabled={downloading}
                                onClick={() => downloadStatement(format)}
                            >
                                {downloading
                                    ? t("analytics.preparingStatement")
                                    : t("analytics.download", { format })}
                            </Button>
                        ))}
                        {statementError && <p role="alert">{statementError}</p>}
                    </section>
                    {filteredContributions.length === 0 ? (
                        <p className="dashboard-chart-empty">
                            {contributions.length === 0 ? t("analytics.noWorkerRecords") : t("analytics.noWorkerMatches")}
                        </p>
                    ) : (
                        <Suspense fallback={<SkeletonLoader variant="chart" count={2} label={t("analytics.chartLoading")} />}>
                            <WorkerAnalyticsCharts monthlyTotals={monthlyTotals} statusCounts={statusCounts} />
                        </Suspense>
                    )}
                </>
            )}
        </div>
    );
}

export default WorkerAnalytics;
