import { useState } from "react";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import { listFunds, getFundAllocations } from "../../services/fundService";
import DataTable from "../../components/ui/DataTable";
import StatusBadge from "../../components/ui/StatusBadge";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";

function FundOversight() {
    const { t, i18n } = useTranslation();
    const fundsApi = useApi(listFunds, []);
    const [viewingFund, setViewingFund] = useState(null);
    const allocationsApi = useApi(
        () => (viewingFund ? getFundAllocations(viewingFund.fund_id) : Promise.resolve([])),
        [viewingFund]
    );
    const locale = i18n.resolvedLanguage?.startsWith("sw") ? "sw-KE" : "en-KE";
    const columns = [
        { key: "fund_name", header: t("regulator.fundsPage.fundName") },
        { key: "administrator_name", header: t("regulator.fundsPage.administrator") },
        { key: "risk_level", header: t("regulator.fundsPage.riskCategory") },
        {
            key: "expected_return",
            header: t("regulator.fundsPage.expectedReturn"),
            render: (row) => row.expected_return === null || row.expected_return === undefined
                ? t("regulator.fundsPage.notConfigured")
                : `${row.expected_return}%`,
        },
        { key: "fund_status", header: t("regulator.fundsPage.status"), render: (row) => <StatusBadge status={row.fund_status} /> },
        {
            key: "actions",
            header: "",
            render: (row) => (
                <Button variant="secondary" size="sm" onClick={() => setViewingFund(row)}>
                    {t("regulator.fundsPage.viewDistribution")}
                </Button>
            ),
        },
    ];

    const allocationColumns = [
        { key: "percentage", header: t("regulator.fundsPage.percentage"), render: (row) => `${Number(row.percentage).toFixed(2)}%` },
        { key: "allocation_count", header: t("regulator.fundsPage.allocationCount") },
        { key: "effective_from", header: t("regulator.fundsPage.effectiveFrom"), render: (row) => formatDate(row.effective_from, locale, t) },
        {
            key: "effective_to",
            header: t("regulator.fundsPage.effectiveTo"),
            render: (row) => (row.effective_to ? formatDate(row.effective_to, locale, t) : t("regulator.fundsPage.ongoing")),
        },
    ];

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">{t("regulator.fundsPage.title")}</h1>
                    <p className="page-subtitle">{t("regulator.fundsPage.subtitle")}</p>
                </div>
            </div>

            <DataTable
                columns={columns}
                rows={fundsApi.data}
                rowKey="fund_id"
                loading={fundsApi.loading}
                refreshing={fundsApi.refreshing}
                error={fundsApi.error}
                onRetry={fundsApi.refetch}
                emptyMessage={t("regulator.fundsPage.noFunds")}
            />

            <Modal
                open={Boolean(viewingFund)}
                size="wide"
                title={t("regulator.fundsPage.dialogTitle", { fund: viewingFund?.fund_name || "" })}
                onClose={() => setViewingFund(null)}
            >
                <DataTable
                    columns={allocationColumns}
                    rows={allocationsApi.data}
                    rowKey="distribution_key"
                    loading={allocationsApi.loading}
                    refreshing={allocationsApi.refreshing}
                    error={allocationsApi.error}
                    onRetry={allocationsApi.refetch}
                    emptyMessage={t("regulator.fundsPage.noAllocations")}
                />
            </Modal>
        </div>
    );
}

function formatDate(value, locale, t) {
    if (!value) return t("regulator.fundsPage.unavailable");
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? t("regulator.fundsPage.unavailable") : date.toLocaleDateString(locale);
}

export default FundOversight;
