import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import WorkerFunds from "./Funds";

vi.mock("../../components/Funds/WorkerFundAllocation", () => ({
    default: () => <section aria-label="Allocation and available funds">Existing fund discovery and allocation form</section>,
}));

describe("WorkerFunds", () => {
    afterEach(cleanup);

    it("hosts the existing fund discovery and allocation workflow on its dedicated page", () => {
        render(<WorkerFunds />);
        expect(screen.getByRole("heading", { name: "My Funds & Allocation" })).toBeInTheDocument();
        expect(screen.getByRole("region", { name: "Allocation and available funds" }))
            .toHaveTextContent("Existing fund discovery and allocation form");
        expect(screen.getByText(/does not represent money invested or a confirmed contribution/i)).toBeInTheDocument();
    });
});
