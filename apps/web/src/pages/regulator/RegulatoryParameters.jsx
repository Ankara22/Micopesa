import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import { getRegulatorInternalControlChecks } from "../../services/regulatorApi";
import DataTable from "../../components/ui/DataTable";
import StatusBadge from "../../components/ui/StatusBadge";
import ErrorState from "../../components/ui/ErrorState";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import "./regulator-pages.css";

function RegulatoryParameters() {
    const { t, i18n } = useTranslation();
    const checksApi = useApi(getRegulatorInternalControlChecks, []);
    const data = checksApi.data;
    const locale = i18n.resolvedLanguage?.startsWith("sw") ? "sw-KE" : "en-KE";
    const columns = [
        { key: "name", header: t("regulator.parametersPage.check") },
        { key: "description", header: t("regulator.parametersPage.description") },
        { key: "observed_value", header: t("regulator.parametersPage.observed") },
        { key: "expected_rule", header: t("regulator.parametersPage.expectedRule") },
        { key: "status", header: t("regulator.parametersPage.result"), render: (row) => <StatusBadge status={row.status} /> },
        { key: "source", header: t("regulator.parametersPage.dataSource") },
        { key: "evaluated_at", header: t("regulator.parametersPage.lastEvaluated"), render: (row) => formatDate(row.evaluated_at, locale, t) },
    ];

    return (
        <div className="regulator-data-page">
            <header className="page-header">
                <div>
                    <h1 className="page-title">{t("regulator.parametersPage.title")}</h1>
                    <p className="page-subtitle">{t("regulator.parametersPage.subtitle")}</p>
                </div>
            </header>

            {checksApi.error && data !== null && (
                <ErrorState
                    title={t("regulator.parametersPage.loadErrorTitle")}
                    message={checksApi.error}
                    onRetry={checksApi.refetch}
                />
            )}

            {checksApi.loading && data === null ? (
                <SkeletonLoader variant="table" count={5} label={t("regulator.parametersPage.loading")} />
            ) : data === null ? (
                <ErrorState
                    title={t("regulator.parametersPage.loadErrorTitle")}
                    message={checksApi.error || t("regulator.parametersPage.loadError")}
                    onRetry={checksApi.refetch}
                />
            ) : (
                <>
                    <section className="regulator-info-panel" aria-labelledby="formal-parameters-heading">
                        <div>
                            <h2 id="formal-parameters-heading">{t("regulator.parametersPage.formalHeading")}</h2>
                            <p>{t("regulator.parametersPage.notConfigured")}</p>
                            <p><strong>{t("regulator.parametersPage.source")}:</strong> {data.formal_parameters?.source || t("regulator.parametersPage.defaultSource")}</p>
                        </div>
                        <StatusBadge status={data.formal_parameters?.status || "NOT_CONFIGURED"} />
                    </section>

                    <section className="regulator-data-section" aria-labelledby="internal-control-heading">
                        <div className="regulator-data-section-heading">
                            <div>
                                <h2 id="internal-control-heading">{t("regulator.parametersPage.internalHeading")}</h2>
                                <p>{t("regulator.parametersPage.internalDescription")}</p>
                            </div>
                            {data.evaluated_at && <time dateTime={data.evaluated_at}>{t("regulator.parametersPage.evaluated", { date: formatDate(data.evaluated_at, locale, t) })}</time>}
                        </div>
                        <DataTable
                            columns={columns}
                            rows={data.checks}
                            rowKey="key"
                            loading={checksApi.loading}
                            refreshing={checksApi.refreshing}
                            error={checksApi.error}
                            onRetry={checksApi.refetch}
                            emptyMessage={t("regulator.parametersPage.empty")}
                        />
                    </section>
                </>
            )}
        </div>
    );
}

function formatDate(value, locale, t) {
    if (!value) return t("regulator.parametersPage.unavailable");
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? t("regulator.parametersPage.unavailable") : date.toLocaleString(locale);
}

export default RegulatoryParameters;
