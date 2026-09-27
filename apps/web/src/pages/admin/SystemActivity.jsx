import useApi from "../../hooks/useApi";
import { getActivitySummary, listSessions } from "../../services/adminService";
import { StatCard } from "../../components/ui/Card";
import DataTable from "../../components/ui/DataTable";
import StatusBadge from "../../components/ui/StatusBadge";
import LoadingState from "../../components/ui/LoadingState";
import ErrorState from "../../components/ui/ErrorState";

const COLUMNS = [
    { key: "full_name", header: "User" },
    { key: "phone", header: "Phone" },
    { key: "session_status", header: "Status", render: (row) => <StatusBadge status={row.session_status} /> },
    { key: "started_at", header: "Started", render: (row) => new Date(row.started_at).toLocaleString() },
    { key: "ended_at", header: "Ended", render: (row) => (row.ended_at ? new Date(row.ended_at).toLocaleString() : "-") },
];

function SystemActivity() {
    const summaryApi = useApi(getActivitySummary, []);
    const sessionsApi = useApi(listSessions, []);

    if (summaryApi.loading) return <LoadingState message="Loading system activity..." />;
    if (summaryApi.error) return <ErrorState message={summaryApi.error} onRetry={summaryApi.refetch} />;

    const summary = summaryApi.data || {};

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">System Activity</h1>
                    <p className="page-subtitle">Live snapshot of platform-wide activity.</p>
                </div>
            </div>

            <div className="stat-card-grid">
                <StatCard label="Active USSD Sessions" value={summary.active_sessions ?? 0} />
                {(summary.users_by_status || []).map((s) => (
                    <StatCard key={s.account_status} label={`Users: ${s.account_status}`} value={s.count} />
                ))}
            </div>

            <div className="section">
                <h2 className="card-title">Audit actions (last 24 hours)</h2>
                {(summary.audit_actions_last_24h || []).length === 0 ? (
                    <div className="state-block">
                        <span>No audit actions recorded in the last 24 hours.</span>
                    </div>
                ) : (
                    <ul>
                        {summary.audit_actions_last_24h.map((a) => (
                            <li key={a.action_type}>
                                {a.action_type}: {a.count}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="section">
                <h2 className="card-title">USSD sessions</h2>
                <DataTable
                    columns={COLUMNS}
                    rows={sessionsApi.data}
                    rowKey="session_id"
                    loading={sessionsApi.loading}
                    error={sessionsApi.error}
                    onRetry={sessionsApi.refetch}
                    emptyMessage="No USSD sessions recorded."
                />
            </div>
        </div>
    );
}

export default SystemActivity;
