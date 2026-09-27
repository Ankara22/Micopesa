import { Link } from "react-router-dom";
import useApi from "../../hooks/useApi";
import { getActivitySummary } from "../../services/adminService";
import { StatCard } from "../../components/ui/Card";
import LoadingState from "../../components/ui/LoadingState";
import ErrorState from "../../components/ui/ErrorState";
import Button from "../../components/ui/Button";

function AdminDashboard() {
    const summaryApi = useApi(getActivitySummary, []);

    if (summaryApi.loading) return <LoadingState message="Loading system overview..." />;
    if (summaryApi.error) return <ErrorState message={summaryApi.error} onRetry={summaryApi.refetch} />;

    const summary = summaryApi.data || {};
    const activeUsers = (summary.users_by_status || []).find((s) => s.account_status === "ACTIVE")?.count || 0;
    const totalUsers = (summary.users_by_status || []).reduce((sum, s) => sum + s.count, 0);

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Admin Dashboard</h1>
                    <p className="page-subtitle">Platform-wide system overview.</p>
                </div>
            </div>

            <div className="stat-card-grid">
                <StatCard label="Total Users" value={totalUsers} />
                <StatCard label="Active Users" value={activeUsers} />
                <StatCard label="Active USSD Sessions" value={summary.active_sessions ?? 0} />
                <StatCard
                    label="Audit Actions (24h)"
                    value={(summary.audit_actions_last_24h || []).reduce((sum, a) => sum + a.count, 0)}
                />
            </div>

            <div className="section card">
                <h2 className="card-title">Quick actions</h2>
                <div className="form-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
                    <Link to="/admin/users">
                        <Button variant="primary">Manage Users</Button>
                    </Link>
                    <Link to="/admin/settings">
                        <Button variant="secondary">System Settings</Button>
                    </Link>
                    <Link to="/admin/notifications">
                        <Button variant="secondary">Send Notification</Button>
                    </Link>
                </div>
            </div>
        </div>
    );
}

export default AdminDashboard;
