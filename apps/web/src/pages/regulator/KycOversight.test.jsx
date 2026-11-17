import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import KycOversight from "./KycOversight";

const mocks = vi.hoisted(() => ({
    getRegulatorKycOversight: vi.fn(),
}));

vi.mock("../../services/regulatorApi", () => ({
    getRegulatorKycOversight: mocks.getRegulatorKycOversight,
}));

describe("Regulator KYC oversight", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await i18n.changeLanguage("en");
        mocks.getRegulatorKycOversight.mockResolvedValue({
            scope: { active_assigned_fund_count: 2, has_active_fund_scope: true },
            kyc_status_counts: [
                { kyc_status: "PENDING", count: 2 },
                { kyc_status: "VERIFIED", count: 7 },
                { kyc_status: "REJECTED", count: 1 },
            ],
            review_history: [{
                log_id: "review-1",
                action_type: "APPROVE",
                kyc_status: "VERIFIED",
                reviewer_role: "ADMIN",
                timestamp: "2026-03-01T10:00:00Z",
            }],
            pagination: { page: 1, total_pages: 2 },
        });
    });

    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
    });

    it("shows assigned-scope summaries and redacted review history with pagination", async () => {
        render(<KycOversight />);

        expect(await screen.findByRole("heading", { name: "KYC Oversight" })).toBeInTheDocument();
        expect(screen.getByText(/Worker names, account identifiers and National IDs are not displayed\./i))
            .toBeInTheDocument();
        expect(screen.getByRole("table")).toHaveTextContent("VERIFIED");
        expect(screen.getByRole("table")).not.toHaveTextContent("worker_id");
        expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("From date"), {
            target: { value: "2026-01-01" },
        });
        fireEvent.change(screen.getByLabelText("Review outcome"), {
            target: { value: "VERIFIED" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

        await waitFor(() => {
            expect(mocks.getRegulatorKycOversight).toHaveBeenLastCalledWith({
                start_date: "2026-01-01",
                status: "VERIFIED",
                page: 1,
                page_size: 25,
            });
        });
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        await waitFor(() => {
            expect(mocks.getRegulatorKycOversight).toHaveBeenLastCalledWith({
                start_date: "2026-01-01",
                status: "VERIFIED",
                page: 2,
                page_size: 25,
            });
        });
    });
});
