import useApi from "../hooks/useApi";
import DataTable from "./ui/DataTable";

const COLUMNS = [
    { key: "timestamp", header: "Timestamp", render: (row) => new Date(row.timestamp).toLocaleString() },
    { key: "full_name", header: "User", render: (row) => row.full_name || "System" },
    { key: "user_role", header: "Role" },
    { key: "action_type", header: "Action" },
    { key: "entity_name", header: "Entity" },
    { key: "entity_id", header: "Entity ID" },
];

/**
 * Shared panel for audit-log viewing. `fetcher` is either
 * auditLogService.getOperationalLogs (FUND_MANAGER/REGULATOR) or
 * getSystemLogs (ADMIN) - both read the same underlying audit_logs table;
 * see the backend's auditLogController.js for that documented decision.
 */
function AuditLogsPanel({ title, subtitle, fetcher }) {
    const logsApi = useApi(fetcher, []);

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">{title}</h1>
                    <p className="page-subtitle">{subtitle}</p>
                </div>
            </div>

            <DataTable
                columns={COLUMNS}
                rows={logsApi.data}
                rowKey="log_id"
                loading={logsApi.loading}
                error={logsApi.error}
                onRetry={logsApi.refetch}
                emptyMessage="No audit log entries found."
            />
        </div>
    );
}

export default AuditLogsPanel;
