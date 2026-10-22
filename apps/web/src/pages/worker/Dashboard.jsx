import { Link } from "react-router-dom";
import { useCallback, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import useApi from "../../hooks/useApi";
import { getMyBalance, getMyContributions } from "../../services/accountService";
import { getRetirementPlan, updateRetirementPlan } from "../../services/retirementApi";
import { getMyClaims } from "../../services/withdrawalService";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import ErrorState from "../../components/ui/ErrorState";
import Button from "../../components/ui/Button";
import StatusBadge from "../../components/ui/StatusBadge";
import PlanForm from "../../components/Retirement/PlanForm";
import ProjectionSummary from "../../components/Retirement/ProjectionSummary";
import DepositModal from "../../components/Deposit/DepositModal";
import "./worker-dashboard.css";

function formatCurrency(value) {
    if (value === undefined || value === null || !Number.isFinite(Number(value))) return "Not available";
    return `KSh ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleDateString();
}

function getGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
}

function WorkerDashboard() {
    const [depositOpen, setDepositOpen] = useState(false);
    const { user } = useAuth();
    const balanceApi = useApi(getMyBalance, []);
    const contributionsApi = useApi(getMyContributions, []);
    const handleDepositCompleted = useCallback((payment) => {
        if (payment.transaction_status === "COMPLETED") {
            balanceApi.refetch();
            contributionsApi.refetch();
        }
    }, [balanceApi, contributionsApi]);
    const fetchPlan = useCallback(
        () => getRetirementPlan().catch((err) => {
            if (err.status === 404) return null;
            throw err;
        }),
        []
    );
    const planApi = useApi(fetchPlan, []);
    const claimsApi = useApi(getMyClaims, []);

    const loading = balanceApi.loading || planApi.loading || claimsApi.loading || contributionsApi.loading;

    if (loading) return <SkeletonLoader variant="metrics" count={3} label="Loading your dashboard" />;

    const balance = balanceApi.data;
    const plan = planApi.data?.plan;
    const projection = planApi.data?.projection;
    const claims = claimsApi.data || [];
    const pendingClaims = claims.filter((claim) => claim.claim_status === "PENDING");
    const contributions = contributionsApi.data || [];
    const recentContributions = contributions.slice(0, 3);
    const firstName = user?.full_name?.trim().split(/\s+/)[0];

    return (
        <div className="worker-dashboard">
            <div className="page-header">
                <div>
                    <p className="worker-dashboard-eyebrow">Your pension, at a glance</p>
                    <h1 className="page-title">{getGreeting()}{firstName ? `, ${firstName}` : ""}</h1>
                    <p className="page-subtitle">A clear view of your savings, retirement plan, and account activity.</p>
                </div>
            </div>

            <section className="worker-dashboard-overview" aria-label="Pension account overview">
                <div className="worker-balance-card">
                    <div>
                        <p className="worker-dashboard-label">Current pension balance</p>
                        {balanceApi.error ? (
                            <ErrorState message={balanceApi.error} onRetry={balanceApi.refetch} />
                        ) : (
                            <>
                                <p className="worker-balance-amount">{formatCurrency(balance?.current_balance)}</p>
                                <div className="worker-balance-status">
                                    <span>Account status</span>
                                    <StatusBadge status={balance?.account_status} />
                                </div>
                            </>
                        )}
                    </div>
                    <Button variant="primary" onClick={() => setDepositOpen(true)}>
                        Make a contribution
                    </Button>
                </div>

                <div className="worker-dashboard-summary-grid">
                    <section className="worker-summary-card" aria-labelledby="worker-retirement-summary-title">
                        <div className="worker-summary-heading">
                            <div>
                                <p className="worker-dashboard-label">Retirement plan</p>
                                <h2 id="worker-retirement-summary-title">
                                    {plan ? `Target age ${plan.target_age}` : "Your future, your goal"}
                                </h2>
                            </div>
                            {plan && <StatusBadge status={plan.plan_status} />}
                        </div>
                        {plan ? (
                            <div className="worker-retirement-values">
                                <div>
                                    <span>Goal amount</span>
                                    <strong>{formatCurrency(plan.target_amount)}</strong>
                                </div>
                                <div>
                                    <span>Projected amount</span>
                                    <strong>{formatCurrency(projection?.projected_amount)}</strong>
                                </div>
                            </div>
                        ) : (
                            <p className="worker-dashboard-supporting">
                                Create a retirement plan to set a target and view an estimate based on your chosen contribution.
                            </p>
                        )}
                        {planApi.error ? (
                            <ErrorState message={planApi.error} onRetry={planApi.refetch} />
                        ) : plan && projection ? (
                            <ProjectionSummary plan={plan} projection={projection} currentBalance={balance?.current_balance} />
                        ) : null}
                        <Link className="worker-dashboard-text-link" to="/worker/retirement-plan">
                            {plan ? "View or update your plan" : "Create your retirement plan"}
                        </Link>
                    </section>

                    <section className="worker-summary-card" aria-labelledby="worker-withdrawals-title">
                        <div className="worker-summary-heading">
                            <div>
                                <p className="worker-dashboard-label">Withdrawals</p>
                                <h2 id="worker-withdrawals-title">Request status</h2>
                            </div>
                            {!claimsApi.error && <span className="worker-pending-count">{pendingClaims.length}</span>}
                        </div>
                        {claimsApi.error ? (
                            <ErrorState message={claimsApi.error} onRetry={claimsApi.refetch} />
                        ) : pendingClaims.length ? (
                            <ul className="worker-pending-list">
                                {pendingClaims.slice(0, 2).map((claim) => (
                                    <li key={claim.claim_id}>
                                        <span>{formatCurrency(claim.amount_requested)}</span>
                                        <StatusBadge status={claim.claim_status} />
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="worker-dashboard-supporting">You have no withdrawal requests awaiting review.</p>
                        )}
                        <Link className="worker-dashboard-text-link" to="/worker/withdrawals">
                            View withdrawals
                        </Link>
                    </section>
                </div>
            </section>

            <section className="worker-dashboard-activity" aria-labelledby="worker-recent-contributions-title">
                <div className="worker-dashboard-section-heading">
                    <div>
                        <p className="worker-dashboard-label">Account activity</p>
                        <h2 id="worker-recent-contributions-title">Recent contributions</h2>
                    </div>
                    <Link className="worker-dashboard-text-link" to="/worker/contributions">
                        View all
                    </Link>
                </div>
                {contributionsApi.error ? (
                    <ErrorState message={contributionsApi.error} onRetry={contributionsApi.refetch} />
                ) : recentContributions.length ? (
                    <ul className="worker-contribution-list">
                        {recentContributions.map((contribution) => (
                            <li key={contribution.contribution_id}>
                                <div className="worker-contribution-detail">
                                    <strong>{formatCurrency(contribution.amount)}</strong>
                                    <span>{formatDate(contribution.created_at)} · {contribution.channel}</span>
                                </div>
                                <StatusBadge status={contribution.contribution_status} />
                            </li>
                        ))}
                    </ul>
                ) : (
                    <div className="worker-dashboard-empty">
                        <p>No contributions yet. When you make one, its status will appear here.</p>
                        <Button variant="secondary" onClick={() => setDepositOpen(true)}>
                            Make your first contribution
                        </Button>
                    </div>
                )}
            </section>

            {planApi.error ? null : (
                <section className="worker-dashboard-plan-form" aria-label="Retirement plan form">
                    <PlanForm
                        plan={plan}
                        projection={projection}
                        onSaved={async (payload) => {
                            const result = await updateRetirementPlan(payload);
                            planApi.setData(result);
                            return result;
                        }}
                    />
                </section>
            )}

            <DepositModal
                open={depositOpen}
                onClose={() => setDepositOpen(false)}
                onCompleted={handleDepositCompleted}
            />
        </div>
    );
}

export default WorkerDashboard;
