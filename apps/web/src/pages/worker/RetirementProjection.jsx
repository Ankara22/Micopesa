import { lazy, Suspense, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../context/AuthContext";
import useApi from "../../hooks/useApi";
import { getMyPlan, saveMyPlan } from "../../services/retirementService";
import Card from "../../components/ui/Card";
import ErrorState from "../../components/ui/ErrorState";
import LoadingState from "../../components/ui/LoadingState";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import PlanForm from "../../components/Retirement/PlanForm";
import ProjectionSummary from "../../components/Retirement/ProjectionSummary";
import "./retirement-projection.css";
import { formatKes, formatNumber } from "../../i18n/formatters";

const RetirementProjectionCharts = lazy(() => import("../../components/Retirement/RetirementProjectionCharts"));

function isValidProjectionData(plan, projection) {
    const isNumber = (value) => value !== null &&
        value !== undefined &&
        value !== "" &&
        Number.isFinite(Number(value));
    const years = Number(projection?.projection_years);
    const series = projection?.yearly_projection;
    return Boolean(plan) &&
        isNumber(plan.target_amount) && Number(plan.target_amount) > 0 &&
        isNumber(plan.target_age) &&
        isNumber(projection?.projected_amount) && Number(projection.projected_amount) >= 0 &&
        isNumber(projection?.assumed_contribution) && Number(projection.assumed_contribution) >= 0 &&
        isNumber(projection?.assumed_return) && Number(projection.assumed_return) >= 0 &&
        Number.isInteger(years) && years > 0 &&
        Number.isInteger(Number(projection.current_age)) &&
        isNumber(projection.starting_balance) && Number(projection.starting_balance) >= 0 &&
        Array.isArray(series) && series.length === years + 1 &&
        series.every((point, index) =>
            point.year === index &&
            Number.isInteger(point.age) &&
            Number.isFinite(Number(point.projectedBalance)) &&
            Number.isFinite(Number(point.totalContributions))
        );
}

function RetirementProjection() {
    const { t, i18n } = useTranslation();
    const { loginSessionId } = useAuth();
    const fetchPlan = useCallback(async () => {
        const result = await getMyPlan();
        const balance = Number(result?.account?.current_balance);
        const growth = Number(result?.assumed_yearly_growth);
        if (
            !result ||
            typeof result !== "object" ||
            !Object.hasOwn(result, "plan") ||
            !Number.isFinite(balance) ||
            balance < 0 ||
            !Number.isFinite(growth) ||
            growth < 0 ||
            growth > 20
        ) {
            throw new Error("UNEXPECTED_RESPONSE");
        }
        return result;
    }, []);
    const planApi = useApi(fetchPlan, [loginSessionId]);
    const plan = planApi.data?.plan || null;
    const projection = planApi.data?.projection || null;
    const validProjection = isValidProjectionData(plan, projection);

    async function saveProjection(payload) {
        const saved = await saveMyPlan(payload);
        await planApi.refetch();
        return saved;
    }

    return (
        <div className="retirement-projection-page">
            <div className="page-header">
                <div>
                    <h1 className="page-title">{t("worker.retirement.projectionTitle")}</h1>
                    <p className="page-subtitle">{t("worker.retirement.projectionSubtitle")}</p>
                </div>
            </div>

            {planApi.loading && planApi.data === null ? (
                <div className="retirement-projection-loading">
                    <SkeletonLoader variant="metrics" count={2} label={t("worker.retirement.loadingAssumptions")} />
                    <SkeletonLoader variant="form" count={4} label={t("worker.retirement.loadingForm")} />
                </div>
            ) : planApi.error && planApi.data === null ? (
                <ErrorState message={t("worker.common.errors.load")} title={t("worker.common.unableToLoad")} retryLabel={t("worker.common.tryAgain")} onRetry={planApi.refetch} />
            ) : (
                <>
                    {planApi.refreshing && <LoadingState message={t("worker.retirement.refreshingProjection")} />}
                    {planApi.error && <ErrorState message={t("worker.common.errors.load")} title={t("worker.common.unableToLoad")} retryLabel={t("worker.common.tryAgain")} onRetry={planApi.refetch} />}

                    <div className="retirement-assumptions" aria-label={t("worker.retirement.assumptionsLabel")}>
                        <Card title={t("worker.retirement.currentBalance")} className="retirement-card">
                            <p className="retirement-assumption-value">
                                {formatKes(planApi.data?.account?.current_balance, i18n.language) || t("worker.retirement.notAvailable")}
                            </p>
                            <p className="retirement-assumption-note">
                                {t("worker.retirement.balanceNote")}
                            </p>
                        </Card>
                        <Card title={t("worker.retirement.annualGrowth")} className="retirement-card">
                            <p className="retirement-assumption-value">
                                {formatNumber(planApi.data?.assumed_yearly_growth, i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}% {t("worker.retirement.perYear")}
                            </p>
                            <p className="retirement-assumption-note">
                                {t("worker.retirement.annualGrowthNote")}
                            </p>
                        </Card>
                    </div>

                    <PlanForm
                        key={loginSessionId || "projection-session"}
                        plan={plan}
                        projection={projection}
                        onSaved={saveProjection}
                    />

                    {projection && !validProjection && (
                        <div className="state-block retirement-projection-empty" role="status">
                            <span className="state-title">{t("worker.retirement.unavailableSeries")}</span>
                            <span>{t("worker.retirement.regenerate")}</span>
                        </div>
                    )}

                    {validProjection && (
                        <>
                            <ProjectionSummary plan={plan} projection={projection} />
                            <Suspense fallback={<SkeletonLoader variant="chart" label={t("worker.retirement.chartLoading")} />}>
                                <RetirementProjectionCharts projection={projection} />
                            </Suspense>
                        </>
                    )}

                    <p className="retirement-disclaimer">
                        {t("worker.retirement.disclaimer")}
                    </p>
                </>
            )}
        </div>
    );
}

export default RetirementProjection;
