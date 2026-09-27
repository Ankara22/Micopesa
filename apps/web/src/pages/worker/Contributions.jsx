import { useState } from "react";
import useApi from "../../hooks/useApi";
import { getMyBalance, getMyContributions, initiateMyContribution } from "../../services/accountService";
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
    { key: "contribution_status", header: "Contribution", render: (row) => <StatusBadge status={row.contribution_status} /> },
    { key: "transaction_status", header: "Payment", render: (row) => <StatusBadge status={row.transaction_status} /> },
];

function Contributions() {
    const balanceApi = useApi(getMyBalance, []);
    const contributionsApi = useApi(getMyContributions, []);
    const [amount, setAmount] = useState("");
    const [channel, setChannel] = useState("MPESA");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submission, setSubmission] = useState(null);

    async function handleSubmit(event) {
        event.preventDefault();
        setSubmission(null);
        setIsSubmitting(true);
        try {
            const result = await initiateMyContribution({ amount, channel });
            setSubmission({ message: result.message, error: false });
            setAmount("");
            await contributionsApi.refetch();
        } catch (error) {
            setSubmission({ message: error.message || "Could not initiate contribution.", error: true });
        } finally {
            setIsSubmitting(false);
        }
    }

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
                    Initiation records a pending contribution and transaction. Payment is not collected
                    or confirmed yet because a payment-provider callback is not configured. Your balance
                    changes only after a future payment-confirmation workflow completes.
                </div>
                {submission && (
                    <div className={submission.error ? "auth-error" : "form-success"} role="status">
                        {submission.message}
                    </div>
                )}
                <form className="form-grid" onSubmit={handleSubmit}>
                    <FormField
                        id="amount"
                        label="Amount (KSh)"
                        type="number"
                        min="1"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        required
                        step="0.01"
                        disabled={isSubmitting}
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
                        disabled={isSubmitting}
                    />
                    <div className="form-actions">
                        <Button type="submit" variant="primary" disabled={isSubmitting}>
                            {isSubmitting ? "Initiating..." : "Initiate contribution"}
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
