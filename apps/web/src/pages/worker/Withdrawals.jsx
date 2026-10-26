import { useEffect, useState } from "react";
import useApi from "../../hooks/useApi";
import { getEligibility, submitClaim, getMyClaims } from "../../services/withdrawalService";
import Card from "../../components/ui/Card";
import DataTable from "../../components/ui/DataTable";
import StatusBadge from "../../components/ui/StatusBadge";
import FormField from "../../components/ui/FormField";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import ErrorState from "../../components/ui/ErrorState";
import { useToast } from "../../components/ui/ToastContext";

function formatCurrency(value) {
    if (value === undefined || value === null) return "KSh 0.00";
    return `KSh ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const COLUMNS = [
    { key: "requested_at", header: "Requested", render: (row) => new Date(row.requested_at).toLocaleString() },
    { key: "amount_requested", header: "Amount", render: (row) => formatCurrency(row.amount_requested) },
    { key: "destination_phone", header: "Destination" },
    { key: "withdrawal_reason", header: "Reason", render: (row) => row.withdrawal_reason || "-" },
    { key: "claim_status", header: "Status", render: (row) => <StatusBadge status={row.claim_status} /> },
];

function Withdrawals() {
    const eligibilityApi = useApi(getEligibility, []);
    const claimsApi = useApi(getMyClaims, []);
    const toast = useToast();

    const [requestOpen, setRequestOpen] = useState(false);
    const [amount, setAmount] = useState("");
    const [phone, setPhone] = useState("");
    const [reason, setReason] = useState("");
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (eligibilityApi.error) toast.error(eligibilityApi.error);
    }, [eligibilityApi.error, toast]);

    async function handleSubmit(e) {
        e.preventDefault();
        if (!amount || !phone || !reason.trim()) {
            toast.error("Amount, destination phone, and withdrawal reason are required.");
            return;
        }

        setSubmitting(true);
        try {
            const result = await submitClaim({
                amount_requested: Number(amount),
                destination_phone: phone,
                withdrawal_reason: reason.trim(),
            });
            claimsApi.setData((claims) => [result.claim, ...(claims || [])]);
            toast.success("Withdrawal request submitted. It is now pending review.");
            setAmount("");
            setPhone("");
            setReason("");
            setRequestOpen(false);
            const [eligibility, claims] = await Promise.all([
                eligibilityApi.refetch(),
                claimsApi.refetch(),
            ]);
            if (!eligibility || !claims) {
                toast.info("Your request was saved, but some account details could not be refreshed.");
            }
        } catch (err) {
            toast.error(err.message || "Failed to submit withdrawal claim.");
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
                {eligibilityApi.error && <ErrorState message={eligibilityApi.error} onRetry={eligibilityApi.refetch} />}
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
                        <p>Reserved for approved, unpaid withdrawals: {formatCurrency(eligibility.reserved_withdrawal_amount)}</p>
                        <p><strong>Available balance after approved reservations: {formatCurrency(eligibility.available_balance)}</strong></p>
                    </>
                )}
            </Card>

            <div className="section card">
                <h2 className="card-title">Request a withdrawal</h2>
                <p className="page-subtitle">Submit a claim for review by a fund manager.</p>
                <div className="form-actions" style={{ justifyContent: "flex-start", marginTop: 16 }}>
                    <Button
                        variant="primary"
                        onClick={() => setRequestOpen(true)}
                        disabled={!eligibility?.eligible || eligibilityApi.loading}
                    >
                        Request Withdrawal
                    </Button>
                </div>
            </div>

            <Modal open={requestOpen} title="Request a withdrawal" onClose={() => setRequestOpen(false)}>
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
                        disabled={submitting}
                    />
                    <FormField
                        id="withdrawal_reason"
                        label="Reason for withdrawal"
                        as="textarea"
                        maxLength="255"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        required
                        disabled={submitting}
                    />
                    <div className="form-actions">
                        <Button type="button" variant="secondary" onClick={() => setRequestOpen(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" loading={submitting}>
                            Submit request
                        </Button>
                    </div>
                </form>
            </Modal>

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
