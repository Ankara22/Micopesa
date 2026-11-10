import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../../components/ui/ToastContext";
import RetirementProjection from "./RetirementProjection";
import i18n from "../../i18n";

const serviceMocks = vi.hoisted(() => ({
    getMyPlan: vi.fn(),
    saveMyPlan: vi.fn(),
    useAuth: vi.fn(),
}));

vi.mock("../../services/retirementService", () => ({
    getMyPlan: serviceMocks.getMyPlan,
    saveMyPlan: serviceMocks.saveMyPlan,
}));
vi.mock("../../context/AuthContext", () => ({
    useAuth: serviceMocks.useAuth,
}));
vi.mock("recharts", () => ({
    CartesianGrid: () => null,
    Legend: () => null,
    Line: () => null,
    LineChart: ({ data }) => <output data-testid="projection-chart-data">{JSON.stringify(data)}</output>,
    ResponsiveContainer: ({ children }) => <div>{children}</div>,
    Tooltip: () => null,
    XAxis: () => null,
    YAxis: () => null,
}));

const planResponse = {
    plan: { target_amount: "1000000.00", target_age: 35 },
    projection: {
        projected_amount: "50000.00",
        assumed_contribution: "200.00",
        assumed_return: "8.00",
        projection_years: 5,
        current_age: 30,
        starting_balance: "10000.00",
        yearly_projection: Array.from({ length: 6 }, (_unused, year) => ({
            year,
            age: 30 + year,
            projectedBalance: 10000 + year * 8000,
            totalContributions: year * 2400,
        })),
    },
    account: { current_balance: "10000.00" },
    assumed_yearly_growth: 8,
};

function renderPage() {
    return render(
        <ToastProvider>
            <MemoryRouter>
                <RetirementProjection />
            </MemoryRouter>
        </ToastProvider>
    );
}

afterEach(() => {
    cleanup();
    i18n.changeLanguage("en");
});

describe("RetirementProjection", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        serviceMocks.useAuth.mockReturnValue({ loginSessionId: "projection-login-1" });
        serviceMocks.getMyPlan.mockResolvedValue(planResponse);
        serviceMocks.saveMyPlan.mockResolvedValue(planResponse);
    });

    it("shows loading before the plan response resolves", () => {
        serviceMocks.getMyPlan.mockReturnValue(new Promise(() => {}));
        renderPage();

        expect(screen.getByRole("status", { name: "Loading retirement assumptions" })).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "Your retirement projection" })).not.toBeInTheDocument();
    });

    it("renders returned assumptions, summary, and charts with matching API values", async () => {
        renderPage();

        expect(await screen.findByRole("heading", { name: "Your retirement projection" })).toBeInTheDocument();
        expect(screen.getAllByText("KSh 50,000.00").length).toBeGreaterThan(0);
        expect(screen.getAllByText("KSh 10,000.00").length).toBeGreaterThan(0);
        expect(screen.getByText("KSh 200.00")).toBeInTheDocument();
        expect(screen.getAllByText("8.00%").length).toBeGreaterThan(0);
        expect(screen.getByText("Age 35")).toBeInTheDocument();
        expect(screen.getByText(/Pending contributions are not included/)).toBeInTheDocument();
        expect(await screen.findByRole("region", { name: "Retirement projection analysis" })).toBeInTheDocument();

        await waitFor(() => {
            const chartData = screen.getAllByTestId("projection-chart-data").map((output) => JSON.parse(output.textContent));
            expect(chartData[0]).toEqual(planResponse.projection.yearly_projection);
            expect(chartData).toHaveLength(1);
        });
    });

    it("allows a worker without a saved plan to enter assumptions and calculate", async () => {
        serviceMocks.getMyPlan.mockResolvedValue({
            plan: null,
            projection: null,
            account: { current_balance: "0.00" },
            assumed_yearly_growth: 8,
        });
        renderPage();

        expect(await screen.findByRole("heading", { name: "Calculate a retirement projection" })).toBeInTheDocument();
        expect(screen.getByLabelText("Your current age")).toBeInTheDocument();
        expect(screen.getByLabelText("Target retirement age")).toBeInTheDocument();
        expect(screen.getByLabelText("Planned monthly contribution (KSh)")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Calculate Projection" })).toBeInTheDocument();
        expect(screen.queryByTestId("projection-chart-data")).not.toBeInTheDocument();
    });

    it("explains when a saved projection predates yearly series data", async () => {
        serviceMocks.getMyPlan.mockResolvedValue({
            ...planResponse,
            projection: { ...planResponse.projection, yearly_projection: null, current_age: null, starting_balance: null },
        });
        renderPage();

        expect(await screen.findByText(/A year-by-year projection is not available/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Calculate Projection" })).toBeInTheDocument();
    });

    it.each([
        ["negative balances", (series) => series.map((point, index) =>
            index === series.length - 1 ? { ...point, projectedBalance: -1 } : point
        )],
        ["an incorrect final age", (series) => series.map((point, index) =>
            index === series.length - 1 ? { ...point, age: point.age - 1 } : point
        )],
        ["a mismatched final balance", (series) => series.map((point, index) =>
            index === series.length - 1 ? { ...point, projectedBalance: point.projectedBalance + 1 } : point
        )],
    ])("does not display a chart for saved projection data with %s", async (_issue, updateSeries) => {
        serviceMocks.getMyPlan.mockResolvedValue({
            ...planResponse,
            projection: {
                ...planResponse.projection,
                yearly_projection: updateSeries(planResponse.projection.yearly_projection),
            },
        });
        renderPage();

        expect(await screen.findByText(/A year-by-year projection is not available/)).toBeInTheDocument();
        expect(screen.queryByTestId("projection-chart-data")).not.toBeInTheDocument();
    });

    it("shows retry after an unexpected API failure instead of leaving the page blank", async () => {
        serviceMocks.getMyPlan.mockRejectedValue(new Error("Retirement service unavailable"));
        renderPage();

        expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load this information right now");
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    });

    it("submits user assumptions and shows a saved status", async () => {
        renderPage();
        await screen.findByRole("button", { name: "Calculate Projection" });
        fireEvent.change(screen.getByLabelText("Planned monthly contribution (KSh)"), { target: { value: "300.00" } });
        fireEvent.submit(screen.getByRole("button", { name: "Calculate Projection" }).closest("form"));

        await waitFor(() => expect(serviceMocks.saveMyPlan).toHaveBeenCalledWith({
            target_amount: 1000000,
            current_age: 30,
            target_retirement_age: 35,
            monthly_contribution_target: 300,
        }));
        expect(await screen.findByText("Your retirement plan and projection have been updated.")).toBeInTheDocument();
    });

    it("shows a clear persistence error when calculation cannot be saved", async () => {
        serviceMocks.saveMyPlan.mockRejectedValue(new Error("Projection could not be saved"));
        renderPage();
        await screen.findByRole("button", { name: "Calculate Projection" });
        fireEvent.submit(screen.getByRole("button", { name: "Calculate Projection" }).closest("form"));

        expect(await screen.findByRole("alert")).toHaveTextContent("Unable to save your retirement plan");
    });

    it("asks the user to regenerate a projection with invalid returned values", async () => {
        serviceMocks.getMyPlan.mockResolvedValue({
            ...planResponse,
            projection: { ...planResponse.projection, projected_amount: "not-an-amount" },
        });
        renderPage();

        expect(await screen.findByText(/A year-by-year projection is not available/)).toBeInTheDocument();
        expect(screen.queryByText("KSh NaN")).not.toBeInTheDocument();
        expect(screen.queryByTestId("projection-chart-data")).not.toBeInTheDocument();
    });

    it("shows a retryable error for an unexpected API response shape", async () => {
        serviceMocks.getMyPlan.mockResolvedValue({ unexpected: true });
        renderPage();

        expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load this information right now");
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    });

    it("translates retirement assumptions and keeps form input when language changes", async () => {
        await i18n.changeLanguage("sw");
        renderPage();

        expect(await screen.findByRole("heading", { name: "Makadirio yako ya kustaafu" })).toBeInTheDocument();
        expect(screen.getByText(/Michango inayosubiri haijajumuishwa/)).toBeInTheDocument();
        const age = screen.getByLabelText("Umri wako wa sasa");
        fireEvent.change(age, { target: { value: "31" } });

        await i18n.changeLanguage("en");
        expect(screen.getByRole("heading", { name: "Your retirement projection" })).toBeInTheDocument();
        expect(screen.getByLabelText("Your current age")).toHaveValue(31);
    });
});
