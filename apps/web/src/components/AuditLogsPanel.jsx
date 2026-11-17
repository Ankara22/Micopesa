import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import useApi from "../hooks/useApi";
import DataTable from "./ui/DataTable";
import Button from "./ui/Button";
import "./AuditLogsPanel.css";

/**
 * Shared panel for audit-log viewing. `fetcher` is either
 * auditLogService.getOperationalLogs (FUND_MANAGER/REGULATOR) or
 * getSystemLogs (ADMIN) - both read the same underlying audit_logs table;
 * see the backend's auditLogController.js for that documented decision.
 */
function AuditLogsPanel({ title, subtitle, fetcher, redacted = false }) {
    const { t, i18n } = useTranslation();
    const [filters, setFilters] = useState({ start_date: "", end_date: "", action_type: "", category: "" });
    const [appliedFilters, setAppliedFilters] = useState({});
    const [page, setPage] = useState(1);
    const fetchLogs = useCallback(
        () => fetcher({ ...appliedFilters, page, page_size: 50 }),
        [appliedFilters, fetcher, page]
    );
    const logsApi = useApi(fetchLogs, [fetchLogs]);
    const rows = Array.isArray(logsApi.data) ? logsApi.data : logsApi.data?.rows;
    const pagination = logsApi.data?.pagination || { page: 1, total_pages: 0 };
    const locale = i18n.resolvedLanguage?.startsWith("sw") ? "sw-KE" : "en-KE";
    const columns = [
        { key: "timestamp", header: t("auditLogs.timestamp"), render: (row) => new Date(row.timestamp).toLocaleString(locale) },
        { key: "full_name", header: t("auditLogs.user"), render: (row) => row.full_name || t("auditLogs.system") },
        { key: "user_role", header: t("auditLogs.role") },
        { key: "action_type", header: t("auditLogs.action") },
        { key: "entity_name", header: t("auditLogs.entity") },
        { key: "entity_id", header: redacted ? t("auditLogs.reference") : t("auditLogs.entityId") },
    ];

    function updateFilter(event) {
        setFilters((current) => ({ ...current, [event.target.name]: event.target.value }));
    }

    function applyFilters(event) {
        event.preventDefault();
        setPage(1);
        setAppliedFilters(Object.fromEntries(
            Object.entries(filters).filter(([, value]) => value.trim() !== "")
        ));
    }

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">{title}</h1>
                    <p className="page-subtitle">{subtitle}</p>
                </div>
            </div>

            <form className="audit-log-filter-form" onSubmit={applyFilters}>
                <label className="form-field">
                    <span>{t("auditLogs.fromDate")}</span>
                    <input type="date" name="start_date" value={filters.start_date} onChange={updateFilter} />
                </label>
                <label className="form-field">
                    <span>{t("auditLogs.toDate")}</span>
                    <input type="date" name="end_date" value={filters.end_date} onChange={updateFilter} />
                </label>
                <label className="form-field">
                    <span>{t("auditLogs.action")}</span>
                    <input name="action_type" value={filters.action_type} onChange={updateFilter} maxLength={40} />
                </label>
                <label className="form-field">
                    <span>{t("auditLogs.category")}</span>
                    <input name="category" value={filters.category} onChange={updateFilter} maxLength={60} />
                </label>
                <div className="audit-log-filter-actions">
                    <Button type="submit">{t("auditLogs.applyFilters")}</Button>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={() => {
                            setFilters({ start_date: "", end_date: "", action_type: "", category: "" });
                            setAppliedFilters({});
                            setPage(1);
                        }}
                    >
                        {t("auditLogs.clearFilters")}
                    </Button>
                </div>
            </form>

            <DataTable
                columns={columns}
                rows={logsApi.data === null ? null : rows}
                rowKey="log_id"
                loading={logsApi.loading}
                refreshing={logsApi.refreshing}
                error={logsApi.error}
                onRetry={logsApi.refetch}
                emptyMessage={t("auditLogs.empty")}
            />
            {pagination.total_pages > 1 && (
                <div className="audit-log-pagination" aria-label={t("auditLogs.pagination")}>
                    <Button variant="secondary" disabled={page <= 1 || logsApi.loading} onClick={() => setPage((current) => current - 1)}>
                        {t("auditLogs.previous")}
                    </Button>
                    <span>{t("auditLogs.pageOf", { page, pages: pagination.total_pages })}</span>
                    <Button variant="secondary" disabled={page >= pagination.total_pages || logsApi.loading} onClick={() => setPage((current) => current + 1)}>
                        {t("auditLogs.next")}
                    </Button>
                </div>
            )}
        </div>
    );
}

export default AuditLogsPanel;
