import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useCallback } from "react";
import { useAuth } from "../../context/AuthContext";
import useApi from "../../hooks/useApi";
import { getMyBalance, getMyContributions } from "../../services/accountService";
import { getRetirementPlan } from "../../services/retirementApi";
import { StatCard } from "../../components/ui/Card";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import ErrorState from "../../components/ui/ErrorState";
import LoadingState from "../../components/ui/LoadingState";
import StatusBadge from "../../components/ui/StatusBadge";
import { formatKes } from "../../i18n/formatters";
import "./worker-dashboard.css";

const WORKER_LINKS = [
    { key: "contributions", to: "/worker/contributions" },
    { key: "analytics", to: "/worker/analytics" },
    { key: "balance", to: "/worker/balance" },
    { key: "funds", to: "/worker/funds" },
    { key: "plan", to: "/worker/retirement-plan" },
    { key: "projection", to: "/worker/retirement-projection" },
    { key: "literacy", to: "/worker/literacy" },
];

function getGreetingKey() {
    const hour = new Date().getHours();
    if (hour < 12) return "greetingMorning";
    if (hour < 18) return "greetingAfternoon";
    return "greetingEvening";
}

function WorkerDashboard() {
    const { t, i18n } = useTranslation();
    const { user, loginSessionId } = useAuth();
    const balanceApi = useApi(getMyBalance, [loginSessionId]);
    const contributionsApi = useApi(getMyContributions, [loginSessionId]);
    const fetchPlan = useCallback(
        () => getRetirementPlan().catch((error) => {
            if (error.status === 404) return null;
            throw error;
        }),
        []
    );
    const planApi = useApi(fetchPlan, [loginSessionId]);
    const firstName = user?.full_name?.trim().split(/\s+/)[0];
    const completedContributions = (contributionsApi.data || [])
        .filter((contribution) => contribution.contribution_status === "COMPLETED");
    const completedTotal = completedContributions.reduce(
        (total, contribution) => total + (Number.isFinite(Number(contribution.amount)) ? Number(contribution.amount) : 0),
        0
    );

    return (
        <div className="worker-dashboard">
            <header className="page-header">
                <div>
                    <p className="worker-dashboard-eyebrow">{t("worker.dashboard.eyebrow")}</p>
                    <h1 className="page-title">{t(`worker.dashboard.${getGreetingKey()}`)}{firstName ? `, ${firstName}` : ""}</h1>
                    <p className="page-subtitle">{t("worker.dashboard.subtitle")}</p>
                </div>
            </header>

            <section aria-label={t("worker.dashboard.summaryLabel")}>
                {balanceApi.loading && balanceApi.data === null ? (
                    <SkeletonLoader variant="metrics" count={3} label={t("worker.dashboard.loadingSummary")} />
                ) : balanceApi.error && balanceApi.data === null ? (
                    <ErrorState message={t("worker.common.errors.load")} title={t("worker.common.unableToLoad")} retryLabel={t("worker.common.tryAgain")} onRetry={balanceApi.refetch} />
                ) : (
                    <>
                        {balanceApi.refreshing && <LoadingState message={t("worker.dashboard.refreshingSummary")} />}
                        {balanceApi.error && <ErrorState message={t("worker.common.errors.load")} title={t("worker.common.unableToLoad")} retryLabel={t("worker.common.tryAgain")} onRetry={balanceApi.refetch} />}
                        <div className="stat-card-grid">
                            <StatCard
                                label={t("worker.dashboard.balance")}
                                value={formatKes(balanceApi.data?.current_balance, i18n.language) || t("worker.common.notAvailable")}
                                hint={balanceApi.data?.account_status
                                    ? t("worker.dashboard.accountStatus", { status: t(`worker.common.statuses.${balanceApi.data.account_status}`, { defaultValue: balanceApi.data.account_status }) })
                                    : t("worker.dashboard.accountStatusUnavailable")}
                            />
                            <StatCard
                                label={t("worker.dashboard.completedRecords")}
                                value={contributionsApi.data === null ? "—" : completedContributions.length}
                                hint={contributionsApi.data === null
                                    ? t("worker.dashboard.contributionSummaryUnavailable")
                                    : t("worker.dashboard.recordedTotal", { amount: formatKes(completedTotal, i18n.language) })}
                            />
                            <StatCard
                                label={t("worker.dashboard.retirementTarget")}
                                value={planApi.data?.plan?.target_age
                                    ? t("worker.retirement.age", { age: planApi.data.plan.target_age })
                                    : planApi.loading ? t("worker.dashboard.loading") : t("worker.dashboard.notSet")}
                                hint={planApi.data?.plan?.target_amount
                                    ? t("worker.dashboard.goal", { amount: formatKes(planApi.data.plan.target_amount, i18n.language) })
                                    : t("worker.dashboard.setTarget")}
                            />
                        </div>
                        {contributionsApi.error && <ErrorState message={t("worker.common.errors.load")} title={t("worker.common.unableToLoad")} retryLabel={t("worker.common.tryAgain")} onRetry={contributionsApi.refetch} />}
                        {planApi.error && <ErrorState message={t("worker.common.errors.load")} title={t("worker.common.unableToLoad")} retryLabel={t("worker.common.tryAgain")} onRetry={planApi.refetch} />}
                        {planApi.data?.plan?.plan_status && (
                            <p className="worker-dashboard-supporting">
                                {t("worker.dashboard.planStatus")} <StatusBadge status={planApi.data.plan.plan_status} label={t(`worker.common.statuses.${planApi.data.plan.plan_status}`, { defaultValue: planApi.data.plan.plan_status })} />
                            </p>
                        )}
                    </>
                )}
            </section>

            <nav className="worker-dashboard-quick-links" aria-label={t("worker.dashboard.workerFeatures")}>
                <h2>{t("worker.dashboard.explore")}</h2>
                <ul>
                    {WORKER_LINKS.map((item) => (
                        <li key={item.to}>
                            <Link to={item.to}>
                                <span>{t(`worker.dashboard.links.${item.key}`)}</span>
                                <small>{t(`worker.dashboard.links.${item.key}Description`)}</small>
                            </Link>
                        </li>
                    ))}
                </ul>
            </nav>
        </div>
    );
}

export default WorkerDashboard;
