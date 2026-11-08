import { useTranslation } from "react-i18next";

function AnalyticsDateFilters({ filters, setFilters }) {
    const { t } = useTranslation();
    return (
        <section className="analytics-filter-bar" aria-label={t("analytics.filterDates")}>
            <label>
                <span>{t("analytics.fromDate")}</span>
                <input
                    type="date"
                    value={filters.start_date}
                    onChange={(event) => setFilters((current) => ({
                        ...current,
                        start_date: event.target.value,
                    }))}
                />
            </label>
            <label>
                <span>{t("analytics.toDate")}</span>
                <input
                    type="date"
                    value={filters.end_date}
                    onChange={(event) => setFilters((current) => ({
                        ...current,
                        end_date: event.target.value,
                    }))}
                />
            </label>
            <button
                className="analytics-filter-reset"
                type="button"
                disabled={!filters.start_date && !filters.end_date}
                onClick={() => setFilters({ start_date: "", end_date: "" })}
            >
                {t("analytics.clearFilters")}
            </button>
        </section>
    );
}

export default AnalyticsDateFilters;
