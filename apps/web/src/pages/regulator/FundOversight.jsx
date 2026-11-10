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
    const accountLabels = new Map();
    allocationsApi.data?.forEach(({ account_id }) => {
        if (!accountLabels.has(account_id)) {
            accountLabels.set(account_id, `Account ${accountLabels.size + 1}`);
        }
    });

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
        { key: "account_id", header: "Account", render: (row) => accountLabels.get(row.account_id) || "Account" },
        { key: "percentage", header: "Percentage", render: (row) => `${Number(row.percentage).toFixed(2)}%` },
        { key: "effective_from", header: "Effective From", render: (row) => formatDate(row.effective_from) },
        {
            key: "effective_to",
            header: "Effective To",
            render: (row) => (row.effective_to ? formatDate(row.effective_to) : "Ongoing"),
        },
    ];

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Fund Oversight</h1>
                    <p className="page-subtitle">
                        View pension funds available within your authorized regulatory scope.
                    </p>
                </div>
            </div>

            <DataTable
                columns={columns}
                rows={fundsApi.data}
                rowKey="fund_id"
                loading={fundsApi.loading}
                refreshing={fundsApi.refreshing}
                error={fundsApi.error}
                onRetry={fundsApi.refetch}
                emptyMessage="No funds are currently available within your authorized scope. Contact the platform administrator if you require fund access."
            />

            <Modal open={Boolean(viewingFund)} title={`Allocations - ${viewingFund?.fund_name || ""}`} onClose={() => setViewingFund(null)}>
                <DataTable
                    columns={allocationColumns}
                    rows={allocationsApi.data}
                    rowKey="allocation_id"
                    loading={allocationsApi.loading}
                    refreshing={allocationsApi.refreshing}
                    error={allocationsApi.error}
                    onRetry={allocationsApi.refetch}
                    emptyMessage="No allocations recorded for this fund."
                />
            </Modal>
        </div>
    );
}

function formatDate(value) {
    if (!value) return "Unavailable";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleDateString();
}

export default FundOversight;
