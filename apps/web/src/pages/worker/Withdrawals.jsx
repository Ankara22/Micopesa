import { useState } from "react";
import useApi from "../../hooks/useApi";
import { getEligibility, submitClaim, getMyClaims } from "../../services/withdrawalService";
import Card from "../../components/ui/Card";
import DataTable from "../../components/ui/DataTable";
import StatusBadge from "../../components/ui/StatusBadge";
import FormField from "../../components/ui/FormField";
import Button from "../../components/ui/Button";

function formatCurrency(value) {
    if (value === undefined || value === null) return "KSh 0.00";
    return `KSh ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const COLUMNS = [
    { key: "requested_at", header: "Requested", render: (row) => new Date(row.requested_at).toLocaleString() },
    { key: "amount_requested", header: "Amount", render: (row) => formatCurrency(row.amount_requested) },
    { key: "destination_phone", header: "Destination" },
    { key: "claim_status", header: "Status", render: (row) => <StatusBadge status={row.claim_status} /> },
];

function Withdrawals() {
    const eligibilityApi = useApi(getEligibility, []);
    const claimsApi = useApi(getMyClaims, []);

    const [amount, setAmount] = useState("");
    const [phone, setPhone] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [formError, setFormError] = useState("");
    const [successMessage, setSuccessMessage] = useState("");

    async function handleSubmit(e) {
        e.preventDefault();
        setFormError("");
        setSuccessMessage("");

        if (!amount || !phone) {
            setFormError("Amount and destination phone are required.");
            return;
        }

        setSubmitting(true);
        try {
            await submitClaim({ amount_requested: Number(amount), destination_phone: phone });
            setSuccessMessage("Withdrawal claim submitted successfully. It is now pending review.");
            setAmount("");
            setPhone("");
            eligibilityApi.refetch();
            claimsApi.refetch();
        } catch (err) {
            setFormError(err.message || "Failed to submit withdrawal claim.");
        } finally {
            setSubmitting(false);
        }
    }

    const eligibility = eligibilityApi.data;

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Withdrawals</h1>
                    <p className="page-subtitle">Check your eligibility and submit a withdrawal claim.</p>
                </div>
            </div>

            <Card title="Eligibility">
                {eligibilityApi.loading && <p>Checking eligibility...</p>}
                {eligibilityApi.error && <div className="form-error">{eligibilityApi.error}</div>}
                {eligibility && (
                    <>
                        <p>
                            Status:{" "}
                            {eligibility.eligible ? (
                                <span className="badge badge-green">Eligible</span>
                            ) : (
                                <span className="badge badge-red">Not eligible</span>
                            )}
                        </p>
                        {eligibility.reasons?.length > 0 && (
                            <ul>
                                {eligibility.reasons.map((reason) => (
                                    <li key={reason}>{reason}</li>
                                ))}
                            </ul>
                        )}
                        <p>Current balance: {formatCurrency(eligibility.current_balance)}</p>
                    </>
                )}
            </Card>

            <div className="section card">
                <h2 className="card-title">Submit a withdrawal claim</h2>
                {formError && <div className="form-error" style={{ marginBottom: 12 }}>{formError}</div>}
                {successMessage && <div className="form-success" style={{ marginBottom: 12 }}>{successMessage}</div>}
                <form className="form-grid" onSubmit={handleSubmit}>
                    <FormField
                        id="amount_requested"
                        label="Amount to withdraw (KSh)"
                        type="number"
                        min="1"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        required
                    />
                    <FormField
                        id="destination_phone"
                        label="Destination phone number"
                        type="tel"
                        placeholder="+254700000000"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        required
                    />
                    <div className="form-actions">
                        <Button type="submit" variant="primary" loading={submitting} disabled={eligibility && !eligibility.eligible}>
                            Submit claim
                        </Button>
                    </div>
                </form>
            </div>

            <div className="section">
                <h2 className="card-title">Your withdrawal claims</h2>
                <DataTable
                    columns={COLUMNS}
                    rows={claimsApi.data}
                    rowKey="claim_id"
                    loading={claimsApi.loading}
                    error={claimsApi.error}
                    onRetry={claimsApi.refetch}
                    emptyMessage="You have no withdrawal claims yet."
                />
            </div>
        </div>
    );
}

export default Withdrawals;
