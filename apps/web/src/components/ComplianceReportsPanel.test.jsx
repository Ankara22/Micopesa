import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "./ui/ToastContext";
import ComplianceReportsPanel from "./ComplianceReportsPanel";
import ComplianceReview from "../pages/regulator/ComplianceReview";

const mocks = vi.hoisted(() => ({
    listFunds: vi.fn(),
    listManagerReports: vi.fn(),
    createDraft: vi.fn(),
    updateDraft: vi.fn(),
    submitReport: vi.fn(),
    getManagerReport: vi.fn(),
    listRegulatorReports: vi.fn(),
    getRegulatorReport: vi.fn(),
    reviewRegulatorReport: vi.fn(),
}));

vi.mock("../services/fundService", () => ({ listFunds: mocks.listFunds }));
vi.mock("../services/complianceReportService", () => ({
    listManagerReports: mocks.listManagerReports,
    createDraft: mocks.createDraft,
    updateDraft: mocks.updateDraft,
    submitReport: mocks.submitReport,
    getManagerReport: mocks.getManagerReport,
    listRegulatorReports: mocks.listRegulatorReports,
    getRegulatorReport: mocks.getRegulatorReport,
    reviewRegulatorReport: mocks.reviewRegulatorReport,
}));

const report = {
    report_id: "report-1",
    fund_id: "fund-1",
    fund_name: "Worker Growth",
    manager_id: "manager-1",
    manager_name: "Fund Manager",
    report_type: "RBA",
    period_start: "2026-01-01",
    period_end: "2026-03-31",
    report_content: {
        executive_summary: "A complete executive summary.",
        financial_summary: "Financial performance reconciled.",
        risk_and_governance: "Risk controls are described in detail.",
        incidents_and_actions: "Incidents and corrective actions are documented.",
        supporting_information: "Supporting materials are described.",
    },
    rba_status: "SUBMITTED",
    is_legacy: false,
    is_legacy_history: false,
    reviewable: true,
    submitted_at: "2026-04-01T10:00:00Z",
    last_submitted_at: "2026-04-01T10:00:00Z",
};

function renderWithToasts(element) {
    return render(<MemoryRouter><ToastProvider>{element}</ToastProvider></MemoryRouter>);
}

describe("compliance reporting and review interface", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.listFunds.mockResolvedValue([{ fund_id: "fund-1", fund_name: "Worker Growth" }]);
        mocks.listManagerReports.mockResolvedValue([]);
        mocks.createDraft.mockResolvedValue({ ...report, rba_status: "DRAFT" });
        mocks.updateDraft.mockResolvedValue({ ...report, rba_status: "DRAFT" });
        mocks.submitReport.mockResolvedValue({ report_id: report.report_id, rba_status: "SUBMITTED" });
        mocks.listRegulatorReports.mockResolvedValue([report]);
        mocks.getRegulatorReport.mockResolvedValue({
            report,
            submissions: [{
                submission_id: "submission-1",
                version: 1,
                submitted_by: "manager-1",
                submitted_by_name: "Fund Manager",
                submitted_by_role: "FUND_MANAGER",
                submitted_at: report.last_submitted_at,
                report_content: report.report_content,
            }],
            reviews: [],
        });
        mocks.reviewRegulatorReport.mockResolvedValue({ report_id: report.report_id, rba_status: "REVISION_REQUESTED" });
    });

    afterEach(cleanup);

    it("lets a fund manager create and save an owned draft", async () => {
        renderWithToasts(<ComplianceReportsPanel title="Operational Reports" subtitle="My fund reports" />);
        fireEvent.click(await screen.findByRole("button", { name: "+ Create report" }));
        const dialog = screen.getByRole("dialog", { name: "Create compliance report draft" });
        const modalBody = dialog.querySelector(".modal-body");
        const modalFooter = dialog.querySelector(".modal-footer");
        const footer = within(modalFooter);
        expect(dialog).toHaveClass("compliance-report-editor-modal");
        expect(modalBody).toContainElement(screen.getByLabelText("Executive summary"));
        expect(modalBody).not.toContainElement(screen.getByRole("button", { name: "Save draft" }));
        expect(footer.getByRole("button", { name: "Close" })).toBeInTheDocument();
        expect(footer.getByRole("button", { name: "Save draft" })).toHaveAttribute(
            "form",
            "compliance-report-editor-form"
        );
        expect(footer.getByRole("button", { name: "Submit to regulator" })).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Managed fund"), { target: { value: "fund-1" } });
        fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

        await waitFor(() => expect(mocks.createDraft).toHaveBeenCalledWith(expect.objectContaining({
            fund_id: "fund-1",
            report_type: "RBA",
        })));
        expect(await screen.findByText("Draft saved.")).toBeInTheDocument();
        expect(mocks.reviewRegulatorReport).not.toHaveBeenCalled();
    });

    it("creates a clearly disclosed synthetic demonstration through the normal draft workflow", async () => {
        renderWithToasts(<ComplianceReportsPanel title="Compliance Reports" subtitle="My fund reports" />);
        fireEvent.click(await screen.findByRole("button", { name: "Create synthetic demo report" }));

        expect(screen.getByText(/Synthetic demonstration only — not a genuine regulatory submission/)).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Managed fund"), { target: { value: "fund-1" } });
        expect(screen.getByLabelText("Report type")).toHaveValue("INTERNAL");
        expect(screen.getByLabelText("Report type")).toBeDisabled();
        const categorySelect = screen.getByLabelText("Report category");
        expect(categorySelect).toHaveValue("QUARTERLY_CONTRIBUTION_RECONCILIATION");
        expect(categorySelect).toBeDisabled();
        for (const label of [
            "Quarterly contribution reconciliation",
            "Investment performance",
            "Assets and liabilities",
            "Compliance checklist",
        ]) {
            expect(within(categorySelect).getByRole("option", { name: label })).toBeInTheDocument();
        }
        fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

        await waitFor(() => expect(mocks.createDraft).toHaveBeenCalledTimes(1));
        const payload = mocks.createDraft.mock.calls[0][0];
        expect(payload).toMatchObject({
            fund_id: "fund-1",
            report_type: "INTERNAL",
            report_content: {
                report_category: "QUARTERLY_CONTRIBUTION_RECONCILIATION",
                demo_classification: "SYNTHETIC_DEMO",
            },
        });
        for (const key of [
            "executive_summary",
            "financial_summary",
            "risk_and_governance",
            "incidents_and_actions",
            "supporting_information",
        ]) {
            expect(payload.report_content[key]).toMatch(/^SYNTHETIC DEMONSTRATION ONLY - NOT A GENUINE REGULATORY SUBMISSION\./);
        }
    });

    it("labels synthetic demo reports in the manager report register", async () => {
        mocks.listManagerReports.mockResolvedValue([{
            ...report,
            report_category: "QUARTERLY_CONTRIBUTION_RECONCILIATION",
            is_synthetic_demo: true,
        }]);
        renderWithToasts(<ComplianceReportsPanel title="Compliance Reports" subtitle="My fund reports" />);

        expect(await screen.findByText("Synthetic demo — not a genuine regulatory submission")).toBeInTheDocument();
        expect(screen.getByText("Quarterly contribution reconciliation")).toBeInTheDocument();
    });

    it("submits a manager report after saving it", async () => {
        renderWithToasts(<ComplianceReportsPanel title="Operational Reports" subtitle="My fund reports" />);
        fireEvent.click(await screen.findByRole("button", { name: "+ Create report" }));
        fireEvent.change(screen.getByLabelText("Managed fund"), { target: { value: "fund-1" } });
        fireEvent.change(screen.getByLabelText("Period start"), { target: { value: "2026-01-01" } });
        fireEvent.change(screen.getByLabelText("Period end"), { target: { value: "2026-03-31" } });
        for (const [label, value] of [
            ["Executive summary", report.report_content.executive_summary],
            ["Financial summary", report.report_content.financial_summary],
            ["Risk management and governance", report.report_content.risk_and_governance],
            ["Incidents and corrective actions", report.report_content.incidents_and_actions],
            ["Supporting information", report.report_content.supporting_information],
        ]) {
            fireEvent.change(screen.getByLabelText(label), { target: { value } });
        }
        fireEvent.click(screen.getByRole("button", { name: "Submit to regulator" }));

        await waitFor(() => expect(mocks.submitReport).toHaveBeenCalledWith(report.report_id));
        expect(mocks.createDraft).toHaveBeenCalledWith(expect.objectContaining({
            fund_id: "fund-1",
            period_start: "2026-01-01",
            report_content: {
                ...report.report_content,
                report_category: "GENERAL_COMPLIANCE",
            },
        }));
    });

    it("prevents duplicate draft creation when submit is clicked rapidly", async () => {
        let finishCreate;
        mocks.createDraft.mockImplementation(() => new Promise((resolve) => {
            finishCreate = resolve;
        }));
        renderWithToasts(<ComplianceReportsPanel title="Operational Reports" subtitle="My fund reports" />);
        fireEvent.click(await screen.findByRole("button", { name: "+ Create report" }));
        fireEvent.change(screen.getByLabelText("Managed fund"), { target: { value: "fund-1" } });

        const submitButton = screen.getByRole("button", { name: "Submit to regulator" });
        fireEvent.click(submitButton);
        fireEvent.click(submitButton);
        expect(mocks.createDraft).toHaveBeenCalledTimes(1);

        finishCreate({ ...report, rba_status: "DRAFT" });
        await waitFor(() => expect(mocks.submitReport).toHaveBeenCalledTimes(1));
    });

    it("retries submission against the same draft after a transient submit failure", async () => {
        mocks.submitReport
            .mockRejectedValueOnce(new Error("Temporary request failure"))
            .mockResolvedValueOnce({ report_id: report.report_id, rba_status: "SUBMITTED" });
        renderWithToasts(<ComplianceReportsPanel title="Operational Reports" subtitle="My fund reports" />);
        fireEvent.click(await screen.findByRole("button", { name: "+ Create report" }));
        fireEvent.change(screen.getByLabelText("Managed fund"), { target: { value: "fund-1" } });

        fireEvent.click(screen.getByRole("button", { name: "Submit to regulator" }));
        expect(await screen.findByText(/Existing report ID:/)).toBeInTheDocument();
        expect(await screen.findByText("Temporary request failure")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Submit to regulator" }));

        await waitFor(() => expect(mocks.createDraft).toHaveBeenCalledTimes(1));
        expect(mocks.updateDraft).toHaveBeenCalledTimes(1);
        expect(mocks.updateDraft).toHaveBeenCalledWith(report.report_id, expect.any(Object));
        expect(mocks.submitReport).toHaveBeenCalledTimes(2);
    });

    it("shows unassigned legacy records as read-only history, not editable drafts", async () => {
        mocks.listManagerReports.mockResolvedValue([{
            ...report,
            report_id: "legacy-report",
            fund_id: null,
            fund_name: null,
            is_legacy: true,
            rba_status: "DRAFT",
        }]);
        renderWithToasts(<ComplianceReportsPanel title="Operational Reports" subtitle="My fund reports" />);

        expect(await screen.findByText("Legacy historical")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Edit draft" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Revise report" })).not.toBeInTheDocument();
    });

    it("allows a returned report to be edited and resubmitted without creating another report", async () => {
        mocks.listManagerReports.mockResolvedValue([{ ...report, rba_status: "REVISION_REQUESTED" }]);
        mocks.getManagerReport.mockResolvedValue({
            report: { ...report, rba_status: "REVISION_REQUESTED" },
            submissions: [],
            reviews: [],
        });
        renderWithToasts(<ComplianceReportsPanel title="Operational Reports" subtitle="My fund reports" />);
        fireEvent.click(await screen.findByRole("button", { name: "Revise report" }));
        expect(await screen.findByText(/Existing report ID:/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Submit to regulator" }));

        await waitFor(() => expect(mocks.updateDraft).toHaveBeenCalledWith(report.report_id, expect.any(Object)));
        expect(mocks.createDraft).not.toHaveBeenCalled();
        expect(mocks.submitReport).toHaveBeenCalledWith(report.report_id);
    });

    it("renders stored submission and review actor snapshots in manager history", async () => {
        mocks.listManagerReports.mockResolvedValue([report]);
        mocks.getManagerReport.mockResolvedValue({
            report,
            submissions: [{
                submission_id: "submission-1",
                version: 1,
                submitted_by: "manager-1",
                submitted_by_name: "Manager One",
                submitted_by_role: "FUND_MANAGER",
                submitted_at: "2026-04-01T10:00:00Z",
                report_content: report.report_content,
            }],
            reviews: [{
                review_id: "review-1",
                version: 1,
                reviewed_by: "regulator-1",
                reviewer_name: "Regulator One",
                reviewer_role: "REGULATOR",
                decision: "REVISION_REQUESTED",
                reason: "Please clarify the reported risk controls.",
                created_at: "2026-04-02T10:00:00Z",
            }],
        });
        renderWithToasts(<ComplianceReportsPanel title="Operational Reports" subtitle="My fund reports" />);
        fireEvent.click(await screen.findByRole("button", { name: "View history" }));

        expect(await screen.findByText(/Submitted by: Manager One \(FUND_MANAGER\) · ID: manager-1/)).toBeInTheDocument();
        expect(screen.getByText(/Reviewed by: Regulator One \(REGULATOR\) · ID: regulator-1/)).toBeInTheDocument();
    });

    it("provides regulator filters and reasoned revision requests without a report-creation action", async () => {
        renderWithToasts(<ComplianceReview />);
        expect(await screen.findByRole("heading", { name: "Recent Compliance Reports" })).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Submitted Reports Awaiting Review" })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Generate system reports and exports" }))
            .toHaveAttribute("href", "/regulator/reports");
        expect(screen.queryByRole("button", { name: /create report/i })).not.toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Fund"), { target: { value: "fund-1" } });
        fireEvent.change(screen.getByLabelText("Report type"), { target: { value: "RBA" } });
        fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
        await waitFor(() => expect(mocks.listRegulatorReports).toHaveBeenLastCalledWith({
            fund_id: "fund-1",
            report_type: "RBA",
        }));

        const reviewQueue = screen.getByRole("region", { name: "Submitted Reports Awaiting Review" });
        fireEvent.click(within(reviewQueue).getByRole("button", { name: "Open report" }));
        expect(await screen.findByText("Current report content")).toBeInTheDocument();
        expect(screen.getAllByText(report.report_content.executive_summary)).toHaveLength(2);
        fireEvent.click(screen.getByRole("button", { name: "Request revisions" }));
        fireEvent.change(screen.getByLabelText("Revision request (required)"), {
            target: { value: "Please add detail on the risk review." },
        });
        fireEvent.click(screen.getByRole("button", { name: "Record decision" }));

        await waitFor(() => expect(mocks.reviewRegulatorReport).toHaveBeenCalledWith("report-1", {
            submission_id: "submission-1",
            decision: "REVISION_REQUESTED",
            reason: "Please add detail on the risk review.",
        }));
    });

    it("labels synthetic demos in the regulator register and report details", async () => {
        const syntheticContent = {
            ...report.report_content,
            report_category: "QUARTERLY_CONTRIBUTION_RECONCILIATION",
            demo_classification: "SYNTHETIC_DEMO",
        };
        const syntheticReport = {
            ...report,
            report_type: "INTERNAL",
            report_category: "QUARTERLY_CONTRIBUTION_RECONCILIATION",
            is_synthetic_demo: true,
            report_content: syntheticContent,
        };
        mocks.listRegulatorReports.mockResolvedValue([syntheticReport]);
        mocks.getRegulatorReport.mockResolvedValue({
            report: syntheticReport,
            submissions: [{
                submission_id: "submission-1",
                version: 1,
                submitted_by: "manager-1",
                submitted_by_name: "Fund Manager",
                submitted_by_role: "FUND_MANAGER",
                submitted_at: report.last_submitted_at,
                report_content: syntheticContent,
            }],
            reviews: [],
        });
        renderWithToasts(<ComplianceReview />);

        expect(await screen.findAllByText("Synthetic demo — not a genuine regulatory submission")).toHaveLength(2);
        expect(screen.getAllByText("Quarterly contribution reconciliation")).toHaveLength(2);
        const reviewQueue = screen.getByRole("region", { name: "Submitted Reports Awaiting Review" });
        fireEvent.click(within(reviewQueue).getByRole("button", { name: "Open report" }));
        expect(await screen.findByText(/Review this record only as a workflow demonstration/)).toBeInTheDocument();
        expect(screen.getAllByText("Report category:")).toHaveLength(2);
    });

    it("shows loading and retryable errors while opening report details", async () => {
        let rejectDetails;
        mocks.getRegulatorReport.mockImplementation(() => new Promise((resolve, reject) => {
            rejectDetails = reject;
        }));
        renderWithToasts(<ComplianceReview />);
        const reviewQueue = await screen.findByRole("region", { name: "Submitted Reports Awaiting Review" });
        fireEvent.click(within(reviewQueue).getByRole("button", { name: "Open report" }));

        expect(screen.getByText("Loading report details...")).toBeInTheDocument();
        await act(async () => rejectDetails(new Error("Report details unavailable")));
        expect(await screen.findByText("Report details unavailable")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    });

    it("shows legacy regulator records as historical and hides review decisions", async () => {
        mocks.listRegulatorReports.mockResolvedValue([{
            ...report,
            is_legacy_history: true,
            is_legacy: true,
            reviewable: false,
        }]);
        mocks.getRegulatorReport.mockResolvedValue({
            report: {
                ...report,
                rba_status: "DRAFT",
                is_legacy: true,
                is_legacy_history: true,
                reviewable: false,
            },
            submissions: [],
            reviews: [],
        });
        renderWithToasts(<ComplianceReview />);
        fireEvent.click(await screen.findByRole("button", { name: "View history" }));

        expect(await screen.findByText(/Legacy historical record — read-only/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "Record review decision" })).not.toBeInTheDocument();
    });

    it("marks final regulator decisions read-only and separates them from current status", async () => {
        mocks.listRegulatorReports.mockResolvedValue([{ ...report, rba_status: "ACCEPTED" }]);
        mocks.getRegulatorReport.mockResolvedValue({
            report: { ...report, rba_status: "ACCEPTED", reviewable: true },
            submissions: [{
                submission_id: "submission-1",
                version: 1,
                submitted_by: "manager-1",
                submitted_by_name: "Manager One",
                submitted_by_role: "FUND_MANAGER",
                submitted_at: "2026-04-01T10:00:00Z",
                report_content: report.report_content,
            }],
            reviews: [{
                review_id: "review-1",
                version: 1,
                reviewed_by: "regulator-1",
                reviewer_name: "Regulator One",
                reviewer_role: "REGULATOR",
                decision: "ACCEPTED",
                reason: null,
                created_at: "2026-04-02T10:00:00Z",
            }],
        });
        renderWithToasts(<ComplianceReview />);
        fireEvent.click(await screen.findByRole("button", { name: "Open report" }));

        expect(await screen.findByText("Final decision recorded. This report is read-only.")).toBeInTheDocument();
        expect(screen.getByText("Current status:")).toBeInTheDocument();
        expect(screen.getByText("Decision on submission 1: ACCEPTED")).toBeInTheDocument();
        expect(screen.getByText(/Submitted by: Manager One \(FUND_MANAGER\) · ID: manager-1/)).toBeInTheDocument();
        expect(screen.getByText(/Reviewed by: Regulator One \(REGULATOR\) · ID: regulator-1/)).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "Record review decision" })).not.toBeInTheDocument();
    });
});
