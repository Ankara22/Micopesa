import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import RegulatorDashboard from "./Dashboard";

const mocks = vi.hoisted(() => ({
    getComplianceOverview: vi.fn(),
    getComplianceReports: vi.fn(),
    getOperationalLogs: vi.fn(),
    listFunds: vi.fn(),
    getFundAllocations: vi.fn(),
    useAuth: vi.fn(),
}));

vi.mock("../../services/regulatorApi", () => ({
    getComplianceOverview: mocks.getComplianceOverview,
    getComplianceReports: mocks.getComplianceReports,
}));
vi.mock("../../services/auditLogService", () => ({
    getOperationalLogs: mocks.getOperationalLogs,
}));
vi.mock("../../services/fundService", () => ({
    listFunds: mocks.listFunds,
    getFundAllocations: mocks.getFundAllocations,
}));
vi.mock("../../context/AuthContext", () => ({ useAuth: mocks.useAuth }));
vi.mock("./RegulatorComplianceChart", () => ({
    default: ({ reportStatusData }) => (
        <output data-testid="report-status-chart">{JSON.stringify(reportStatusData)}</output>
    ),
}));

function renderDashboard() {
    return render(<MemoryRouter><RegulatorDashboard /></MemoryRouter>);
}

describe("RegulatorDashboard", () => {
    afterEach(cleanup);

    beforeEach(async () => {
        vi.clearAllMocks();
        await i18n.changeLanguage("en");
        mocks.useAuth.mockReturnValue({ user: { full_name: "Achieng Regulator" } });
        mocks.getComplianceOverview.mockResolvedValue({
            audit_health: { events_last_24h: 14, last_event_at: "2026-04-03T10:00:00Z" },
            rba_reports_by_status: [
                { rba_status: "SUBMITTED", count: 3 },
                { rba_status: "ACCEPTED", count: 2 },
            ],
            latest_rba_report: { rba_status: "SUBMITTED" },
            rba_parameter_checks: { status: "NOT_CONFIGURED", details: "No check configuration is available." },
        });
        mocks.getComplianceReports.mockResolvedValue([
            {
                report_id: "report-1",
                report_type: "RBA",
                period_start: "2026-01-01",
                period_end: "2026-03-31",
                generated_at: "2026-04-01T10:00:00Z",
                fund_name: "Worker Growth",
                manager_name: "Achieng Manager",
                rba_status: "SUBMITTED",
                last_submitted_at: "2026-04-01T10:00:00Z",
            },
            {
                report_id: "report-2",
                report_type: "NSSF",
                period_start: "2026-01-01",
                period_end: "2026-03-31",
                generated_at: "2026-04-02T10:00:00Z",
                fund_name: "Community Growth",
                manager_name: "Kamau Manager",
                rba_status: "ACCEPTED",
                last_submitted_at: "2026-04-02T10:00:00Z",
            },
            {
                report_id: "report-3",
                report_type: "INTERNAL",
                period_start: "2026-01-01",
                period_end: "2026-03-31",
                generated_at: "2026-04-03T10:00:00Z",
                rba_status: "DRAFT",
            },
        ]);
        mocks.getOperationalLogs.mockResolvedValue([{
            log_id: "log-1",
            action_type: "GENERATE_REPORT",
            full_name: "Manager Name",
            entity_name: "COMPLIANCE_REPORTS",
            timestamp: "2026-04-03T10:00:00Z",
        }]);
        mocks.listFunds.mockResolvedValue([{
            fund_id: "fund-1",
            fund_name: "Growth Fund",
            fund_status: "ACTIVE",
            risk_level: "MEDIUM",
            expected_return: "8.25",
        }]);
        mocks.getFundAllocations.mockResolvedValue([
            { allocation_id: "allocation-1", percentage: "60", effective_from: "2026-01-01" },
            { allocation_id: "allocation-2", percentage: "40", effective_from: "2026-03-01" },
        ]);
    });

    it("shows submitted report status, manager and date, and links to read-only detail pages", async () => {
        renderDashboard();

        expect(await screen.findByRole("heading", { name: "Welcome, Achieng" })).toBeInTheDocument();
        expect(screen.getByText("Audit events (24 hours)").parentElement).toHaveTextContent("14");
        expect(screen.getByText("Recorded RBA reports").parentElement).toHaveTextContent("5");
        expect(await screen.findByTestId("report-status-chart")).toHaveTextContent(
            JSON.stringify([
                { status: "SUBMITTED", reports: 3 },
                { status: "ACCEPTED", reports: 2 },
            ]),
        );
        expect(screen.getByText("Recent compliance reports")).toBeInTheDocument();
        expect(screen.getByText("Recent audit activity")).toBeInTheDocument();
        expect(screen.getByText("GENERATE_REPORT")).toBeInTheDocument();
        expect(screen.getByText("Manager Name · COMPLIANCE_REPORTS")).toBeInTheDocument();
        expect(screen.getByText("Fund oversight")).toBeInTheDocument();
        expect(screen.getByText("Growth Fund")).toBeInTheDocument();
        expect(screen.getByText(/MEDIUM · 2 allocation records · Configured expected return 8\.25%/))
            .toBeInTheDocument();
        expect(await screen.findByRole("heading", { name: "Submitted reports awaiting review" })).toBeInTheDocument();
        const reportRow = screen.getByRole("row", { name: /Worker Growth Achieng Manager SUBMITTED/ });
        expect(reportRow).toHaveTextContent("Worker Growth");
        expect(reportRow).toHaveTextContent("Achieng Manager");
        expect(reportRow).toHaveTextContent("SUBMITTED");
        expect(reportRow.textContent).toMatch(/2026/);
        expect(screen.queryByRole("row", { name: /Community Growth/ })).not.toBeInTheDocument();
        expect(screen.queryByRole("row", { name: /report-3/ })).not.toBeInTheDocument();
        expect(screen.getByRole("link", { name: "View all reports" })).toHaveAttribute("href", "/regulator/compliance-reports");
        expect(screen.getByRole("link", { name: /Fund Oversight/ })).toHaveAttribute("href", "/regulator/funds");
        expect(screen.getByRole("link", { name: /Compliance Reports/ })).toHaveAttribute("href", "/regulator/compliance-reports");
        expect(screen.getByRole("link", { name: /Audit Logs/ })).toHaveAttribute("href", "/regulator/audit-logs");
        expect(screen.getAllByRole("table")).toHaveLength(2);
        expect(screen.queryByRole("img", { name: /report/i })).not.toBeInTheDocument();
    });

    it("displays parameter-check state without implying enforcement or approval", async () => {
        renderDashboard();
        expect(await screen.findAllByText("NOT_CONFIGURED")).toHaveLength(2);
        expect(screen.getAllByText("No check configuration is available.")).toHaveLength(2);
        expect(screen.queryByRole("button", { name: /approve|suspend|enforce/i })).not.toBeInTheDocument();
    });

    it("shows loading and retryable compliance errors", async () => {
        mocks.getComplianceOverview.mockRejectedValue(new Error("Compliance overview unavailable"));
        renderDashboard();
        expect(await screen.findAllByText("Compliance overview unavailable")).toHaveLength(2);
        expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(2);
    });

    it("shows a retryable error when submitted reports cannot be loaded", async () => {
        mocks.getComplianceReports.mockRejectedValue(new Error("Submitted reports unavailable"));
        renderDashboard();
        expect(await screen.findAllByText("Submitted reports unavailable")).toHaveLength(2);
        expect(screen.getByText("Unable to load submitted reports")).toBeInTheDocument();
    });

    it("shows an empty state when no submissions await review", async () => {
        mocks.getComplianceOverview.mockResolvedValue({
            audit_health: { events_last_24h: 0 },
            rba_reports_by_status: [],
        });
        mocks.getComplianceReports.mockResolvedValue([]);
        mocks.getOperationalLogs.mockResolvedValue([]);
        mocks.listFunds.mockResolvedValue([]);
        renderDashboard();

        expect(await screen.findByText("No compliance reports are available in the report register.")).toBeInTheDocument();
        expect(screen.getByText("No operational audit events are available.")).toBeInTheDocument();
        expect(screen.getByText("No fund records are available.")).toBeInTheDocument();
        expect(await screen.findByTestId("report-status-chart")).toHaveTextContent("[]");
        expect(await screen.findByText("No submitted reports are awaiting review.")).toBeInTheDocument();
        expect(screen.queryAllByRole("table")).toHaveLength(0);
    });

    it("updates the submitted-report view in Kiswahili without navigating away", async () => {
        renderDashboard();
        expect(await screen.findByRole("heading", { name: "Submitted reports awaiting review" })).toBeInTheDocument();

        await i18n.changeLanguage("sw");

        expect(await screen.findByRole("heading", { name: "Ripoti zilizowasilishwa zinazosubiri kukaguliwa" })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Tazama ripoti zote" })).toHaveAttribute("href", "/regulator/compliance-reports");
    });
});
