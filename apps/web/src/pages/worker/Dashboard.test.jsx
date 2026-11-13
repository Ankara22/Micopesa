import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import WorkerDashboard from "./Dashboard";

const mocks = vi.hoisted(() => ({
    getMyBalance: vi.fn(),
    getMyContributions: vi.fn(),
    getRetirementPlan: vi.fn(),
    useAuth: vi.fn(),
}));

vi.mock("../../services/accountService", () => ({
    getMyBalance: mocks.getMyBalance,
    getMyContributions: mocks.getMyContributions,
}));
vi.mock("../../services/retirementApi", () => ({
    getRetirementPlan: mocks.getRetirementPlan,
}));
vi.mock("../../context/AuthContext", () => ({ useAuth: mocks.useAuth }));

function renderDashboard() {
    return render(<MemoryRouter><WorkerDashboard /></MemoryRouter>);
}

describe("WorkerDashboard", () => {
    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.useAuth.mockReturnValue({
            user: { full_name: "Amina Worker", user_id: "worker-1" },
            loginSessionId: "login-1",
        });
        mocks.getMyBalance.mockResolvedValue({ current_balance: "14850.00", account_status: "ACTIVE" });
        mocks.getMyContributions.mockResolvedValue([
            { contribution_id: "c1", amount: "2500.00", contribution_status: "COMPLETED" },
            { contribution_id: "c2", amount: "900.00", contribution_status: "PENDING" },
        ]);
        mocks.getRetirementPlan.mockResolvedValue({
            plan: { target_amount: "500000.00", target_age: 60, plan_status: "ACTIVE" },
            projection: { projected_amount: "420000.00" },
        });
    });

    it("shows concise summaries from existing account APIs and links to dedicated features", async () => {
        renderDashboard();

        expect(await screen.findByRole("heading", { name: /Good .*Amina/ })).toBeInTheDocument();
        expect(screen.getByText("Verify your registered phone to enable M-Pesa payments."))
            .toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Verify phone" }))
            .toHaveAttribute("href", "/worker/profile");
        expect(screen.getByText("KSh 14,850.00")).toBeInTheDocument();
        expect(screen.getByText("Completed contribution records").parentElement)
            .toHaveTextContent("1");
        expect(screen.getByText("Recorded total KSh 2,500.00")).toBeInTheDocument();
        expect(screen.getByText("Goal KSh 500,000.00")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /My Funds & Allocation/ })).toHaveAttribute("href", "/worker/funds");
        expect(screen.getByRole("link", { name: /My Analytics/ })).toHaveAttribute("href", "/worker/analytics");
        expect(screen.getByRole("link", { name: /Financial Literacy/ })).toHaveAttribute("href", "/worker/literacy");
        expect(screen.queryByRole("heading", { name: "My Fund Allocation" })).not.toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "Insights for your next step" })).not.toBeInTheDocument();
        expect(screen.queryByText("Retirement plan form")).not.toBeInTheDocument();
        expect(mocks.getMyBalance).toHaveBeenCalledTimes(1);
        expect(mocks.getMyContributions).toHaveBeenCalledTimes(1);
    });

    it("hides the verification prompt when the registered phone is verified", async () => {
        mocks.useAuth.mockReturnValue({
            user: { full_name: "Amina Worker", user_id: "worker-1", phone_verified: true },
            loginSessionId: "login-1",
        });
        renderDashboard();

        expect(await screen.findByRole("heading", { name: /Good .*Amina/ })).toBeInTheDocument();
        expect(screen.queryByText("Verify your registered phone to enable M-Pesa payments."))
            .not.toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Verify phone" })).not.toBeInTheDocument();
    });

    it("shows useful no-record summaries without inventing account data", async () => {
        mocks.getRetirementPlan.mockRejectedValue({
            status: 404,
            message: "No active retirement plan found",
            data: {
                code: "RETIREMENT_PLAN_NOT_FOUND",
                data: { plan: null, projection: null },
            },
        });
        mocks.getMyContributions.mockResolvedValue([]);
        renderDashboard();

        expect(await screen.findByText("Not set")).toBeInTheDocument();
        expect(screen.getByText("Recorded total KSh 0.00")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Create a retirement plan" }))
            .toHaveAttribute("href", "/worker/retirement-plan");
        expect(screen.queryByText(/insights for your next step/i)).not.toBeInTheDocument();
    });

    it("surfaces unrelated retirement-plan 404 responses", async () => {
        mocks.getRetirementPlan.mockRejectedValue({
            status: 404,
            message: "No pension account found",
            data: { code: "PENSION_ACCOUNT_NOT_FOUND" },
        });
        renderDashboard();

        expect(await screen.findByText("Unable to load this information right now. Please try again."))
            .toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Create a retirement plan" })).not.toBeInTheDocument();
    });

    it("surfaces API errors with recovery actions", async () => {
        mocks.getMyBalance.mockRejectedValue(new Error("Balance service unavailable"));
        renderDashboard();

        expect(await screen.findByText("Unable to load this information right now. Please try again.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    });

    it("keeps other summaries visible while an individual widget is still loading", async () => {
        mocks.getMyBalance.mockImplementation(() => new Promise(() => {}));
        renderDashboard();

        expect(await screen.findByText("Recorded total KSh 2,500.00")).toBeInTheDocument();
        expect(screen.getByText("Goal KSh 500,000.00")).toBeInTheDocument();
        expect(screen.getByText("Loading")).toBeInTheDocument();
    });

    it.each([
        ["balance", 403],
        ["contributions", 500],
        ["retirement plan", 500],
    ])("keeps successful summaries visible when the %s widget returns HTTP %i", async (widget, status) => {
        const error = { status, message: "Request failed" };
        if (widget === "balance") mocks.getMyBalance.mockRejectedValue(error);
        if (widget === "contributions") mocks.getMyContributions.mockRejectedValue(error);
        if (widget === "retirement plan") mocks.getRetirementPlan.mockRejectedValue(error);
        renderDashboard();

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Unable to load this information right now. Please try again."
        );
        expect(screen.getAllByRole("alert")).toHaveLength(1);
        if (widget !== "balance") {
            expect(screen.getByText("KSh 14,850.00")).toBeInTheDocument();
        }
        if (widget !== "contributions") {
            expect(screen.getByText("Recorded total KSh 2,500.00")).toBeInTheDocument();
        }
        if (widget !== "retirement plan") {
            expect(screen.getByText("Goal KSh 500,000.00")).toBeInTheDocument();
        }
    });

    it("renders worker dashboard labels in Kiswahili", async () => {
        await i18n.changeLanguage("sw");
        renderDashboard();

        expect(await screen.findByText("Salio la sasa la pensheni")).toBeInTheDocument();
        expect(screen.getByText("Rekodi za michango iliyokamilika")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /Hazina Zangu na Mgao/ })).toHaveAttribute("href", "/worker/funds");
    });
});
