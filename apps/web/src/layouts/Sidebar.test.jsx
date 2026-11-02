import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import Sidebar from "./Sidebar";
import AppLayout from "./AppLayout";
import { ROLE_NAV } from "../routes/roleRoutes";

const authMock = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("../context/AuthContext", () => ({ useAuth: authMock.useAuth }));

const KNOWN_PATHS = new Set([
    "/worker/dashboard", "/worker/contributions", "/worker/balance", "/worker/funds",
    "/worker/retirement-plan", "/worker/retirement-projection", "/worker/withdrawals",
    "/worker/literacy", "/worker/notifications", "/worker/profile",
    "/manager/dashboard", "/manager/funds", "/manager/analytics", "/manager/withdrawal-requests",
    "/manager/reports", "/manager/audit-logs", "/manager/notifications", "/manager/profile",
    "/regulator/dashboard", "/regulator/funds", "/regulator/compliance-reports",
    "/regulator/audit-logs", "/regulator/notifications", "/regulator/profile",
    "/admin/dashboard", "/admin/users", "/admin/roles", "/admin/settings",
    "/admin/notifications", "/admin/activity", "/admin/audit-logs", "/admin/profile",
]);

describe("role-aware sidebar", () => {
    afterEach(cleanup);

    it("renders only the authenticated role's links and each link maps to an application route", () => {
        for (const [role, items] of Object.entries(ROLE_NAV)) {
            cleanup();
            authMock.useAuth.mockReturnValue({ user: { role } });
            render(
                <MemoryRouter initialEntries={[items[0].path]}>
                    <Sidebar open />
                </MemoryRouter>
            );
            const nav = screen.getByRole("navigation", { name: "Main navigation" });
            for (const item of items) {
                expect(within(nav).getByRole("link", { name: item.label })).toHaveAttribute("href", item.path);
                expect(KNOWN_PATHS.has(item.path)).toBe(true);
            }
            const otherRolePaths = Object.entries(ROLE_NAV)
                .filter(([otherRole]) => otherRole !== role)
                .flatMap(([, otherItems]) => otherItems.map((item) => item.path));
            for (const path of otherRolePaths) {
                expect(within(nav).queryByRole("link", { name: items.find((item) => item.path === path)?.label || path }))
                    .not.toBeInTheDocument();
            }
        }
    });

    it("highlights the current route and closes the mobile sidebar after navigation", () => {
        authMock.useAuth.mockReturnValue({
            user: { role: "WORKER", full_name: "Worker" },
            logout: vi.fn(),
        });
        render(
            <MemoryRouter initialEntries={["/worker/dashboard"]}>
                <Routes>
                    <Route element={<AppLayout />}>
                        <Route path="/worker/dashboard" element={<h1>Dashboard content</h1>} />
                        <Route path="/worker/funds" element={<h1>Funds content</h1>} />
                    </Route>
                </Routes>
            </MemoryRouter>
        );

        const toggle = screen.getByRole("button", { name: "Toggle navigation menu" });
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect(document.querySelector(".app-sidebar")).toHaveClass("open");

        const currentDashboardLink = screen.getByRole("link", { name: "Dashboard" });
        expect(currentDashboardLink).toHaveAttribute("aria-current", "page");
        fireEvent.click(screen.getByRole("link", { name: "My Funds & Allocation" }));
        expect(screen.getByRole("heading", { name: "Funds content" })).toBeInTheDocument();
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        expect(document.querySelector(".app-sidebar")).not.toHaveClass("open");
    });
});
