import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import FinancialInsights from "./FinancialInsights";
import { buildInsights, getCompletedContributions, selectFinancialInsights } from "./insightEngine";

const verifiedContributions = [
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
    {
        amount: "999999.00",
        contribution_status: "PENDING",
        transaction_status: "PENDING",
        created_at: "2026-10-21T09:00:00.000Z",
    },
];

const financialData = {
    balance: { current_balance: "14850.00" },
    contributions: verifiedContributions,
    plan: { target_amount: "500000.00" },
    projection: { projected_amount: "420000.00" },
};

afterEach(cleanup);

describe("financial insight engine", () => {
    it("selects different insight sets for different login sessions", () => {
        const firstLogin = selectFinancialInsights(financialData, "session-alpha");
        const secondLogin = selectFinancialInsights(financialData, "session-beta");

        expect(firstLogin).toHaveLength(3);
        expect(secondLogin).toHaveLength(3);
        expect(firstLogin.map((insight) => insight.id)).not.toEqual(secondLogin.map((insight) => insight.id));
    });

    it("personalizes only from completed contribution and transaction records", () => {
        expect(getCompletedContributions(verifiedContributions)).toHaveLength(2);
        const insights = buildInsights(financialData);

        expect(insights.find((insight) => insight.id === "recorded-contributions").explanation)
            .toContain("2 completed contributions total KSh 4,000.00");
        expect(insights.find((insight) => insight.id === "retirement-estimate").explanation)
            .toContain("estimates KSh 420,000.00");
        expect(insights.find((insight) => insight.id === "retirement-estimate").explanation)
            .toContain("not a guaranteed outcome");
    });

    it("uses supportive general guidance when there are no completed contributions", () => {
        const insights = buildInsights({ ...financialData, contributions: [] });

        expect(insights.find((insight) => insight.id === "starting-small").explanation)
            .toContain("There is no required starting amount");
        expect(insights.find((insight) => insight.id === "recorded-contributions")).toBeUndefined();
    });

    it("handles missing and incomplete records without inventing financial figures", () => {
        const insights = buildInsights({
            balance: null,
            contributions: [{ amount: "not-a-number", contribution_status: "COMPLETED" }],
            plan: null,
            projection: null,
        });
        const text = insights.map(({ explanation }) => explanation).join(" ");

        expect(insights.some((insight) => insight.id === "balance-unavailable")).toBe(true);
        expect(insights.some((insight) => insight.id === "retirement-goal")).toBe(true);
        expect(text).not.toContain("KSh NaN");
        expect(text).not.toContain("KSh 0.00");
    });

    it("marks insight guidance as general when account data could not be retrieved", () => {
        const insights = buildInsights({
            balance: null,
            contributions: null,
            plan: null,
            projection: null,
            dataUnavailable: true,
        });
        expect(insights.some((insight) => insight.id === "personalization-limited")).toBe(true);
        expect(insights.some((insight) => insight.id === "contribution-records-unavailable")).toBe(true);
    });
});

describe("FinancialInsights", () => {
    it("keeps the selection stable on rerender and changes it on refresh", () => {
        const { rerender } = render(
            <FinancialInsights {...financialData} sessionKey="session-alpha" />
        );
        const title = screen.getByRole("heading", { name: "Your recorded contributions" });
        const initialTitles = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);

        rerender(<FinancialInsights {...financialData} sessionKey="session-alpha" />);
        expect(screen.getByRole("heading", { name: title.textContent })).toBeInTheDocument();
        expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(initialTitles);

        fireEvent.click(screen.getByRole("button", { name: "Refresh financial insights" }));
        expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent))
            .not.toEqual(initialTitles);
    });

    it("shows loading and error states accessibly", () => {
        const { rerender } = render(<FinancialInsights loading />);
        expect(screen.getByRole("status")).toHaveTextContent("Loading your financial insights");

        rerender(<FinancialInsights error="Could not load account data" />);
        expect(screen.getByRole("alert")).toHaveTextContent("Unable to load financial insights right now");
    });

    it("shows general guidance and a data limitation notice for incomplete inputs", () => {
        render(
            <FinancialInsights
                balance={null}
                contributions={[]}
                plan={null}
                projection={null}
                sessionKey="missing-data"
                dataUnavailable
            />
        );

        expect(screen.getByText(/Some account data was unavailable/)).toBeInTheDocument();
        expect(screen.getAllByRole("heading", { level: 2 }).length).toBeGreaterThan(1);
    });

    it("keeps the selected insight set stable while refreshed data is incomplete", () => {
        const { rerender } = render(
            <FinancialInsights {...financialData} sessionKey="session-stable" />
        );
        const originalTitles = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);

        rerender(
            <FinancialInsights
                balance={null}
                contributions={null}
                plan={null}
                projection={null}
                sessionKey="session-stable"
                dataUnavailable
            />
        );
        expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent))
            .toEqual(originalTitles);

        fireEvent.click(screen.getByRole("button", { name: "Refresh financial insights" }));
        expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent))
            .toEqual(originalTitles);
        expect(screen.getByText(/current insights are being kept/i)).toBeInTheDocument();
    });

    it("waits for asynchronous initial data, then selects once for the session", async () => {
        const { rerender } = render(
            <FinancialInsights
                {...financialData}
                sessionKey="async-session"
                loading
                dataReady={false}
            />
        );
        expect(screen.getByText("Loading your financial insights…")).toBeInTheDocument();

        rerender(
            <FinancialInsights
                {...financialData}
                sessionKey="async-session"
                dataReady
            />
        );
        await waitFor(() => expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(4));
        const originalTitles = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);

        rerender(
            <FinancialInsights
                {...financialData}
                sessionKey="async-session"
                dataReady
            />
        );
        expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent))
            .toEqual(originalTitles);
    });
});
