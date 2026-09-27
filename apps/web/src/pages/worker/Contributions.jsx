import { useState } from "react";
import useApi from "../../hooks/useApi";
import { getMyBalance, getMyContributions } from "../../services/accountService";
import { StatCard } from "../../components/ui/Card";
import DataTable from "../../components/ui/DataTable";
import StatusBadge from "../../components/ui/StatusBadge";
import FormField from "../../components/ui/FormField";
import Button from "../../components/ui/Button";

function formatCurrency(value) {
    if (value === undefined || value === null) return "KSh 0.00";
    return `KSh ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const COLUMNS = [
    { key: "created_at", header: "Date", render: (row) => new Date(row.created_at).toLocaleString() },
    { key: "amount", header: "Amount", render: (row) => formatCurrency(row.amount) },
    { key: "channel", header: "Channel" },
    { key: "contribution_status", header: "Status", render: (row) => <StatusBadge status={row.contribution_status} /> },
];

function Contributions() {
    const balanceApi = useApi(getMyBalance, []);
    const contributionsApi = useApi(getMyContributions, []);
    const [amount, setAmount] = useState("");
    const [channel, setChannel] = useState("MPESA");

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
                <h2 className="card-title">Make a contribution</h2>
                <div className="form-error" role="note" style={{ marginBottom: 14 }}>
                    This action is not yet available: the backend has no endpoint to initiate a new
                    contribution (e.g. an M-Pesa STK push). Only viewing your balance and contribution
                    history is currently supported (GET /api/accounts/my-balance and
                    /my-contributions). This form is shown for reference and is disabled until that
                    endpoint is built.
                </div>
                <form
                    className="form-grid"
                    onSubmit={(e) => e.preventDefault()}
                    aria-disabled="true"
                >
                    <FormField
                        id="amount"
                        label="Amount (KSh)"
                        type="number"
                        min="1"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        disabled
                    />
                    <FormField
                        id="channel"
                        label="Channel"
                        as="select"
                        value={channel}
                        onChange={(e) => setChannel(e.target.value)}
                        options={[
                            { value: "MPESA", label: "M-Pesa" },
                            { value: "BANK", label: "Bank Transfer" },
                            { value: "USSD", label: "USSD" },
                        ]}
                        disabled
                    />
                    <div className="form-actions">
                        <Button type="submit" variant="primary" disabled>
                            Deposit (unavailable)
                        </Button>
                    </div>
                </form>
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
        </div>
    );
}

export default Contributions;
