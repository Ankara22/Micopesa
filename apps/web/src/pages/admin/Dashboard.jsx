import { Link } from "react-router-dom";
import useApi from "../../hooks/useApi";
import { getActivitySummary } from "../../services/adminService";
import { getSystemLogs } from "../../services/auditLogService";
import { useAuth } from "../../context/AuthContext";
import { StatCard } from "../../components/ui/Card";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import LoadingState from "../../components/ui/LoadingState";
import ErrorState from "../../components/ui/ErrorState";
import StatusBadge from "../../components/ui/StatusBadge";
import "./admin-dashboard.css";

const ADMIN_LINKS = [
    { label: "User Management", description: "Review accounts and update status.", to: "/admin/users" },
    { label: "Roles & Permissions", description: "Manage user roles and access.", to: "/admin/roles" },
    { label: "Audit Logs", description: "Review recorded system actions.", to: "/admin/audit-logs" },
    { label: "System Activity", description: "View USSD sessions and activity counts.", to: "/admin/activity" },
    { label: "Notifications", description: "Compose and review notifications.", to: "/admin/notifications" },
    { label: "System Settings", description: "Manage configured platform settings.", to: "/admin/settings" },
];

function formatTimestamp(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString();
}

function getCount(value) {
    const count = Number(value);
    return Number.isFinite(count) ? count : 0;
}

function AdminDashboard() {
    const { user } = useAuth();
    const summaryApi = useApi(getActivitySummary, []);
    const auditApi = useApi(getSystemLogs, []);
    const summary = summaryApi.data;
    const usersByStatus = summary?.users_by_status || [];
    const totalUsers = usersByStatus.reduce((total, item) => total + getCount(item.count), 0);
    const activeUsers = getCount(usersByStatus.find((item) => item.account_status === "ACTIVE")?.count);
    const recentAuditActions = summary?.audit_actions_last_24h || [];
    const auditActionCount = recentAuditActions.reduce((total, item) => total + getCount(item.count), 0);
    const recentLogs = (auditApi.data || []).slice(0, 5);
    const firstName = user?.full_name?.trim().split(/\s+/)[0];

    return (
        <div className="admin-dashboard">
            <header className="page-header admin-dashboard-header">
                <div>
                    <p className="admin-dashboard-eyebrow">Administration</p>
                    <h1 className="page-title">
                        {firstName ? `Welcome, ${firstName}` : "Admin Dashboard"}
                    </h1>
                    <p className="page-subtitle">A clear overview of accounts and recent system activity.</p>
                </div>
            </header>

            <section className="admin-dashboard-section" aria-label="Platform summary">
                {summaryApi.loading ? (
                    <SkeletonLoader variant="metrics" count={4} label="Loading platform summary" />
                ) : summaryApi.error ? (
                    <ErrorState message={summaryApi.error} onRetry={summaryApi.refetch} />
                ) : (
                    <>
                        <div className="stat-card-grid admin-dashboard-stats">
                            <StatCard label="Total users" value={totalUsers} />
                            <StatCard label="Active users" value={activeUsers} />
                            <StatCard label="Active USSD sessions" value={getCount(summary.active_sessions)} />
                            <StatCard label="Audit actions (24 hours)" value={auditActionCount} />
                        </div>
                        <section className="admin-dashboard-card" aria-labelledby="admin-user-status-title">
                            <div className="admin-dashboard-section-heading">
                                <div>
                                    <p className="admin-dashboard-eyebrow">Accounts</p>
                                    <h2 id="admin-user-status-title">Users by status</h2>
                                </div>
                                <Link className="admin-dashboard-link" to="/admin/users">Manage users</Link>
                            </div>
                            {usersByStatus.length ? (
                                <ul className="admin-dashboard-status-list">
                                    {usersByStatus.map((item) => (
                                        <li key={item.account_status}>
                                            <StatusBadge status={item.account_status} />
                                            <strong>{getCount(item.count)}</strong>
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="admin-dashboard-empty">No user account statuses are available.</p>
                            )}
                        </section>
                    </>
                )}
            </section>

            <div className="admin-dashboard-content">
                <section className="admin-dashboard-card admin-dashboard-activity" aria-labelledby="admin-recent-activity-title">
                    <div className="admin-dashboard-section-heading">
                        <div>
                            <p className="admin-dashboard-eyebrow">Recorded events</p>
                            <h2 id="admin-recent-activity-title">Recent system activity</h2>
                        </div>
                        <Link className="admin-dashboard-link" to="/admin/audit-logs">View audit logs</Link>
                    </div>
                    {auditApi.loading ? (
                        <LoadingState message="Loading recent audit activity..." />
                    ) : auditApi.error ? (
                        <ErrorState message={auditApi.error} onRetry={auditApi.refetch} />
                    ) : recentLogs.length ? (
                        <ol className="admin-dashboard-audit-list">
                            {recentLogs.map((log) => (
                                <li key={log.log_id}>
                                    <div className="admin-dashboard-audit-copy">
                                        <strong>{log.action_type}</strong>
                                        <span>
                                            {(log.full_name || "System")} · {log.entity_name || "Record"}
                                        </span>
                                    </div>
                                    <time dateTime={log.timestamp}>{formatTimestamp(log.timestamp)}</time>
                                </li>
                            ))}
                        </ol>
                    ) : (
                        <p className="admin-dashboard-empty">No system audit activity has been recorded.</p>
                    )}
                </section>

                <nav className="admin-dashboard-card admin-dashboard-navigation" aria-labelledby="admin-quick-links-title">
                    <p className="admin-dashboard-eyebrow">Administration</p>
                    <h2 id="admin-quick-links-title">Quick access</h2>
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
        </div>
    );
}

export default AdminDashboard;
