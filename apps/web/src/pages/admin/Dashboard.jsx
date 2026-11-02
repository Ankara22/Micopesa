import { Link } from "react-router-dom";
import useApi from "../../hooks/useApi";
import { getActivitySummary } from "../../services/adminService";
import { useAuth } from "../../context/AuthContext";
import { StatCard } from "../../components/ui/Card";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import LoadingState from "../../components/ui/LoadingState";
import ErrorState from "../../components/ui/ErrorState";
import "./admin-dashboard.css";

const ADMIN_LINKS = [
    { label: "User Management", description: "Review accounts and update status.", to: "/admin/users" },
    { label: "Roles & Permissions", description: "Manage user roles and access.", to: "/admin/roles" },
    { label: "System Settings", description: "Manage configured platform settings.", to: "/admin/settings" },
    { label: "Notifications", description: "Compose and review notifications.", to: "/admin/notifications" },
    { label: "System Activity", description: "Review recorded activity and sessions.", to: "/admin/activity" },
    { label: "Audit Logs", description: "Review recorded system actions.", to: "/admin/audit-logs" },
    { label: "Profile", description: "View your administrator profile.", to: "/admin/profile" },
];

function getCount(value) {
    const count = Number(value);
    return Number.isFinite(count) ? count : 0;
}

function AdminDashboard() {
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
                    <p className="admin-dashboard-eyebrow">Administration</p>
                    <h1 className="page-title">{firstName ? `Welcome, ${firstName}` : "Admin Dashboard"}</h1>
                    <p className="page-subtitle">A concise overview of platform accounts and recorded activity.</p>
                </div>
            </header>

            <section className="admin-dashboard-section" aria-label="Platform summary">
                {summaryApi.refreshing && <LoadingState message="Refreshing platform summary..." />}
                {summaryApi.loading && summaryApi.data === null ? (
                    <SkeletonLoader variant="metrics" count={4} label="Loading platform summary" />
                ) : summaryApi.error && summaryApi.data === null ? (
                    <ErrorState message={summaryApi.error} onRetry={summaryApi.refetch} />
                ) : (
                    <>
                        {summaryApi.error && <ErrorState message={summaryApi.error} onRetry={summaryApi.refetch} />}
                        <div className="stat-card-grid admin-dashboard-stats">
                            <StatCard label="Total users" value={totalUsers} />
                            <StatCard label="Active users" value={activeUsers} />
                            <StatCard label="Active USSD sessions" value={getCount(summary?.active_sessions)} />
                            <StatCard label="Audit actions (24 hours)" value={auditActionCount} />
                        </div>
                    </>
                )}
            </section>

            <nav className="admin-dashboard-card admin-dashboard-navigation" aria-label="Administration pages">
                <p className="admin-dashboard-eyebrow">Administration</p>
                <h2>Go to a feature</h2>
                <ul>
                    {ADMIN_LINKS.map((item) => (
                        <li key={item.to}>
                            <Link to={item.to}>
                                <span>{item.label}</span>
                                <small>{item.description}</small>
                            </Link>
                        </li>
                    ))}
                </ul>
            </nav>
        </div>
    );
}

export default AdminDashboard;
