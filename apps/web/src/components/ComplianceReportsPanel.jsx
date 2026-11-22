import { useRef, useState } from "react";
import useApi from "../hooks/useApi";
import { listFunds } from "../services/fundService";
import {
    createDraft,
    getManagerReport,
    listManagerReports,
    submitReport,
    updateDraft,
} from "../services/complianceReportService";
import DataTable from "./ui/DataTable";
import StatusBadge from "./ui/StatusBadge";
import Button from "./ui/Button";
import Modal from "./ui/Modal";
import FormField from "./ui/FormField";
import { useToast } from "./ui/ToastContext";
import {
    getReportCategoryLabel,
    isSyntheticDemo,
    REPORT_CATEGORIES,
    SYNTHETIC_DEMO_CLASSIFICATION,
    SYNTHETIC_DEMO_TEMPLATES,
} from "../utils/complianceReports";
import "./compliance-workflow.css";

const CONTENT_FIELDS = [
    ["executive_summary", "Executive summary"],
    ["financial_summary", "Financial summary"],
    ["risk_and_governance", "Risk management and governance"],
    ["incidents_and_actions", "Incidents and corrective actions"],
    ["supporting_information", "Supporting information"],
];
const EMPTY_FORM = {
    fund_id: "",
    report_type: "RBA",
    period_start: "",
    period_end: "",
    report_content: {
        report_category: "GENERAL_COMPLIANCE",
        ...Object.fromEntries(CONTENT_FIELDS.map(([key]) => [key, ""])),
    },
};

function formatDate(value) {
    if (!value) return "Not submitted";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleString();
}

function ComplianceReportsPanel({ title, subtitle }) {
    const reportsApi = useApi(listManagerReports, []);
    const fundsApi = useApi(listFunds, []);
    const toast = useToast();
    const [editorOpen, setEditorOpen] = useState(false);
    const [viewingReport, setViewingReport] = useState(null);
    const [reportDetails, setReportDetails] = useState(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [editingId, setEditingId] = useState(null);
    const [saving, setSaving] = useState(false);
    const submissionInProgressRef = useRef(false);

    function openNewDraft(syntheticDemo = false) {
        setEditingId(null);
        const demoCategory = "QUARTERLY_CONTRIBUTION_RECONCILIATION";
        setForm({
            ...EMPTY_FORM,
            report_type: syntheticDemo ? "INTERNAL" : EMPTY_FORM.report_type,
            report_content: syntheticDemo
                ? {
                    ...SYNTHETIC_DEMO_TEMPLATES[demoCategory],
                    report_category: demoCategory,
                    demo_classification: SYNTHETIC_DEMO_CLASSIFICATION,
                }
                : { ...EMPTY_FORM.report_content },
        });
        setEditorOpen(true);
    }

    async function openReport(row) {
        try {
            setViewingReport(row);
            setReportDetails(await getManagerReport(row.report_id));
        } catch (error) {
            setViewingReport(null);
            toast.error(error.message || "Unable to load this report.");
        }
    }

    async function openEditor(row) {
        try {
            const details = await getManagerReport(row.report_id);
            const report = details.report;
            setEditingId(report.report_id);
            setForm({
                fund_id: report.fund_id || "",
                report_type: report.report_type || "RBA",
                period_start: report.period_start?.slice(0, 10) || "",
                period_end: report.period_end?.slice(0, 10) || "",
                report_content: { ...EMPTY_FORM.report_content, ...(report.report_content || {}) },
            });
            setEditorOpen(true);
        } catch (error) {
            toast.error(error.message || "Unable to load this report.");
        }
    }

    function handleChange(event) {
        const { name, value } = event.target;
        if (name.startsWith("report_content.")) {
            const contentKey = name.slice("report_content.".length);
            setForm((current) => ({
                ...current,
                report_content: { ...current.report_content, [contentKey]: value },
            }));
        } else {
            setForm((current) => ({ ...current, [name]: value }));
        }
    }

    async function persistDraft() {
        const payload = {
            fund_id: form.fund_id,
            report_type: form.report_type || null,
            period_start: form.period_start || null,
            period_end: form.period_end || null,
            report_content: form.report_content,
        };
        if (editingId) return updateDraft(editingId, payload);
        return createDraft(payload);
    }

    async function handleSave(event) {
        event.preventDefault();
        if (submissionInProgressRef.current) return;
        submissionInProgressRef.current = true;
        setSaving(true);
        try {
            const report = await persistDraft();
            setEditingId(report.report_id);
            await reportsApi.refetch();
            toast.success("Draft saved.");
        } catch (error) {
            toast.error(error.message || "Unable to save this draft.");
        } finally {
            setSaving(false);
            submissionInProgressRef.current = false;
        }
    }

    async function handleSubmit() {
        if (submissionInProgressRef.current) return;
        submissionInProgressRef.current = true;
        setSaving(true);
        try {
            const report = await persistDraft();
            setEditingId(report.report_id);
            await submitReport(report.report_id);
            setEditorOpen(false);
            await reportsApi.refetch();
            toast.success("Report submitted to the regulator.");
        } catch (error) {
            toast.error(error.message || "Unable to submit this report.");
        } finally {
            setSaving(false);
            submissionInProgressRef.current = false;
        }
    }

    const columns = [
        { key: "fund_name", header: "Fund", render: (row) => row.is_legacy || !row.fund_id ? "Legacy historical" : row.fund_name },
        { key: "report_type", header: "Type" },
        { key: "report_category", header: "Category", render: (row) => getReportCategoryLabel(row.report_category) },
        {
            key: "is_synthetic_demo",
            header: "Classification",
            render: (row) => row.is_synthetic_demo
                ? <span className="compliance-demo-badge">Synthetic demo — not a genuine regulatory submission</span>
                : "Not marked synthetic",
        },
        { key: "period_start", header: "Period", render: (row) => `${row.period_start || "—"} – ${row.period_end || "—"}` },
        { key: "rba_status", header: "Status", render: (row) => <StatusBadge status={row.rba_status} /> },
        { key: "last_submitted_at", header: "Last submitted", render: (row) => formatDate(row.last_submitted_at) },
        {
            key: "actions",
            header: "Actions",
            render: (row) => (
                <div className="compliance-actions">
                    <Button variant="secondary" size="sm" onClick={() => openReport(row)}>View history</Button>
                    {!row.is_legacy && row.fund_id && ["DRAFT", "REVISION_REQUESTED"].includes(row.rba_status) && (
                        <Button variant="secondary" size="sm" onClick={() => openEditor(row)}>
                            {row.rba_status === "DRAFT" ? "Edit draft" : "Revise report"}
                        </Button>
                    )}
                </div>
            ),
        },
    ];

    return (
        <div className="compliance-workflow">
            <div className="page-header">
                <div>
                    <h1 className="page-title">{title}</h1>
                    <p className="page-subtitle">{subtitle}</p>
                </div>
                <div className="compliance-actions">
                    <Button variant="primary" onClick={() => openNewDraft(false)}>+ Create report</Button>
                    <Button variant="secondary" onClick={() => openNewDraft(true)}>Create synthetic demo report</Button>
                </div>
            </div>

            <DataTable
                columns={columns}
                rows={reportsApi.data}
                rowKey="report_id"
                loading={reportsApi.loading}
                refreshing={reportsApi.refreshing}
                error={reportsApi.error}
                onRetry={reportsApi.refetch}
                emptyMessage="You have no compliance reports yet."
            />

            <Modal
                open={editorOpen}
                className="compliance-report-editor-modal"
                title={editingId ? "Edit compliance report" : isSyntheticDemo(form.report_content) ? "Create synthetic demo report draft" : "Create compliance report draft"}
                onClose={() => !saving && setEditorOpen(false)}
                footer={(
                    <div className="compliance-report-editor-actions">
                        <Button type="button" variant="secondary" disabled={saving} onClick={() => setEditorOpen(false)}>Close</Button>
                        <Button type="submit" form="compliance-report-editor-form" variant="secondary" loading={saving}>Save draft</Button>
                        <Button type="button" variant="primary" loading={saving} onClick={handleSubmit}>Submit to regulator</Button>
                    </div>
                )}
            >
                <form id="compliance-report-editor-form" className="form-grid compliance-report-editor-form" onSubmit={handleSave}>
                    {editingId && (
                        <p className="compliance-evidence-note">
                            Existing report ID: <strong>{editingId}</strong>. Saving or submitting updates this report.
                        </p>
                    )}
                    {isSyntheticDemo(form.report_content) && (
                        <p className="compliance-synthetic-notice" role="status">
                            Synthetic demonstration only — not a genuine regulatory submission. Use fictional information only; this report is stored and reviewed through the normal workflow.
                        </p>
                    )}
                    <FormField
                        id="fund_id"
                        label="Managed fund"
                        as="select"
                        required
                        value={form.fund_id}
                        onChange={handleChange}
                        disabled={saving || Boolean(editingId)}
                        options={[
                            { value: "", label: fundsApi.loading ? "Loading funds..." : "Select a fund" },
                            ...(fundsApi.data || []).map((fund) => ({ value: fund.fund_id, label: fund.fund_name })),
                        ]}
                    />
                    <FormField
                        id="report_type"
                        label="Report type"
                        as="select"
                        value={form.report_type}
                        onChange={handleChange}
                        disabled={saving || isSyntheticDemo(form.report_content)}
                        options={[
                            { value: "RBA", label: "RBA" },
                            { value: "NSSF", label: "NSSF" },
                            { value: "INTERNAL", label: "Internal" },
                        ]}
                    />
                    <FormField
                        id="report_category"
                        name="report_content.report_category"
                        label="Report category"
                        as="select"
                        value={form.report_content.report_category || "GENERAL_COMPLIANCE"}
                        onChange={handleChange}
                        disabled={saving || isSyntheticDemo(form.report_content)}
                        options={REPORT_CATEGORIES.map((category) => ({
                            value: category.value,
                            label: category.label,
                        }))}
                    />
                    <div className="compliance-period-fields">
                        <FormField id="period_start" label="Period start" type="date" value={form.period_start} onChange={handleChange} disabled={saving} />
                        <FormField id="period_end" label="Period end" type="date" value={form.period_end} onChange={handleChange} disabled={saving} />
                    </div>
                    <p className="compliance-evidence-note">
                        Add supporting information as text below. Secure document attachments are not available.
                    </p>
                    {CONTENT_FIELDS.map(([key, label]) => (
                        <FormField
                            key={key}
                            id={`report_content.${key}`}
                            label={label}
                            as="textarea"
                            value={form.report_content[key]}
                            onChange={handleChange}
                            disabled={saving}
                            maxLength={10000}
                        />
                    ))}
                </form>
            </Modal>

            <Modal
                open={Boolean(viewingReport)}
                size="review"
                title="Compliance report history"
                onClose={() => {
                    setViewingReport(null);
                    setReportDetails(null);
                }}
            >
                {!reportDetails ? <p>Loading report details...</p> : (
                    <div className="compliance-report-detail">
                        {reportDetails.report.is_legacy_history && (
                            <p className="compliance-evidence-note" role="status">
                                Legacy historical record — read-only. It has no complete reviewable submission snapshot.
                            </p>
                        )}
                        {["ACCEPTED", "REJECTED"].includes(reportDetails.report.rba_status) && (
                            <p className="compliance-evidence-note" role="status">
                                Final decision recorded. This report is read-only.
                            </p>
                        )}
                        <p><strong>Fund:</strong> {reportDetails.report.fund_name || "Legacy report"}</p>
                        <p><strong>Report category:</strong> {getReportCategoryLabel(reportDetails.report.report_category || reportDetails.report.report_content?.report_category)}</p>
                        {isSyntheticDemo(reportDetails.report.report_content) && (
                            <p className="compliance-synthetic-notice" role="status">
                                Synthetic demonstration only — not a genuine regulatory submission.
                            </p>
                        )}
                        <p><strong>Reporting period:</strong> {reportDetails.report.period_start || "—"} – {reportDetails.report.period_end || "—"}</p>
                        <p><strong>Current status:</strong> <StatusBadge status={reportDetails.report.rba_status} /></p>
                        {reportDetails.reviews.map((review) => (
                            <section className="compliance-history-item" key={review.review_id}>
                                <h3>Decision on submission {review.version}: {review.decision.replaceAll("_", " ")}</h3>
                                <p>{review.reason}</p>
                                <small>
                                    Reviewed by: {review.reviewer_name || "Historical name unavailable"}
                                    {review.reviewer_role ? ` (${review.reviewer_role})` : ""}
                                    {review.reviewed_by ? ` · ID: ${review.reviewed_by}` : ""}
                                    {" · "}{formatDate(review.created_at)}
                                </small>
                            </section>
                        ))}
                        {reportDetails.submissions.map((submission) => (
                            <section className="compliance-history-item" key={submission.submission_id}>
                                <h3>Submission {submission.version}</h3>
                                {isSyntheticDemo(submission.report_content) && (
                                    <p className="compliance-synthetic-notice" role="status">
                                        Synthetic demonstration only — not a genuine regulatory submission.
                                    </p>
                                )}
                                <p><strong>Report category:</strong> {getReportCategoryLabel(submission.report_content?.report_category)}</p>
                                <small>
                                    Submitted by: {submission.submitted_by_name || "Historical name unavailable"}
                                    {submission.submitted_by_role ? ` (${submission.submitted_by_role})` : ""}
                                    {submission.submitted_by ? ` · ID: ${submission.submitted_by}` : ""}
                                    {" · "}{formatDate(submission.submitted_at)}
                                </small>
                                {CONTENT_FIELDS.map(([key, label]) => (
                                    <div key={key}>
                                        <strong>{label}</strong>
                                        <p>{submission.report_content?.[key] || "—"}</p>
                                    </div>
                                ))}
                            </section>
                        ))}
                    </div>
                )}
            </Modal>
        </div>
    );
}

export default ComplianceReportsPanel;
