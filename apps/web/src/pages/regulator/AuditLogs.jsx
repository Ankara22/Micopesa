import AuditLogsPanel from "../../components/AuditLogsPanel";
import { getOperationalLogs } from "../../services/auditLogService";

function AuditLogs() {
    return (
        <AuditLogsPanel
            title="Operational Audit Logs"
            subtitle="Recent platform activity relevant to compliance oversight."
            fetcher={getOperationalLogs}
        />
    );
}

export default AuditLogs;
