import { useState } from "react";
import useApi from "../../hooks/useApi";
import { getPendingClaims, approveClaim, rejectClaim } from "../../services/withdrawalService";
import DataTable from "../../components/ui/DataTable";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";

function formatCurrency(value) {
    if (value === undefined || value === null) return "KSh 0.00";
    return `KSh ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function WithdrawalRequests() {
    const claimsApi = useApi(getPendingClaims, []);
    const [confirming, setConfirming] = useState(null); // { claim, decision }
    const [processing, setProcessing] = useState(false);
    const [actionError, setActionError] = useState("");

    async function handleConfirm() {
        if (!confirming) return;
        setProcessing(true);
        setActionError("");
        try {
            if (confirming.decision === "approve") {
                await approveClaim(confirming.claim.claim_id);
            } else {
                await rejectClaim(confirming.claim.claim_id);
            }
            setConfirming(null);
            claimsApi.refetch();
        } catch (err) {
            setActionError(err.message || "Failed to update the claim.");
        } finally {
            setProcessing(false);
        }
    }

    const columns = [
        { key: "full_name", header: "Worker" },
        { key: "phone", header: "Phone" },
        { key: "amount_requested", header: "Amount", render: (row) => formatCurrency(row.amount_requested) },
        { key: "destination_phone", header: "Destination" },
        { key: "requested_at", header: "Requested", render: (row) => new Date(row.requested_at).toLocaleString() },
        {
            key: "actions",
            header: "",
            render: (row) => (
                <div style={{ display: "flex", gap: 8 }}>
                    <Button variant="primary" size="sm" onClick={() => setConfirming({ claim: row, decision: "approve" })}>
                        Approve
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => setConfirming({ claim: row, decision: "reject" })}>
                        Reject
                    </Button>
                </div>
            ),
        },
    ];

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Withdrawal Requests</h1>
                    <p className="page-subtitle">Review pending withdrawal claims from workers.</p>
                </div>
            </div>

            <DataTable
                columns={columns}
                rows={claimsApi.data}
                rowKey="claim_id"
                loading={claimsApi.loading}
                error={claimsApi.error}
                onRetry={claimsApi.refetch}
                emptyMessage="There are no pending withdrawal requests."
            />

            <Modal
                open={Boolean(confirming)}
                title={confirming?.decision === "approve" ? "Approve withdrawal claim?" : "Reject withdrawal claim?"}
                onClose={() => setConfirming(null)}
            >
                {actionError && <div className="form-error" style={{ marginBottom: 12 }}>{actionError}</div>}
                {confirming && (
                    <p>
                        {confirming.decision === "approve" ? "Approve" : "Reject"} the claim for{" "}
                        <strong>{formatCurrency(confirming.claim.amount_requested)}</strong> from{" "}
                        <strong>{confirming.claim.full_name}</strong>?
                    </p>
                )}
                <div className="form-actions">
                    <Button variant="secondary" onClick={() => setConfirming(null)}>
                        Cancel
                    </Button>
                    <Button
                        variant={confirming?.decision === "approve" ? "primary" : "danger"}
                        loading={processing}
                        onClick={handleConfirm}
                    >
                        Confirm
                    </Button>
                </div>
            </Modal>
        </div>
    );
}

export default WithdrawalRequests;
