import { lazy, Suspense } from "react";
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

const RegulatorComplianceChart = lazy(() => import("./RegulatorComplianceChart"));
const REGULATOR_LINKS = [
    { label: "Compliance Reports", description: "Review available reports.", to: "/regulator/compliance-reports" },
    { label: "Fund Oversight", description: "Review funds and allocation records.", to: "/regulator/funds" },
    { label: "Audit Logs", description: "Review recorded operational events.", to: "/regulator/audit-logs" },
    { label: "Profile", description: "View your regulator profile.", to: "/regulator/profile" },
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
    const reportStatusData = (compliance?.rba_reports_by_status || []).map((item) => ({
        status: item.rba_status,
        reports: getCount(item.count),
    }));
    const auditHealth = compliance?.audit_health || {};
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
    const legacyReportColumns = [
        { key: "report_type", header: "Report type" },
        { key: "period_start", header: "Period", render: (row) => `${formatDate(row.period_start, false, dateLocale)} – ${formatDate(row.period_end, false, dateLocale)}` },
        { key: "rba_status", header: "Recorded status", render: (row) => <StatusBadge status={row.rba_status} /> },
        { key: "generated_at", header: "Generated", render: (row) => formatDate(row.generated_at, true, dateLocale) },
    ];
    const submittedReportColumns = [
        { key: "fund_name", header: t("regulator.dashboard.fund"), render: (report) => report.fund_name || t("regulator.dashboard.unavailable") },
        { key: "manager_name", header: t("regulator.dashboard.fundManager"), render: (report) => report.manager_name || t("regulator.dashboard.formerManager") },
        { key: "rba_status", header: t("regulator.dashboard.status"), render: (report) => <StatusBadge status={report.rba_status} /> },
        { key: "last_submitted_at", header: t("regulator.dashboard.lastSubmitted"), render: (report) => formatDate(report.last_submitted_at || report.submitted_at, true, dateLocale) },
    ];

    return (
        <div className="regulator-dashboard">
            <header className="page-header regulator-dashboard-header">
                <div>
                    <p className="regulator-dashboard-eyebrow">Oversight and transparency</p>
                    <h1 className="page-title">{firstName ? `Welcome, ${firstName}` : "Regulator Dashboard"}</h1>
                    <p className="page-subtitle">A concise overview of recorded compliance and operational health.</p>
                </div>
            </header>

            <section className="regulator-dashboard-overview" aria-label="Compliance oversight summary">
                {complianceApi.loading ? (
                    <SkeletonLoader variant="metrics" count={3} label="Loading compliance overview" />
                ) : complianceApi.error ? (
                    <ErrorState message={complianceApi.error} onRetry={complianceApi.refetch} />
                ) : (
                    <div className="regulator-dashboard-overview-content">
                        <div className="stat-card-grid regulator-dashboard-stats">
                            <StatCard
                                label="Audit events (24 hours)"
                                value={auditHealth.events_last_24h ?? "Unavailable"}
                                hint={auditHealth.last_event_at
                                    ? `Most recent ${formatDate(auditHealth.last_event_at, true, dateLocale)}`
                                    : "No recent event timestamp available"}
                            />
                            <StatCard
                                label="Recorded RBA reports"
                                value={reportStatusTotals}
                                hint={latestReport
                                    ? `Latest status: ${latestReport.rba_status}`
                                    : "No RBA report recorded"}
                            />
                            <StatCard
                                label="Regulatory parameter checks"
                                value={<StatusBadge status={parameterChecks?.status || "NOT_CONFIGURED"} />}
                                hint={parameterChecks?.details || "Configuration status unavailable"}
                            />
                        </div>
                        <section className="regulator-dashboard-card regulator-parameter-card" aria-labelledby="parameter-checks-title">
                            <div>
                                <p className="regulator-dashboard-eyebrow">Configuration</p>
                                <h2 id="parameter-checks-title">Regulatory parameter checks</h2>
                            </div>
                            <div className="regulator-parameter-state">
                                <StatusBadge status={parameterChecks?.status || "NOT_CONFIGURED"} />
                                <p>{parameterChecks?.details || "Parameter-check configuration status is unavailable."}</p>
                            </div>
                        </section>
                    </div>
                )}
            </section>

            <section className="regulator-dashboard-section" aria-labelledby="rba-status-title">
                <div className="regulator-dashboard-section-heading">
                    <div>
                        <p className="regulator-dashboard-eyebrow">Report records</p>
                        <h2 id="rba-status-title">RBA reports by recorded status</h2>
                    </div>
                    <Link className="regulator-dashboard-link" to="/regulator/compliance-reports">View reports</Link>
                </div>
                {complianceApi.loading ? (
                    <SkeletonLoader variant="chart" label="Loading report status chart" />
                ) : complianceApi.error ? (
                    <ErrorState message={complianceApi.error} onRetry={complianceApi.refetch} />
                ) : (
                    <Suspense fallback={<SkeletonLoader variant="chart" label="Loading report status chart" />}>
                        <RegulatorComplianceChart reportStatusData={reportStatusData} />
                    </Suspense>
                )}
            </section>

            <section className="regulator-dashboard-section" aria-labelledby="reports-overview-title">
                <div className="regulator-dashboard-section-heading">
                    <div>
                        <p className="regulator-dashboard-eyebrow">Report register</p>
                        <h2 id="reports-overview-title">Recent compliance reports</h2>
                    </div>
                    <Link className="regulator-dashboard-link" to="/regulator/compliance-reports">All reports</Link>
                </div>
                <p className="regulator-dashboard-note">
                    These are reports recorded in MicoPesa. Their presence does not establish external filing or acceptance.
                </p>
                <DataTable
                    columns={legacyReportColumns}
                    rows={reports.slice(0, 5)}
                    rowKey="report_id"
                    loading={reportsApi.loading}
                    error={reportsApi.error}
                    onRetry={reportsApi.refetch}
                    emptyMessage="No compliance reports are available in the report register."
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
                    rows={submittedReports}
                    rowKey="report_id"
                    loading={reportsApi.loading}
                    refreshing={reportsApi.refreshing}
                    error={reportsApi.error}
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
                            <p className="regulator-dashboard-eyebrow">Recorded events</p>
                            <h2 id="audit-activity-title">Recent audit activity</h2>
                        </div>
                        <Link className="regulator-dashboard-link" to="/regulator/audit-logs">View audit logs</Link>
                    </div>
                    {auditApi.loading ? (
                        <LoadingState message="Loading recent audit events..." />
                    ) : auditApi.error ? (
                        <ErrorState message={auditApi.error} onRetry={auditApi.refetch} />
                    ) : recentAudit.length ? (
                        <ol className="regulator-audit-list">
                            {recentAudit.map((event) => (
                                <li key={event.log_id}>
                                    <strong>{event.action_type || "Action unavailable"}</strong>
                                    <span>{event.full_name || "System"} · {event.entity_name || "Record"}</span>
                                    <time dateTime={event.timestamp}>{formatDate(event.timestamp, true, dateLocale)}</time>
                                </li>
                            ))}
                        </ol>
                    ) : (
                        <p className="regulator-dashboard-empty">No operational audit events are available.</p>
                    )}
                </section>

                <section className="regulator-dashboard-section" aria-labelledby="fund-oversight-title">
                    <div className="regulator-dashboard-section-heading">
                        <div>
                            <p className="regulator-dashboard-eyebrow">Fund register</p>
                            <h2 id="fund-oversight-title">Fund oversight</h2>
                        </div>
                        <Link className="regulator-dashboard-link" to="/regulator/funds">View all funds</Link>
                    </div>
                    {fundsApi.loading ? (
                        <LoadingState message="Loading fund records..." />
                    ) : fundsApi.error ? (
                        <ErrorState message={fundsApi.error} onRetry={fundsApi.refetch} />
                    ) : funds.length ? (
                        <ul className="regulator-fund-list">
                            {funds.slice(0, 4).map(({ fund, allocationCount }) => (
                                <li key={fund.fund_id}>
                                    <div className="regulator-fund-heading">
                                        <strong>{fund.fund_name}</strong>
                                        {fund.fund_status
                                            ? <StatusBadge status={fund.fund_status} />
                                            : <span>Unavailable</span>}
                                    </div>
                                    <span>
                                        {fund.risk_level || "Risk category unavailable"} · {allocationCount} allocation records
                                        {" · Configured expected return "}
                                        {fund.expected_return === undefined || fund.expected_return === null
                                            || !Number.isFinite(Number(fund.expected_return))
                                            ? "Unavailable"
                                            : `${Number(fund.expected_return).toFixed(2)}%`}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="regulator-dashboard-empty">No fund records are available.</p>
                    )}
                </section>
            </div>

            <nav className="regulator-dashboard-section regulator-dashboard-navigation" aria-label="Regulator features">
                <div className="regulator-dashboard-section-heading">
                    <div>
                        <p className="regulator-dashboard-eyebrow">Navigation</p>
                        <h2>Quick access</h2>
                    </div>
                </div>
                <ul>
                    {REGULATOR_LINKS.map((item) => (
                        <li key={item.to}>
                            <Link to={item.to}>
                                <span>{item.label}</span>
                                <small>{item.description}</small>
                            </Link>
                        </li>
                    ))}
                </ul>
            </nav>
        </div>
    );
}

export default RegulatorDashboard;
