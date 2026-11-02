import useApi from "../../hooks/useApi";
import { getActivitySummary, listSessions } from "../../services/adminService";
import DataTable from "../../components/ui/DataTable";
import ErrorState from "../../components/ui/ErrorState";
import LoadingState from "../../components/ui/LoadingState";
import { AdminCard, AdminPage } from "../../components/AdminPage";

function getCount(value) {
    const count = Number(value);
    return Number.isFinite(count) ? count : 0;
}

function SystemActivity() {
    const summaryApi = useApi(getActivitySummary, []);
    const sessionsApi = useApi(listSessions, []);
    const summary = summaryApi.data;
    const usersByStatus = summary?.users_by_status || [];
    const getStatusCount = (status) => getCount(
        usersByStatus.find((item) => item.account_status === status)?.count
    );
    const auditActions = [...(summary?.audit_actions_last_24h || [])]
        .sort((left, right) => left.action_type.localeCompare(right.action_type));

    const columns = [
        { key: "full_name", header: "User" },
        { key: "phone", header: "Phone" },
        {
            key: "session_status",
            header: "Status",
            render: (row) => {
                const status = row.session_status === "EXPIRED" ? "TIMED OUT" : row.session_status;
                return <span className="admin-status-pill" data-status={status}>{status}</span>;
            },
        },
        { key: "started_at", header: "Started", render: (row) => new Date(row.started_at).toLocaleString() },
        { key: "ended_at", header: "Ended", render: (row) => row.ended_at ? new Date(row.ended_at).toLocaleString() : "—" },
    ];

    const metrics = [
        { label: "Active USSD sessions", value: getCount(summary?.active_sessions) },
        { label: "Users: active", value: getStatusCount("ACTIVE") },
        { label: "Users: suspended", value: getStatusCount("SUSPENDED") },
        {
            label: "Audit actions, 24 hours",
            value: auditActions.reduce((total, item) => total + getCount(item.count), 0),
        },
    ];

    return (
        <AdminPage
            title="System activity"
            subtitle="Recent platform activity, account status totals, and recorded USSD sessions."
        >
            <div className="admin-stack">
                <section className="admin-metric-grid" aria-label="Activity summary" aria-busy={summaryApi.loading}>
                    {summaryApi.loading && summary === null ? (
                        <div className="admin-card admin-span-all"><LoadingState message="Loading system activity..." /></div>
                    ) : summaryApi.error && summary === null ? (
                        <div className="admin-span-all"><ErrorState message={summaryApi.error} onRetry={summaryApi.refetch} /></div>
                    ) : (
                        metrics.map((metric) => (
                            <article className="admin-metric-card" key={metric.label}>
                                <span className="admin-metric-label">{metric.label}</span>
                                <strong className="admin-metric-value">{metric.value}</strong>
                            </article>
                        ))
                    )}
                </section>

                {summaryApi.error && summary !== null && <ErrorState message={summaryApi.error} onRetry={summaryApi.refetch} />}

                <AdminCard title="Audit actions, last 24 hours">
                    {auditActions.length === 0 ? (
                        <p className="admin-hint">No audit actions were recorded in the last 24 hours.</p>
                    ) : (
                        <ul className="admin-activity-list">
                            {auditActions.map((action) => (
                                <li key={action.action_type}>
                                    <span className="admin-status-pill">{action.action_type}</span>
                                    <strong>{getCount(action.count)}</strong>
                                </li>
                            ))}
                        </ul>
                    )}
                </AdminCard>

                <AdminCard title="USSD sessions" description="Session records are visible only while retained in the system.">
                    <DataTable
                        columns={columns}
                        rows={sessionsApi.data}
                        rowKey="session_id"
                        loading={sessionsApi.loading}
                        refreshing={sessionsApi.refreshing}
                        error={sessionsApi.error}
                        onRetry={sessionsApi.refetch}
                        emptyMessage="No USSD sessions recorded."
                    />
                </AdminCard>
            </div>
        </AdminPage>
    );
}

export default SystemActivity;
