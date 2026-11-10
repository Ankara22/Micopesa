import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import { downloadMyStatement, getMyBalance, getMyContributions } from "../../services/accountService";
import { getMyAllocations, listAvailableFunds } from "../../services/fundService";
import { StatCard } from "../../components/ui/Card";
import DataTable from "../../components/ui/DataTable";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import ErrorState from "../../components/ui/ErrorState";
import LoadingState from "../../components/ui/LoadingState";
import StatusBadge from "../../components/ui/StatusBadge";
import Button from "../../components/ui/Button";
import ContributionModal from "../../components/Contribution/ContributionModal";
import DepositModal from "../../components/Deposit/DepositModal";
import { formatDateTime, formatKes, formatNumber } from "../../i18n/formatters";

const getColumns = (t, language) => [
    { key: "created_at", header: t("worker.contributions.date"), render: (row) => formatDateTime(row.created_at, language) },
    { key: "amount", header: t("worker.contributions.amount"), render: (row) => formatKes(row.amount, language) || t("worker.common.notAvailable") },
    {
        key: "channel",
        header: t("worker.contributions.channel"),
        render: (row) => row.payment_provider === "SIMULATED"
            ? t("worker.contributions.simulated")
            : row.channel,
    },
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
    {
        key: "mpesa_result_description",
        header: t("worker.contributions.paymentDetails"),
        render: (row) => {
            const details = row.mpesa_result_description || "";
            const simulated = row.payment_provider === "SIMULATED";
            const reference = simulated
                ? (row.checkout_request_id || row.mpesa_receipt)
                : row.payment_provider === "DARAJA" ? row.mpesa_receipt : null;
            return [
                simulated
                    ? t("worker.contributions.simulatedNoMoney")
                    : "",
                reference
                    ? `${t(simulated
                        ? "worker.contributions.syntheticReference"
                        : "worker.depositModal.receipt")}: ${reference}`
                    : "",
                details,
            ].filter(Boolean).join(" — ") || "-";
        },
    },
];

function Contributions() {
    const { t, i18n } = useTranslation();
    const [contributionOpen, setContributionOpen] = useState(false);
    const [depositOpen, setDepositOpen] = useState(false);
    const [statementDownloading, setStatementDownloading] = useState(false);
    const [statementError, setStatementError] = useState("");
    const balanceApi = useApi(getMyBalance, []);
    const contributionsApi = useApi(getMyContributions, []);
    const fundsApi = useApi(listAvailableFunds, []);
    const allocationsApi = useApi(getMyAllocations, []);
    const { refetch: refetchBalance } = balanceApi;
    const { refetch: refetchContributions } = contributionsApi;
    const handleContributionCreated = useCallback(async () => {
        const refreshed = await refetchContributions();
        return refreshed !== null;
    }, [refetchContributions]);
    const handleDepositCompleted = useCallback(async () => {
        await Promise.all([
            refetchBalance(true),
            refetchContributions(true),
        ]);
    }, [refetchBalance, refetchContributions]);
    const handleStatementDownload = async (format) => {
        setStatementError("");
        setStatementDownloading(true);
        try {
            const response = await downloadMyStatement(format);
            const url = URL.createObjectURL(response.data);
            const link = document.createElement("a");
            link.href = url;
            link.download = `micopesa-my-statement-${new Date().toISOString().slice(0, 10)}.${format.toLowerCase()}`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) {
            setStatementError(error.message || t("worker.contributions.statementError"));
        } finally {
            setStatementDownloading(false);
        }
    };

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
                <Button variant="secondary" onClick={() => setDepositOpen(true)}>{t("worker.contributions.mpesaDeposit")}</Button>
            </div>

            <div className="section">
                <h2 className="card-title">{t("worker.contributions.history")}</h2>
                <div
                    aria-label={t("worker.contributions.statementDownloads")}
                    style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}
                >
                    {["CSV", "XLSX", "PDF"].map((format) => (
                        <Button
                            key={format}
                            variant="secondary"
                            disabled={statementDownloading}
                            onClick={() => handleStatementDownload(format)}
                        >
                            {statementDownloading
                                ? t("worker.contributions.statementDownloading")
                                : t(`worker.contributions.download${format}`)}
                        </Button>
                    ))}
                </div>
                {statementError && <p role="alert">{statementError}</p>}
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
            <DepositModal
                open={depositOpen}
                onClose={() => setDepositOpen(false)}
                onCompleted={handleDepositCompleted}
            />
        </div>
    );
}

export default Contributions;
