import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import { getFundPerformance } from "../../services/fundManagerApi";
import { useAuth } from "../../context/AuthContext";
import { StatCard } from "../../components/ui/Card";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import ErrorState from "../../components/ui/ErrorState";
import LoadingState from "../../components/ui/LoadingState";
import "./fund-manager-dashboard.css";

const MANAGER_LINKS = [
    { key: "funds", to: "/manager/funds" },
    { key: "analytics", to: "/manager/analytics" },
    { key: "withdrawals", to: "/manager/withdrawal-requests" },
    { key: "reports", to: "/manager/reports" },
    { key: "audit", to: "/manager/audit-logs" },
    { key: "profile", to: "/manager/profile" },
];

function formatCurrency(value, locale, unavailable) {
    if (value === undefined || value === null || value === "" || !Number.isFinite(Number(value))) return unavailable;
    return `KSh ${Number(value).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCount(value, locale, unavailable) {
    return value !== undefined && value !== null && Number.isFinite(Number(value))
        ? Number(value).toLocaleString(locale)
        : unavailable;
}

function formatPercentage(value, locale, unavailable) {
    if (value === undefined || value === null || value === "" || !Number.isFinite(Number(value))) return unavailable;
    return `${Number(value).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function FundManagerDashboard() {
    const { t, i18n } = useTranslation();
    const { user } = useAuth();
    const performanceApi = useApi(getFundPerformance, []);
    const performance = performanceApi.data;
    const firstName = user?.full_name?.trim().split(/\s+/)[0];
    const locale = i18n.resolvedLanguage?.startsWith("sw") ? "sw-KE" : "en-KE";

    return (
        <div className="fund-manager-dashboard">
            <header className="page-header fund-manager-dashboard-header">
                <div>
                    <p className="fund-manager-eyebrow">{t("dashboards.manager.eyebrow")}</p>
                    <h1 className="page-title">
                        {firstName ? t("dashboards.welcome", { name: firstName }) : t("dashboards.manager.title")}
                    </h1>
                    <p className="page-subtitle">{t("dashboards.manager.subtitle")}</p>
                </div>
            </header>

            <section aria-label={t("dashboards.manager.summary")}>
                {performanceApi.refreshing && <LoadingState message={t("dashboards.manager.refreshing")} />}
                {performanceApi.loading && performanceApi.data === null ? (
                    <SkeletonLoader variant="metrics" count={4} label={t("dashboards.manager.loading")} />
                ) : performanceApi.error && performanceApi.data === null ? (
                    <ErrorState title={t("dashboards.manager.errorTitle")} message={t("dashboards.manager.loadError")} onRetry={performanceApi.refetch} />
                ) : (
                    <>
                        {performanceApi.error && <ErrorState title={t("dashboards.manager.errorTitle")} message={t("dashboards.manager.loadError")} onRetry={performanceApi.refetch} />}
                        <div className="stat-card-grid fund-manager-summary">
                            <StatCard label={t("dashboards.manager.totalBalances")} value={formatCurrency(performance?.total_assets, locale, t("analytics.unavailable"))} hint={t("dashboards.manager.allBalances")} />
                            <StatCard label={t("dashboards.manager.activeAccounts")} value={formatCount(performance?.active_accounts, locale, t("analytics.unavailable"))} />
                            <StatCard label={t("dashboards.manager.managedFunds")} value={formatCount(performance?.funds_managed, locale, t("analytics.unavailable"))} />
                            <StatCard label={t("dashboards.manager.averageReturn")} value={formatPercentage(performance?.average_yield, locale, t("analytics.unavailable"))} hint={t("dashboards.manager.configuredReturn")} />
                        </div>
                    </>
                )}
            </section>

            <nav className="fund-manager-dashboard-section fund-manager-quick-links" aria-label={t("dashboards.manager.workspace")}>
                <p className="fund-manager-eyebrow">{t("dashboards.manager.workspace")}</p>
                <h2>{t("dashboards.manager.goToFeature")}</h2>
                <ul>
                    {MANAGER_LINKS.map((item) => (
                        <li key={item.to}>
                            <Link to={item.to}>
                                <span>{t(`dashboards.manager.links.${item.key}`)}</span>
                                <small>{t(`dashboards.manager.links.${item.key}Description`)}</small>
                            </Link>
                        </li>
                    ))}
                </ul>
            </nav>
        </div>
    );
}

export default FundManagerDashboard;
