import useApi from "../../hooks/useApi";
import { getMyPlan } from "../../services/retirementService";
import { StatCard } from "../../components/ui/Card";
import LoadingState from "../../components/ui/LoadingState";
import ErrorState from "../../components/ui/ErrorState";

function formatCurrency(value) {
    if (value === undefined || value === null) return "KSh 0.00";
    return `KSh ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function RetirementProjection() {
    const planApi = useApi(getMyPlan, []);

    if (planApi.loading) return <LoadingState message="Loading your projection..." />;
    if (planApi.error) return <ErrorState message={planApi.error} onRetry={planApi.refetch} />;

    const { plan, projection } = planApi.data || {};

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Retirement Projection</h1>
                    <p className="page-subtitle">
                        An estimate of your pension balance at retirement, assuming an 8% annual growth rate.
                    </p>
                </div>
            </div>

            {!projection ? (
                <div className="state-block">
                    <span>No projection has been calculated yet. Save a retirement plan first.</span>
                </div>
            ) : (
                <>
                    <div className="stat-card-grid">
                        <StatCard label="Projected Balance" value={formatCurrency(projection.projected_amount)} />
                        <StatCard
                            label="Assumed Monthly Contribution"
                            value={formatCurrency(projection.assumed_contribution)}
                        />
                        <StatCard label="Assumed Annual Return" value={`${projection.assumed_return}%`} />
                        <StatCard label="Years to Retirement" value={projection.projection_years} />
                    </div>
                    {plan && (
                        <div className="section card">
                            <h2 className="card-title">Based on your plan</h2>
                            <p>
                                Target: KSh {Number(plan.target_amount).toLocaleString()} by age {plan.target_age}
                            </p>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

export default RetirementProjection;
