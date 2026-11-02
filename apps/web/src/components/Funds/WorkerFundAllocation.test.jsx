import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import WorkerFundAllocation from "./WorkerFundAllocation";

const mocks = vi.hoisted(() => ({
    getMyAllocations: vi.fn(),
    listAvailableFunds: vi.fn(),
    replaceMyAllocations: vi.fn(),
    useAuth: vi.fn(),
}));

vi.mock("../../services/fundService", () => ({
    getMyAllocations: mocks.getMyAllocations,
    listAvailableFunds: mocks.listAvailableFunds,
    replaceMyAllocations: mocks.replaceMyAllocations,
}));
vi.mock("../../context/AuthContext", () => ({
    useAuth: mocks.useAuth,
}));

const activeFunds = [
    {
        fund_id: "growth",
        fund_name: "Growth Fund",
        administrator_name: "MicoPesa",
        risk_level: "HIGH",
        expected_return: "8.00",
        fund_status: "ACTIVE",
    },
    {
        fund_id: "balanced",
        fund_name: "Balanced Fund",
        administrator_name: "MicoPesa",
        risk_level: "MEDIUM",
        expected_return: "6.00",
        fund_status: "ACTIVE",
    },
];

const allocations = [{
    allocation_id: "allocation-1",
    fund_id: "growth",
    fund_name: "Growth Fund",
    allocation_percentage: "40.00",
    effective_from: "2026-10-01",
    effective_to: null,
    fund_status: "ACTIVE",
}];

function renderSection() {
    return render(<WorkerFundAllocation />);
}

describe("WorkerFundAllocation", () => {
    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
    });

    beforeEach(() => {
        vi.resetAllMocks();
        mocks.useAuth.mockReturnValue({ loginSessionId: "worker-session-1" });
        mocks.listAvailableFunds.mockResolvedValue(activeFunds);
        mocks.getMyAllocations.mockResolvedValue(allocations);
        mocks.replaceMyAllocations.mockResolvedValue([]);
    });

    it("loads the current distribution and available funds from the API", async () => {
        renderSection();

        expect(await screen.findByRole("heading", { name: "My Fund Allocation" })).toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: /Growth Fund/ })).toBeInTheDocument();
        expect(screen.getByText("Current recorded distribution")).toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: /Growth Fund/ })).toBeChecked();
        expect(screen.getByLabelText("Allocation percentage")).toHaveValue(40);
        expect(screen.getByText("Current total:", { exact: false })).toBeInTheDocument();
        expect(mocks.listAvailableFunds).toHaveBeenCalledTimes(1);
        expect(mocks.getMyAllocations).toHaveBeenCalledTimes(1);
        expect(screen.getByText(/does not move money, change your balance, or confirm an investment/i)).toBeInTheDocument();
    });

    it("updates percentage totals and saves only a valid 100.00% distribution", async () => {
        mocks.getMyAllocations
            .mockResolvedValueOnce(allocations)
            .mockResolvedValueOnce([
                { ...allocations[0], allocation_percentage: "40.00" },
                {
                    ...allocations[0],
                    allocation_id: "allocation-2",
                    fund_id: "balanced",
                    fund_name: "Balanced Fund",
                    allocation_percentage: "60.00",
                },
            ]);
        const { container } = renderSection();

        await screen.findByRole("checkbox", { name: /Growth Fund/ });
        const balancedCheckbox = screen.getByRole("checkbox", { name: /Balanced Fund/ });
        fireEvent.click(balancedCheckbox);
        const percentageInputs = screen.getAllByLabelText("Allocation percentage");
        fireEvent.change(percentageInputs[1], { target: { value: "60.00" } });

        expect(container.querySelector(".worker-fund-allocation-total")).toHaveTextContent("Current total: 100.00%");
        const saveButton = screen.getByRole("button", { name: "Save allocation distribution" });
        expect(saveButton).toBeEnabled();
        fireEvent.click(saveButton);

        await waitFor(() => {
            expect(mocks.replaceMyAllocations).toHaveBeenCalledWith([
                { fund_id: "growth", allocation_percentage: "40.00" },
                { fund_id: "balanced", allocation_percentage: "60.00" },
            ]);
        });
        expect(await screen.findByRole("status")).toHaveTextContent("Your allocation distribution was saved.");
        expect(mocks.getMyAllocations).toHaveBeenCalledTimes(2);
        expect(screen.getByRole("checkbox", { name: /Balanced Fund/ })).toBeChecked();
    });

    it("disables save and explains totals below or above 100%", async () => {
        const { container } = renderSection();
        await screen.findByRole("checkbox", { name: /Growth Fund/ });

        expect(screen.getByRole("alert")).toHaveTextContent("Add 60.00% to reach 100.00%");
        expect(screen.getByRole("button", { name: "Save allocation distribution" })).toBeDisabled();
        fireEvent.click(screen.getByRole("checkbox", { name: /Balanced Fund/ }));
        fireEvent.change(screen.getAllByLabelText("Allocation percentage")[1], { target: { value: "80.00" } });
        expect(screen.getByRole("alert")).toHaveTextContent("Reduce the total by 20.00% to reach 100.00%");
        expect(screen.getByRole("button", { name: "Save allocation distribution" })).toBeDisabled();
        expect(mocks.replaceMyAllocations).not.toHaveBeenCalled();
        expect(container.querySelector(".worker-fund-allocation-total")).toHaveTextContent("Over by: 20.00%");
    });

    it("requires at least one selected fund", async () => {
        renderSection();
        await screen.findByRole("checkbox", { name: /Growth Fund/ });
        fireEvent.click(screen.getByRole("checkbox", { name: /Growth Fund/ }));

        expect(screen.getByRole("alert")).toHaveTextContent("Select at least one active fund.");
        expect(screen.getByRole("button", { name: "Save allocation distribution" })).toBeDisabled();
    });

    it("shows a previously allocated suspended fund but does not offer it as a selectable fund", async () => {
        mocks.getMyAllocations.mockResolvedValue([
            ...allocations,
            {
                allocation_id: "allocation-inactive",
                fund_id: "suspended",
                fund_name: "Suspended Fund",
                allocation_percentage: "60.00",
                effective_from: "2026-10-01",
                effective_to: null,
                fund_status: "SUSPENDED",
            },
        ]);
        renderSection();

        expect(await screen.findByText("Suspended Fund")).toBeInTheDocument();
        expect(screen.getByText("SUSPENDED")).toBeInTheDocument();
        expect(screen.queryByRole("checkbox", { name: /Suspended Fund/ })).not.toBeInTheDocument();
        expect(screen.getByText(/cannot be selected again/i)).toBeInTheDocument();
    });

    it("renders no-fund and no-allocation empty states", async () => {
        mocks.listAvailableFunds.mockResolvedValue([]);
        mocks.getMyAllocations.mockResolvedValue([]);
        renderSection();

        expect(await screen.findByText("You have not set a fund allocation distribution yet.")).toBeInTheDocument();
        expect(screen.getByText("No active funds are available for a new allocation distribution.")).toBeInTheDocument();
    });

    it("shows and retries available-fund and allocation read errors", async () => {
        mocks.listAvailableFunds
            .mockRejectedValueOnce(new Error("Eligible funds unavailable"))
            .mockResolvedValueOnce([]);
        mocks.getMyAllocations.mockRejectedValueOnce(new Error("Allocation records unavailable"));
        renderSection();

        const errors = await screen.findAllByRole("alert");
        expect(within(errors[0]).getByText("Unable to load this information right now. Please try again.")).toBeInTheDocument();
        expect(within(errors[1]).getByText("Unable to load this information right now. Please try again.")).toBeInTheDocument();
        fireEvent.click(within(errors[0]).getByRole("button", { name: "Try again" }));
        await waitFor(() => expect(mocks.listAvailableFunds).toHaveBeenCalledTimes(2));
        const allocationError = screen.getByRole("alert");
        fireEvent.click(within(allocationError).getByRole("button", { name: "Try again" }));

        await waitFor(() => expect(mocks.getMyAllocations).toHaveBeenCalledTimes(2));
        expect(await screen.findByText("No active funds are available for a new allocation distribution.")).toBeInTheDocument();
    });

    it("shows save failures without discarding the draft", async () => {
        mocks.replaceMyAllocations.mockRejectedValue(new Error("Allocation save failed"));
        renderSection();
        await screen.findByRole("checkbox", { name: /Growth Fund/ });
        fireEvent.click(screen.getByRole("checkbox", { name: /Balanced Fund/ }));
        fireEvent.change(screen.getAllByLabelText("Allocation percentage")[1], { target: { value: "60" } });
        fireEvent.click(screen.getByRole("button", { name: "Save allocation distribution" }));

        expect(await screen.findByRole("alert")).toHaveTextContent("Unable to save your allocation distribution");
        expect(screen.getByRole("checkbox", { name: /Growth Fund/ })).toBeChecked();
        expect(screen.getByRole("checkbox", { name: /Balanced Fund/ })).toBeChecked();
    });

    it("translates fund allocation controls while preserving the selected fund", async () => {
        await i18n.changeLanguage("sw");
        renderSection();

        const growth = await screen.findByRole("checkbox", { name: /Growth Fund/ });
        expect(screen.getByRole("heading", { name: "Mgao wa Hazina Zangu" })).toBeInTheDocument();
        expect(growth).toBeChecked();
        expect(screen.getByText("Mgao wa sasa uliorekodiwa")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Hifadhi mgao" })).toBeDisabled();
    });
});
