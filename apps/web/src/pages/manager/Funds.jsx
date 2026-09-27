import { useState } from "react";
import useApi from "../../hooks/useApi";
import { listFunds, createFund, updateFund } from "../../services/fundService";
import DataTable from "../../components/ui/DataTable";
import StatusBadge from "../../components/ui/StatusBadge";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import FormField from "../../components/ui/FormField";

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
    const fundsApi = useApi(listFunds, []);
    const [modalOpen, setModalOpen] = useState(false);
    const [editingFund, setEditingFund] = useState(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [submitting, setSubmitting] = useState(false);
    const [formError, setFormError] = useState("");

    function openCreateModal() {
        setEditingFund(null);
        setForm(EMPTY_FORM);
        setFormError("");
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
        setFormError("");
        setModalOpen(true);
    }

    function handleChange(e) {
        const { name, value } = e.target;
        setForm((prev) => ({ ...prev, [name]: value }));
    }

    async function handleSubmit(e) {
        e.preventDefault();
        setFormError("");
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
            fundsApi.refetch();
        } catch (err) {
            setFormError(err.message || "Failed to save fund.");
        } finally {
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
            key: "actions",
            header: "",
            render: (row) => (
                <Button variant="secondary" size="sm" onClick={() => openEditModal(row)}>
                    Edit
                </Button>
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
                error={fundsApi.error}
                onRetry={fundsApi.refetch}
                emptyMessage="You do not manage any funds yet."
            />

            <Modal open={modalOpen} title={editingFund ? "Edit fund" : "Create fund"} onClose={() => setModalOpen(false)}>
                {formError && <div className="form-error" style={{ marginBottom: 12 }}>{formError}</div>}
                <form className="form-grid" onSubmit={handleSubmit}>
                    <FormField id="fund_name" label="Fund name" value={form.fund_name} onChange={handleChange} required />
                    <FormField
                        id="administrator_name"
                        label="Administrator name"
                        value={form.administrator_name}
                        onChange={handleChange}
                        required
                    />
                    <FormField
                        id="risk_level"
                        label="Risk level"
                        as="select"
                        options={RISK_OPTIONS}
                        value={form.risk_level}
                        onChange={handleChange}
                    />
                    <FormField
                        id="expected_return"
                        label="Expected return (%)"
                        type="number"
                        step="0.01"
                        value={form.expected_return}
                        onChange={handleChange}
                        required
                    />
                    {editingFund && (
                        <FormField
                            id="fund_status"
                            label="Fund status"
                            as="select"
                            options={STATUS_OPTIONS}
                            value={form.fund_status}
                            onChange={handleChange}
                        />
                    )}
                    <div className="form-actions">
                        <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" loading={submitting}>
                            Save
                        </Button>
                    </div>
                </form>
            </Modal>
        </div>
    );
}

export default Funds;
