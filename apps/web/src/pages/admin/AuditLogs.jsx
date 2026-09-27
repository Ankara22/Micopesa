import AuditLogsPanel from "../../components/AuditLogsPanel";
import { getSystemLogs } from "../../services/auditLogService";

function AuditLogs() {
    return (
        <AuditLogsPanel
            title="System Audit Logs"
            subtitle="Full, unrestricted platform audit trail."
            fetcher={getSystemLogs}
        />
    );
}

export default AuditLogs;
