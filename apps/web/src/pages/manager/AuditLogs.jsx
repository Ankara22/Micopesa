import AuditLogsPanel from "../../components/AuditLogsPanel";
import { getOperationalLogs } from "../../services/auditLogService";

function AuditLogs() {
    return (
        <AuditLogsPanel
            title="Operational Audit Logs"
            subtitle="Recent platform activity relevant to fund operations."
            fetcher={getOperationalLogs}
        />
    );
}

export default AuditLogs;
