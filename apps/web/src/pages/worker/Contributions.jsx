import { useCallback, useState } from "react";
import useApi from "../../hooks/useApi";
import { getMyBalance, getMyContributions } from "../../services/accountService";
import { StatCard } from "../../components/ui/Card";
import DataTable from "../../components/ui/DataTable";
import StatusBadge from "../../components/ui/StatusBadge";
import Button from "../../components/ui/Button";
import DepositModal from "../../components/Deposit/DepositModal";

function formatCurrency(value) {
    if (value === undefined || value === null) return "KSh 0.00";
    return `KSh ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const COLUMNS = [
    { key: "created_at", header: "Date", render: (row) => new Date(row.created_at).toLocaleString() },
    { key: "amount", header: "Amount", render: (row) => formatCurrency(row.amount) },
    { key: "channel", header: "Channel" },
    { key: "contribution_status", header: "Contribution", render: (row) => <StatusBadge status={row.contribution_status} /> },
    { key: "transaction_status", header: "Payment", render: (row) => <StatusBadge status={row.transaction_status} /> },
    { key: "mpesa_result_description", header: "Payment details", render: (row) => row.mpesa_result_description || "-" },
];

function Contributions() {
    const [depositOpen, setDepositOpen] = useState(false);
    const balanceApi = useApi(getMyBalance, []);
    const contributionsApi = useApi(getMyContributions, []);
    const { setData: setBalanceData } = balanceApi;
    const { refetch: refetchContributions } = contributionsApi;
    const handleDepositCompleted = useCallback((payment) => {
        if (payment.account_balance !== undefined) {
            setBalanceData((current) => ({ ...current, current_balance: payment.account_balance }));
        }
        refetchContributions();
    }, [setBalanceData, refetchContributions]);

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Contributions / Deposit</h1>
                    <p className="page-subtitle">Make a new contribution and review your contribution history.</p>
                </div>
            </div>

            <div className="stat-card-grid">
                <StatCard
                    label="Current Balance"
                    value={balanceApi.loading ? "..." : formatCurrency(balanceApi.data?.current_balance)}
                />
            </div>

            <div className="section card">
                <h2 className="card-title">Make a deposit</h2>
                <p className="page-subtitle" style={{ marginBottom: 14 }}>
                    Authorize a deposit through a secure M-Pesa prompt. Your balance changes only after provider confirmation.
                </p>
                <Button variant="primary" onClick={() => setDepositOpen(true)}>Add funds</Button>
            </div>

            <div className="section">
                <h2 className="card-title">Contribution history</h2>
                <DataTable
                    columns={COLUMNS}
                    rows={contributionsApi.data}
                    rowKey="contribution_id"
                    loading={contributionsApi.loading}
                    error={contributionsApi.error}
                    onRetry={contributionsApi.refetch}
                    emptyMessage="You have no contributions yet."
                />
            </div>
            <DepositModal
                open={depositOpen}
                onClose={() => setDepositOpen(false)}
                onCompleted={handleDepositCompleted}
            />
        </div>
    );
}

export default Contributions;
