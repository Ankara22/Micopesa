import Card from "../ui/Card";
import { useTranslation } from "react-i18next";
import { formatKes, formatNumber } from "../../i18n/formatters";
import "./retirement.css";

function ProjectionSummary({ plan, projection }) {
    const { t, i18n } = useTranslation();
    if (!plan || !projection) return null;

    const targetAmount = Number(plan.target_amount);
    const projectedAmount = Number(projection.projected_amount);
    const monthlyContribution = Number(projection.assumed_contribution);
    const projectionYears = Number(projection.projection_years);
    const startingBalance = Number(projection.starting_balance);
    const totalContributions = monthlyContribution * projectionYears * 12;
    const estimatedGrowth = projectedAmount - startingBalance - totalContributions;
    const achievable = projectedAmount >= targetAmount;
    const progress = targetAmount > 0 ? Math.min((projectedAmount / targetAmount) * 100, 100) : 0;

    const metrics = [
        [t("worker.retirement.targetAge"), t("worker.retirement.age", { age: plan.target_age })],
        [t("worker.retirement.targetAmount"), formatKes(targetAmount, i18n.language) || t("worker.retirement.notAvailable")],
        [t("worker.retirement.startingBalance"), formatKes(startingBalance, i18n.language) || t("worker.retirement.notAvailable")],
        [t("worker.retirement.plannedMonthly"), formatKes(monthlyContribution, i18n.language) || t("worker.retirement.notAvailable")],
        [t("worker.retirement.assumedGrowth"), `${formatNumber(projection.assumed_return, i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`],
        [t("worker.retirement.years"), formatNumber(projectionYears, i18n.language)],
        [t("worker.retirement.futureValue"), formatKes(projectedAmount, i18n.language) || t("worker.retirement.notAvailable")],
        [t("worker.retirement.totalContributions"), formatKes(totalContributions, i18n.language) || t("worker.retirement.notAvailable")],
        [t("worker.retirement.estimatedGrowth"), formatKes(estimatedGrowth, i18n.language) || t("worker.retirement.notAvailable")],
    ];

    return (
        <Card title={t("worker.retirement.summaryTitle")} className="retirement-card">
            <div className="retirement-projection-status">
                <span>{achievable ? t("worker.retirement.atOrAbove") : t("worker.retirement.below")}</span>
            </div>
            <div
                className="retirement-progress-track"
                role="progressbar"
                aria-label={t("worker.retirement.progressLabel")}
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
                {t("worker.retirement.ofGoal", {
                    percent: formatNumber(progress, i18n.language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
                })}
            </p>
            <p className="retirement-intro">
                {t("worker.retirement.estimateNote")}
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
