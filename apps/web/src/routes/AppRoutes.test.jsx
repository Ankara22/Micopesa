import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppRoutes from "./AppRoutes";

const mocks = vi.hoisted(() => ({
    useAuth: vi.fn(),
    listAvailableFunds: vi.fn(),
    getMyAllocations: vi.fn(),
    replaceMyAllocations: vi.fn(),
    listFunds: vi.fn(),
    getFundAllocations: vi.fn(),
}));

vi.mock("../context/AuthContext", () => ({ useAuth: mocks.useAuth }));
vi.mock("../services/fundService", () => ({
    listAvailableFunds: mocks.listAvailableFunds,
    getMyAllocations: mocks.getMyAllocations,
    replaceMyAllocations: mocks.replaceMyAllocations,
    listFunds: mocks.listFunds,
    getFundAllocations: mocks.getFundAllocations,
}));

function renderRoute(path, role) {
    mocks.useAuth.mockReturnValue({
        isAuthenticated: true,
        isLoading: false,
        loginSessionId: "session-1",
        user: { role, full_name: "Test User" },
        logout: vi.fn(),
    });
    return render(<MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>);
}

describe("role feature routes", () => {
    afterEach(cleanup);

    it("renders the dedicated worker funds page under worker access", async () => {
        mocks.listAvailableFunds.mockResolvedValue([]);
        mocks.getMyAllocations.mockResolvedValue([]);
        renderRoute("/worker/funds", "WORKER");

        expect(await screen.findByRole("heading", { name: "My Funds & Allocation" })).toBeInTheDocument();
        expect(screen.getByText("No active funds are available for a new allocation distribution.")).toBeInTheDocument();
    });

    it("renders manager analytics on its dedicated manager route", async () => {
        mocks.listFunds.mockResolvedValue([]);
        renderRoute("/manager/analytics", "FUND_MANAGER");

        expect(await screen.findByRole("heading", { name: "Fund Analytics" })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Manage funds" })).toHaveAttribute("href", "/manager/funds");
    });

    it("continues to reject cross-role direct access to manager analytics", async () => {
        renderRoute("/manager/analytics", "WORKER");
        expect(await screen.findByRole("heading", { name: "Access denied" })).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "Fund Analytics" })).not.toBeInTheDocument();
    });
});
