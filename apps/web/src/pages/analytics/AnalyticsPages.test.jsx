import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkerAnalytics from "../worker/Analytics";
import ManagerAnalytics from "../manager/Analytics";
import RegulatorAnalytics from "../regulator/Analytics";
import AdminAnalytics from "../admin/Analytics";
import i18n from "../../i18n";

const mocks = vi.hoisted(() => ({
    getMyContributions: vi.fn(),
    getMyBalance: vi.fn(),
    downloadMyStatement: vi.fn(),
    getReportAnalytics: vi.fn(),
}));

vi.mock("../../services/accountService", () => ({
    getMyContributions: mocks.getMyContributions,
    getMyBalance: mocks.getMyBalance,
    downloadMyStatement: mocks.downloadMyStatement,
}));
vi.mock("../../services/reportsApi", () => ({
    getReportAnalytics: mocks.getReportAnalytics,
}));
vi.mock("recharts", () => ({
    BarChart: ({ data }) => <output data-testid="chart-data">{JSON.stringify(data)}</output>,
    Bar: () => null,
    CartesianGrid: () => null,
    ResponsiveContainer: ({ children }) => <div>{children}</div>,
    Tooltip: () => null,
    XAxis: () => null,
    YAxis: () => null,
}));

function renderPage(Page) {
    return render(<MemoryRouter><Page /></MemoryRouter>);
}

function getChartData() {
    return screen.getAllByTestId("chart-data").map((chart) => JSON.parse(chart.textContent));
}

describe("role analytics pages", () => {
    afterEach(async () => {
        cleanup();
        await i18n.changeLanguage("en");
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getReportAnalytics.mockReset();
        mocks.getReportAnalytics.mockResolvedValue({
            contribution_trends: [
                { period: "2026-03-01", status: "COMPLETED", contribution_count: 2, allocated_amount: "100.00" },
            ],
            fund_comparison: [
                { fund_id: "f1", fund_name: "Growth", status: "COMPLETED", contribution_count: 3, allocated_amount: "50.00" },
            ],
            compliance_trends: [
                { period: "2026-03-01", status: "SUBMITTED", report_count: 2 },
            ],
            compliance_evidence: [{ section: "FINANCIAL_SUMMARY", report_count: 1 }],
            compliance_activity: [{ period: "2026-03-01", action_type: "SUBMIT", event_count: 2 }],
            risk_summary: [{ risk_level: "LOW", fund_count: 1 }],
            notification_outcomes: [
                { channel: "SMS", status: "PROVIDER_ACCEPTED", notification_count: 4 },
                { channel: "EMAIL", status: "DELIVERED", notification_count: 2 },
                { channel: "PUSH", status: "PROVIDER_ACCEPTED", notification_count: 1 },
            ],
            mpesa_statuses: [
                { category: "SETTLEMENT", status: "SETTLED", item_count: 2 },
            ],
            activity: [{ entity_name: "USER", action_type: "LOGIN", event_count: 5 }],
            user_trends: [{ period: "2026-03-01", account_status: "ACTIVE", user_count: 4 }],
            fund_summary: { managed_funds: 2, allocated_workers: 8 },
            fund_performance: [{
                fund_id: "f1",
                fund_name: "Growth",
                settled_contributions: "100.00",
                expected_return: "6.5",
            }],
        });
        mocks.getMyBalance.mockResolvedValue({ current_balance: "180.00" });
        mocks.downloadMyStatement.mockResolvedValue({ data: new Blob() });
        mocks.getMyContributions.mockResolvedValue([
            { contribution_id: "c1", amount: "100.00", contribution_status: "COMPLETED", transaction_status: "COMPLETED", created_at: "2026-03-15T12:00:00Z" },
            { contribution_id: "c2", amount: "40.00", contribution_status: "PENDING", created_at: "2026-03-20T12:00:00Z" },
            { contribution_id: "c3", amount: "80.00", contribution_status: "COMPLETED", transaction_status: "COMPLETED", created_at: "2026-04-02T12:00:00Z" },
        ]);
    });

    it("charts only the worker's own contribution data and applies actual date/status filters", async () => {
        renderPage(WorkerAnalytics);
        expect(await screen.findByRole("heading", { name: "My Analytics" })).toBeInTheDocument();
        await waitFor(() => expect(getChartData()).toHaveLength(2));
        expect(mocks.getMyContributions).toHaveBeenCalledOnce();
        expect(getChartData()[0]).toEqual([
            { month: "Mar 2026", amount: 100 },
            { month: "Apr 2026", amount: 80 },
        ]);
        expect(getChartData()[1]).toEqual([
            { label: "Completed", count: 2 },
            { label: "Pending", count: 1 },
        ]);

        fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-04-01" } });
        await waitFor(() => expect(getChartData()[0]).toEqual([{ month: "Apr 2026", amount: 80 }]));
        fireEvent.change(screen.getByLabelText("Contribution status"), { target: { value: "PENDING" } });
        expect(await screen.findByText("No personal contributions match these filters.")).toBeInTheDocument();
    });

    it("shows loading, empty and retryable error states for personal contribution records", async () => {
        mocks.getMyContributions.mockReturnValueOnce(new Promise(() => {}));
        const { unmount } = renderPage(WorkerAnalytics);
        expect(screen.getByRole("status", { name: "Loading your analytics" })).toBeInTheDocument();
        unmount();

        mocks.getMyContributions.mockResolvedValueOnce([]);
        const emptyRender = renderPage(WorkerAnalytics);
        expect(await screen.findByText("No personal contribution records are available yet.")).toBeInTheDocument();
        emptyRender.unmount();

        mocks.getMyContributions
            .mockRejectedValueOnce(new Error("Personal records unavailable"))
            .mockResolvedValueOnce([]);
        renderPage(WorkerAnalytics);
        const alert = (await screen.findByText("Unable to load your analytics right now. Please try again.")).closest('[role="alert"]');
        expect(alert).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() => expect(mocks.getMyContributions).toHaveBeenCalledTimes(4));
        expect(await screen.findByText("No personal contribution records are available yet.")).toBeInTheDocument();
        expect(alert).not.toBeInTheDocument();
    });

    it("preserves worker filters and route while switching languages and sends those filters with statement downloads", async () => {
        mocks.downloadMyStatement.mockRejectedValueOnce(new Error("download unavailable"));
        renderPage(WorkerAnalytics);
        await screen.findByRole("heading", { name: "My Analytics" });

        const fromDate = screen.getByLabelText("From date");
        const status = screen.getByLabelText("Contribution status");
        await screen.findByRole("option", { name: "Pending" });
        fireEvent.change(fromDate, { target: { value: "2026-03-01" } });
        fireEvent.change(status, { target: { value: "PENDING" } });
        fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));

        await screen.findByText("Unable to download your filtered statement. Please try again.");
        expect(mocks.downloadMyStatement).toHaveBeenCalledWith("CSV", {
            start_date: "2026-03-01",
            contribution_status: "PENDING",
        });

        await i18n.changeLanguage("sw");
        expect(await screen.findByRole("heading", { name: "Uchambuzi Wangu" })).toBeInTheDocument();
        expect(screen.getByLabelText("Kuanzia tarehe")).toHaveValue("2026-03-01");
        expect(screen.getByLabelText("Hali ya mchango")).toHaveValue("PENDING");
        expect(screen.getByRole("link", { name: "Rudi kwenye dashibodi" })).toHaveAttribute("href", "/worker/dashboard");
    });

    it("uses role-scoped contribution and compliance analytics for the regulator", async () => {
        renderPage(RegulatorAnalytics);
        expect(await screen.findByRole("heading", { name: "Regulator Analytics" })).toBeInTheDocument();
        await waitFor(() => expect(getChartData()).toHaveLength(6));
        expect(mocks.getReportAnalytics).toHaveBeenCalledOnce();
        expect(getChartData()[0]).toEqual([{ label: "Growth / Completed", count: 3 }]);
        expect(getChartData()[1]).toEqual([{ label: "Growth / Completed", amount: 50 }]);
        expect(getChartData()[2]).toEqual([{ label: "Mar 2026 / Submitted", count: 2 }]);
        expect(getChartData()[3]).toEqual([{ label: "Financial summary", count: 1 }]);
        expect(getChartData()[4]).toEqual([{ label: "Mar 2026 / Submitted", count: 2 }]);
        expect(getChartData()[5]).toEqual([{ label: "Low", count: 1 }]);
    });

    it("shows empty and retryable errors for regulator analytics", async () => {
        mocks.getReportAnalytics.mockResolvedValueOnce({
            fund_comparison: [],
            compliance_trends: [],
            compliance_evidence: [],
            risk_summary: [],
        });
        const emptyRender = renderPage(RegulatorAnalytics);
        await emptyRender.findByText("No contribution records are available for active assigned funds.");
        emptyRender.unmount();

        mocks.getReportAnalytics
            .mockRejectedValueOnce(new Error("Authorized funds unavailable"))
            .mockResolvedValueOnce({ fund_comparison: [], compliance_trends: [], compliance_evidence: [] });
        renderPage(RegulatorAnalytics);
        await screen.findByText("Unable to load authorized fund analytics right now. Please try again.");
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByText("No contribution records are available for active assigned funds.")).toBeInTheDocument();
        expect(mocks.getReportAnalytics).toHaveBeenCalledTimes(3);
    });

    it("charts actual administrator notification, payment, and audit aggregates", async () => {
        renderPage(AdminAnalytics);
        expect(await screen.findByRole("heading", { name: "Administrator Analytics" })).toBeInTheDocument();
        await waitFor(() => expect(getChartData()).toHaveLength(5));
        expect(mocks.getReportAnalytics).toHaveBeenCalledOnce();
        expect(getChartData()[0]).toEqual([
            { label: "Email", value: 2 },
            { label: "Browser push", value: 1 },
            { label: "SMS", value: 4 },
        ]);
        expect(getChartData()[1]).toEqual([
            { label: "SMS / Accepted by provider", count: 4 },
            { label: "Email / Delivered", count: 2 },
            { label: "Browser push / Accepted by provider", count: 1 },
        ]);
        expect(getChartData()[2]).toEqual([{ label: "Settlement / Settled after verification", count: 2 }]);
        expect(getChartData()[3]).toEqual([{ label: "User / Signed in", count: 5 }]);
        expect(getChartData()[4]).toEqual([{ label: "Mar 2026 / Active", count: 4 }]);
        expect(screen.getByText(/Provider acceptance does not confirm delivery/)).toBeInTheDocument();

        await i18n.changeLanguage("sw");
        expect(await screen.findByRole("heading", { name: "Uchambuzi wa Msimamizi" })).toBeInTheDocument();
        expect(screen.getByText("Mgawanyo wa arifa kulingana na njia")).toBeInTheDocument();
        expect(screen.getByText(/Kukubaliwa na mtoa huduma hakuthibitishi uwasilishaji/)).toBeInTheDocument();
    });

    it("renders manager aggregates from the role-scoped analytics endpoint", async () => {
        renderPage(ManagerAnalytics);
        await waitFor(() => expect(getChartData()).toHaveLength(5));
        expect(mocks.getReportAnalytics).toHaveBeenCalledOnce();
        expect(getChartData()[0]).toEqual([{ label: "Mar 2026", count: 2, amount: 100 }]);
        expect(getChartData()[1]).toEqual([{ label: "Mar 2026", count: 2, amount: 100 }]);
        expect(getChartData()[2]).toEqual([{ label: "Completed", value: 2 }]);
        expect(getChartData()[3]).toEqual([{ label: "Growth", amount: 100 }]);
        expect(getChartData()[4]).toEqual([{ label: "Growth", value: 6.5 }]);
    });
});
