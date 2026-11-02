import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import { getMyBalance, getMyContributions } from "../../services/accountService";
import { StatCard } from "../../components/ui/Card";
import DataTable from "../../components/ui/DataTable";
import StatusBadge from "../../components/ui/StatusBadge";
import { formatDateTime, formatKes } from "../../i18n/formatters";

function BalanceHistory() {
    const { t, i18n } = useTranslation();
    const balanceApi = useApi(getMyBalance, []);
    const historyApi = useApi(getMyContributions, []);
    const columns = [
        { key: "created_at", header: t("worker.balance.date"), render: (row) => formatDateTime(row.created_at, i18n.language) },
        { key: "transaction_id", header: t("worker.balance.transactionId") },
        { key: "amount", header: t("worker.balance.amount"), render: (row) => formatKes(row.amount, i18n.language) || t("worker.common.notAvailable") },
        { key: "channel", header: t("worker.balance.channel") },
        { key: "contribution_status", header: t("worker.balance.status"), render: (row) => <StatusBadge status={row.contribution_status} label={t(`worker.common.statuses.${row.contribution_status}`, { defaultValue: row.contribution_status })} /> },
    ];

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">{t("worker.balance.title")}</h1>
                    <p className="page-subtitle">{t("worker.balance.subtitle")}</p>
                </div>
            </div>

            <div className="stat-card-grid">
                <StatCard
                    label={t("worker.balance.currentBalance")}
                    value={balanceApi.loading ? "..." : formatKes(balanceApi.data?.current_balance, i18n.language) || t("worker.common.notAvailable")}
                    hint={balanceApi.data?.account_status
                        ? t(`worker.common.statuses.${balanceApi.data.account_status}`, { defaultValue: balanceApi.data.account_status })
                        : undefined}
                />
            </div>

            <div className="section">
                <h2 className="card-title">{t("worker.balance.allTransactions")}</h2>
                <DataTable
                    columns={columns}
                    rows={historyApi.data}
                    rowKey="contribution_id"
                    loading={historyApi.loading}
                    refreshing={historyApi.refreshing}
                    error={historyApi.error ? t("worker.common.errors.load") : null}
                    onRetry={historyApi.refetch}
                    emptyMessage={t("worker.balance.empty")}
                    loadingLabel={t("worker.common.loadingRecords")}
                    refreshingLabel={t("worker.common.refreshingRecords")}
                    errorTitle={t("worker.common.unableToLoad")}
                    retryLabel={t("worker.common.tryAgain")}
                    unexpectedDataMessage={t("worker.common.unexpectedData")}
                />
            </div>
        </div>
    );
}

export default BalanceHistory;
