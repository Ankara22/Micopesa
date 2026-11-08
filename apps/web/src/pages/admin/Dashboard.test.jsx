import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminDashboard from "./Dashboard";

const mocks = vi.hoisted(() => ({
    getActivitySummary: vi.fn(),
    useAuth: vi.fn(),
}));

vi.mock("../../services/adminService", () => ({ getActivitySummary: mocks.getActivitySummary }));
vi.mock("../../context/AuthContext", () => ({ useAuth: mocks.useAuth }));

function renderDashboard() {
    return render(<MemoryRouter><AdminDashboard /></MemoryRouter>);
}

describe("AdminDashboard", () => {
    afterEach(cleanup);

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.useAuth.mockReturnValue({ user: { full_name: "Njeri Admin" } });
        mocks.getActivitySummary.mockResolvedValue({
            active_sessions: 3,
            users_by_status: [
                { account_status: "ACTIVE", count: 12 },
                { account_status: "INACTIVE", count: 2 },
                { account_status: "SUSPENDED", count: 1 },
            ],
            audit_actions_last_24h: [{ action_type: "LOGIN", count: 4 }, { action_type: "UPDATE_USER_STATUS", count: 2 }],
        });
    });

    it("shows concise administrative summaries and links to all existing admin pages", async () => {
        renderDashboard();

        expect(await screen.findByRole("heading", { name: "Welcome, Njeri" })).toBeInTheDocument();
        expect(screen.getByText("Total users").parentElement).toHaveTextContent("15");
        expect(screen.getByText("Active users").parentElement).toHaveTextContent("12");
        expect(screen.getByText("Active USSD sessions").parentElement).toHaveTextContent("3");
        expect(screen.getByText("Audit actions (24 hours)").parentElement).toHaveTextContent("6");
        const links = [
            ["Analytics", "/admin/analytics"],
            ["User Management", "/admin/users"],
            ["Roles & Permissions", "/admin/roles"],
            ["System Settings", "/admin/settings"],
            ["Notifications", "/admin/notifications"],
            ["System Activity", "/admin/activity"],
            ["Audit Logs", "/admin/audit-logs"],
            ["Profile", "/admin/profile"],
        ];
        for (const [label, path] of links) {
            expect(screen.getByRole("link", { name: new RegExp(label) })).toHaveAttribute("href", path);
        }
        expect(screen.queryByRole("heading", { name: "Users by status" })).not.toBeInTheDocument();
        expect(screen.queryByText("UPDATE_USER_STATUS")).not.toBeInTheDocument();
    });

    it("shows summary loading and retryable errors without a separate detailed audit feed", async () => {
        mocks.getActivitySummary.mockRejectedValue(new Error("Summary unavailable"));
        renderDashboard();
        expect(await screen.findByText("Unable to load the platform summary right now. Please try again.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
        expect(screen.queryByText("Loading recent audit activity")).not.toBeInTheDocument();
    });
});
