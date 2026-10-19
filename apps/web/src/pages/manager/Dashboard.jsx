import { lazy, Suspense, useState } from "react";
import useApi from "../../hooks/useApi";
import { getFundPerformance, getWithdrawalClaims, reviewWithdrawal } from "../../services/fundManagerApi";
import { listFunds, getFundAllocations } from "../../services/fundService";
import { StatCard } from "../../components/ui/Card";
import DataTable from "../../components/ui/DataTable";
import StatusBadge from "../../components/ui/StatusBadge";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import ErrorState from "../../components/ui/ErrorState";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import { useToast } from "../../components/ui/ToastContext";
const FundManagerCharts = lazy(() => import("./FundManagerCharts"));

function getFundChartData() {
    return listFunds().then(async (funds) => {
        const allocationEntries = await Promise.all(
            funds.map(async (fund) => ({
                fund,
                allocations: await getFundAllocations(fund.fund_id),
            }))
        );
        return { funds, allocationEntries };
    });
}

function formatCurrency(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return "KSh 0.00";
    return `KSh ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function FundManagerDashboard() {
    const performanceApi = useApi(getFundPerformance, []);
    const claimsApi = useApi(getWithdrawalClaims, []);
    const fundsApi = useApi(getFundChartData, []);
    const toast = useToast();
    const [confirming, setConfirming] = useState(null);
    const [processing, setProcessing] = useState(false);

    async function handleReview() {
        if (!confirming) return;
        setProcessing(true);
        try {
            await reviewWithdrawal(confirming.claim.claim_id, confirming.decision);
            setConfirming(null);
            const refreshed = await claimsApi.refetch();
            if (!refreshed) {
                toast.error("The review was saved, but the withdrawal list could not be refreshed.");
            } else {
                toast.success(`Withdrawal claim ${confirming.decision.toLowerCase()}.`);
            }
        } catch (error) {
            toast.error(error.message || "Unable to review the withdrawal claim.");
        } finally {
            setProcessing(false);
        }
    }

    if (performanceApi.loading || claimsApi.loading || fundsApi.loading) {
        return (
            <>
                <SkeletonLoader variant="metrics" count={4} label="Loading fund performance" />
                <div className="dashboard-chart-grid">
                    <SkeletonLoader variant="chart" label="Loading fund allocation chart" />
                    <SkeletonLoader variant="chart" label="Loading portfolio mix chart" />
                </div>
            </>
        );
    }
    if (performanceApi.error) {
        return <ErrorState message={performanceApi.error} onRetry={performanceApi.refetch} />;
    }

    const performance = performanceApi.data || {};
    const withdrawals = claimsApi.data || [];
    const funds = fundsApi.data?.funds || [];
    const allocationEntries = fundsApi.data?.allocationEntries || [];
    const columns = [
        { key: "full_name", header: "Worker" },
        { key: "phone", header: "Phone" },
        { key: "amount_requested", header: "Amount", render: (row) => formatCurrency(row.amount_requested) },
        { key: "destination_phone", header: "Destination" },
        { key: "withdrawal_reason", header: "Reason", render: (row) => row.withdrawal_reason || "-" },
        { key: "claim_status", header: "Status", render: (row) => <StatusBadge status={row.claim_status} /> },
        { key: "requested_at", header: "Requested", render: (row) => new Date(row.requested_at).toLocaleString() },
        {
            key: "reviewed_by",
            header: "Reviewed by",
            render: (row) => row.reviewer_name || (row.claim_status === "PENDING" ? "-" : "Unavailable"),
        },
        {
            key: "actions",
            header: "",
            render: (row) => row.claim_status === "PENDING" ? (
                <div className="form-actions" style={{ justifyContent: "flex-start" }}>
                    <Button
                        size="sm"
                        onClick={() => {
                            setConfirming({ claim: row, decision: "APPROVED" });
                        }}
                    >
                        Approve
                    </Button>
                    <Button
                        variant="danger"
                        size="sm"
                        onClick={() => {
                            setConfirming({ claim: row, decision: "REJECTED" });
                        }}
                    >
                        Reject
                    </Button>
                </div>
            ) : "-",
        },
    ];

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Fund Manager Dashboard</h1>
                    <p className="page-subtitle">Monitor fund performance and review worker withdrawal requests.</p>
                </div>
            </div>

            <section className="section" aria-label="Fund performance">
                <h2 className="card-title">Fund Performance</h2>
                <div className="stat-card-grid">
                    <StatCard label="Total pension assets" value={formatCurrency(performance.total_assets)} hint="Across all pension accounts" />
                    <StatCard label="Active accounts" value={performance.active_accounts ?? 0} />
                    <StatCard
                        label="Average yield"
                        value={performance.average_yield === null ? "N/A" : `${Number(performance.average_yield).toFixed(2)}%`}
                        hint={`${performance.funds_managed ?? 0} funds managed`}
                    />
                    <StatCard label="Withdrawal claims" value={withdrawals.length} hint="Pending and historical (up to 500)" />
                </div>
            </section>

            {fundsApi.error ? (
                <ErrorState message={fundsApi.error} onRetry={fundsApi.refetch} />
            ) : (
                <Suspense fallback={<SkeletonLoader variant="chart" label="Loading fund charts" />}>
                    <FundManagerCharts funds={funds} allocationEntries={allocationEntries} />
                </Suspense>
            )}

            <section className="section">
                <div className="page-header">
                    <div>
                        <h2 className="card-title">Withdrawal Requests</h2>
                        <p className="page-subtitle">Review pending requests and view historical claim decisions.</p>
                    </div>
                </div>
                <DataTable
                    columns={columns}
                    rows={withdrawals}
                    rowKey="claim_id"
                    loading={false}
                    error={claimsApi.error}
                    onRetry={claimsApi.refetch}
                    emptyMessage="There are no withdrawal claims."
                />
            </section>

            <Modal
                open={Boolean(confirming)}
                title={confirming?.decision === "APPROVED" ? "Approve withdrawal claim?" : "Reject withdrawal claim?"}
                onClose={() => setConfirming(null)}
            >
                {confirming && (
                    <p>
                        {confirming.decision === "APPROVED" ? "Approve" : "Reject"} the request of{" "}
                        <strong>{formatCurrency(confirming.claim.amount_requested)}</strong> from{" "}
                        <strong>{confirming.claim.full_name}</strong>?
                    </p>
                )}
                <div className="form-actions">
                    <Button variant="secondary" onClick={() => setConfirming(null)}>Cancel</Button>
                    <Button
                        variant={confirming?.decision === "APPROVED" ? "primary" : "danger"}
                        loading={processing}
                        onClick={handleReview}
                    >
                        Confirm
                    </Button>
                </div>
            </Modal>
        </div>
    );
}

export default FundManagerDashboard;
