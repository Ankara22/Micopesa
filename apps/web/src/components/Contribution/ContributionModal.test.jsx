import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ContributionModal from "./ContributionModal";

const mocks = vi.hoisted(() => ({
    initiateMyContribution: vi.fn(),
    toast: { info: vi.fn(), error: vi.fn() },
}));

vi.mock("../../services/accountService", () => ({
    initiateMyContribution: mocks.initiateMyContribution,
}));
vi.mock("../ui/ToastContext", () => ({ useToast: () => mocks.toast }));

const availableFunds = [
    { fund_id: "FUND-A", fund_name: "Balanced" },
    { fund_id: "FUND-B", fund_name: "Growth" },
];
const allocations = [
    { fund_id: "FUND-A", fund_name: "Balanced", allocation_percentage: "70.00" },
    { fund_id: "FUND-B", fund_name: "Growth", allocation_percentage: "30.00" },
    { fund_id: "FUND-C", fund_name: "Not available", allocation_percentage: "10.00" },
];

function renderModal(props = {}) {
    return render(
        <ContributionModal
            open
            onClose={vi.fn()}
            availableFunds={availableFunds}
            allocations={allocations}
            loading={false}
            error={null}
            onRetry={vi.fn()}
            onCreated={vi.fn().mockResolvedValue(true)}
            {...props}
        />,
    );
}

describe("ContributionModal", () => {
    afterEach(cleanup);

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.initiateMyContribution.mockResolvedValue({
            status: "success",
            data: { payment_status: "PENDING" },
        });
    });

    it("lists active funds returned by the API, allows multiple selections, and records a pending split", async () => {
        const onCreated = vi.fn().mockResolvedValue(true);
        renderModal({ onCreated });

        expect(screen.getByLabelText(/Balanced/)).toBeInTheDocument();
        expect(screen.getByLabelText(/Growth/)).toBeInTheDocument();
        expect(screen.queryByLabelText(/Not available/)).not.toBeInTheDocument();
        fireEvent.click(screen.getByLabelText(/Balanced/));
        fireEvent.click(screen.getByLabelText(/Growth/));
        fireEvent.change(screen.getByLabelText("Amount (KES)"), { target: { value: "25.50" } });
        fireEvent.change(screen.getByLabelText("Intended channel (not processed)"), {
            target: { value: "USSD" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Create pending contribution" }));

        await waitFor(() => {
            expect(mocks.initiateMyContribution).toHaveBeenCalledWith({
                amount: "25.50",
                channel: "USSD",
                fund_ids: ["FUND-A", "FUND-B"],
            });
        });
        expect(onCreated).toHaveBeenCalledOnce();
        expect(mocks.toast.info).toHaveBeenCalledWith(expect.stringMatching(/recorded as pending/i));
        expect(screen.queryByText(/payment is taken/i)).not.toBeInTheDocument();
    });

    it("requires a selected fund and does not submit without one", async () => {
        renderModal();
        fireEvent.change(screen.getByLabelText("Amount (KES)"), { target: { value: "10.00" } });
        fireEvent.click(screen.getByRole("button", { name: "Create pending contribution" }));

        expect(await screen.findByRole("alert")).toHaveTextContent("Select at least one currently allocated active fund.");
        expect(mocks.initiateMyContribution).not.toHaveBeenCalled();
    });

    it("shows loading and retryable API errors", () => {
        const onRetry = vi.fn();
        const { rerender } = renderModal({ loading: true });
        expect(screen.getByRole("status")).toHaveTextContent("Loading eligible funds");

        rerender(
            <ContributionModal
                open
                onClose={vi.fn()}
                availableFunds={availableFunds}
                allocations={allocations}
                loading={false}
                error="Funds unavailable"
                onRetry={onRetry}
                onCreated={vi.fn()}
            />,
        );
        expect(screen.getByText("Unable to load this information right now. Please try again.")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(onRetry).toHaveBeenCalledOnce();
    });

    it("shows API persistence errors without closing or claiming success", async () => {
        mocks.initiateMyContribution.mockRejectedValue(new Error("Unable to record contribution"));
        renderModal();
        fireEvent.click(screen.getByLabelText(/Balanced/));
        fireEvent.change(screen.getByLabelText("Amount (KES)"), { target: { value: "10.00" } });
        fireEvent.click(screen.getByRole("button", { name: "Create pending contribution" }));

        expect(await screen.findByRole("alert")).toHaveTextContent("Unable to record this contribution");
        expect(mocks.toast.info).not.toHaveBeenCalled();
    });
});
