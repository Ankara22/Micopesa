import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
            "View pension funds available within your authorized regulatory scope."
        )).toBeInTheDocument();
        await waitFor(() => {
            expect(screen.getByText(
                "No funds are currently available within your authorized scope. Contact the platform administrator if you require fund access."
            )).toBeInTheDocument();
        });
        expect(screen.queryByText("No funds have been created yet.")).not.toBeInTheDocument();
        expect(mocks.listFunds).toHaveBeenCalledOnce();
    });
});
