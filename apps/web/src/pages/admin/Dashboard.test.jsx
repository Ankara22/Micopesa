import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminDashboard from "./Dashboard";

const serviceMocks = vi.hoisted(() => ({
    getActivitySummary: vi.fn(),
    getSystemLogs: vi.fn(),
    useAuth: vi.fn(),
}));

vi.mock("../../services/adminService", () => ({
    getActivitySummary: serviceMocks.getActivitySummary,
}));
vi.mock("../../services/auditLogService", () => ({
    getSystemLogs: serviceMocks.getSystemLogs,
}));
vi.mock("../../context/AuthContext", () => ({
    useAuth: serviceMocks.useAuth,
}));

function renderDashboard() {
    return render(
        <MemoryRouter>
            <AdminDashboard />
        </MemoryRouter>,
    );
}

describe("AdminDashboard", () => {
    afterEach(cleanup);

    beforeEach(() => {
        vi.clearAllMocks();
        serviceMocks.useAuth.mockReturnValue({ user: { full_name: "Njeri Admin" } });
        serviceMocks.getActivitySummary.mockResolvedValue({
            active_sessions: 3,
            users_by_status: [
                { account_status: "ACTIVE", count: 12 },
                { account_status: "INACTIVE", count: 2 },
                { account_status: "SUSPENDED", count: 1 },
            ],
            audit_actions_last_24h: [
                { action_type: "LOGIN", count: 4 },
                { action_type: "UPDATE_USER_STATUS", count: 2 },
            ],
        });
        serviceMocks.getSystemLogs.mockResolvedValue([
            {
                log_id: "audit-1",
                action_type: "UPDATE_USER_STATUS",
                full_name: "Njeri Admin",
                entity_name: "users",
                timestamp: "2026-10-21T20:00:00.000Z",
            },
        ]);
    });

    it("keeps the authenticated admin identity visible while summary and audit data load", () => {
        serviceMocks.getActivitySummary.mockReturnValue(new Promise(() => {}));
        serviceMocks.getSystemLogs.mockReturnValue(new Promise(() => {}));
        renderDashboard();

        expect(screen.getByRole("heading", { name: "Welcome, Njeri" })).toBeInTheDocument();
        expect(screen.getByRole("status", { name: "Loading platform summary" })).toBeInTheDocument();
        expect(screen.getByText("Loading recent audit activity...")).toBeInTheDocument();
    });

    it("renders summary metrics, status counts, recent audit records, and existing admin navigation", async () => {
        renderDashboard();

        expect(await screen.findByRole("heading", { name: "Welcome, Njeri" })).toBeInTheDocument();
        expect(screen.getByText("Total users")).toBeInTheDocument();
        expect(screen.getByText("Total users").parentElement).toHaveTextContent("15");
        expect(screen.getByText("Active users").parentElement).toHaveTextContent("12");
        expect(screen.getByText("Active USSD sessions").parentElement).toHaveTextContent("3");
        expect(screen.getByText("Audit actions (24 hours)").parentElement).toHaveTextContent("6");
        expect(screen.getByRole("heading", { name: "Users by status" })).toBeInTheDocument();
        expect(screen.getByText("INACTIVE").parentElement).toHaveTextContent("2");
        expect(screen.getByText("SUSPENDED").parentElement).toHaveTextContent("1");
        expect(screen.getByText("UPDATE_USER_STATUS")).toBeInTheDocument();
        expect(screen.getByText("Njeri Admin · users")).toBeInTheDocument();

        expect(screen.getByRole("link", { name: /User Management/ })).toHaveAttribute("href", "/admin/users");
        expect(screen.getByRole("link", { name: /Roles & Permissions/ })).toHaveAttribute("href", "/admin/roles");
        expect(screen.getByRole("link", { name: /Audit Logs/ })).toHaveAttribute("href", "/admin/audit-logs");
        expect(screen.getByRole("link", { name: /System Activity/ })).toHaveAttribute("href", "/admin/activity");
        expect(screen.getByRole("link", { name: /Notifications/ })).toHaveAttribute("href", "/admin/notifications");
        expect(screen.getByRole("link", { name: /System Settings/ })).toHaveAttribute("href", "/admin/settings");
    });

    it("shows explicit empty states for successful but empty API responses", async () => {
        serviceMocks.getActivitySummary.mockResolvedValue({
            active_sessions: 0,
            users_by_status: [],
            audit_actions_last_24h: [],
        });
        serviceMocks.getSystemLogs.mockResolvedValue([]);
        renderDashboard();

        expect(await screen.findByText("No user account statuses are available.")).toBeInTheDocument();
        expect(screen.getByText("No system audit activity has been recorded.")).toBeInTheDocument();
        expect(screen.getByText("Active USSD sessions")).toBeInTheDocument();
        expect(screen.getByText("Audit actions (24 hours)")).toBeInTheDocument();
    });

    it("surfaces summary and audit API failures with retry actions", async () => {
        serviceMocks.getActivitySummary.mockRejectedValue(new Error("Summary unavailable"));
        serviceMocks.getSystemLogs.mockRejectedValue(new Error("Audit feed unavailable"));
        renderDashboard();

        expect(await screen.findByText("Summary unavailable")).toBeInTheDocument();
        expect(await screen.findByText("Audit feed unavailable")).toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(2);
    });

    it("does not render unsupported operational or compliance metrics", async () => {
        renderDashboard();

        expect(await screen.findByRole("heading", { name: "Welcome, Njeri" })).toBeInTheDocument();
        expect(screen.queryByText(/uptime|payment gateway|KYC|AML|custodian|webhook|license|yield/i)).not.toBeInTheDocument();
    });
});
