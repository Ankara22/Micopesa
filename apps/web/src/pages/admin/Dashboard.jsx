import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import { getActivitySummary } from "../../services/adminService";
import { useAuth } from "../../context/AuthContext";
import { StatCard } from "../../components/ui/Card";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import LoadingState from "../../components/ui/LoadingState";
import ErrorState from "../../components/ui/ErrorState";
import "./admin-dashboard.css";

const ADMIN_LINKS = [
    { key: "analytics", to: "/admin/analytics" },
    { key: "users", to: "/admin/users" },
    { key: "roles", to: "/admin/roles" },
    { key: "settings", to: "/admin/settings" },
    { key: "notifications", to: "/admin/notifications" },
    { key: "activity", to: "/admin/activity" },
    { key: "audit", to: "/admin/audit-logs" },
    { key: "profile", to: "/admin/profile" },
];

function getCount(value) {
    const count = Number(value);
    return Number.isFinite(count) ? count : 0;
}

function AdminDashboard() {
    const { t, i18n } = useTranslation();
    const { user } = useAuth();
    const summaryApi = useApi(getActivitySummary, []);
    const summary = summaryApi.data;
    const usersByStatus = summary?.users_by_status || [];
    const totalUsers = usersByStatus.reduce((total, item) => total + getCount(item.count), 0);
    const activeUsers = getCount(usersByStatus.find((item) => item.account_status === "ACTIVE")?.count);
    const auditActionCount = (summary?.audit_actions_last_24h || [])
        .reduce((total, item) => total + getCount(item.count), 0);
    const firstName = user?.full_name?.trim().split(/\s+/)[0];

    return (
        <div className="admin-dashboard">
            <header className="page-header admin-dashboard-header">
                <div>
                    <p className="admin-dashboard-eyebrow">{t("dashboards.admin.eyebrow")}</p>
                    <h1 className="page-title">
                        {firstName ? t("dashboards.welcome", { name: firstName }) : t("dashboards.admin.title")}
                    </h1>
                    <p className="page-subtitle">{t("dashboards.admin.subtitle")}</p>
                </div>
            </header>

            <section className="admin-dashboard-section" aria-label={t("dashboards.admin.summary")}>
                {summaryApi.refreshing && <LoadingState message={t("dashboards.admin.refreshing")} />}
                {summaryApi.loading && summaryApi.data === null ? (
                    <SkeletonLoader variant="metrics" count={4} label={t("dashboards.admin.loading")} />
                ) : summaryApi.error && summaryApi.data === null ? (
                    <ErrorState title={t("dashboards.admin.errorTitle")} message={t("dashboards.admin.loadError")} onRetry={summaryApi.refetch} />
                ) : (
                    <>
                        {summaryApi.error && <ErrorState title={t("dashboards.admin.errorTitle")} message={t("dashboards.admin.loadError")} onRetry={summaryApi.refetch} />}
                        <div className="stat-card-grid admin-dashboard-stats">
                            <StatCard label={t("dashboards.admin.totalUsers")} value={new Intl.NumberFormat(i18n.resolvedLanguage === "sw" ? "sw-KE" : "en-KE").format(totalUsers)} />
                            <StatCard label={t("dashboards.admin.activeUsers")} value={new Intl.NumberFormat(i18n.resolvedLanguage === "sw" ? "sw-KE" : "en-KE").format(activeUsers)} />
                            <StatCard label={t("dashboards.admin.activeSessions")} value={new Intl.NumberFormat(i18n.resolvedLanguage === "sw" ? "sw-KE" : "en-KE").format(getCount(summary?.active_sessions))} />
                            <StatCard label={t("dashboards.admin.auditActions")} value={new Intl.NumberFormat(i18n.resolvedLanguage === "sw" ? "sw-KE" : "en-KE").format(auditActionCount)} />
                        </div>
                    </>
                )}
            </section>

            <nav className="admin-dashboard-card admin-dashboard-navigation" aria-label={t("dashboards.admin.eyebrow")}>
                <p className="admin-dashboard-eyebrow">{t("dashboards.admin.eyebrow")}</p>
                <h2>{t("dashboards.admin.goToFeature")}</h2>
                <ul>
                    {ADMIN_LINKS.map((item) => (
                        <li key={item.to}>
                            <Link to={item.to}>
                                <span>{t(`dashboards.admin.links.${item.key}`)}</span>
                                <small>{t(`dashboards.admin.links.${item.key}Description`)}</small>
                            </Link>
                        </li>
                    ))}
                </ul>
            </nav>
        </div>
    );
}

export default AdminDashboard;
