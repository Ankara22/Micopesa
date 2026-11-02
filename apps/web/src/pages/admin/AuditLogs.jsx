import { useMemo, useState } from "react";
import useApi from "../../hooks/useApi";
import { getSystemLogs } from "../../services/auditLogService";
import DataTable from "../../components/ui/DataTable";
import { AdminCard, AdminPage } from "../../components/AdminPage";

const ACTION_FILTERS = ["All", "CREATE", "UPDATE", "DELETE", "LOGIN", "LOGOUT", "APPROVE", "REJECT"];

function AuditLogs() {
    const logsApi = useApi(getSystemLogs, []);
    const [activeFilter, setActiveFilter] = useState("All");
    const filteredRows = useMemo(
        () => (logsApi.data || []).filter((row) =>
            activeFilter === "All" || row.action_type === activeFilter
        ),
        [logsApi.data, activeFilter]
    );

    const columns = [
        { key: "timestamp", header: "When", render: (row) => new Date(row.timestamp).toLocaleString() },
        { key: "full_name", header: "Who", render: (row) => row.full_name || "System" },
        {
            key: "action_type",
            header: "Action",
            render: (row) => <span className="admin-status-pill">{row.action_type}</span>,
        },
        {
            key: "record",
            header: "Record",
            render: (row) => (
                <span>
                    {row.entity_name} · {row.entity_id}
                    {row.details?.key && (
                        <small className="admin-audit-detail">
                            {row.details.key}: {String(row.details.old_value)} → {String(row.details.new_value)}
                        </small>
                    )}
                </span>
            ),
        },
    ];

    return (
        <AdminPage
            title="System audit logs"
            subtitle="Immutable system records of administrative and operational actions."
        >
            <AdminCard title="Log entries">
                <div className="admin-filter-pills admin-audit-filters" role="group" aria-label="Filter audit actions">
                    {ACTION_FILTERS.map((filter) => (
                        <button
                            type="button"
                            className="admin-filter-pill"
                            aria-pressed={activeFilter === filter}
                            key={filter}
                            onClick={() => setActiveFilter(filter)}
                        >
                            {filter}
                        </button>
                    ))}
                </div>
                <DataTable
                    columns={columns}
                    rows={logsApi.data === null ? null : filteredRows}
                    rowKey="log_id"
                    loading={logsApi.loading}
                    refreshing={logsApi.refreshing}
                    error={logsApi.error}
                    onRetry={logsApi.refetch}
                    emptyMessage="No audit log entries match this filter."
                />
            </AdminCard>
        </AdminPage>
    );
}

export default AuditLogs;
