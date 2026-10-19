import { Link } from "react-router-dom";
import { useCallback } from "react";
import useApi from "../../hooks/useApi";
import { getMyBalance } from "../../services/accountService";
import { getRetirementPlan, updateRetirementPlan } from "../../services/retirementApi";
import { getMyClaims } from "../../services/withdrawalService";
import { StatCard } from "../../components/ui/Card";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import ErrorState from "../../components/ui/ErrorState";
import Button from "../../components/ui/Button";
import PlanForm from "../../components/Retirement/PlanForm";
import ProjectionSummary from "../../components/Retirement/ProjectionSummary";

function formatCurrency(value) {
    if (value === undefined || value === null) return "KSh 0.00";
    return `KSh ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function WorkerDashboard() {
    const balanceApi = useApi(getMyBalance, []);
    const fetchPlan = useCallback(
        () => getRetirementPlan().catch((err) => {
            if (err.status === 404) return null;
            throw err;
        }),
        []
    );
    const planApi = useApi(fetchPlan, []);
    const claimsApi = useApi(() => getMyClaims().catch(() => []), []);

    const loading = balanceApi.loading || planApi.loading || claimsApi.loading;
    const error = balanceApi.error;

    if (loading) return <SkeletonLoader variant="metrics" count={4} label="Loading your dashboard" />;
    if (error) return <ErrorState message={error} onRetry={balanceApi.refetch} />;

    const balance = balanceApi.data;
    const plan = planApi.data?.plan;
    const projection = planApi.data?.projection;
    const claims = claimsApi.data || [];
    const pendingClaims = claims.filter((c) => c.claim_status === "PENDING").length;

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Welcome back</h1>
                    <p className="page-subtitle">Here's an overview of your MicoPesa pension account.</p>
                </div>
            </div>

            <div className="stat-card-grid">
                <StatCard label="Current Balance" value={formatCurrency(balance?.current_balance)} hint={balance?.account_status} />
                <StatCard
                    label="Retirement Target"
                    value={plan ? formatCurrency(plan.target_amount) : "Not set"}
                    hint={plan ? `By age ${plan.target_age}` : "Create a retirement plan"}
                />
                <StatCard
                    label="Projected Balance"
                    value={projection ? formatCurrency(projection.projected_amount) : "N/A"}
                    hint={projection ? `${projection.projection_years} years` : undefined}
                />
                <StatCard label="Pending Withdrawal Claims" value={pendingClaims} />
            </div>

            {planApi.error ? (
                <ErrorState message={planApi.error} onRetry={planApi.refetch} />
            ) : (
                <>
                    {plan && (
                        <ProjectionSummary
                            plan={plan}
                            projection={projection}
                            currentBalance={balance?.current_balance}
                        />
                    )}
                    <PlanForm
                        plan={plan}
                        projection={projection}
                        onSaved={async (payload) => {
                            const result = await updateRetirementPlan(payload);
                            planApi.setData(result);
                            return result;
                        }}
                    />
                </>
            )}

            <div className="section card">
                <h2 className="card-title">Quick actions</h2>
                <div className="form-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
                    <Link to="/worker/contributions">
                        <Button variant="primary">Make a Contribution</Button>
                    </Link>
                    <Link to="/worker/withdrawals">
                        <Button variant="secondary">Request a Withdrawal</Button>
                    </Link>
                    <Link to="/worker/retirement-plan">
                        <Button variant="secondary">Update Retirement Plan</Button>
                    </Link>
                </div>
            </div>
        </div>
    );
}

export default WorkerDashboard;
