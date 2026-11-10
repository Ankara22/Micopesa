import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Funds from "./Funds";

const mocks = vi.hoisted(() => ({
    listFunds: vi.fn(),
    createFund: vi.fn(),
    updateFund: vi.fn(),
    getFundAllocations: vi.fn(),
    refetch: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
}));

vi.mock("../../hooks/useApi", () => ({
    default: () => ({
        data: [{
            fund_id: "fund-1",
            fund_name: "Synthetic Growth",
            administrator_name: "MicoPesa",
            risk_level: "MEDIUM",
            expected_return: "7.00",
            fund_status: "ACTIVE",
        }],
        loading: false,
        refreshing: false,
        error: null,
        refetch: mocks.refetch,
    }),
}));

vi.mock("../../services/fundService", () => ({
    listFunds: mocks.listFunds,
    createFund: mocks.createFund,
    updateFund: mocks.updateFund,
    getFundAllocations: mocks.getFundAllocations,
}));

vi.mock("../../components/ui/ToastContext", () => ({
    useToast: () => ({ success: mocks.success, error: mocks.error }),
}));

describe("Fund Manager funds page", () => {
    afterEach(cleanup);

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.refetch.mockResolvedValue([]);
    });

    it("shows a managed fund's dated allocation history without exposing account identifiers or editing controls", async () => {
        mocks.getFundAllocations.mockResolvedValue([
            {
                allocation_id: "allocation-current",
                account_id: "synthetic-account-1",
                fund_id: "fund-1",
                percentage: "65.00",
                effective_from: "2026-11-01",
                effective_to: null,
            },
            {
                allocation_id: "allocation-previous",
                account_id: "synthetic-account-1",
                fund_id: "fund-1",
                percentage: "50.00",
                effective_from: "2026-09-01",
                effective_to: "2026-10-31",
            },
        ]);
        render(<Funds />);

        fireEvent.click(screen.getByRole("button", { name: "View allocations" }));

        const dialog = await screen.findByRole("dialog", { name: "Allocation history: Synthetic Growth" });
        const table = within(dialog).getByRole("table");
        expect(within(table).getAllByText("Account 1")).toHaveLength(2);
        expect(within(table).getByText("65.00%")).toBeInTheDocument();
        expect(within(table).getByText("2026-11-01")).toBeInTheDocument();
        expect(within(table).getByText("Current")).toBeInTheDocument();
        expect(within(table).getByText("50.00%")).toBeInTheDocument();
        expect(within(table).getByText("2026-10-31")).toBeInTheDocument();
        expect(dialog).not.toHaveTextContent("synthetic-account-1");
        expect(within(dialog).queryByRole("button", { name: /edit allocation/i })).not.toBeInTheDocument();
        expect(mocks.getFundAllocations).toHaveBeenCalledWith("fund-1");
    });

    it("shows an empty state when a managed fund has no allocation history", async () => {
        mocks.getFundAllocations.mockResolvedValue([]);
        render(<Funds />);

        fireEvent.click(screen.getByRole("button", { name: "View allocations" }));

        expect(await screen.findByText("No allocation history exists for this fund.")).toBeInTheDocument();
    });

    it("shows a retryable error when allocation history cannot be loaded", async () => {
        mocks.getFundAllocations.mockRejectedValueOnce(new Error("GET /api/funds/:fundId/allocations failed (HTTP 500)"))
            .mockResolvedValue([]);
        render(<Funds />);

        fireEvent.click(screen.getByRole("button", { name: "View allocations" }));

        expect(await screen.findByText("GET /api/funds/:fundId/allocations failed (HTTP 500)")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() => expect(mocks.getFundAllocations).toHaveBeenCalledTimes(2));
        expect(await screen.findByText("No allocation history exists for this fund.")).toBeInTheDocument();
    });
});
