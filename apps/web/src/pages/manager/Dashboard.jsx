import { lazy, Suspense, useState } from "react";
import { Link } from "react-router-dom";
import useApi from "../../hooks/useApi";
import { getFundPerformance, getWithdrawalClaims, reviewWithdrawal } from "../../services/fundManagerApi";
import { listFunds, getFundAllocations } from "../../services/fundService";
import { useAuth } from "../../context/AuthContext";
import { StatCard } from "../../components/ui/Card";
import StatusBadge from "../../components/ui/StatusBadge";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import ErrorState from "../../components/ui/ErrorState";
import LoadingState from "../../components/ui/LoadingState";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import { useToast } from "../../components/ui/ToastContext";
import { getCurrentAllocationBreakdown } from "./fundAllocationUtils";
import "./fund-manager-dashboard.css";

const FundManagerCharts = lazy(() => import("./FundManagerCharts"));
const FUND_MANAGER_LINKS = [
    { label: "Funds", description: "View fund details and configured expectations.", to: "/manager/funds" },
    { label: "Withdrawal Requests", description: "Review submitted worker requests.", to: "/manager/withdrawal-requests" },
    { label: "Operational Reports", description: "Open operational reporting.", to: "/manager/reports" },
    { label: "Audit Logs", description: "Review recorded operational actions.", to: "/manager/audit-logs" },
];

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
    if (value === undefined || value === null || value === "" || !Number.isFinite(Number(value))) {
        return "Unavailable";
    }
    return `KSh ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCount(value) {
    const count = Number(value);
    return value !== undefined && value !== null && Number.isFinite(count)
        ? count.toLocaleString()
        : "Unavailable";
}

function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleDateString();
}

function formatPercentage(value) {
    if (value === undefined || value === null || value === "" || !Number.isFinite(Number(value))) {
        return "Unavailable";
    }
    return `${Number(value).toFixed(2)}%`;
}

function FundManagerDashboard() {
    const { user } = useAuth();
    const performanceApi = useApi(getFundPerformance, []);
    const claimsApi = useApi(getWithdrawalClaims, []);
    const fundsApi = useApi(getFundChartData, []);
    const toast = useToast();
    const [confirming, setConfirming] = useState(null);
    const [processing, setProcessing] = useState(false);
    const performance = performanceApi.data;
    const funds = fundsApi.data?.funds || [];
    const allocationEntries = fundsApi.data?.allocationEntries || [];
    const allocationBreakdown = getCurrentAllocationBreakdown(funds, allocationEntries);
    const pendingClaims = (claimsApi.data || []).filter((claim) => claim.claim_status === "PENDING").slice(0, 5);
    const firstName = user?.full_name?.trim().split(/\s+/)[0];

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

    return (
        <div className="fund-manager-dashboard">
            <header className="page-header fund-manager-dashboard-header">
                <div>
                    <p className="fund-manager-eyebrow">Fund management</p>
                    <h1 className="page-title">
                        {firstName ? `Welcome, ${firstName}` : "Fund Manager Dashboard"}
                    </h1>
                    <p className="page-subtitle">
                        Review account summaries, managed funds, and pending withdrawal requests.
                    </p>
                </div>
            </header>

            <section aria-label="Fund management summary">
                {performanceApi.loading ? (
                    <SkeletonLoader variant="metrics" count={4} label="Loading fund summary" />
                ) : performanceApi.error ? (
                    <ErrorState message={performanceApi.error} onRetry={performanceApi.refetch} />
                ) : (
                    <div className="stat-card-grid fund-manager-summary">
                        <StatCard
                            label="Total pension account balances"
                            value={formatCurrency(performance?.total_assets)}
                            hint="Across all pension accounts"
                        />
                        <StatCard
                            label="Active pension accounts"
                            value={formatCount(performance?.active_accounts)}
                        />
                        <StatCard
                            label="Managed funds"
                            value={formatCount(performance?.funds_managed)}
                        />
                        <StatCard
                            label="Average expected return"
                            value={formatPercentage(performance?.average_yield)}
                            hint="Configured average for active managed funds"
                        />
                    </div>
                )}
            </section>

            <section className="fund-manager-dashboard-section" aria-labelledby="fund-allocation-title">
                <div className="fund-manager-section-heading">
                    <div>
                        <p className="fund-manager-eyebrow">Allocation records</p>
                        <h2 id="fund-allocation-title">Fund allocation</h2>
                    </div>
                </div>
                {fundsApi.loading ? (
                    <SkeletonLoader variant="chart" label="Loading fund allocation chart" />
                ) : fundsApi.error ? (
                    <ErrorState message={fundsApi.error} onRetry={fundsApi.refetch} />
                ) : (
                    <Suspense fallback={<SkeletonLoader variant="chart" label="Loading fund allocation chart" />}>
                        <FundManagerCharts funds={funds} allocationEntries={allocationEntries} />
                    </Suspense>
                )}
            </section>

            <section className="fund-manager-dashboard-section" aria-labelledby="managed-funds-title">
                <div className="fund-manager-section-heading">
                    <div>
                        <p className="fund-manager-eyebrow">Portfolio configuration</p>
                        <h2 id="managed-funds-title">Managed funds</h2>
                    </div>
                    <Link className="fund-manager-link" to="/manager/funds">View funds</Link>
                </div>
                {fundsApi.loading ? (
                    <LoadingState message="Loading managed funds..." />
                ) : fundsApi.error ? (
                    <ErrorState message={fundsApi.error} onRetry={fundsApi.refetch} />
                ) : funds.length ? (
                    <>
                        <p className="fund-manager-section-note">
                            Expected returns are configured values, not realized investment performance. Allocation share is based on current recorded allocation percentage points, not asset value.
                        </p>
                        <ul className="fund-manager-fund-list">
                            {funds.map((fund) => {
                                const allocation = allocationBreakdown.find(
                                    (item) => String(item.fund_id) === String(fund.fund_id)
                                );
                                const allocationValue = allocation?.percentagePoints > 0
                                    ? `${allocation.allocationShare.toFixed(1)}%`
                                    : "No active allocation";
                                return (
                                    <li key={fund.fund_id}>
                                        <div className="fund-manager-fund-heading">
                                            <div>
                                                <h3>{fund.fund_name}</h3>
                                                <span>{fund.administrator_name || "Administrator unavailable"}</span>
                                            </div>
                                            {fund.fund_status
                                                ? <StatusBadge status={fund.fund_status} />
                                                : <span>Unavailable</span>}
                                        </div>
                                        <dl>
                                            <div>
                                                <dt>Risk category</dt>
                                                <dd>{fund.risk_level || "Unavailable"}</dd>
                                            </div>
                                            <div>
                                                <dt>Expected return</dt>
                                                <dd>{formatPercentage(fund.expected_return)}</dd>
                                            </div>
                                            <div>
                                                <dt>Share of recorded allocations</dt>
                                                <dd>{allocationValue}</dd>
                                            </div>
                                        </dl>
                                    </li>
                                );
                            })}
                        </ul>
                    </>
                ) : (
                    <p className="fund-manager-empty">No managed funds are available.</p>
                )}
            </section>

            <section className="fund-manager-dashboard-section" aria-labelledby="pending-withdrawals-title">
                <div className="fund-manager-section-heading">
                    <div>
                        <p className="fund-manager-eyebrow">Review queue</p>
                        <h2 id="pending-withdrawals-title">Pending withdrawal requests</h2>
                    </div>
                    <Link className="fund-manager-link" to="/manager/withdrawal-requests">View all requests</Link>
                </div>
                {claimsApi.loading ? (
                    <LoadingState message="Loading withdrawal requests..." />
                ) : claimsApi.error ? (
                    <ErrorState message={claimsApi.error} onRetry={claimsApi.refetch} />
                ) : pendingClaims.length ? (
                    <ul className="fund-manager-claim-list">
                        {pendingClaims.map((claim) => (
                            <li key={claim.claim_id}>
                                <div className="fund-manager-claim-info">
                                    <strong>{claim.full_name || "Worker"}</strong>
                                    <span>{formatCurrency(claim.amount_requested)} · Requested {formatDate(claim.requested_at)}</span>
                                    <StatusBadge status={claim.claim_status} />
                                </div>
                                <div className="fund-manager-claim-actions">
                                    <Button
                                        size="sm"
                                        onClick={() => setConfirming({ claim, decision: "APPROVED" })}
                                    >
                                        Approve
                                    </Button>
                                    <Button
                                        variant="danger"
                                        size="sm"
                                        onClick={() => setConfirming({ claim, decision: "REJECTED" })}
                                    >
                                        Reject
                                    </Button>
                                </div>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="fund-manager-empty">There are no pending withdrawal requests.</p>
                )}
            </section>

            <nav className="fund-manager-dashboard-section fund-manager-quick-links" aria-labelledby="manager-quick-access-title">
                <div className="fund-manager-section-heading">
                    <div>
                        <p className="fund-manager-eyebrow">Navigation</p>
                        <h2 id="manager-quick-access-title">Quick access</h2>
                    </div>
                </div>
                <ul>
                    {FUND_MANAGER_LINKS.map((item) => (
                        <li key={item.to}>
                            <Link to={item.to}>
                                <span>{item.label}</span>
                                <small>{item.description}</small>
                            </Link>
                        </li>
                    ))}
                </ul>
            </nav>

            <Modal
                open={Boolean(confirming)}
                title={confirming?.decision === "APPROVED" ? "Approve withdrawal claim?" : "Reject withdrawal claim?"}
                onClose={() => setConfirming(null)}
            >
                {confirming && (
                    <p>
                        {confirming.decision === "APPROVED" ? "Approve" : "Reject"} the request of{" "}
                        <strong>{formatCurrency(confirming.claim.amount_requested)}</strong> from{" "}
                        <strong>{confirming.claim.full_name}</strong>? Approval records a review decision and does not pay the claim.
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
