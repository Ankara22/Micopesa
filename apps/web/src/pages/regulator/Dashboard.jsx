import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import { getComplianceOverview, getComplianceReports } from "../../services/regulatorApi";
import { getOperationalLogs } from "../../services/auditLogService";
import { listFunds, getFundAllocations } from "../../services/fundService";
import { useAuth } from "../../context/AuthContext";
import { StatCard } from "../../components/ui/Card";
import StatusBadge from "../../components/ui/StatusBadge";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import LoadingState from "../../components/ui/LoadingState";
import ErrorState from "../../components/ui/ErrorState";
import DataTable from "../../components/ui/DataTable";
import "./regulator-dashboard.css";

const REGULATOR_LINKS = [
    { key: "analytics", to: "/regulator/analytics" },
    { key: "reports", to: "/regulator/compliance-reports" },
    { key: "funds", to: "/regulator/funds" },
    { key: "audit", to: "/regulator/audit-logs" },
    { key: "profile", to: "/regulator/profile" },
];

function getFundOverview() {
    return listFunds().then(async (funds) => Promise.all(
        funds.map(async (fund) => ({
            fund,
            allocationCount: (await getFundAllocations(fund.fund_id)).length,
        }))
    ));
}

function formatDate(value, includeTime = false, locale) {
    if (!value) return "Unavailable";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unavailable";
    return includeTime ? date.toLocaleString(locale) : date.toLocaleDateString(locale);
}

function getCount(value) {
    const count = Number(value);
    return Number.isFinite(count) ? count : 0;
}

function RegulatorDashboard() {
    const { t, i18n } = useTranslation();
    const { user } = useAuth();
    const complianceApi = useApi(getComplianceOverview, []);
    const reportsApi = useApi(getComplianceReports, []);
    const auditApi = useApi(getOperationalLogs, []);
    const fundsApi = useApi(getFundOverview, []);
    const compliance = complianceApi.data;
    const reports = reportsApi.data || [];
    const auditHealth = compliance?.audit_health || {};
    const kycStatuses = compliance?.kyc_status_counts || [];
    const kycReviewHistory = compliance?.kyc_review_history || [];
    const parameterChecks = compliance?.rba_parameter_checks;
    const latestReport = compliance?.latest_rba_report;
    const recentAudit = (auditApi.data || []).slice(0, 5);
    const funds = fundsApi.data || [];
    const firstName = user?.full_name?.trim().split(/\s+/)[0];
    const reportStatusTotals = (compliance?.rba_reports_by_status || []).reduce(
        (sum, item) => sum + getCount(item.count),
        0
    );
    const submittedReports = (reportsApi.data || [])
        .filter((report) => report.rba_status === "SUBMITTED" && !report.is_legacy_history)
        .slice(0, 5);
    const dateLocale = i18n.resolvedLanguage?.startsWith("sw") ? "sw-KE" : "en-KE";
    const parameterDetails = parameterChecks?.status === "NOT_CONFIGURED"
        ? t("dashboards.regulator.parameterNotConfigured")
        : parameterChecks?.details || t("dashboards.regulator.parameterUnavailable");
    const translatedStatus = (status) =>
        status ? t(`analytics.status.${status}`, { defaultValue: status }) : undefined;
    const legacyReportColumns = [
        { key: "report_type", header: t("dashboards.regulator.reportType") },
        { key: "period_start", header: t("dashboards.regulator.period"), render: (row) => `${formatDate(row.period_start, false, dateLocale)} – ${formatDate(row.period_end, false, dateLocale)}` },
        { key: "rba_status", header: t("regulator.dashboard.recordedStatus"), render: (row) => <StatusBadge status={row.rba_status} label={translatedStatus(row.rba_status)} /> },
        { key: "generated_at", header: t("dashboards.regulator.generated"), render: (row) => formatDate(row.generated_at, true, dateLocale) },
    ];
    const submittedReportColumns = [
        { key: "fund_name", header: t("regulator.dashboard.fund"), render: (report) => report.fund_name || t("regulator.dashboard.unavailable") },
        { key: "manager_name", header: t("regulator.dashboard.fundManager"), render: (report) => report.manager_name || t("regulator.dashboard.formerManager") },
        { key: "rba_status", header: t("regulator.dashboard.status"), render: (report) => <StatusBadge status={report.rba_status} label={translatedStatus(report.rba_status)} /> },
        { key: "last_submitted_at", header: t("regulator.dashboard.lastSubmitted"), render: (report) => formatDate(report.last_submitted_at || report.submitted_at, true, dateLocale) },
    ];

    return (
        <div className="regulator-dashboard">
            <header className="page-header regulator-dashboard-header">
                <div>
                    <p className="regulator-dashboard-eyebrow">{t("dashboards.regulator.eyebrow")}</p>
                    <h1 className="page-title">
                        {firstName ? t("dashboards.welcome", { name: firstName }) : t("dashboards.regulator.title")}
                    </h1>
                    <p className="page-subtitle">{t("dashboards.regulator.subtitle")}</p>
                </div>
            </header>

            <section className="regulator-dashboard-overview" aria-label={t("dashboards.regulator.summary")}>
                {complianceApi.loading ? (
                    <SkeletonLoader variant="metrics" count={3} label={t("dashboards.regulator.loading")} />
                ) : complianceApi.error ? (
                    <ErrorState
                        title={t("dashboards.regulator.errorTitle")}
                        message={t("dashboards.regulator.complianceError")}
                        onRetry={complianceApi.refetch}
                    />
                ) : (
                    <div className="regulator-dashboard-overview-content">
                        <div className="stat-card-grid regulator-dashboard-stats">
                            <StatCard
                                label={t("dashboards.regulator.auditEvents")}
                                value={auditHealth.events_last_24h ?? t("analytics.unavailable")}
                                hint={auditHealth.last_event_at
                                    ? t("dashboards.regulator.mostRecent", { date: formatDate(auditHealth.last_event_at, true, dateLocale) })
                                    : t("dashboards.regulator.noRecentEvent")}
                            />
                            <StatCard
                                label={t("dashboards.regulator.rbaReports")}
                                value={new Intl.NumberFormat(dateLocale).format(reportStatusTotals)}
                                hint={latestReport
                                    ? t("dashboards.regulator.latestStatus", {
                                        status: t(`analytics.status.${latestReport.rba_status}`, { defaultValue: latestReport.rba_status }),
                                    })
                                    : t("dashboards.regulator.noRbaReport")}
                            />
                            <StatCard
                                label={t("dashboards.regulator.parameterChecks")}
                                value={<StatusBadge
                                    status={parameterChecks?.status || "NOT_CONFIGURED"}
                                    label={translatedStatus(parameterChecks?.status || "NOT_CONFIGURED")}
                                />}
                                hint={parameterDetails}
                            />
                        </div>
                        <section className="regulator-dashboard-card regulator-parameter-card" aria-labelledby="parameter-checks-title">
                            <div>
                                <p className="regulator-dashboard-eyebrow">{t("dashboards.regulator.configuration")}</p>
                                <h2 id="parameter-checks-title">{t("dashboards.regulator.parameterChecks")}</h2>
                            </div>
                            <div className="regulator-parameter-state">
                                <StatusBadge
                                    status={parameterChecks?.status || "NOT_CONFIGURED"}
                                    label={translatedStatus(parameterChecks?.status || "NOT_CONFIGURED")}
                                />
                                <p>{parameterDetails}</p>
                            </div>
                        </section>
                    </div>
                )}
            </section>

            <section className="regulator-dashboard-section" aria-labelledby="kyc-oversight-title">
                <div className="regulator-dashboard-section-heading">
                    <div>
                        <p className="regulator-dashboard-eyebrow">{t("dashboards.regulator.kycEyebrow")}</p>
                        <h2 id="kyc-oversight-title">{t("dashboards.regulator.kycOversight")}</h2>
                    </div>
                </div>
                {complianceApi.loading ? (
                    <LoadingState message={t("dashboards.regulator.loadingKyc")} />
                ) : complianceApi.error ? (
                    <p className="regulator-dashboard-empty">{t("dashboards.regulator.kycUnavailable")}</p>
                ) : (
                    <div className="regulator-kyc-oversight">
                        <ul aria-label={t("dashboards.regulator.kycStatusCounts")}>
                            {["PENDING", "VERIFIED", "REJECTED"].map((status) => {
                                const count = kycStatuses.find((item) => item.kyc_status === status)?.count ?? 0;
                                return (
                                    <li key={status}>
                                        <span>{t(`analytics.status.${status}`, { defaultValue: status })}</span>
                                        <strong>{new Intl.NumberFormat(dateLocale).format(getCount(count))}</strong>
                                    </li>
                                );
                            })}
                        </ul>
                        <div>
                            <h3>{t("dashboards.regulator.kycReviewHistory")}</h3>
                            {kycReviewHistory.length ? (
                                <ol className="regulator-audit-list">
                                    {kycReviewHistory.map((event, index) => {
                                        const status = event.kyc_status || (event.action_type === "APPROVE" ? "VERIFIED" : "REJECTED");
                                        return (
                                            <li key={`${event.timestamp}-${event.action_type}-${index}`}>
                                                <strong>{t(`analytics.status.${status}`, { defaultValue: status })}</strong>
                                                <span>{t("dashboards.regulator.kycReviewRecorded")}</span>
                                                <time dateTime={event.timestamp}>{formatDate(event.timestamp, true, dateLocale)}</time>
                                            </li>
                                        );
                                    })}
                                </ol>
                            ) : (
                                <p className="regulator-dashboard-empty">{t("dashboards.regulator.noKycReviews")}</p>
                            )}
                        </div>
                        <p className="regulator-dashboard-note">{t("dashboards.regulator.kycPrivacyNote")}</p>
                    </div>
                )}
            </section>

            <section className="regulator-dashboard-section" aria-labelledby="reports-overview-title">
                <div className="regulator-dashboard-section-heading">
                    <div>
                        <p className="regulator-dashboard-eyebrow">{t("dashboards.regulator.reportRegister")}</p>
                        <h2 id="reports-overview-title">{t("dashboards.regulator.recentReports")}</h2>
                    </div>
                    <Link className="regulator-dashboard-link" to="/regulator/compliance-reports">{t("dashboards.regulator.allReports")}</Link>
                </div>
                <p className="regulator-dashboard-note">
                    {t("dashboards.regulator.reportDisclaimer")}
                </p>
                <DataTable
                    columns={legacyReportColumns}
                    rows={reportsApi.data === null ? null : reports.slice(0, 5)}
                    rowKey="report_id"
                    loading={reportsApi.loading}
                    error={reportsApi.error ? t("dashboards.regulator.reportsError") : null}
                    onRetry={reportsApi.refetch}
                    emptyMessage={t("dashboards.regulator.noReports")}
                />
            </section>

            <section className="regulator-dashboard-section" aria-labelledby="submitted-reports-heading">
                <div className="regulator-dashboard-section-heading">
                    <h2 id="submitted-reports-heading">{t("regulator.dashboard.submittedReports")}</h2>
                    <Link className="regulator-dashboard-link" to="/regulator/compliance-reports">
                        {t("regulator.dashboard.viewAllReports")}
                    </Link>
                </div>
                <DataTable
                    columns={submittedReportColumns}
                    rows={reportsApi.data === null ? null : submittedReports}
                    rowKey="report_id"
                    loading={reportsApi.loading}
                    refreshing={reportsApi.refreshing}
                    error={reportsApi.error ? t("dashboards.regulator.reportsError") : null}
                    onRetry={reportsApi.refetch}
                    emptyMessage={t("regulator.dashboard.emptyReports")}
                    loadingLabel={t("regulator.dashboard.loadingReports")}
                    refreshingLabel={t("regulator.dashboard.refreshingReports")}
                    errorTitle={t("regulator.dashboard.reportsErrorTitle")}
                />
            </section>

            <div className="regulator-dashboard-lower-grid">
                <section className="regulator-dashboard-section" aria-labelledby="audit-activity-title">
                    <div className="regulator-dashboard-section-heading">
                        <div>
                            <p className="regulator-dashboard-eyebrow">{t("dashboards.regulator.recordedEvents")}</p>
                            <h2 id="audit-activity-title">{t("dashboards.regulator.recentAudit")}</h2>
                        </div>
                        <Link className="regulator-dashboard-link" to="/regulator/audit-logs">{t("dashboards.regulator.viewAudit")}</Link>
                    </div>
                    {auditApi.loading ? (
                        <LoadingState message={t("dashboards.regulator.loadingAudit")} />
                    ) : auditApi.error ? (
                        <ErrorState
                            title={t("dashboards.regulator.errorTitle")}
                            message={t("dashboards.regulator.auditError")}
                            onRetry={auditApi.refetch}
                        />
                    ) : recentAudit.length ? (
                        <ol className="regulator-audit-list">
                            {recentAudit.map((event) => (
                                <li key={event.log_id}>
                                    <strong>{t(`analytics.status.${event.action_type}`, { defaultValue: event.action_type || t("dashboards.regulator.actionUnavailable") })}</strong>
                                    <span>
                                        {event.full_name || t("dashboards.regulator.system")} · {t(
                                            `analytics.status.${event.entity_name}`,
                                            { defaultValue: event.entity_name || t("dashboards.regulator.record") }
                                        )}
                                    </span>
                                    <time dateTime={event.timestamp}>{formatDate(event.timestamp, true, dateLocale)}</time>
                                </li>
                            ))}
                        </ol>
                    ) : (
                        <p className="regulator-dashboard-empty">{t("dashboards.regulator.noAudit")}</p>
                    )}
                </section>

                <section className="regulator-dashboard-section" aria-labelledby="fund-oversight-title">
                    <div className="regulator-dashboard-section-heading">
                        <div>
                            <p className="regulator-dashboard-eyebrow">{t("dashboards.regulator.fundRegister")}</p>
                            <h2 id="fund-oversight-title">{t("dashboards.regulator.fundOversight")}</h2>
                        </div>
                        <Link className="regulator-dashboard-link" to="/regulator/funds">{t("dashboards.regulator.viewFunds")}</Link>
                    </div>
                    {fundsApi.loading ? (
                        <LoadingState message={t("dashboards.regulator.loadingFunds")} />
                    ) : fundsApi.error ? (
                        <ErrorState
                            title={t("dashboards.regulator.errorTitle")}
                            message={t("dashboards.regulator.fundsError")}
                            onRetry={fundsApi.refetch}
                        />
                    ) : funds.length ? (
                        <ul className="regulator-fund-list">
                            {funds.slice(0, 4).map(({ fund, allocationCount }) => (
                                <li key={fund.fund_id}>
                                    <div className="regulator-fund-heading">
                                        <strong>{fund.fund_name}</strong>
                                        {fund.fund_status
                                            ? <StatusBadge status={fund.fund_status} label={translatedStatus(fund.fund_status)} />
                                            : <span>{t("analytics.unavailable")}</span>}
                                    </div>
                                    <span>
                                        {fund.risk_level
                                            ? translatedStatus(fund.risk_level)
                                            : t("dashboards.regulator.riskUnavailable")} · {t("dashboards.regulator.allocationRecords", { count: new Intl.NumberFormat(dateLocale).format(allocationCount) })}
                                        {" · "}
                                        {fund.expected_return === undefined || fund.expected_return === null
                                            || !Number.isFinite(Number(fund.expected_return))
                                            ? t("analytics.unavailable")
                                            : t("dashboards.regulator.expectedReturn", {
                                                percentage: new Intl.NumberFormat(dateLocale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(fund.expected_return)),
                                            })}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="regulator-dashboard-empty">{t("dashboards.regulator.noFunds")}</p>
                    )}
                </section>
            </div>

            <nav className="regulator-dashboard-section regulator-dashboard-navigation" aria-label={t("dashboards.regulator.features")}>
                <div className="regulator-dashboard-section-heading">
                    <div>
                        <p className="regulator-dashboard-eyebrow">{t("dashboards.regulator.navigation")}</p>
                        <h2>{t("dashboards.regulator.quickAccess")}</h2>
                    </div>
                </div>
                <ul>
                    {REGULATOR_LINKS.map((item) => (
                        <li key={item.to}>
                            <Link to={item.to}>
                                <span>{t(`dashboards.regulator.links.${item.key}`)}</span>
                                <small>{t(`dashboards.regulator.links.${item.key}Description`)}</small>
                            </Link>
                        </li>
                    ))}
                </ul>
            </nav>
        </div>
    );
}

export default RegulatorDashboard;
