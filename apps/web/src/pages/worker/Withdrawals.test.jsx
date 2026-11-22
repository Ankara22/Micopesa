import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui/ToastContext";
import i18n from "../../i18n";
import Withdrawals from "./Withdrawals";

const mocks = vi.hoisted(() => ({
    getEligibility: vi.fn(),
    getMyClaims: vi.fn(),
    submitClaim: vi.fn(),
    verifyPayoutOtp: vi.fn(),
}));

vi.mock("../../services/withdrawalService", () => ({
    getEligibility: mocks.getEligibility,
    getMyClaims: mocks.getMyClaims,
    submitClaim: mocks.submitClaim,
    verifyPayoutOtp: mocks.verifyPayoutOtp,
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
        mocks.verifyPayoutOtp.mockResolvedValue({
            status: "VERIFIED",
            payoutStatus: "NOT_PROCESSED",
        });
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

    it("rejects exponent-form amounts before submitting a claim", async () => {
        renderPage();
        await screen.findByRole("heading", { name: "Kutoa Pesa" });
        fireEvent.click(screen.getByRole("button", { name: "Omba Kutoa Pesa" }));
        fireEvent.change(screen.getByLabelText("Kiasi cha kutoa (KSh)"), {
            target: { value: "1e2" },
        });
        fireEvent.change(screen.getByLabelText("Nambari ya simu ya kupokea pesa"), {
            target: { value: "0712345678" },
        });
        fireEvent.change(screen.getByLabelText("Sababu ya kutoa pesa"), {
            target: { value: "Medical expense" },
        });
        fireEvent.submit(screen.getByRole("dialog", { name: "Omba kutoa pesa" }).querySelector("form"));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Weka kiasi kizima cha shilingi za Kenya kilicho zaidi ya sifuri.",
        );
        expect(mocks.submitClaim).not.toHaveBeenCalled();
    });

    it("submits a withdrawal request without requiring an OTP", async () => {
        mocks.submitClaim.mockResolvedValue({
            claim: {
                claim_id: "claim-1",
                claim_status: "PENDING",
                amount_requested: "100",
                requested_at: "2026-04-04T12:00:00.000Z",
            },
        });
        renderPage();
        await screen.findByRole("heading", { name: "Kutoa Pesa" });
        fireEvent.click(screen.getByRole("button", { name: "Omba Kutoa Pesa" }));
        fireEvent.change(screen.getByLabelText("Kiasi cha kutoa (KSh)"), {
            target: { value: "100" },
        });
        fireEvent.change(screen.getByLabelText("Nambari ya simu ya kupokea pesa"), {
            target: { value: "0712345678" },
        });
        fireEvent.change(screen.getByLabelText("Sababu ya kutoa pesa"), {
            target: { value: "Medical expense" },
        });
        fireEvent.submit(screen.getByRole("dialog", { name: "Omba kutoa pesa" }).querySelector("form"));

        expect(await screen.findByText("Ombi la kutoa pesa limetumwa na linasubiri kuchunguzwa.")).toBeInTheDocument();
        expect(mocks.submitClaim).toHaveBeenCalledTimes(1);
        expect(mocks.verifyPayoutOtp).not.toHaveBeenCalled();
    });

    it("verifies the code only for an approved claim and reports authorization without payout", async () => {
        mocks.getMyClaims.mockResolvedValue([{
            claim_id: "approved-claim",
            claim_status: "APPROVED",
            amount_requested: "100",
            destination_phone: "+254712345678",
            withdrawal_reason: "Medical expense",
            requested_at: "2026-04-04T12:00:00.000Z",
            payout_otp_status: "ISSUED",
        }]);
        renderPage();
        await screen.findByLabelText("Msimbo wa tarakimu sita");
        fireEvent.change(screen.getByLabelText("Msimbo wa tarakimu sita"), {
            target: { value: "123456" },
        });
        fireEvent.submit(screen.getByLabelText("Msimbo wa tarakimu sita").closest("form"));

        expect(await screen.findByText("OTP imethibitishwa. Hii haitekelezi malipo.")).toBeInTheDocument();
        expect(mocks.verifyPayoutOtp).toHaveBeenCalledWith("approved-claim", "123456");
    });
});
