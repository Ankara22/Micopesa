import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import DataTable from "../../components/ui/DataTable";
import Button from "../../components/ui/Button";
import { useToast } from "../../components/ui/ToastContext";
import {
    downloadReport,
    generateReport,
    getReportCatalog,
    getReportFunds,
    getReportHistory,
} from "../../services/reportsApi";

function saveDownload(response, fallbackName) {
    const blob = response.data instanceof Blob
        ? response.data
        : new Blob([response.data], { type: response.headers?.["content-type"] });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = fallbackName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
}

function getTruncatedCount(response) {
    if (String(response.headers?.["x-report-truncated"]).toLowerCase() !== "true") return null;
    const count = Number(response.headers?.["x-report-total-count"]);
    return Number.isSafeInteger(count) && count > 0 ? count : 5001;
}

function ReportsPage({ historyOnly = false }) {
    const { t, i18n } = useTranslation();
    const [filters, setFilters] = useState({
        report_key: "",
        format: "CSV",
        start_date: "",
        end_date: "",
        fund_id: "",
        user_id: "",
        status: "",
        channel: "",
        delivery_status: "",
        category: "",
        transaction_status: "",
        contribution_status: "",
    });
    const [generating, setGenerating] = useState(false);
    const [truncatedCount, setTruncatedCount] = useState(null);
    const generationRef = useRef(false);
    const toast = useToast();
    const catalogApi = useApi(getReportCatalog, []);
    const fundsApi = useApi(getReportFunds, []);
    const historyApi = useApi(getReportHistory, []);

    const columns = [
        {
            key: "report_key",
            header: t("reports.report"),
            render: (row) => t(`reports.keys.${row.report_key}`, { defaultValue: row.report_key }),
        },
        { key: "export_format", header: t("reports.format") },
        { key: "generated_by_name", header: t("reports.generatedBy") },
        {
            key: "generated_at",
            header: t("reports.generatedAt"),
            render: (row) => new Date(row.generated_at).toLocaleString(
                i18n.language === "sw" ? "sw-KE" : "en-KE"
            ),
        },
        { key: "result_count", header: t("reports.records") },
        { key: "download_count", header: t("reports.downloads") },
        {
            key: "download",
            header: t("reports.download"),
            render: (row) => (
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleDownload(row)}
                >
                    {t("reports.download")}
                </Button>
            ),
        },
    ];

    function updateFilter(event) {
        const { name, value } = event.target;
        setFilters((current) => ({ ...current, [name]: value }));
    }

    async function handleGenerate(event) {
        event.preventDefault();
        if (generationRef.current || !filters.report_key) return;
        generationRef.current = true;
        setGenerating(true);
        try {
            const reportFilters = Object.fromEntries(
                Object.entries(filters)
                    .filter(([key, value]) => !["report_key", "format"].includes(key) && value !== "")
            );
            const response = await generateReport({
                report_key: filters.report_key,
                format: filters.format,
                filters: reportFilters,
            });
            setTruncatedCount(getTruncatedCount(response));
            saveDownload(response, `micopesa-${filters.report_key}.${filters.format.toLowerCase()}`);
            await historyApi.refetch();
            toast.success(t("reports.generated"));
        } catch {
            toast.error(t("reports.generateError"));
        } finally {
            generationRef.current = false;
            setGenerating(false);
        }
    }

    async function handleDownload(row) {
        try {
            const response = await downloadReport(row.report_id);
            setTruncatedCount(getTruncatedCount(response));
            saveDownload(response, `micopesa-${row.report_key}-${row.report_id}.${row.export_format.toLowerCase()}`);
            await historyApi.refetch();
        } catch {
            toast.error(t("reports.downloadError"));
        }
    }

    const selectedReport = catalogApi.data?.includes(filters.report_key);
    return (
        <div className="page-content">
            <header className="page-header">
                <div>
                    <h1 className="page-title">
                        {historyOnly ? t("reports.historyTitle") : t("reports.title")}
                    </h1>
                    <p className="page-subtitle">{t("reports.subtitle")}</p>
                </div>
            </header>

            {truncatedCount !== null && (
                <p className="card" role="status">
                    {t("reports.truncatedNotice", { count: truncatedCount })}
                </p>
            )}

            {!historyOnly && (
                <section className="card" aria-labelledby="report-generator-heading">
                    <h2 id="report-generator-heading">{t("reports.generateTitle")}</h2>
                    {catalogApi.error ? (
                        <p role="alert">{t("reports.loadError")}</p>
                    ) : (
                        <form className="form-grid" onSubmit={handleGenerate}>
                            <label className="form-field">
                                <span>{t("reports.report")}</span>
                                <select name="report_key" value={filters.report_key} onChange={updateFilter} required>
                                    <option value="">{t("reports.selectReport")}</option>
                                    {(catalogApi.data || []).map((key) => (
                                        <option key={key} value={key}>
                                            {t(`reports.keys.${key}`, { defaultValue: key })}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label className="form-field">
                                <span>{t("reports.format")}</span>
                                <select name="format" value={filters.format} onChange={updateFilter}>
                                    {["CSV", "XLSX", "PDF"].map((format) => (
                                        <option key={format} value={format}>{format}</option>
                                    ))}
                                </select>
                            </label>
                            <label className="form-field">
                                <span>{t("reports.startDate")}</span>
                                <input name="start_date" type="date" value={filters.start_date} onChange={updateFilter} />
                            </label>
                            <label className="form-field">
                                <span>{t("reports.endDate")}</span>
                                <input name="end_date" type="date" value={filters.end_date} onChange={updateFilter} />
                            </label>
                            <label className="form-field">
                                <span>{t("reports.fund")}</span>
                                <select name="fund_id" value={filters.fund_id} onChange={updateFilter}>
                                    <option value="">{t("reports.allAuthorizedFunds")}</option>
                                    {(fundsApi.data || []).map((fund) => (
                                        <option key={fund.fund_id} value={fund.fund_id}>{fund.fund_name}</option>
                                    ))}
                                </select>
                            </label>
                            <label className="form-field">
                                <span>{t("reports.userId")}</span>
                                <input name="user_id" value={filters.user_id} onChange={updateFilter} maxLength={25} />
                            </label>
                            <label className="form-field">
                                <span>{t("reports.status")}</span>
                                <input name="status" value={filters.status} onChange={updateFilter} maxLength={40} />
                            </label>
                            {filters.report_key === "mpesa-payments" && (
                                <label className="form-field">
                                    <span>{t("reports.transactionStatus")}</span>
                                    <input name="transaction_status" value={filters.transaction_status} onChange={updateFilter} maxLength={40} />
                                </label>
                            )}
                            {["contributions", "settled-contributions", "contribution-trends"].includes(filters.report_key) && (
                                <label className="form-field">
                                    <span>{t("reports.contributionStatus")}</span>
                                    <input name="contribution_status" value={filters.contribution_status} onChange={updateFilter} maxLength={40} />
                                </label>
                            )}
                            <label className="form-field">
                                <span>{t("reports.deliveryStatus")}</span>
                                <input name="delivery_status" value={filters.delivery_status} onChange={updateFilter} maxLength={40} />
                            </label>
                            <label className="form-field">
                                <span>{t("reports.category")}</span>
                                <input name="category" value={filters.category} onChange={updateFilter} maxLength={40} />
                            </label>
                            <label className="form-field">
                                <span>{t("reports.channel")}</span>
                                <select name="channel" value={filters.channel} onChange={updateFilter}>
                                    <option value="">{t("reports.allChannels")}</option>
                                    {["SMS", "EMAIL", "PUSH", "MPESA", "BANK", "USSD"].map((channel) => (
                                        <option key={channel} value={channel}>{channel}</option>
                                    ))}
                                </select>
                            </label>
                            <Button type="submit" loading={generating} disabled={!selectedReport}>
                                {t("reports.generate")}
                            </Button>
                            <p>{t("reports.scopeNotice")}</p>
                        </form>
                    )}
                </section>
            )}

            <section className="card" id="report-history" aria-labelledby="report-history-heading">
                <h2 id="report-history-heading">{t("reports.historyTitle")}</h2>
                <DataTable
                    columns={columns}
                    rows={historyApi.data}
                    rowKey="report_id"
                    loading={historyApi.loading}
                    refreshing={historyApi.refreshing}
                    error={historyApi.error}
                    onRetry={historyApi.refetch}
                    emptyMessage={t("reports.emptyHistory")}
                />
            </section>
        </div>
    );
}

export default ReportsPage;
