import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import useApi from "../../hooks/useApi";
import { listFunds } from "../../services/fundService";
import {
    getRegulatorReport,
    listRegulatorReports,
    reviewRegulatorReport,
} from "../../services/complianceReportService";
import {
    getReportCategoryLabel,
    isSyntheticDemo,
} from "../../utils/complianceReports";
import DataTable from "../../components/ui/DataTable";
import StatusBadge from "../../components/ui/StatusBadge";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import FormField from "../../components/ui/FormField";
import LoadingState from "../../components/ui/LoadingState";
import ErrorState from "../../components/ui/ErrorState";
import { useToast } from "../../components/ui/ToastContext";
import "../../components/compliance-workflow.css";

const EMPTY_FILTERS = {
    fund_id: "",
    manager_id: "",
    report_type: "",
    status: "",
    period_start: "",
    period_end: "",
    search: "",
};
const CONTENT_LABELS = [
    ["executive_summary", "Executive summary"],
    ["financial_summary", "Financial summary"],
    ["risk_and_governance", "Risk management and governance"],
    ["incidents_and_actions", "Incidents and corrective actions"],
    ["supporting_information", "Supporting information"],
];
const STATUSES = ["SUBMITTED", "REVISION_REQUESTED", "ACCEPTED", "REJECTED"];

function formatDate(value) {
    if (!value) return "Not available";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleString();
}

function ComplianceReview() {
    const { t } = useTranslation();
    const toast = useToast();
    const fundsApi = useApi(listFunds, []);
    const [filters, setFilters] = useState(EMPTY_FILTERS);
    const [appliedFilters, setAppliedFilters] = useState({});
    const reportsApi = useApi(() => listRegulatorReports(appliedFilters), [appliedFilters]);
    const [selectedReportId, setSelectedReportId] = useState(null);
    const [reportDetails, setReportDetails] = useState(null);
    const [detailsLoading, setDetailsLoading] = useState(false);
    const [detailsError, setDetailsError] = useState(null);
    const [decision, setDecision] = useState("");
    const [reason, setReason] = useState("");
    const [saving, setSaving] = useState(false);
    const detailsRequestId = useRef(0);

    function updateFilter(event) {
        setFilters((current) => ({ ...current, [event.target.name]: event.target.value }));
    }

    function applyFilters(event) {
        event.preventDefault();
        setAppliedFilters(Object.fromEntries(
            Object.entries(filters).filter(([, value]) => value.trim() !== "")
        ));
    }

    async function openReport(row) {
        const requestId = ++detailsRequestId.current;
        setSelectedReportId(row.report_id);
        setReportDetails(null);
        setDetailsError(null);
        setDetailsLoading(true);
        try {
            const details = await getRegulatorReport(row.report_id);
            if (requestId === detailsRequestId.current) setReportDetails(details);
        } catch (error) {
            if (requestId === detailsRequestId.current) {
                setDetailsError(error.message || t("regulator.review.detailsErrorTitle"));
            }
        } finally {
            if (requestId === detailsRequestId.current) setDetailsLoading(false);
        }
    }

    function closeReport() {
        detailsRequestId.current += 1;
        setSelectedReportId(null);
        setReportDetails(null);
        setDetailsError(null);
        setDetailsLoading(false);
        setDecision("");
        setReason("");
    }

    async function saveDecision(event) {
        event.preventDefault();
        if (!reportDetails) return;
        if (decision !== "ACCEPTED" && !reason.trim()) {
            toast.error("A reason is required for rejection or revision requests.");
            return;
        }
        const reportId = reportDetails.report.report_id;
        const currentSubmission = reportDetails.submissions.at(-1);
        if (!currentSubmission?.submission_id) {
            toast.error(t("regulator.review.submissionUnavailable"));
            return;
        }
        setSaving(true);
        try {
            await reviewRegulatorReport(reportId, {
                submission_id: currentSubmission.submission_id,
                decision,
                ...(reason.trim() ? { reason: reason.trim() } : {}),
            });
            toast.success(`Report ${decision.toLowerCase().replaceAll("_", " ")}.`);
            setDecision("");
            setReason("");
            await reportsApi.refetch();
            await openReport({ report_id: reportId });
        } catch (error) {
            if (error.status === 409 && error.data?.code === "STALE_SUBMISSION") {
                toast.error(t("regulator.review.staleSubmission"));
                setDecision("");
                setReason("");
                await reportsApi.refetch();
                await openReport({ report_id: reportId });
            } else {
                toast.error(error.message || "Unable to record the review decision.");
            }
        } finally {
            setSaving(false);
        }
    }

    const columns = [
        {
            key: "origin",
            header: "Origin",
            render: (row) => row.is_legacy_history
                ? "Legacy historical record"
                : row.manager_name ? "Fund manager submission" : "Origin unavailable",
        },
        { key: "report_type", header: "Report type" },
        { key: "report_category", header: "Category", render: (row) => getReportCategoryLabel(row.report_category) },
        {
            key: "is_synthetic_demo",
            header: "Classification",
            render: (row) => row.is_synthetic_demo
                ? <span className="compliance-demo-badge">Synthetic demo — not a genuine regulatory submission</span>
                : "Not marked synthetic",
        },
        { key: "fund_name", header: "Fund", render: (row) => row.fund_name || "Legacy historical" },
        { key: "period_start", header: "Period", render: (row) => `${row.period_start || "—"} – ${row.period_end || "—"}` },
        { key: "rba_status", header: "Status", render: (row) => <StatusBadge status={row.rba_status} /> },
        { key: "generated_at", header: "Recorded", render: (row) => formatDate(row.generated_at) },
        { key: "last_submitted_at", header: "Submitted", render: (row) => formatDate(row.last_submitted_at || row.submitted_at) },
        {
            key: "actions",
            header: "Details",
            render: (row) => (
                <Button variant="secondary" size="sm" onClick={() => openReport(row)}>
                    {row.is_legacy_history ? "View history" : "Open report"}
                </Button>
            ),
        },
    ];
    const currentSubmission = reportDetails?.submissions?.at(-1);
    const currentContent = currentSubmission?.report_content || reportDetails?.report.report_content;
    const reportRows = reportsApi.data || [];
    const awaitingReview = reportRows.filter((report) =>
        report.rba_status === "SUBMITTED" && report.reviewable && !report.is_legacy_history
    );

    return (
        <div className="compliance-workflow">
            <div className="page-header">
                <div>
                    <h1 className="page-title">Compliance Reports</h1>
                    <p className="page-subtitle">View the report register and review complete manager submissions within your assigned fund scope.</p>
                </div>
            </div>

            {fundsApi.error && (
                <ErrorState
                    title="Unable to load assigned funds"
                    message={fundsApi.error}
                    onRetry={fundsApi.refetch}
                />
            )}

            <form className="compliance-filters" onSubmit={applyFilters}>
                <FormField
                    id="fund_id"
                    label="Fund"
                    as="select"
                    name="fund_id"
                    value={filters.fund_id}
                    onChange={updateFilter}
                    options={[
                        { value: "", label: "All funds" },
                        ...(fundsApi.data || []).map((fund) => ({ value: fund.fund_id, label: fund.fund_name })),
                    ]}
                />
                <FormField id="search" label="Search fund or manager" name="search" value={filters.search} onChange={updateFilter} />
                <FormField
                    id="report_type"
                    label="Report type"
                    as="select"
                    name="report_type"
                    value={filters.report_type}
                    onChange={updateFilter}
                    options={[
                        { value: "", label: "All types" },
                        { value: "RBA", label: "RBA" },
                        { value: "NSSF", label: "NSSF" },
                        { value: "INTERNAL", label: "Internal" },
                    ]}
                />
                <FormField
                    id="status"
                    label="Status"
                    as="select"
                    name="status"
                    value={filters.status}
                    onChange={updateFilter}
                    options={[
                        { value: "", label: "All review statuses" },
                        ...STATUSES.map((status) => ({ value: status, label: status.replaceAll("_", " ") })),
                    ]}
                />
                <div className="compliance-period-fields">
                    <FormField id="period_start" label="Period from" type="date" name="period_start" value={filters.period_start} onChange={updateFilter} />
                    <FormField id="period_end" label="Period to" type="date" name="period_end" value={filters.period_end} onChange={updateFilter} />
                </div>
                <div className="compliance-filter-actions">
                    <Button type="submit" variant="primary">Apply filters</Button>
                    <Button type="button" variant="secondary" onClick={() => { setFilters(EMPTY_FILTERS); setAppliedFilters({}); }}>Clear</Button>
                </div>
            </form>

            <section className="compliance-report-register" aria-labelledby="recent-compliance-reports-heading">
                <div className="compliance-register-heading">
                    <div>
                        <h2 id="recent-compliance-reports-heading">Recent Compliance Reports</h2>
                        <p>These are records in MicoPesa. Their presence does not establish external filing or acceptance.</p>
                    </div>
                    <Link to="/regulator/reports">Generate system reports and exports</Link>
                </div>
                <DataTable
                    columns={columns}
                    rows={reportsApi.data === null ? null : reportRows.slice(0, 10)}
                    rowKey="report_id"
                    loading={reportsApi.loading}
                    refreshing={reportsApi.refreshing}
                    error={reportsApi.error}
                    onRetry={reportsApi.refetch}
                    emptyMessage="No compliance reports are recorded in the report register."
                />
            </section>

            <section className="compliance-report-queue" aria-labelledby="submitted-reports-heading">
                <div className="compliance-register-heading">
                    <div>
                        <h2 id="submitted-reports-heading">Submitted Reports Awaiting Review</h2>
                        <p>Only current, complete submissions with a stored version are included. Drafts and incomplete legacy records are excluded.</p>
                    </div>
                    {reportsApi.data !== null && !reportsApi.error && (
                        <span className="compliance-queue-count" role="status">
                            {awaitingReview.length} awaiting review
                        </span>
                    )}
                </div>
                <DataTable
                    columns={columns}
                    rows={reportsApi.data === null ? null : awaitingReview}
                    rowKey="report_id"
                    loading={reportsApi.loading}
                    refreshing={reportsApi.refreshing}
                    error={reportsApi.error}
                    onRetry={reportsApi.refetch}
                    emptyMessage="No submitted reports are awaiting review."
                />
            </section>

            <Modal
                open={Boolean(selectedReportId)}
                size="review"
                title="Compliance report review"
                onClose={() => {
                    if (!saving) closeReport();
                }}
                footer={
                    reportDetails?.report.reviewable &&
                    currentSubmission?.submission_id &&
                    reportDetails.report.rba_status === "SUBMITTED" ? (
                        <div className="compliance-actions">
                            {!decision ? (
                                <>
                                    <Button onClick={() => setDecision("ACCEPTED")}>Accept</Button>
                                    <Button variant="danger" onClick={() => setDecision("REJECTED")}>Reject</Button>
                                    <Button variant="secondary" onClick={() => setDecision("REVISION_REQUESTED")}>Request revisions</Button>
                                </>
                            ) : (
                                <>
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        disabled={saving}
                                        onClick={() => { setDecision(""); setReason(""); }}
                                    >
                                        Cancel
                                    </Button>
                                    <Button
                                        type="submit"
                                        form="compliance-decision-form"
                                        variant={decision === "REJECTED" ? "danger" : "primary"}
                                        loading={saving}
                                    >
                                        Record decision
                                    </Button>
                                </>
                            )}
                        </div>
                    ) : null
                }
            >
                {detailsLoading && <LoadingState message={t("regulator.review.loadingDetails")} />}
                {detailsError && (
                    <ErrorState
                        message={detailsError}
                        title={t("regulator.review.detailsErrorTitle")}
                        retryLabel={t("regulator.review.retry")}
                        onRetry={() => openReport({ report_id: selectedReportId })}
                    />
                )}
                {reportDetails && (
                    <div className="compliance-report-detail">
                        <div className="compliance-report-summary">
                            {reportDetails.report.is_legacy_history && (
                                <p className="compliance-evidence-note" role="status">
                                    Legacy historical record — read-only and excluded from the active review workflow because required submission data is missing.
                                </p>
                            )}
                            {!reportDetails.report.is_legacy_history && ["ACCEPTED", "REJECTED"].includes(reportDetails.report.rba_status) && (
                                <p className="compliance-evidence-note" role="status">
                                    Final decision recorded. This report is read-only.
                                </p>
                            )}
                            {isSyntheticDemo(currentContent) && (
                                <p className="compliance-synthetic-notice" role="status">
                                    Synthetic demonstration only — not a genuine regulatory submission. Review this record only as a workflow demonstration.
                                </p>
                            )}
                            <p><strong>Fund:</strong> {reportDetails.report.fund_name || "Legacy report"}</p>
                            <p><strong>Fund manager:</strong> {reportDetails.report.manager_name || "Former manager"}</p>
                            <p><strong>Report type:</strong> {reportDetails.report.report_type || "Not specified"}</p>
                            <p><strong>Report category:</strong> {getReportCategoryLabel(currentContent?.report_category || reportDetails.report.report_category)}</p>
                            <p><strong>Period:</strong> {reportDetails.report.period_start || "—"} – {reportDetails.report.period_end || "—"}</p>
                            <p><strong>Current status:</strong> <StatusBadge status={reportDetails.report.rba_status} /></p>
                            <p><strong>First submitted:</strong> {formatDate(reportDetails.report.submitted_at)}</p>
                            <p><strong>Last submitted:</strong> {formatDate(reportDetails.report.last_submitted_at)}</p>
                        </div>
                        <section>
                            <h3>Current report content</h3>
                            {CONTENT_LABELS.map(([key, label]) => (
                                <div className="compliance-content-section" key={key}>
                                    <h4>{label}</h4>
                                    <p>{currentContent?.[key] || "No information provided."}</p>
                                </div>
                            ))}
                        </section>
                        <section>
                            <h3>Submission and review history</h3>
                            {[...reportDetails.submissions].reverse().map((submission) => (
                                <article className="compliance-history-item" key={submission.submission_id}>
                                    <details>
                                        <summary>Submission {submission.version} · {formatDate(submission.submitted_at)}</summary>
                                        {isSyntheticDemo(submission.report_content) && (
                                            <p className="compliance-synthetic-notice" role="status">
                                                Synthetic demonstration only — not a genuine regulatory submission.
                                            </p>
                                        )}
                                        <p><strong>Report category:</strong> {getReportCategoryLabel(submission.report_content?.report_category)}</p>
                                        <p>
                                            Submitted by: {submission.submitted_by_name || "Historical name unavailable"}
                                            {submission.submitted_by_role ? ` (${submission.submitted_by_role})` : ""}
                                            {submission.submitted_by ? ` · ID: ${submission.submitted_by}` : ""}
                                        </p>
                                        {CONTENT_LABELS.map(([key, label]) => (
                                            <div className="compliance-content-section" key={key}>
                                                <h4>{label}</h4>
                                                <p>{submission.report_content?.[key] || "No information provided."}</p>
                                            </div>
                                        ))}
                                    </details>
                                </article>
                            ))}
                            {reportDetails.reviews.map((review) => (
                                <article className="compliance-history-item" key={review.review_id}>
                                    <h4>Decision on submission {review.version}: {review.decision.replaceAll("_", " ")}</h4>
                                    <p>{review.reason || "No additional comment."}</p>
                                    <small>
                                        Reviewed by: {review.reviewer_name || "Historical name unavailable"}
                                        {review.reviewer_role ? ` (${review.reviewer_role})` : ""}
                                        {review.reviewed_by ? ` · ID: ${review.reviewed_by}` : ""}
                                        {" · "}{formatDate(review.created_at)}
                                    </small>
                                </article>
                            ))}
                        </section>
                        {reportDetails.report.reviewable && currentSubmission?.submission_id && reportDetails.report.rba_status === "SUBMITTED" && (
                            <section className="compliance-decision">
                                <h3>Record review decision</h3>
                                {decision && (
                                    <form id="compliance-decision-form" className="form-grid" onSubmit={saveDecision}>
                                        <p>Decision: <strong>{decision.replaceAll("_", " ")}</strong></p>
                                        {decision !== "ACCEPTED" && (
                                            <FormField
                                                id="decision_reason"
                                                label={decision === "REJECTED" ? "Rejection reason (required)" : "Revision request (required)"}
                                                as="textarea"
                                                required
                                                minLength={10}
                                                maxLength={2000}
                                                value={reason}
                                                onChange={(event) => setReason(event.target.value)}
                                                disabled={saving}
                                            />
                                        )}
                                    </form>
                                )}
                            </section>
                        )}
                    </div>
                )}
            </Modal>
        </div>
    );
}

export default ComplianceReview;
