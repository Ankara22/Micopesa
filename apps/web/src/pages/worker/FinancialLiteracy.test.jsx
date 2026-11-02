import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FinancialLiteracy from "./FinancialLiteracy";
import i18n from "../../i18n";

const serviceMocks = vi.hoisted(() => ({
    getMyBalance: vi.fn(),
    getMyContributions: vi.fn(),
    getRetirementPlan: vi.fn(),
    getArticles: vi.fn(),
    useAuth: vi.fn(),
}));

let loginSessionCounter = 100;

vi.mock("../../services/accountService", () => ({
    getMyBalance: serviceMocks.getMyBalance,
    getMyContributions: serviceMocks.getMyContributions,
}));
vi.mock("../../services/retirementApi", () => ({
    getRetirementPlan: serviceMocks.getRetirementPlan,
}));
vi.mock("../../services/literacyService", () => ({
    getArticles: serviceMocks.getArticles,
}));
vi.mock("../../context/AuthContext", () => ({
    useAuth: serviceMocks.useAuth,
}));

const contributions = [
    {
        amount: "2500.00",
        contribution_status: "COMPLETED",
        transaction_status: "COMPLETED",
        created_at: "2026-09-20T09:00:00.000Z",
    },
    {
        amount: "1500.00",
        contribution_status: "COMPLETED",
        transaction_status: "COMPLETED",
        created_at: "2026-10-20T09:00:00.000Z",
    },
];

const articles = [
    { id: "why-save-early", title: "Why Saving Early Matters", summary: "Understand how compounding growth makes small, regular contributions powerful over time.", body: "Even small monthly contributions can grow significantly over decades thanks to compound interest. Starting at 25 instead of 35 can more than double your retirement savings for the same monthly amount." },
    { id: "choosing-a-contribution-channel", title: "Choosing the Right Contribution Channel", summary: "M-Pesa, bank transfer, or USSD - pick what fits your routine.", body: "MicoPesa supports M-Pesa, bank, and USSD contributions. Choose the channel that's easiest for you to use consistently - consistency matters more than the amount." },
    { id: "understanding-fund-risk-levels", title: "Understanding Fund Risk Levels", summary: "LOW, MEDIUM, and HIGH risk funds explained.", body: "Lower-risk funds prioritize capital protection with modest growth. Higher-risk funds aim for larger growth but can fluctuate more. Your ideal mix depends on how many years remain until retirement." },
    { id: "when-can-i-withdraw", title: "When Can I Withdraw My Savings?", summary: "What to know before submitting a withdrawal claim.", body: "Withdrawal claims are reviewed by a Fund Manager before payout. Make sure your account is active and your requested amount does not exceed your current balance to avoid delays." },
];

function renderPage() {
    return render(<FinancialLiteracy />);
}

function getInsightContent() {
    const region = screen.getByRole("region", { name: "Insights for your next step" });
    const grid = region.querySelector(".worker-dashboard-insight-grid");
    return grid?.textContent || "";
}

function getInsightTitles() {
    const region = screen.getByRole("region", { name: "Insights for your next step" });
    return within(region)
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent)
        .filter((title) => title !== "Insights for your next step");
}

afterEach(() => {
    cleanup();
    i18n.changeLanguage("en");
});

describe("FinancialLiteracy page insights", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        serviceMocks.useAuth.mockReturnValue({
            user: { user_id: "worker-literacy-1" },
            loginSessionId: `literacy-session-${loginSessionCounter++}`,
        });
        serviceMocks.getMyBalance.mockResolvedValue({ current_balance: "14850.00" });
        serviceMocks.getMyContributions.mockResolvedValue(contributions);
        serviceMocks.getRetirementPlan.mockResolvedValue({
            plan: { target_amount: "500000.00" },
            projection: { projected_amount: "420000.00" },
        });
        serviceMocks.getArticles.mockResolvedValue(articles);
    });

    it("renders personalized insights as the page's main vertically stacked content", async () => {
        serviceMocks.useAuth.mockReturnValue({
            user: { user_id: "worker-literacy-1" },
            loginSessionId: `literacy-page-${loginSessionCounter++}`,
        });
        renderPage();

        expect(await screen.findByRole("heading", { name: "Insights for your next step" })).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Financial Literacy" })).toBeInTheDocument();
        await waitFor(() => {
            expect(document.querySelector(".financial-literacy-page .worker-dashboard-insight-grid.is-stacked"))
                .toBeInTheDocument();
        });
        expect(screen.queryByText("Saving basics")).not.toBeInTheDocument();
        expect(serviceMocks.getMyBalance).toHaveBeenCalledTimes(1);
        expect(serviceMocks.getMyContributions).toHaveBeenCalledTimes(1);
        expect(serviceMocks.getRetirementPlan).toHaveBeenCalledTimes(1);
    });

    it("selects fresh insights after logout and login as the same worker", async () => {
        serviceMocks.useAuth.mockReturnValue({
            user: { user_id: "worker-literacy-1" },
            loginSessionId: `literacy-before-logout-${loginSessionCounter++}`,
        });
        const { rerender } = renderPage();
        await screen.findByRole("heading", { name: "Insights for your next step" });
        const firstSessionTitles = getInsightTitles();

        serviceMocks.useAuth.mockReturnValue({
            user: null,
            loginSessionId: `literacy-logout-${loginSessionCounter++}`,
        });
        rerender(<FinancialLiteracy />);

        serviceMocks.useAuth.mockReturnValue({
            user: { user_id: "worker-literacy-1" },
            loginSessionId: `literacy-after-login-${loginSessionCounter++}`,
        });
        rerender(<FinancialLiteracy />);

        await waitFor(() => {
            expect(serviceMocks.getMyBalance).toHaveBeenCalledTimes(3);
            expect(serviceMocks.getMyContributions).toHaveBeenCalledTimes(3);
            expect(serviceMocks.getRetirementPlan).toHaveBeenCalledTimes(3);
        });
        await waitFor(() => expect(getInsightTitles()).not.toEqual(firstSessionTitles));
    });

    it("keeps the session selection stable across remounts and refreshed financial data", async () => {
        const sessionKey = "literacy-stability-session";
        serviceMocks.useAuth.mockReturnValue({
            user: { user_id: "worker-literacy-1" },
            loginSessionId: sessionKey,
        });
        const { unmount } = renderPage();
        await screen.findByRole("heading", { name: "Insights for your next step" });
        await waitFor(() => expect(getInsightTitles()).toHaveLength(3));
        const originalContent = getInsightContent();
        unmount();

        serviceMocks.getMyBalance.mockResolvedValue({ current_balance: "99999999.00" });
        serviceMocks.getMyContributions.mockResolvedValue([
            {
                amount: "800000.00",
                contribution_status: "COMPLETED",
                transaction_status: "COMPLETED",
                created_at: "2026-11-20T09:00:00.000Z",
            },
        ]);
        renderPage();

        await screen.findByRole("heading", { name: "Insights for your next step" });
        await waitFor(() => expect(getInsightTitles()).toHaveLength(3));
        expect(getInsightContent()).toEqual(originalContent);
        expect(getInsightContent()).not.toContain("99999999");
    });

    it("shows loading feedback while account data is pending", () => {
        serviceMocks.getMyBalance.mockReturnValue(new Promise(() => {}));
        serviceMocks.getMyContributions.mockReturnValue(new Promise(() => {}));
        serviceMocks.getRetirementPlan.mockReturnValue(new Promise(() => {}));
        renderPage();

        expect(screen.getByText("Loading your financial insights…")).toBeInTheDocument();
    });

    it("uses safe fallback insights when account requests fail", async () => {
        serviceMocks.getMyBalance.mockRejectedValue(new Error("Balance unavailable"));
        serviceMocks.getMyContributions.mockRejectedValue(new Error("Contributions unavailable"));
        serviceMocks.getRetirementPlan.mockRejectedValue(new Error("Plan unavailable"));
        renderPage();

        expect(await screen.findByText(/Some account data was unavailable/)).toBeInTheDocument();
        expect(getInsightContent()).not.toContain("KSh NaN");
        expect(getInsightContent()).not.toContain("KSh 0.00");
    });

    it("searches and filters articles and renders complete English and Kiswahili content", async () => {
        renderPage();
        const category = await screen.findByLabelText("Filter by topic");
        fireEvent.change(category, { target: { value: "saving" } });

        expect(screen.getByRole("heading", { name: "Why Saving Early Matters" })).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "Understanding Fund Risk Levels" })).not.toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Search articles"), { target: { value: "compound interest" } });
        expect(screen.getByRole("heading", { name: "Why Saving Early Matters" })).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Search articles"), { target: { value: "" } });
        fireEvent.click(screen.getByRole("button", { name: "Read full article" }));
        expect(screen.getByText(articles[0].body)).toBeInTheDocument();

        await i18n.changeLanguage("sw");
        expect(screen.getByLabelText("Chuja kwa mada")).toHaveValue("saving");
        expect(screen.getByRole("heading", { name: "Kwa nini ni muhimu kuanza kuweka akiba mapema" })).toBeInTheDocument();
        expect(screen.getByText(/Hata michango midogo ya kila mwezi inaweza kukua sana kwa miongo kadhaa/)).toBeInTheDocument();
        expect(screen.getByLabelText("Tafuta makala")).toHaveValue("");
        fireEvent.change(screen.getByLabelText("Tafuta makala"), { target: { value: "riba-jumuishi" } });
        expect(screen.getByRole("heading", { name: "Kwa nini ni muhimu kuanza kuweka akiba mapema" })).toBeInTheDocument();
    });
});
