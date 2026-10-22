import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("../../context/AuthContext", () => ({
    useAuth: mocks.useAuth,
}));
vi.mock("./RegulatorComplianceChart", () => ({
    default: ({ reportStatusData }) => (
        <output data-testid="report-status-chart">{JSON.stringify(reportStatusData)}</output>
    ),
}));

function renderDashboard() {
    return render(
        <MemoryRouter>
            <RegulatorDashboard />
        </MemoryRouter>,
    );
}

describe("RegulatorDashboard", () => {
    afterEach(cleanup);

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.useAuth.mockReturnValue({ user: { full_name: "Achieng Regulator" } });
        mocks.getComplianceOverview.mockResolvedValue({
            audit_health: {
                events_last_24h: 14,
                last_event_at: "2026-10-21T21:45:00.000Z",
            },
            rba_compliance_status: "PENDING_REVIEW",
            rba_reports_by_status: [
                { rba_status: "SUBMITTED", count: 3 },
                { rba_status: "ACCEPTED", count: 2 },
            ],
            latest_rba_report: {
                report_id: "rba-latest",
                rba_status: "SUBMITTED",
                period_start: "2026-07-01",
                period_end: "2026-09-30",
                generated_at: "2026-10-20T09:00:00.000Z",
            },
            rba_parameter_checks: {
                status: "NOT_CONFIGURED",
                details: "No regulatory parameter configuration is available.",
            },
        });
        mocks.getComplianceReports.mockResolvedValue([
            {
                report_id: "report-1",
                report_type: "RBA",
                period_start: "2026-07-01",
                period_end: "2026-09-30",
                rba_status: "SUBMITTED",
                generated_at: "2026-10-20T09:00:00.000Z",
            },
        ]);
        mocks.getOperationalLogs.mockResolvedValue([
            {
                log_id: "log-1",
                action_type: "GENERATE_REPORT",
                full_name: "Manager Name",
                entity_name: "COMPLIANCE_REPORTS",
                timestamp: "2026-10-21T21:45:00.000Z",
            },
        ]);
        mocks.listFunds.mockResolvedValue([
            {
                fund_id: "fund-1",
                fund_name: "Growth Fund",
                fund_status: "ACTIVE",
                risk_level: "MEDIUM",
                expected_return: "8.25",
            },
        ]);
        mocks.getFundAllocations.mockResolvedValue([
            { allocation_id: "allocation-1", percentage: "60", effective_from: "2026-01-01" },
            { allocation_id: "allocation-2", percentage: "40", effective_from: "2026-03-01" },
        ]);
    });

    it("shows the authenticated regulator identity during loading", () => {
        mocks.getComplianceOverview.mockReturnValue(new Promise(() => {}));
        renderDashboard();

        expect(screen.getByRole("heading", { name: "Welcome, Achieng" })).toBeInTheDocument();
        expect(screen.getByRole("status", { name: "Loading compliance overview" })).toBeInTheDocument();
    });

    it("renders supported report counts, recorded statuses, audit activity, and fund oversight details", async () => {
        renderDashboard();

        expect(await screen.findByRole("heading", { name: "Welcome, Achieng" })).toBeInTheDocument();
        expect(screen.getByText("Audit events (24 hours)").parentElement).toHaveTextContent("14");
        expect(screen.getByText("Recorded RBA reports").parentElement).toHaveTextContent("5");
        expect(screen.getAllByText("NOT_CONFIGURED")).toHaveLength(2);
        expect(screen.getAllByText("No regulatory parameter configuration is available.")).toHaveLength(2);
        expect(await screen.findByTestId("report-status-chart")).toHaveTextContent(
            JSON.stringify([
                { status: "SUBMITTED", reports: 3 },
                { status: "ACCEPTED", reports: 2 },
            ]),
        );
        expect(screen.getByText("Recent compliance reports")).toBeInTheDocument();
        expect(screen.getByText("SUBMITTED")).toBeInTheDocument();
        expect(screen.getByText(/does not establish external filing or acceptance/i)).toBeInTheDocument();
        expect(screen.getByText("GENERATE_REPORT")).toBeInTheDocument();
        expect(screen.getByText("Manager Name · COMPLIANCE_REPORTS")).toBeInTheDocument();
        expect(screen.getByText("Growth Fund")).toBeInTheDocument();
        expect(screen.getByText("ACTIVE")).toBeInTheDocument();
        expect(screen.getByText(/MEDIUM · 2 allocation records · Configured expected return 8\.25%/))
            .toBeInTheDocument();
    });

    it("shows empty states for empty report, audit, and fund responses", async () => {
        mocks.getComplianceOverview.mockResolvedValue({
            audit_health: { events_last_24h: 0, last_event_at: null },
            rba_reports_by_status: [],
            latest_rba_report: null,
            rba_parameter_checks: { status: "NOT_CONFIGURED", details: "No checks configured." },
        });
        mocks.getComplianceReports.mockResolvedValue([]);
        mocks.getOperationalLogs.mockResolvedValue([]);
        mocks.listFunds.mockResolvedValue([]);
        renderDashboard();

        expect(await screen.findByText("No compliance reports are available in the report register.")).toBeInTheDocument();
        expect(screen.getByText("No operational audit events are available.")).toBeInTheDocument();
        expect(screen.getByText("No fund records are available.")).toBeInTheDocument();
        expect(await screen.findByTestId("report-status-chart")).toHaveTextContent("[]");
    });

    it("surfaces failures for each data source rather than showing empty or passing values", async () => {
        mocks.getComplianceOverview.mockRejectedValue(new Error("Compliance overview unavailable"));
        mocks.getComplianceReports.mockRejectedValue(new Error("Report register unavailable"));
        mocks.getOperationalLogs.mockRejectedValue(new Error("Audit feed unavailable"));
        mocks.listFunds.mockRejectedValue(new Error("Fund records unavailable"));
        renderDashboard();

        expect(await screen.findAllByText("Compliance overview unavailable")).toHaveLength(2);
        expect(screen.getByText("Report register unavailable")).toBeInTheDocument();
        expect(screen.getByText("Audit feed unavailable")).toBeInTheDocument();
        expect(screen.getByText("Fund records unavailable")).toBeInTheDocument();
        expect(screen.queryByText("COMPLIANT")).not.toBeInTheDocument();
    });

    it("links only to the existing regulator oversight pages", async () => {
        renderDashboard();

        expect(await screen.findByRole("link", { name: /Compliance Reports/ })).toHaveAttribute(
            "href",
            "/regulator/compliance-reports",
        );
        expect(screen.getByRole("link", { name: /Fund Oversight/ })).toHaveAttribute("href", "/regulator/funds");
        expect(screen.getByRole("link", { name: /Audit Logs/ })).toHaveAttribute("href", "/regulator/audit-logs");
        expect(screen.getByRole("link", { name: /Profile/ })).toHaveAttribute("href", "/regulator/profile");
        expect(screen.queryByRole("link", { name: /Admin|Manager|Worker/i })).not.toBeInTheDocument();
    });

    it("omits unsupported regulatory and compliance claims", async () => {
        renderDashboard();

        expect(await screen.findByText("Growth Fund")).toBeInTheDocument();
        expect(screen.queryByText(/solvency|adequacy ratio|governance score|KYC|AML|filing deadline|immutable|cryptographic|license|real-time/i))
            .not.toBeInTheDocument();
    });
});
