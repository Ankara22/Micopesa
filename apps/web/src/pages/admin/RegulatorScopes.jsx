import { useState } from "react";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import DataTable from "../../components/ui/DataTable";
import Button from "../../components/ui/Button";
import { AdminCard, AdminPage } from "../../components/AdminPage";
import { useToast } from "../../components/ui/ToastContext";
import {
    assignRegulatorFund,
    getRegulatorFundAssignmentCandidates,
    listRegulatorFundAssignments,
    revokeRegulatorFund,
} from "../../services/adminService";

function RegulatorScopes() {
    const { t } = useTranslation();
    const [regulatorId, setRegulatorId] = useState("");
    const [fundId, setFundId] = useState("");
    const [saving, setSaving] = useState(false);
    const assignmentsApi = useApi(listRegulatorFundAssignments, []);
    const candidatesApi = useApi(getRegulatorFundAssignmentCandidates, []);
    const toast = useToast();

    async function addAssignment(event) {
        event.preventDefault();
        if (!regulatorId || !fundId || saving) return;
        setSaving(true);
        try {
            await assignRegulatorFund(regulatorId, fundId);
            await assignmentsApi.refetch();
            toast.success(t("regulatorScopes.assigned"));
        } catch {
            toast.error(t("regulatorScopes.saveError"));
        } finally {
            setSaving(false);
        }
    }

    async function removeAssignment(row) {
        if (!window.confirm(t("regulatorScopes.confirmRevoke", {
            regulator: row.regulator_name,
            fund: row.fund_name,
        }))) return;
        try {
            await revokeRegulatorFund(row.regulator_user_id, row.fund_id);
            await assignmentsApi.refetch();
            toast.success(t("regulatorScopes.revoked"));
        } catch {
            toast.error(t("regulatorScopes.saveError"));
        }
    }

    const columns = [
        { key: "regulator_name", header: t("regulatorScopes.regulator") },
        { key: "fund_name", header: t("regulatorScopes.fund") },
        {
            key: "active",
            header: t("regulatorScopes.status"),
            render: (row) => row.active ? t("regulatorScopes.active") : t("regulatorScopes.inactive"),
        },
        { key: "assigned_by_name", header: t("regulatorScopes.assignedBy") },
        {
            key: "action",
            header: t("regulatorScopes.action"),
            render: (row) => row.active && (
                <Button variant="danger" size="sm" onClick={() => removeAssignment(row)}>
                    {t("regulatorScopes.revoke")}
                </Button>
            ),
        },
    ];

    const candidates = candidatesApi.data || { regulators: [], funds: [] };
    return (
        <AdminPage title={t("regulatorScopes.title")} subtitle={t("regulatorScopes.subtitle")}>
            <AdminCard
                title={t("regulatorScopes.assignmentTitle")}
                description={t("regulatorScopes.authorityNote")}
            >
                {candidatesApi.error ? (
                    <p role="alert">{t("regulatorScopes.loadError")}</p>
                ) : (
                    <form className="admin-form-grid" onSubmit={addAssignment}>
                        <label className="admin-form-field">
                            <span>{t("regulatorScopes.regulator")}</span>
                            <select value={regulatorId} onChange={(event) => setRegulatorId(event.target.value)} required>
                                <option value="">{t("regulatorScopes.selectRegulator")}</option>
                                {candidates.regulators.map((item) => (
                                    <option key={item.user_id} value={item.user_id}>{item.full_name}</option>
                                ))}
                            </select>
                        </label>
                        <label className="admin-form-field">
                            <span>{t("regulatorScopes.fund")}</span>
                            <select value={fundId} onChange={(event) => setFundId(event.target.value)} required>
                                <option value="">{t("regulatorScopes.selectFund")}</option>
                                {candidates.funds.map((item) => (
                                    <option key={item.fund_id} value={item.fund_id}>{item.fund_name}</option>
                                ))}
                            </select>
                        </label>
                        <Button type="submit" loading={saving}>{t("regulatorScopes.assign")}</Button>
                    </form>
                )}
            </AdminCard>
            <AdminCard title={t("regulatorScopes.currentAssignments")}>
                <DataTable
                    columns={columns}
                    rows={assignmentsApi.data}
                    rowKey="assignment_id"
                    loading={assignmentsApi.loading}
                    refreshing={assignmentsApi.refreshing}
                    error={assignmentsApi.error}
                    onRetry={assignmentsApi.refetch}
                    emptyMessage={t("regulatorScopes.empty")}
                />
            </AdminCard>
        </AdminPage>
    );
}

export default RegulatorScopes;
