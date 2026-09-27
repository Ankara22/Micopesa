import useApi from "../../hooks/useApi";
import { getMyBalance, getMyContributions } from "../../services/accountService";
import { StatCard } from "../../components/ui/Card";
import DataTable from "../../components/ui/DataTable";
import StatusBadge from "../../components/ui/StatusBadge";

function formatCurrency(value) {
    if (value === undefined || value === null) return "KSh 0.00";
    return `KSh ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const COLUMNS = [
    { key: "created_at", header: "Date", render: (row) => new Date(row.created_at).toLocaleString() },
    { key: "transaction_id", header: "Transaction ID" },
    { key: "amount", header: "Amount", render: (row) => formatCurrency(row.amount) },
    { key: "channel", header: "Channel" },
    { key: "contribution_status", header: "Status", render: (row) => <StatusBadge status={row.contribution_status} /> },
];

function BalanceHistory() {
    const balanceApi = useApi(getMyBalance, []);
    const historyApi = useApi(getMyContributions, []);

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Balance &amp; Transaction History</h1>
                    <p className="page-subtitle">Your current pension account balance and full transaction history.</p>
                </div>
            </div>

            <div className="stat-card-grid">
                <StatCard
                    label="Current Balance"
                    value={balanceApi.loading ? "..." : formatCurrency(balanceApi.data?.current_balance)}
                    hint={balanceApi.data?.account_status}
                />
            </div>

            <div className="section">
                <h2 className="card-title">All transactions</h2>
                <DataTable
                    columns={COLUMNS}
                    rows={historyApi.data}
                    rowKey="contribution_id"
                    loading={historyApi.loading}
                    error={historyApi.error}
                    onRetry={historyApi.refetch}
                    emptyMessage="No transactions found."
                />
            </div>
        </div>
    );
}

export default BalanceHistory;
