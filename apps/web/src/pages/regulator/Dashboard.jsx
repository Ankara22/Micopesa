import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../context/AuthContext";
import useApi from "../../hooks/useApi";
import RegulatorNavIcon from "../../components/RegulatorNavIcon";
import DataTable from "../../components/ui/DataTable";
import ErrorState from "../../components/ui/ErrorState";
import LoadingState from "../../components/ui/LoadingState";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import StatusBadge from "../../components/ui/StatusBadge";
import { getRegulatorDashboard } from "../../services/regulatorApi";
import { getReportCategoryLabel } from "../../utils/complianceReports";
import "./regulator-pages.css";
import "./regulator-dashboard.css";

const REGULATOR_LINKS = [
    { key: "dashboard", labelKey: "dashboard", path: "/regulator/dashboard", icon: "dashboard" },
    { key: "analytics", labelKey: "regulatorAnalytics", path: "/regulator/analytics", icon: "analytics" },
    { key: "funds", labelKey: "fundOversight", path: "/regulator/funds", icon: "funds" },
    { key: "reports", labelKey: "complianceReports", path: "/regulator/compliance-reports", icon: "reports" },
    { key: "parameters", labelKey: "regulatoryParameters", path: "/regulator/regulatory-parameters", icon: "parameters" },
    { key: "kyc", labelKey: "kycOversight", path: "/regulator/kyc-oversight", icon: "kyc" },
    { key: "audit", labelKey: "operationalAuditLogs", path: "/regulator/audit-logs", icon: "audit" },
    { key: "notifications", labelKey: "regulatorNotifications", path: "/regulator/notifications", icon: "notifications" },
    { key: "notificationAudit", labelKey: "notificationAuditLog", path: "/regulator/notification-audit-log", icon: "notificationAudit" },
    { key: "exports", labelKey: "reportsExports", path: "/regulator/reports", icon: "exports" },
    { key: "history", labelKey: "reportHistory", path: "/regulator/report-history", icon: "history" },
    { key: "profile", labelKey: "profile", path: "/regulator/profile", icon: "profile" },
];

function RegulatorDashboard() {
    const { t, i18n } = useTranslation();
    const { user } = useAuth();
    const dashboardApi = useApi(getRegulatorDashboard, []);
    const data = dashboardApi.data;
    const firstName = user?.full_name?.trim().split(/\s+/)[0];
    const locale = i18n.resolvedLanguage?.startsWith("sw") ? "sw-KE" : "en-KE";
    const numberFormat = new Intl.NumberFormat(locale);
    const canShowScopedData = Boolean(data?.scope?.has_active_fund_scope);
    const workflowSummary = data?.report_summary?.workflow || {};
    const syntheticDemoSummary = data?.report_summary?.synthetic_demo || {};
    const reportMetrics = [
        ["drafts", workflowSummary.draft_count],
        ["submitted", workflowSummary.submitted_count],
        ["awaitingReviewCount", workflowSummary.awaiting_review_count],
        ["incompleteSubmissions", workflowSummary.incomplete_submission_count],
        ["approved", workflowSummary.approved_count],
        ["returned", workflowSummary.returned_count],
        ["rejected", workflowSummary.rejected_count],
        ["legacyHistory", data?.report_summary?.legacy_history_count],
    ];
    const syntheticDemoMetrics = [
        ["drafts", syntheticDemoSummary.draft_count],
        ["submitted", syntheticDemoSummary.submitted_count],
        ["awaitingReviewCount", syntheticDemoSummary.awaiting_review_count],
        ["incompleteSubmissions", syntheticDemoSummary.incomplete_submission_count],
        ["approved", syntheticDemoSummary.approved_count],
        ["returned", syntheticDemoSummary.returned_count],
        ["rejected", syntheticDemoSummary.rejected_count],
    ];

    const reportColumns = [
        { key: "report_type", header: t("regulator.dashboardData.reportType") },
        {
            key: "report_category",
            header: t("regulator.dashboardData.reportCategory"),
            render: (row) => getReportCategoryLabel(row.report_category),
        },
        {
            key: "is_synthetic_demo",
            header: t("regulator.dashboardData.classification"),
            render: (row) => row.is_synthetic_demo
                ? <span className="regulator-dashboard-demo-badge">{t("regulator.dashboardData.syntheticDemoLabel")}</span>
                : t("regulator.dashboardData.notMarkedSynthetic"),
        },
        {
            key: "submitted_at",
            header: t("regulator.dashboardData.submittedAt"),
            render: (row) => formatDate(row.submitted_at, locale, t),
        },
        {
            key: "rba_status",
            header: t("regulator.dashboardData.status"),
            render: (row) => <StatusBadge status={row.rba_status} />,
        },
    ];
    const activityColumns = [
        { key: "report_type", header: t("regulator.dashboardData.reportType") },
        {
            key: "report_category",
            header: t("regulator.dashboardData.reportCategory"),
            render: (row) => getReportCategoryLabel(row.report_category),
        },
        {
            key: "is_synthetic_demo",
            header: t("regulator.dashboardData.classification"),
            render: (row) => row.is_synthetic_demo
                ? <span className="regulator-dashboard-demo-badge">{t("regulator.dashboardData.syntheticDemoLabel")}</span>
                : t("regulator.dashboardData.notMarkedSynthetic"),
        },
        { key: "action_type", header: t("regulator.dashboardData.action") },
        {
            key: "rba_status",
            header: t("regulator.dashboardData.status"),
            render: (row) => <StatusBadge status={row.rba_status} />,
        },
        {
            key: "timestamp",
            header: t("regulator.dashboardData.eventDate"),
            render: (row) => formatDate(row.timestamp, locale, t),
        },
    ];
    const kycColumns = [
        {
            key: "kyc_status",
            header: t("regulator.dashboardData.status"),
            render: (row) => (
                <StatusBadge
                    status={row.kyc_status}
                    label={t(`profile.kycStatuses.${row.kyc_status}`, { defaultValue: row.kyc_status })}
                />
            ),
        },
        { key: "action_type", header: t("regulator.dashboardData.action") },
        {
            key: "timestamp",
            header: t("regulator.dashboardData.eventDate"),
            render: (row) => formatDate(row.timestamp, locale, t),
        },
    ];
    const controlColumns = [
        { key: "name", header: t("regulator.dashboardData.check") },
        {
            key: "status",
            header: t("regulator.dashboardData.status"),
            render: (row) => <StatusBadge status={row.status} label={t(`regulator.dashboardData.statuses.${row.status}`)} />,
        },
        { key: "observed_value", header: t("regulator.dashboardData.observed") },
    ];

    return (
        <div className="regulator-dashboard">
            <header className="regulator-welcome">
                <div className="regulator-brand-mark" aria-hidden="true">M</div>
                <div>
                    <p className="regulator-dashboard-eyebrow">{t("dashboards.regulator.eyebrow")}</p>
                    <h1 className="page-title">
                        {firstName ? t("dashboards.welcome", { name: firstName }) : t("dashboards.regulator.title")}
                    </h1>
                    <p className="page-subtitle">{t("regulator.portal.intro")}</p>
                    <p className="regulator-welcome-description">{t("regulator.portal.responsibilities")}</p>
                </div>
            </header>

            <section className="regulator-dashboard-data" aria-labelledby="regulator-dashboard-data-heading">
                <div className="regulator-dashboard-data-heading">
                    <div>
                        <p className="regulator-dashboard-eyebrow">{t("regulator.dashboardData.eyebrow")}</p>
                        <h2 id="regulator-dashboard-data-heading">{t("regulator.dashboardData.title")}</h2>
                        <p>{t("regulator.dashboardData.subtitle")}</p>
                    </div>
                    {data?.evaluated_at && (
                        <time dateTime={data.evaluated_at}>
                            {t("regulator.dashboardData.evaluated", { date: formatDate(data.evaluated_at, locale, t) })}
                        </time>
                    )}
                </div>

                {dashboardApi.error && data !== null && (
                    <ErrorState
                        title={t("regulator.dashboardData.loadErrorTitle")}
                        message={dashboardApi.error}
                        onRetry={dashboardApi.refetch}
                    />
                )}
                {dashboardApi.refreshing && <LoadingState message={t("regulator.dashboardData.refreshing")} />}
                {dashboardApi.loading && data === null ? (
                    <SkeletonLoader variant="dashboard" count={4} label={t("regulator.dashboardData.loading")} />
                ) : data === null ? (
                    <ErrorState
                        title={t("regulator.dashboardData.loadErrorTitle")}
                        message={dashboardApi.error || t("regulator.dashboardData.loadError")}
                        onRetry={dashboardApi.refetch}
                    />
                ) : !canShowScopedData ? (
                    <p className="regulator-privacy-note" role="status">{t("regulator.dashboardData.noScope")}</p>
                ) : (
                    <>
                        <section className="regulator-summary-grid" aria-label={t("regulator.dashboardData.overview")}>
                            <SummaryCard
                                label={t("regulator.dashboardData.activeFunds")}
                                value={data.fund_overview.active_fund_count}
                                format={numberFormat}
                            />
                            <SummaryCard
                                label={t("regulator.dashboardData.workers")}
                                value={data.account_overview.worker_count}
                                format={numberFormat}
                            />
                            <SummaryCard
                                label={t("regulator.dashboardData.activeAccounts")}
                                value={data.account_overview.active_account_count}
                                format={numberFormat}
                            />
                            <SummaryCard
                                label={t("regulator.dashboardData.awaitingReview")}
                                value={data.awaiting_review.count}
                                format={numberFormat}
                            />
                        </section>

                        <section className="regulator-data-section" aria-labelledby="regulator-reports-heading">
                            <div className="regulator-data-section-heading">
                                <div>
                                    <h2 id="regulator-reports-heading">{t("regulator.dashboardData.reportsHeading")}</h2>
                                    <p>{t("regulator.dashboardData.reportsDescription")}</p>
                                    <p className="regulator-dashboard-report-summary" aria-label={t("regulator.dashboardData.workflowCounts")}>
                                        <strong>{t("regulator.dashboardData.workflowCounts")}</strong>
                                        {reportMetrics.map(([key, count]) => (
                                            <span key={key}>
                                                <strong>{numberFormat.format(Number(count))}</strong>
                                                {t(`regulator.dashboardData.reportCounts.${key}`)}
                                            </span>
                                        ))}
                                    </p>
                                    <p className="regulator-dashboard-synthetic-notice" role="status">
                                        {t("regulator.dashboardData.syntheticDemoDisclosure")}
                                    </p>
                                    <p className="regulator-dashboard-report-summary" aria-label={t("regulator.dashboardData.syntheticDemoCounts")}>
                                        <strong>{t("regulator.dashboardData.syntheticDemoHeading")}</strong>
                                        {syntheticDemoMetrics.map(([key, count]) => (
                                            <span key={key}>
                                                <strong>{numberFormat.format(Number(count))}</strong>
                                                {t(`regulator.dashboardData.reportCounts.${key}`)}
                                            </span>
                                        ))}
                                    </p>
                                </div>
                                <Link to="/regulator/compliance-reports">{t("regulator.dashboardData.viewReports")}</Link>
                            </div>
                            <DataTable
                                columns={reportColumns}
                                rows={data.awaiting_review.recent}
                                rowKey="report_id"
                                emptyMessage={t("regulator.dashboardData.noAwaitingReports")}
                            />
                        </section>

                        <div className="regulator-dashboard-two-column">
                            <section className="regulator-data-section" aria-labelledby="regulator-activity-heading">
                                <div className="regulator-data-section-heading">
                                    <div>
                                        <h2 id="regulator-activity-heading">{t("regulator.dashboardData.activityHeading")}</h2>
                                        <p>{t("regulator.dashboardData.activityDescription")}</p>
                                    </div>
                                    <Link to="/regulator/compliance-reports">{t("regulator.dashboardData.viewReports")}</Link>
                                </div>
                                <DataTable
                                    columns={activityColumns}
                                    rows={data.recent_compliance_activity}
                                    rowKey="log_id"
                                    emptyMessage={t("regulator.dashboardData.noComplianceActivity")}
                                />
                            </section>

                            <section className="regulator-data-section" aria-labelledby="regulator-audit-heading">
                                <div className="regulator-data-section-heading">
                                    <div>
                                        <h2 id="regulator-audit-heading">{t("regulator.dashboardData.auditHeading")}</h2>
                                        <p>{t("regulator.dashboardData.auditEvents", {
                                            count: numberFormat.format(Number(data.audit_summary.events_last_24h)),
                                        })}</p>
                                        <p>{t("regulator.dashboardData.lastActivity", {
                                            date: formatDate(data.audit_summary.last_event_at, locale, t),
                                        })}</p>
                                    </div>
                                    <Link to="/regulator/audit-logs">{t("regulator.dashboardData.viewAudit")}</Link>
                                </div>
                            </section>
                        </div>

                        <section className="regulator-data-section" aria-labelledby="regulator-controls-heading">
                            <div className="regulator-data-section-heading">
                                <div>
                                    <h2 id="regulator-controls-heading">{t("regulator.dashboardData.controlsHeading")}</h2>
                                    <p>{t("regulator.dashboardData.controlsDescription")}</p>
                                    <p className="regulator-dashboard-control-summary">
                                        {Object.entries(data.control_checks.summary).map(([key, value]) => (
                                            <span key={key}>
                                                <strong>{numberFormat.format(Number(value))}</strong> {t(`regulator.dashboardData.controlCounts.${key}`)}
                                            </span>
                                        ))}
                                    </p>
                                </div>
                                <Link to="/regulator/regulatory-parameters">{t("regulator.dashboardData.viewControls")}</Link>
                            </div>
                            <DataTable
                                columns={controlColumns}
                                rows={data.control_checks.checks}
                                rowKey="key"
                                emptyMessage={t("regulator.dashboardData.noControls")}
                            />
                        </section>

                        <section className="regulator-data-section" aria-labelledby="regulator-kyc-heading">
                            <div className="regulator-data-section-heading">
                                <div>
                                    <h2 id="regulator-kyc-heading">{t("regulator.dashboardData.kycHeading")}</h2>
                                    <p>{t("regulator.dashboardData.kycDescription")}</p>
                                </div>
                                <Link to="/regulator/kyc-oversight">{t("regulator.dashboardData.viewKyc")}</Link>
                            </div>
                            <div className="regulator-summary-grid regulator-dashboard-kyc-summary" aria-label={t("regulator.kycPage.statusSummary")}>
                                {["PENDING", "VERIFIED", "REJECTED"].map((status) => {
                                    const count = data.kyc.status_counts.find((item) => item.kyc_status === status)?.count ?? 0;
                                    return (
                                        <SummaryCard
                                            key={status}
                                            label={t(`profile.kycStatuses.${status}`, { defaultValue: status })}
                                            value={count}
                                            format={numberFormat}
                                        />
                                    );
                                })}
                            </div>
                            <DataTable
                                columns={kycColumns}
                                rows={data.kyc.recent_review_history}
                                rowKey="log_id"
                                emptyMessage={t("regulator.dashboardData.noKycActivity")}
                            />
                        </section>
                    </>
                )}
            </section>

            <section className="regulator-navigation-section" aria-labelledby="regulator-navigation-title">
                <div className="regulator-navigation-heading">
                    <div>
                        <p className="regulator-dashboard-eyebrow">{t("regulator.portal.navigationEyebrow")}</p>
                        <h2 id="regulator-navigation-title">{t("regulator.portal.navigationTitle")}</h2>
                    </div>
                    <p>{t("regulator.portal.navigationDescription")}</p>
                </div>
                <nav aria-label={t("dashboards.regulator.features")}>
                    <ul className="regulator-navigation-grid">
                        {REGULATOR_LINKS.map((item) => (
                            <li key={item.path}>
                                <Link to={item.path} className="regulator-navigation-card">
                                    <span className="regulator-navigation-icon" aria-hidden="true">
                                        <RegulatorNavIcon name={item.icon} />
                                    </span>
                                    <span className="regulator-navigation-card-copy">
                                        <strong>{t(`navigation.${item.labelKey || item.key}`)}</strong>
                                        <small>{t(`regulator.portal.links.${item.key}`)}</small>
                                    </span>
                                    <span className="regulator-navigation-arrow" aria-hidden="true">›</span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                </nav>
            </section>
        </div>
    );
}

function SummaryCard({ label, value, format }) {
    return (
        <article className="regulator-summary-card">
            <span>{label}</span>
            <strong>{format.format(Number(value))}</strong>
        </article>
    );
}

function formatDate(value, locale, t) {
    if (!value) return t("regulator.dashboardData.unavailable");
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? t("regulator.dashboardData.unavailable") : date.toLocaleString(locale);
}

export default RegulatorDashboard;
