import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import RegulatorDashboard from "./Dashboard";

const mocks = vi.hoisted(() => ({
    getRegulatorDashboard: vi.fn(),
    useAuth: vi.fn(),
}));

vi.mock("../../services/regulatorApi", () => ({
    getRegulatorDashboard: mocks.getRegulatorDashboard,
}));
vi.mock("../../context/AuthContext", () => ({ useAuth: mocks.useAuth }));

function dashboardData() {
    return {
        evaluated_at: "2026-11-17T10:00:00Z",
        scope: { assigned_fund_count: 2, active_assigned_fund_count: 2, has_active_fund_scope: true },
        fund_overview: { total_fund_count: 2, active_fund_count: 2, inactive_fund_count: 0 },
        account_overview: { account_count: 4, active_account_count: 4, worker_count: 4 },
        report_summary: {
            workflow: {
                total_count: 2,
                draft_count: 0,
                submitted_count: 1,
                awaiting_review_count: 1,
                incomplete_submission_count: 0,
                approved_count: 0,
                returned_count: 0,
                rejected_count: 0,
            },
            synthetic_demo: {
                total_count: 1,
                draft_count: 0,
                submitted_count: 1,
                awaiting_review_count: 1,
                incomplete_submission_count: 0,
                approved_count: 0,
                returned_count: 0,
                rejected_count: 0,
            },
            legacy_history_count: 0,
        },
        awaiting_review: {
            count: 1,
            synthetic_demo_count: 1,
            recent: [
                {
                    report_id: "report-1",
                    report_type: "RBA",
                    report_category: "GENERAL_COMPLIANCE",
                    is_synthetic_demo: false,
                    submitted_at: "2026-11-16T10:00:00Z",
                    rba_status: "SUBMITTED",
                },
                {
                    report_id: "report-2",
                    report_type: "INTERNAL",
                    report_category: "QUARTERLY_CONTRIBUTION_RECONCILIATION",
                    is_synthetic_demo: true,
                    submitted_at: "2026-11-16T11:00:00Z",
                    rba_status: "SUBMITTED",
                },
            ],
        },
        recent_compliance_activity: [{
            log_id: "activity-1",
            report_type: "RBA",
            report_category: "GENERAL_COMPLIANCE",
            is_synthetic_demo: false,
            rba_status: "SUBMITTED",
            action_type: "SUBMIT",
            timestamp: "2026-11-16T10:00:00Z",
        }],
        audit_summary: { events_last_24h: 1, last_event_at: "2026-11-16T10:00:00Z" },
        kyc: {
            status_counts: [{ kyc_status: "VERIFIED", count: 2 }],
            recent_review_history: [{
                log_id: "kyc-log-1",
                action_type: "APPROVE",
                kyc_status: "VERIFIED",
                reviewer_role: "ADMIN",
                timestamp: "2026-11-16T09:00:00Z",
            }],
        },
        control_checks: {
            summary: {
                evaluated_count: 3,
                passed_count: 2,
                failed_count: 0,
                attention_required_count: 1,
                unevaluated_count: 0,
                not_configured_count: 2,
            },
            checks: [{
                key: "fund_status",
                name: "Assigned fund configuration",
                observed_value: "ACTIVE: 2",
                status: "PASS",
            }],
        },
    };
}

function renderDashboard() {
    return render(<MemoryRouter><RegulatorDashboard /></MemoryRouter>);
}

describe("RegulatorDashboard", () => {
    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
    });

    beforeEach(async () => {
        vi.clearAllMocks();
        await i18n.changeLanguage("en");
        mocks.useAuth.mockReturnValue({ user: { full_name: "Achieng Regulator" } });
        mocks.getRegulatorDashboard.mockResolvedValue(dashboardData());
    });

    it("shows assigned-scope summaries and links to the detailed oversight pages", async () => {
        renderDashboard();

        expect(await screen.findByRole("heading", { name: "Live oversight summary" })).toBeInTheDocument();
        expect(mocks.getRegulatorDashboard).toHaveBeenCalledTimes(1);
        const overview = screen.getByRole("region", { name: "Scoped system overview" });
        expect(within(overview).getByText("2")).toBeInTheDocument();
        expect(within(overview).getAllByText("4")).toHaveLength(2);

        const reports = screen.getByRole("region", { name: "Compliance report register" });
        expect(within(reports).getByText("RBA")).toBeInTheDocument();
        expect(within(reports).getByText("Synthetic demo — not a genuine regulatory submission")).toBeInTheDocument();
        expect(within(reports).getByText("Synthetic demonstration reports contain fictional information and are not genuine regulatory submissions. Their lifecycle totals are separated below.")).toBeInTheDocument();
        expect(within(reports).getAllByText("drafts")).toHaveLength(2);
        expect(within(reports).getAllByText("returned for revision")).toHaveLength(2);
        expect(within(reports).getByRole("link", { name: "Review compliance reports" }))
            .toHaveAttribute("href", "/regulator/compliance-reports");
        expect(screen.getByRole("heading", { name: "Recent compliance activity" })).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Application-level control checks" })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Open KYC oversight" }))
            .toHaveAttribute("href", "/regulator/kyc-oversight");

        const links = [
            ["Analytics", "/regulator/analytics"],
            ["Fund Oversight", "/regulator/funds"],
            ["Compliance Reports", "/regulator/compliance-reports"],
            ["Regulatory Parameters", "/regulator/regulatory-parameters"],
            ["KYC Oversight", "/regulator/kyc-oversight"],
            ["Operational Audit Logs", "/regulator/audit-logs"],
            ["Regulatory Notifications", "/regulator/notifications"],
            ["Notification Audit Log", "/regulator/notification-audit-log"],
            ["Reports and Exports", "/regulator/reports"],
            ["Report History", "/regulator/report-history"],
        ];
        for (const [label, path] of links) {
            expect(screen.getByRole("link", { name: new RegExp(label) })).toHaveAttribute("href", path);
        }
    });

    it("shows the request failure instead of successful zero values", async () => {
        mocks.getRegulatorDashboard.mockRejectedValue(new Error("Dashboard request failed."));
        renderDashboard();

        expect(await screen.findByRole("alert")).toHaveTextContent("Dashboard request failed.");
        expect(screen.queryByText("0", { exact: true })).not.toBeInTheDocument();
        expect(screen.queryByText("No submitted reports are awaiting review.")).not.toBeInTheDocument();
    });

    it("explains an empty authorized fund scope without rendering zeroed oversight cards", async () => {
        mocks.getRegulatorDashboard.mockResolvedValue({
            ...dashboardData(),
            scope: { assigned_fund_count: 0, active_assigned_fund_count: 0, has_active_fund_scope: false },
        });
        renderDashboard();

        expect(await screen.findByText("No active assigned funds are available for this regulator.")).toBeInTheDocument();
        expect(screen.queryByText("0", { exact: true })).not.toBeInTheDocument();
        expect(screen.queryByRole("table")).not.toBeInTheDocument();
    });

    it("keeps all navigation links available in Kiswahili", async () => {
        renderDashboard();
        await screen.findByRole("heading", { name: "Live oversight summary" });

        await i18n.changeLanguage("sw");

        expect(await screen.findByRole("link", { name: /Vigezo vya Udhibiti/ }))
            .toHaveAttribute("href", "/regulator/regulatory-parameters");
        expect(screen.getByRole("link", { name: /Uangalizi wa KYC/ }))
            .toHaveAttribute("href", "/regulator/kyc-oversight");
        expect(screen.getByRole("link", { name: /Ripoti na Upakuaji/ }))
            .toHaveAttribute("href", "/regulator/reports");
    });
});
