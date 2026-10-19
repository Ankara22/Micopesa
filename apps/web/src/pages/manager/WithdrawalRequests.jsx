import { useState } from "react";
import useApi from "../../hooks/useApi";
import { getPendingClaims, approveClaim, rejectClaim } from "../../services/withdrawalService";
import DataTable from "../../components/ui/DataTable";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import { useToast } from "../../components/ui/ToastContext";

function formatCurrency(value) {
    if (value === undefined || value === null) return "KSh 0.00";
    return `KSh ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function WithdrawalRequests() {
    const claimsApi = useApi(getPendingClaims, []);
    const toast = useToast();
    const [confirming, setConfirming] = useState(null);
    const [processing, setProcessing] = useState(false);

    async function handleConfirm() {
        if (!confirming) return;
        setProcessing(true);
        try {
            if (confirming.decision === "approve") {
                await approveClaim(confirming.claim.claim_id);
            } else {
                await rejectClaim(confirming.claim.claim_id);
            }
            setConfirming(null);
            const claims = await claimsApi.refetch();
            if (claims) toast.success("Withdrawal claim reviewed successfully.");
            else toast.error("The claim was reviewed, but the list could not be refreshed.");
        } catch (err) {
            toast.error(err.message || "Failed to update the claim.");
        } finally {
            setProcessing(false);
        }
    }

    const columns = [
        { key: "full_name", header: "Worker" },
        { key: "phone", header: "Phone" },
        { key: "amount_requested", header: "Amount", render: (row) => formatCurrency(row.amount_requested) },
        { key: "destination_phone", header: "Destination" },
        { key: "withdrawal_reason", header: "Reason", render: (row) => row.withdrawal_reason || "-" },
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
