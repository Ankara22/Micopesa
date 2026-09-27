import { useState } from "react";
import useApi from "../../hooks/useApi";
import { listFunds, getFundAllocations } from "../../services/fundService";
import DataTable from "../../components/ui/DataTable";
import StatusBadge from "../../components/ui/StatusBadge";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";

function FundOversight() {
    const fundsApi = useApi(listFunds, []);
    const [viewingFund, setViewingFund] = useState(null);
    const allocationsApi = useApi(
        () => (viewingFund ? getFundAllocations(viewingFund.fund_id) : Promise.resolve([])),
        [viewingFund]
    );

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
                <Button variant="secondary" size="sm" onClick={() => setViewingFund(row)}>
                    View allocations
                </Button>
            ),
        },
    ];

    const allocationColumns = [
        { key: "account_id", header: "Account" },
        { key: "percentage", header: "Percentage", render: (row) => `${row.percentage}%` },
        { key: "effective_from", header: "Effective From", render: (row) => new Date(row.effective_from).toLocaleDateString() },
        {
            key: "effective_to",
            header: "Effective To",
            render: (row) => (row.effective_to ? new Date(row.effective_to).toLocaleDateString() : "Ongoing"),
        },
    ];

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Fund Oversight</h1>
                    <p className="page-subtitle">Read-only view of all pension funds on the platform.</p>
                </div>
            </div>

            <DataTable
                columns={columns}
                rows={fundsApi.data}
                rowKey="fund_id"
                loading={fundsApi.loading}
                error={fundsApi.error}
                onRetry={fundsApi.refetch}
                emptyMessage="No funds have been created yet."
            />

            <Modal open={Boolean(viewingFund)} title={`Allocations - ${viewingFund?.fund_name || ""}`} onClose={() => setViewingFund(null)}>
                <DataTable
                    columns={allocationColumns}
                    rows={allocationsApi.data}
                    rowKey="allocation_id"
                    loading={allocationsApi.loading}
                    error={allocationsApi.error}
                    emptyMessage="No allocations recorded for this fund."
                />
            </Modal>
        </div>
    );
}

export default FundOversight;
