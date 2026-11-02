import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import { getMyBalance, getMyContributions } from "../../services/accountService";
import { getMyAllocations, listAvailableFunds } from "../../services/fundService";
import { StatCard } from "../../components/ui/Card";
import DataTable from "../../components/ui/DataTable";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import ErrorState from "../../components/ui/ErrorState";
import LoadingState from "../../components/ui/LoadingState";
import StatusBadge from "../../components/ui/StatusBadge";
import Button from "../../components/ui/Button";
import ContributionModal from "../../components/Contribution/ContributionModal";
import { formatDateTime, formatKes, formatNumber } from "../../i18n/formatters";

const getColumns = (t, language) => [
    { key: "created_at", header: t("worker.contributions.date"), render: (row) => formatDateTime(row.created_at, language) },
    { key: "amount", header: t("worker.contributions.amount"), render: (row) => formatKes(row.amount, language) || t("worker.common.notAvailable") },
    { key: "channel", header: t("worker.contributions.channel") },
    {
        key: "fund_allocations",
        header: t("worker.contributions.fundAllocation"),
        render: (row) => Array.isArray(row.fund_allocations) && row.fund_allocations.length
            ? row.fund_allocations.map((share) =>
                `${share.fund_name}: ${formatKes(share.allocated_amount, language) || t("worker.common.notAvailable")} (${formatNumber(share.allocation_percentage, language, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%)`
            ).join(", ")
            : t("worker.contributions.noAllocation"),
    },
    { key: "contribution_status", header: t("worker.contributions.contribution"), render: (row) => <StatusBadge status={row.contribution_status} label={t(`worker.common.statuses.${row.contribution_status}`, { defaultValue: row.contribution_status })} /> },
    { key: "transaction_status", header: t("worker.contributions.payment"), render: (row) => <StatusBadge status={row.transaction_status} label={t(`worker.common.statuses.${row.transaction_status}`, { defaultValue: row.transaction_status })} /> },
    { key: "mpesa_result_description", header: t("worker.contributions.paymentDetails"), render: (row) => row.mpesa_result_description || "-" },
];

function Contributions() {
    const { t, i18n } = useTranslation();
    const [contributionOpen, setContributionOpen] = useState(false);
    const balanceApi = useApi(getMyBalance, []);
    const contributionsApi = useApi(getMyContributions, []);
    const fundsApi = useApi(listAvailableFunds, []);
    const allocationsApi = useApi(getMyAllocations, []);
    const { refetch: refetchContributions } = contributionsApi;
    const handleContributionCreated = useCallback(async () => {
        const refreshed = await refetchContributions();
        return refreshed !== null;
    }, [refetchContributions]);

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">{t("worker.contributions.title")}</h1>
                    <p className="page-subtitle">{t("worker.contributions.subtitle")}</p>
                </div>
            </div>

            <section aria-label={t("worker.contributions.currentBalance")}>
                {balanceApi.loading && balanceApi.data === null ? (
                    <SkeletonLoader variant="metrics" count={1} label={t("worker.contributions.loadingBalance")} />
                ) : balanceApi.error && balanceApi.data === null ? (
                    <ErrorState message={t("worker.common.errors.load")} title={t("worker.common.unableToLoad")} retryLabel={t("worker.common.tryAgain")} onRetry={balanceApi.refetch} />
                ) : (
                    <>
                        {balanceApi.refreshing && <LoadingState message={t("worker.contributions.refreshingBalance")} />}
                        {balanceApi.error && <ErrorState message={t("worker.common.errors.load")} title={t("worker.common.unableToLoad")} retryLabel={t("worker.common.tryAgain")} onRetry={balanceApi.refetch} />}
                        <div className="stat-card-grid">
                            <StatCard label={t("worker.contributions.currentBalance")} value={formatKes(balanceApi.data?.current_balance, i18n.language) || t("worker.common.notAvailable")} />
                        </div>
                    </>
                )}
            </section>

            <div className="section card">
                <h2 className="card-title">{t("worker.contributions.makeContribution")}</h2>
                <p className="page-subtitle" style={{ marginBottom: 14 }}>
                    {t("worker.contributions.paymentUnavailable")}
                </p>
                <Button variant="primary" onClick={() => setContributionOpen(true)}>{t("worker.contributions.recordContribution")}</Button>
            </div>

            <div className="section">
                <h2 className="card-title">{t("worker.contributions.history")}</h2>
                <DataTable
                    columns={getColumns(t, i18n.language)}
                    rows={contributionsApi.data}
                    rowKey="contribution_id"
                    loading={contributionsApi.loading}
                    refreshing={contributionsApi.refreshing}
                    error={contributionsApi.error ? t("worker.common.errors.load") : null}
                    onRetry={contributionsApi.refetch}
                    emptyMessage={t("worker.contributions.empty")}
                    loadingLabel={t("worker.common.loadingRecords")}
                    refreshingLabel={t("worker.common.refreshingRecords")}
                    errorTitle={t("worker.common.unableToLoad")}
                    retryLabel={t("worker.common.tryAgain")}
                    unexpectedDataMessage={t("worker.common.unexpectedData")}
                />
            </div>
            <ContributionModal
                open={contributionOpen}
                onClose={() => setContributionOpen(false)}
                availableFunds={fundsApi.data || []}
                allocations={allocationsApi.data || []}
                loading={
                    (fundsApi.loading && fundsApi.data === null) ||
                    (allocationsApi.loading && allocationsApi.data === null)
                }
                error={fundsApi.error || allocationsApi.error ? t("worker.common.errors.load") : null}
                loadingLabel={t("worker.common.loadingRecords")}
                onRetry={() => {
                    fundsApi.refetch(true);
                    allocationsApi.refetch(true);
                }}
                onCreated={handleContributionCreated}
            />
        </div>
    );
}

export default Contributions;
