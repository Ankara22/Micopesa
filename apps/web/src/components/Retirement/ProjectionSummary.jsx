import Card from "../ui/Card";
import StatusBadge from "../ui/StatusBadge";
import "./retirement.css";

function formatCurrency(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return "Not available";
    return `KSh ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ProjectionSummary({ plan, projection, currentBalance = 0 }) {
    if (!plan || !projection) return null;

    const targetAmount = Number(plan.target_amount);
    const projectedAmount = Number(projection.projected_amount);
    const monthlyContribution = Number(projection.assumed_contribution);
    const projectionYears = Number(projection.projection_years);
    const totalContributions = monthlyContribution * projectionYears * 12;
    const expectedYield = projectedAmount - Number(currentBalance || 0) - totalContributions;
    const achievable = projectedAmount >= targetAmount;
    const progress = targetAmount > 0 ? Math.min((projectedAmount / targetAmount) * 100, 100) : 0;

    const metrics = [
        ["Target retirement age", `Age ${plan.target_age}`],
        ["Target goal amount", formatCurrency(targetAmount)],
        ["Monthly contribution target", formatCurrency(monthlyContribution)],
        ["Projected amount at retirement", formatCurrency(projectedAmount)],
        ["Total contributions", formatCurrency(totalContributions)],
        ["Expected yield", formatCurrency(expectedYield)],
    ];

    return (
        <Card title="Your retirement projection" className="retirement-card">
            <div className="retirement-projection-status">
                <StatusBadge status={achievable ? "ACTIVE" : "PENDING"} />
                <span>{achievable ? "Target Achievable" : "Shortfall Warning"}</span>
            </div>
            <div
                className="retirement-progress-track"
                role="progressbar"
                aria-label="Projected progress toward retirement goal"
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow={Math.round(progress)}
            >
                <div
                    className={`retirement-progress-fill ${achievable ? "is-achievable" : "is-shortfall"}`}
                    style={{ width: `${progress}%` }}
                />
            </div>
            <p className="retirement-progress-label">
                {progress.toFixed(1)}% of your goal projected
            </p>
            <dl className="retirement-metrics">
                {metrics.map(([label, value]) => (
                    <div className="retirement-metric" key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                    </div>
                ))}
            </dl>
        </Card>
    );
}

export default ProjectionSummary;
