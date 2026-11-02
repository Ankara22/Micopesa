import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import { getMyPlan, saveMyPlan } from "../../services/retirementService";
import PlanForm from "../../components/Retirement/PlanForm";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import ErrorState from "../../components/ui/ErrorState";
import { formatKes } from "../../i18n/formatters";

function RetirementPlan() {
    const { t, i18n } = useTranslation();
    const planApi = useApi(() => getMyPlan(), []);
    const plan = planApi.data?.plan || null;
    const projection = planApi.data?.projection || null;

    async function savePlan(payload) {
        const saved = await saveMyPlan(payload);
        await planApi.refetch();
        return saved;
    }

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">{t("worker.retirement.planTitle")}</h1>
                    <p className="page-subtitle">{t("worker.retirement.planSubtitle")}</p>
                </div>
            </div>

            {planApi.loading && planApi.data === null ? (
                <SkeletonLoader variant="form" count={4} label={t("worker.retirement.loadingPlan")} />
            ) : planApi.error && planApi.data === null ? (
                <ErrorState message={t("worker.common.errors.load")} title={t("worker.common.unableToLoad")} retryLabel={t("worker.common.tryAgain")} onRetry={planApi.refetch} />
            ) : (
                <>
                    {planApi.refreshing && <p role="status">{t("worker.retirement.refreshingPlan")}</p>}
                    {planApi.error && <ErrorState message={t("worker.common.errors.load")} title={t("worker.common.unableToLoad")} retryLabel={t("worker.common.tryAgain")} onRetry={planApi.refetch} />}
                    {plan && (
                        <div className="section card">
                            <h2 className="card-title">{t("worker.retirement.currentPlan")}</h2>
                            <p>
                                {t("worker.retirement.target")} <strong>{formatKes(plan.target_amount, i18n.language)}</strong> {t("worker.retirement.byAge")}{" "}
                                <strong>{plan.target_age}</strong>
                            </p>
                            <p>{t("worker.retirement.status")} {t(`worker.common.statuses.${plan.plan_status}`, { defaultValue: plan.plan_status })}</p>
                        </div>
                    )}
                    <PlanForm
                        key={plan?.plan_id || "new"}
                        plan={plan}
                        projection={projection}
                        onSaved={savePlan}
                    />
                </>
            )}
        </div>
    );
}

export default RetirementPlan;
