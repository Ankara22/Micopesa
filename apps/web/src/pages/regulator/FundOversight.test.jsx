import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FundOversight from "./FundOversight";

const mocks = vi.hoisted(() => ({
    listFunds: vi.fn(),
    getFundAllocations: vi.fn(),
}));

vi.mock("../../services/fundService", () => ({
    listFunds: mocks.listFunds,
    getFundAllocations: mocks.getFundAllocations,
}));

describe("Regulator FundOversight", () => {
    afterEach(cleanup);

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.listFunds.mockResolvedValue([]);
        mocks.getFundAllocations.mockResolvedValue([]);
    });

    it("describes and reports an empty authorized scope without implying that no funds exist globally", async () => {
        render(<FundOversight />);

        expect(screen.getByText(
            "Review funds and allocation records within your authorized regulatory scope. Expected returns are configured assumptions, not realized performance."
        )).toBeInTheDocument();
        await waitFor(() => {
            expect(screen.getByText(
                "No funds are currently available within your authorized scope. Contact the platform administrator if you require fund access."
            )).toBeInTheDocument();
        });
        expect(screen.queryByText("No funds have been created yet.")).not.toBeInTheDocument();
        expect(mocks.listFunds).toHaveBeenCalledOnce();
    });

    it("shows assigned-fund allocation history with pseudonymous accounts and no editing actions", async () => {
        mocks.listFunds.mockResolvedValue([{
            fund_id: "fund-1",
            fund_name: "Assigned Growth",
            administrator_name: "Synthetic",
            risk_level: "LOW",
            expected_return: "5.00",
            fund_status: "ACTIVE",
        }]);
        mocks.getFundAllocations.mockResolvedValue([{
            distribution_key: "67.50|2026-10-01|ongoing",
            percentage: "67.50",
            effective_from: "2026-10-01",
            effective_to: null,
            allocation_count: 3,
        }]);
        render(<FundOversight />);

        fireEvent.click(await screen.findByRole("button", { name: "View allocation distribution" }));

        const dialog = await screen.findByRole("dialog", { name: "Allocation distribution - Assigned Growth" });
        const table = within(dialog).getByRole("table");
        expect(within(table).getByText("67.50%")).toBeInTheDocument();
        expect(within(table).getByText("3")).toBeInTheDocument();
        expect(within(table).getByText("01/10/2026")).toBeInTheDocument();
        expect(within(table).getByText("Ongoing")).toBeInTheDocument();
        expect(dialog).not.toHaveTextContent("account_id");
        expect(within(dialog).queryByRole("button", { name: /edit|change/i })).not.toBeInTheDocument();
        expect(mocks.getFundAllocations).toHaveBeenCalledWith("fund-1");
    });
});
