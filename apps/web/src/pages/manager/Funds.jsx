import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import { listFunds, createFund, updateFund, getFundAllocations } from "../../services/fundService";
import DataTable from "../../components/ui/DataTable";
import StatusBadge from "../../components/ui/StatusBadge";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import FormField from "../../components/ui/FormField";
import { useToast } from "../../components/ui/ToastContext";

function FundAllocationHistory({ fund, onClose }) {
    const { t } = useTranslation();
    const [allocations, setAllocations] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [retryCount, setRetryCount] = useState(0);

    useEffect(() => {
        let cancelled = false;
        getFundAllocations(fund.fund_id)
            .then((rows) => {
                if (!cancelled) setAllocations(rows);
            })
            .catch((requestError) => {
                if (!cancelled) setError(requestError.message || "Unable to load allocation history.");
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [fund.fund_id, retryCount]);

    function retry() {
        setAllocations(null);
        setLoading(true);
        setError(null);
        setRetryCount((count) => count + 1);
    }

    const accountLabels = new Map();
    allocations?.forEach(({ account_id }) => {
        if (!accountLabels.has(account_id)) {
            accountLabels.set(account_id, `Account ${accountLabels.size + 1}`);
        }
    });
    const columns = [
        { key: "account_id", header: t("dashboards.manager.fundsPage.workerAccount"), render: (row) => accountLabels.get(row.account_id) || t("dashboards.manager.fundsPage.account") },
        { key: "percentage", header: t("dashboards.manager.fundsPage.allocation"), render: (row) => `${Number(row.percentage).toFixed(2)}%` },
        { key: "effective_from", header: t("dashboards.manager.fundsPage.effectiveFrom") },
        { key: "effective_to", header: t("dashboards.manager.fundsPage.effectiveThrough"), render: (row) => row.effective_to || t("dashboards.manager.fundsPage.current") },
    ];

    return (
        <Modal open title={t("dashboards.manager.fundsPage.historyTitle", { fund: fund.fund_name })} onClose={onClose}>
            <DataTable
                columns={columns}
                rows={allocations}
                rowKey="allocation_id"
                loading={loading}
                error={error}
                onRetry={retry}
                emptyMessage={t("dashboards.manager.fundsPage.emptyHistory")}
                loadingLabel={t("dashboards.manager.fundsPage.loadingHistory")}
                errorTitle={t("dashboards.manager.fundsPage.historyErrorTitle")}
            />
        </Modal>
    );
}

const RISK_OPTIONS = [
    { value: "LOW", label: "Low" },
    { value: "MEDIUM", label: "Medium" },
    { value: "HIGH", label: "High" },
];

const STATUS_OPTIONS = [
    { value: "ACTIVE", label: "Active" },
    { value: "SUSPENDED", label: "Suspended" },
    { value: "CLOSED", label: "Closed" },
];

const EMPTY_FORM = { fund_name: "", administrator_name: "", risk_level: "MEDIUM", expected_return: "" };

function Funds() {
    const { t } = useTranslation();
    const fundsApi = useApi(listFunds, []);
    const toast = useToast();
    const [modalOpen, setModalOpen] = useState(false);
    const [editingFund, setEditingFund] = useState(null);
    const [viewingFund, setViewingFund] = useState(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [submitting, setSubmitting] = useState(false);
    const submissionInProgressRef = useRef(false);

    function openCreateModal() {
        setEditingFund(null);
        setForm(EMPTY_FORM);
        setModalOpen(true);
    }

    function openEditModal(fund) {
        setEditingFund(fund);
        setForm({
            fund_name: fund.fund_name,
            administrator_name: fund.administrator_name,
            risk_level: fund.risk_level,
            expected_return: fund.expected_return,
            fund_status: fund.fund_status,
        });
        setModalOpen(true);
    }

    function handleChange(e) {
        const { name, value } = e.target;
        setForm((prev) => ({ ...prev, [name]: value }));
    }

    async function handleSubmit(e) {
        e.preventDefault();
        if (submissionInProgressRef.current) return;
        submissionInProgressRef.current = true;
        setSubmitting(true);
        try {
            if (editingFund) {
                await updateFund(editingFund.fund_id, {
                    ...form,
                    expected_return: Number(form.expected_return),
                });
            } else {
                await createFund({ ...form, expected_return: Number(form.expected_return) });
            }
            setModalOpen(false);
            const funds = await fundsApi.refetch();
            toast.success(editingFund ? "Fund updated successfully." : "Fund created successfully.");
            if (!funds) toast.error("The fund was saved, but the list could not be refreshed.");
        } catch (err) {
            toast.error(err.message || "Failed to save fund.");
        } finally {
            submissionInProgressRef.current = false;
            setSubmitting(false);
        }
    }

    const columns = [
        { key: "fund_name", header: "Fund Name" },
        { key: "administrator_name", header: "Administrator" },
        { key: "risk_level", header: "Risk Level" },
        { key: "expected_return", header: "Expected Return", render: (row) => `${row.expected_return}%` },
        { key: "fund_status", header: "Status", render: (row) => <StatusBadge status={row.fund_status} /> },
        {
            key: "allocations",
            header: t("dashboards.manager.fundsPage.allocationsColumn"),
            render: (row) => (
                <div className="table-actions">
                    <Button variant="secondary" size="sm" onClick={() => setViewingFund(row)}>
                        {t("dashboards.manager.fundsPage.viewAllocations")}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => openEditModal(row)}>
                        {t("dashboards.manager.fundsPage.editFund")}
                    </Button>
                </div>
            ),
        },
    ];

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Funds / Fund Performance</h1>
                    <p className="page-subtitle">Manage the funds you administer.</p>
                </div>
                <Button variant="primary" onClick={openCreateModal}>
                    + New Fund
                </Button>
            </div>

            <DataTable
                columns={columns}
                rows={fundsApi.data}
                rowKey="fund_id"
                loading={fundsApi.loading}
                refreshing={fundsApi.refreshing}
                error={fundsApi.error}
                onRetry={fundsApi.refetch}
                emptyMessage="You do not manage any funds yet."
            />

            <Modal
                open={modalOpen}
                title={editingFund ? "Edit fund" : "Create fund"}
                onClose={() => {
                    if (!submitting) setModalOpen(false);
                }}
            >
                <form className="form-grid" onSubmit={handleSubmit}>
                    <FormField id="fund_name" label="Fund name" value={form.fund_name} onChange={handleChange} required disabled={submitting} />
                    <FormField
                        id="administrator_name"
                        label="Administrator name"
                        value={form.administrator_name}
                        onChange={handleChange}
                        required
                        disabled={submitting}
                    />
                    <FormField
                        id="risk_level"
                        label="Risk level"
                        as="select"
                        options={RISK_OPTIONS}
                        value={form.risk_level}
                        onChange={handleChange}
                        disabled={submitting}
                    />
                    <FormField
                        id="expected_return"
                        label="Expected return (%)"
                        type="number"
                        step="0.01"
                        value={form.expected_return}
                        onChange={handleChange}
                        required
                        disabled={submitting}
                    />
                    {editingFund && (
                        <FormField
                            id="fund_status"
                            label="Fund status"
                            as="select"
                            options={STATUS_OPTIONS}
                            value={form.fund_status}
                            onChange={handleChange}
                            disabled={submitting}
                        />
                    )}
                    <div className="form-actions">
                        <Button type="button" variant="secondary" disabled={submitting} onClick={() => setModalOpen(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" loading={submitting}>
                            Save
                        </Button>
                    </div>
                </form>
            </Modal>
            {viewingFund && (
                <FundAllocationHistory
                    key={viewingFund.fund_id}
                    fund={viewingFund}
                    onClose={() => setViewingFund(null)}
                />
            )}
        </div>
    );
}

export default Funds;
