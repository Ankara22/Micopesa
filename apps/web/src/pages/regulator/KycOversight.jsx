import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import { getRegulatorKycOversight } from "../../services/regulatorApi";
import DataTable from "../../components/ui/DataTable";
import FormField from "../../components/ui/FormField";
import Button from "../../components/ui/Button";
import StatusBadge from "../../components/ui/StatusBadge";
import ErrorState from "../../components/ui/ErrorState";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import "./regulator-pages.css";

const EMPTY_FILTERS = { start_date: "", end_date: "", status: "" };

function KycOversight() {
    const { t, i18n } = useTranslation();
    const [filters, setFilters] = useState(EMPTY_FILTERS);
    const [appliedFilters, setAppliedFilters] = useState({});
    const [page, setPage] = useState(1);
    const fetchKyc = useCallback(
        () => getRegulatorKycOversight({ ...appliedFilters, page, page_size: 25 }),
        [appliedFilters, page]
    );
    const kycApi = useApi(fetchKyc, [fetchKyc]);
    const data = kycApi.data;
    const counts = data?.kyc_status_counts || [];
    const history = data?.review_history || [];
    const pagination = data?.pagination;
    const locale = i18n.resolvedLanguage?.startsWith("sw") ? "sw-KE" : "en-KE";

    function updateFilter(event) {
        setFilters((current) => ({ ...current, [event.target.name]: event.target.value }));
    }

    function applyFilters(event) {
        event.preventDefault();
        setPage(1);
        setAppliedFilters(Object.fromEntries(
            Object.entries(filters).filter(([, value]) => value.trim() !== "")
        ));
    }

    const columns = [
        {
            key: "timestamp",
            header: t("regulator.kycPage.reviewDate"),
            render: (row) => formatDate(row.timestamp, locale),
        },
        {
            key: "kyc_status",
            header: t("regulator.kycPage.outcome"),
            render: (row) => (
                <StatusBadge
                    status={row.kyc_status}
                    label={t(`profile.kycStatuses.${row.kyc_status}`, { defaultValue: row.kyc_status })}
                />
            ),
        },
        {
            key: "reviewer_role",
            header: t("regulator.kycPage.reviewer"),
            render: (row) => t(`roles.${row.reviewer_role}`, { defaultValue: row.reviewer_role }),
        },
    ];

    return (
        <div className="regulator-data-page">
            <header className="page-header">
                <div>
                    <h1 className="page-title">{t("regulator.kycPage.title")}</h1>
                    <p className="page-subtitle">{t("regulator.kycPage.subtitle")}</p>
                </div>
            </header>

            {kycApi.error && data !== null && (
                <ErrorState
                    title={t("regulator.kycPage.loadErrorTitle")}
                    message={kycApi.error}
                    onRetry={kycApi.refetch}
                />
            )}

            {kycApi.loading && data === null ? (
                <SkeletonLoader variant="dashboard" count={3} label={t("regulator.kycPage.loading")} />
            ) : data === null ? (
                <ErrorState
                    title={t("regulator.kycPage.loadErrorTitle")}
                    message={kycApi.error || t("regulator.kycPage.loadError")}
                    onRetry={kycApi.refetch}
                />
            ) : data.scope.has_active_fund_scope ? (
                <section className="regulator-summary-grid" aria-label={t("regulator.kycPage.statusSummary")}>
                    {["PENDING", "VERIFIED", "REJECTED"].map((status) => {
                        const count = counts.find((item) => item.kyc_status === status)?.count ?? 0;
                        return (
                            <article className="regulator-summary-card" key={status}>
                                <span>{t(`profile.kycStatuses.${status}`, { defaultValue: status })}</span>
                                <strong>{new Intl.NumberFormat(locale).format(Number(count))}</strong>
                            </article>
                        );
                    })}
                </section>
            ) : (
                <p className="regulator-privacy-note" role="status">{t("regulator.kycPage.noScope")}</p>
            )}

            <p className="regulator-privacy-note">{t("regulator.kycPage.privacy")}</p>

            {data?.scope.has_active_fund_scope && (
                <>
                    <form className="regulator-filter-form" onSubmit={applyFilters}>
                        <FormField id="kyc-start-date" label={t("regulator.kycPage.fromDate")} type="date" name="start_date" value={filters.start_date} onChange={updateFilter} />
                        <FormField id="kyc-end-date" label={t("regulator.kycPage.toDate")} type="date" name="end_date" value={filters.end_date} onChange={updateFilter} />
                        <FormField
                            id="kyc-status"
                            label={t("regulator.kycPage.outcome")}
                            as="select"
                            name="status"
                            value={filters.status}
                            onChange={updateFilter}
                            options={[
                                { value: "", label: t("regulator.kycPage.allOutcomes") },
                                { value: "VERIFIED", label: t("profile.kycStatuses.VERIFIED") },
                                { value: "REJECTED", label: t("profile.kycStatuses.REJECTED") },
                            ]}
                        />
                        <div className="regulator-filter-actions">
                            <Button type="submit">{t("regulator.kycPage.applyFilters")}</Button>
                            <Button
                                type="button"
                                variant="secondary"
                                onClick={() => {
                                    setFilters(EMPTY_FILTERS);
                                    setAppliedFilters({});
                                    setPage(1);
                                }}
                            >
                                {t("regulator.kycPage.clearFilters")}
                            </Button>
                        </div>
                    </form>

                    <section className="regulator-data-section" aria-labelledby="kyc-review-history-heading">
                        <div className="regulator-data-section-heading">
                            <div>
                                <h2 id="kyc-review-history-heading">{t("regulator.kycPage.reviewHistory")}</h2>
                                <p>{t("regulator.kycPage.readOnly")}</p>
                            </div>
                        </div>
                        {data === null ? null : (
                            <DataTable
                                columns={columns}
                                rows={history}
                                rowKey="log_id"
                                loading={kycApi.loading}
                                refreshing={kycApi.refreshing}
                                onRetry={kycApi.refetch}
                                emptyMessage={t("regulator.kycPage.emptyHistory")}
                            />
                        )}
                        {pagination?.total_pages > 1 && (
                            <div className="regulator-pagination" aria-label={t("regulator.kycPage.pagination")}>
                                <Button
                                    variant="secondary"
                                    disabled={page <= 1 || kycApi.loading}
                                    onClick={() => setPage((current) => current - 1)}
                                >
                                    {t("regulator.kycPage.previous")}
                                </Button>
                                <span>{t("regulator.kycPage.pageOf", { page, pages: pagination.total_pages })}</span>
                                <Button
                                    variant="secondary"
                                    disabled={page >= pagination.total_pages || kycApi.loading}
                                    onClick={() => setPage((current) => current + 1)}
                                >
                                    {t("regulator.kycPage.next")}
                                </Button>
                            </div>
                        )}
                    </section>
                </>
            )}
        </div>
    );
}

function formatDate(value, locale) {
    if (!value) return "Unavailable";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString(locale);
}

export default KycOversight;
