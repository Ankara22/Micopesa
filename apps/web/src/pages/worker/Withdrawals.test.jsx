import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui/ToastContext";
import i18n from "../../i18n";
import Withdrawals from "./Withdrawals";

const mocks = vi.hoisted(() => ({
    getEligibility: vi.fn(),
    getMyClaims: vi.fn(),
    submitClaim: vi.fn(),
}));

vi.mock("../../services/withdrawalService", () => ({
    getEligibility: mocks.getEligibility,
    getMyClaims: mocks.getMyClaims,
    submitClaim: mocks.submitClaim,
}));

function renderPage() {
    return render(
        <ToastProvider>
            <Withdrawals />
        </ToastProvider>
    );
}

describe("worker withdrawal localization", () => {
    beforeEach(async () => {
        await i18n.changeLanguage("sw");
        vi.clearAllMocks();
        mocks.getEligibility.mockResolvedValue({
            eligible: true,
            reasons: [],
            current_balance: "5000.00",
            reserved_withdrawal_amount: "0.00",
            available_balance: "5000.00",
        });
        mocks.getMyClaims.mockResolvedValue([]);
    });

    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
    });

    it("translates eligibility, request form, and withdrawal history", async () => {
        renderPage();

        expect(await screen.findByRole("heading", { name: "Kutoa Pesa" })).toBeInTheDocument();
        expect(screen.getByText("Unastahili")).toBeInTheDocument();
        expect(screen.getByText(/Salio linalopatikana baada ya kutoa fedha zilizotengwa/)).toBeInTheDocument();
        expect(screen.getByText("Bado huna maombi ya kutoa pesa.")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Omba Kutoa Pesa" }));
        expect(screen.getByRole("dialog", { name: "Omba kutoa pesa" })).toBeInTheDocument();
        expect(screen.getByLabelText("Kiasi cha kutoa (KSh)")).toBeInTheDocument();
        expect(screen.getByLabelText("Nambari ya simu ya kupokea pesa")).toBeInTheDocument();
        expect(screen.getByLabelText("Sababu ya kutoa pesa")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Tuma ombi" })).toBeInTheDocument();
    });
});
