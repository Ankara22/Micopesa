import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui/ToastContext";
import i18n from "../../i18n";
import PayoutAuthorizations from "./PayoutAuthorizations";

const mocks = vi.hoisted(() => ({
    getPayoutAuthorizationQueue: vi.fn(),
    initiatePayoutOtp: vi.fn(),
    resendPayoutOtp: vi.fn(),
}));

vi.mock("../../services/withdrawalService", () => ({
    getPayoutAuthorizationQueue: mocks.getPayoutAuthorizationQueue,
    initiatePayoutOtp: mocks.initiatePayoutOtp,
    resendPayoutOtp: mocks.resendPayoutOtp,
}));

const approvedClaim = {
    claim_id: "approved-claim",
    worker_name: "Test Worker",
    amount_requested: "1000.00",
    claim_status: "APPROVED",
    account_status: "ACTIVE",
    worker_status: "ACTIVE",
    verified_destination_matches: true,
    destination_phone_last_four: "5678",
    requested_at: "2026-04-04T12:00:00.000Z",
    otp_status: null,
};

function renderPage() {
    return render(
        <ToastProvider>
            <PayoutAuthorizations />
        </ToastProvider>
    );
}

describe("payout officer authorization page", () => {
    beforeEach(async () => {
        await i18n.changeLanguage("en");
        vi.clearAllMocks();
        vi.stubGlobal("crypto", { randomUUID: () => "7a8b9c10-1112-4a13-8b14-111111111111" });
        mocks.getPayoutAuthorizationQueue.mockResolvedValue([approvedClaim]);
        mocks.initiatePayoutOtp.mockResolvedValue({ status: "ISSUED" });
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        i18n.changeLanguage("en");
    });

    it("initiates an OTP for an approved claim without exposing the full destination", async () => {
        renderPage();
        expect(await screen.findByRole("heading", {
            name: "Withdrawal payout authorization",
        })).toBeInTheDocument();
        expect(screen.getByText(/Payout execution is not enabled/)).toBeInTheDocument();
        expect(screen.getByText("Ending 5678")).toBeInTheDocument();
        expect(screen.queryByText("+254712345678")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Send OTP" }));
        expect(await screen.findByText(/The SMS provider accepted the OTP request/)).toBeInTheDocument();
        expect(mocks.initiatePayoutOtp).toHaveBeenCalledWith(
            "approved-claim",
            "7a8b9c10-1112-4a13-8b14-111111111111"
        );
    });

    it("does not offer another authorization or a payout action after verification", async () => {
        mocks.getPayoutAuthorizationQueue.mockResolvedValue([{
            ...approvedClaim,
            otp_status: "VERIFIED",
        }]);
        renderPage();
        expect(await screen.findByText("Verified - unpaid")).toBeInTheDocument();
        expect(screen.getByText("Authorization complete; payout is not processed.")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Send OTP" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Resend OTP" })).not.toBeInTheDocument();
    });
});
