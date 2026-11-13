import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../ui/ToastContext";
import DepositModal from "./DepositModal";
import {
    confirmSimulatedPayment,
    getPaymentProvider,
    getStkPushStatus,
    getStkPushStatusByIdempotencyKey,
    initiateStkPush,
} from "../../services/mpesaApi";
import { getMyBalance, getMyContributions } from "../../services/accountService";
import { getMyProfile } from "../../services/profileApi";
import i18n from "../../i18n";

vi.mock("../../services/mpesaApi", () => ({
    confirmSimulatedPayment: vi.fn(),
    getPaymentProvider: vi.fn(),
    getStkPushStatus: vi.fn(),
    getStkPushStatusByIdempotencyKey: vi.fn(),
    initiateStkPush: vi.fn(),
}));

vi.mock("../../services/accountService", () => ({
    getMyBalance: vi.fn(),
    getMyContributions: vi.fn(),
}));

vi.mock("../../services/profileApi", () => ({
    getMyProfile: vi.fn(),
}));

describe("DepositModal", () => {
    afterEach(async () => {
        cleanup();
        window.sessionStorage.removeItem("micopesa.mpesa.lastPaymentAttempt");
        window.sessionStorage.removeItem("micopesa.mpesa.paymentIdempotencyKey");
        await i18n.changeLanguage("en");
    });

    beforeEach(() => {
        vi.clearAllMocks();
        window.sessionStorage.removeItem("micopesa.mpesa.lastPaymentAttempt");
        window.sessionStorage.removeItem("micopesa.mpesa.paymentIdempotencyKey");
        getPaymentProvider.mockResolvedValue({
            provider: "DARAJA",
            environment: "sandbox",
            payment_enabled: false,
            message_key: "MPESA_PAYMENTS_DISABLED",
        });
        getStkPushStatus.mockResolvedValue({});
        getStkPushStatusByIdempotencyKey.mockResolvedValue({});
        getMyBalance.mockResolvedValue({ current_balance: 0 });
        getMyContributions.mockResolvedValue([]);
        getMyProfile.mockResolvedValue({
            phone: "07000000000",
            phone_verified_at: "2026-01-01T00:00:00.000Z",
        });
    });

    it.each([
        ["DARAJA", "sandbox"],
        ["SIMULATOR", "unavailable"],
        ["UNAVAILABLE", "unavailable"],
    ])("keeps real and simulated payment initiation disabled for %s", async (provider, environment) => {
        getPaymentProvider.mockResolvedValue({
            provider,
            environment,
            payment_enabled: false,
            message_key: "MPESA_PAYMENTS_DISABLED",
        });

        render(
            <ToastProvider>
                <DepositModal open onClose={vi.fn()} />
            </ToastProvider>,
        );

        const unavailableMessage = await screen.findByText(
            "M-Pesa deposits are not enabled. No payment was started."
        );
        expect(unavailableMessage).toHaveAttribute("role", "status");

        const amount = screen.getByLabelText("Amount (KES)");
        const phone = screen.getByLabelText("M-Pesa phone number");
        const submit = screen.getByRole("button", { name: "Deposits unavailable" });

        expect(amount).toBeDisabled();
        expect(phone).toHaveAttribute("readonly");
        expect(submit).toBeDisabled();

        fireEvent.submit(amount.closest("form"));
        await waitFor(() => expect(initiateStkPush).not.toHaveBeenCalled());
        expect(confirmSimulatedPayment).not.toHaveBeenCalled();
    });

    it("does not allow initiation when the profile phone is not verified", async () => {
        getPaymentProvider.mockResolvedValue({
            provider: "DARAJA",
            environment: "sandbox",
            payment_enabled: true,
            message_key: "MPESA_PAYMENTS_AVAILABLE",
        });
        getMyProfile.mockResolvedValue({ phone: "07000000000", phone_verified_at: null });

        render(
            <ToastProvider>
                <DepositModal open onClose={vi.fn()} />
            </ToastProvider>,
        );

        expect(await screen.findByText(
            "Verify a phone number in your profile before making a contribution.",
        )).toBeInTheDocument();
        expect(screen.getByLabelText("M-Pesa phone number")).toBeDisabled();
        expect(initiateStkPush).not.toHaveBeenCalled();
    });

    it("offers a safe retry when the verified phone profile cannot be loaded", async () => {
        getMyProfile
            .mockRejectedValueOnce(new Error("sensitive profile details"))
            .mockResolvedValueOnce({
                phone: "07000000000",
                phone_verified_at: "2026-01-01T00:00:00.000Z",
            });

        render(
            <ToastProvider>
                <DepositModal open onClose={vi.fn()} />
            </ToastProvider>,
        );

        expect(await screen.findByText(
            "Unable to load your verified phone number. Try again before making a payment.",
        )).toBeInTheDocument();
        expect(screen.queryByText("sensitive profile details")).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByLabelText("M-Pesa phone number")).toHaveValue("07000000000");
        expect(getMyProfile).toHaveBeenCalledTimes(2);
        expect(initiateStkPush).not.toHaveBeenCalled();
    });

    it("starts a Daraja request only after explicit payment and verified-phone confirmation", async () => {
        getPaymentProvider.mockResolvedValue({
            provider: "DARAJA",
            environment: "sandbox",
            payment_enabled: true,
            message_key: "MPESA_PAYMENTS_AVAILABLE",
        });
        const pendingAttempt = {
            attempt_id: "attempt-pending-1",
            transaction_id: "transaction-pending-1",
            attempt_status: "PENDING",
            transaction_status: "PENDING",
            payment_status: "PENDING",
        };
        initiateStkPush.mockResolvedValue(pendingAttempt);

        render(
            <ToastProvider>
                <DepositModal open onClose={vi.fn()} />
            </ToastProvider>,
        );

        const amount = await screen.findByLabelText("Amount (KES)");
        const phone = screen.getByLabelText("M-Pesa phone number");
        expect(phone).toHaveValue("07000000000");
        expect(phone).toHaveAttribute("readonly");

        fireEvent.change(amount, { target: { value: "2500" } });
        const submit = screen.getByRole("button", { name: "Send STK Push" });
        expect(submit).toBeDisabled();
        fireEvent.click(screen.getByLabelText("I confirm this is my verified M-Pesa phone number."));
        expect(submit).toBeEnabled();
        fireEvent.click(submit);

        await waitFor(() => {
            expect(initiateStkPush).toHaveBeenCalledWith({
                amount: 2500,
                phoneNumber: "07000000000",
                idempotencyKey: expect.any(String),
                provider: "DARAJA",
            });
        });
        expect(await screen.findByText("Awaiting provider confirmation...")).toBeInTheDocument();
        expect(screen.queryByText("Deposit successful.")).not.toBeInTheDocument();
        expect(window.sessionStorage.getItem("micopesa.mpesa.lastPaymentAttempt"))
            .toBe("attempt-pending-1");
        expect(confirmSimulatedPayment).not.toHaveBeenCalled();
    });

    it("does not resubmit when initiation outcome is unknown", async () => {
        getPaymentProvider.mockResolvedValue({
            provider: "DARAJA",
            environment: "sandbox",
            payment_enabled: true,
            message_key: "MPESA_PAYMENTS_AVAILABLE",
        });
        initiateStkPush.mockRejectedValue({ status: null });

        render(
            <ToastProvider>
                <DepositModal open onClose={vi.fn()} />
            </ToastProvider>,
        );

        fireEvent.change(await screen.findByLabelText("Amount (KES)"), {
            target: { value: "2500" },
        });
        fireEvent.click(screen.getByLabelText("I confirm this is my verified M-Pesa phone number."));
        fireEvent.click(screen.getByRole("button", { name: "Send STK Push" }));

        expect(await screen.findByText("Payment confirmation unknown")).toBeInTheDocument();
        expect(initiateStkPush).toHaveBeenCalledTimes(1);
        expect(getStkPushStatusByIdempotencyKey).not.toHaveBeenCalled();
        expect(confirmSimulatedPayment).not.toHaveBeenCalled();
    });

    it("restores a saved attempt and checks its status without initiating payment", async () => {
        window.sessionStorage.setItem("micopesa.mpesa.lastPaymentAttempt", "attempt-recovery-1");
        getStkPushStatus.mockResolvedValue({
            attempt_id: "attempt-recovery-1",
            attempt_status: "PENDING",
            transaction_status: "PENDING",
            contribution_status: "PENDING",
            payment_provider: "DARAJA",
        });

        render(
            <ToastProvider>
                <DepositModal open onClose={vi.fn()} />
            </ToastProvider>,
        );

        await waitFor(() => {
            expect(getStkPushStatus).toHaveBeenCalledWith("attempt-recovery-1");
        });
        expect(initiateStkPush).not.toHaveBeenCalled();
        expect(confirmSimulatedPayment).not.toHaveBeenCalled();
        expect(await screen.findByText(
            "M-Pesa did not return a definitive response. The transaction remains pending; no balance has been credited. Check your contribution history before retrying.",
        )).toBeInTheDocument();
    });

    it("does not report success while transaction and contribution status disagree", async () => {
        const onCompleted = vi.fn();
        window.sessionStorage.setItem("micopesa.mpesa.lastPaymentAttempt", "attempt-pending-settlement");
        getStkPushStatus.mockResolvedValue({
            attempt_id: "attempt-pending-settlement",
            attempt_status: "PENDING",
            transaction_status: "COMPLETED",
            contribution_status: "PENDING",
            settlement_confirmed: false,
            payment_provider: "DARAJA",
        });

        render(
            <ToastProvider>
                <DepositModal open onClose={vi.fn()} onCompleted={onCompleted} />
            </ToastProvider>,
        );

        expect(await screen.findByText(
            "The payment and contribution records do not yet agree. No success is shown while confirmation is pending.",
        )).toBeInTheDocument();
        expect(onCompleted).not.toHaveBeenCalled();
        expect(getMyBalance).not.toHaveBeenCalled();
        expect(getMyContributions).not.toHaveBeenCalled();
        expect(initiateStkPush).not.toHaveBeenCalled();
        expect(confirmSimulatedPayment).not.toHaveBeenCalled();
    });

    it("reports completion only after a saved attempt is confirmed as fully settled", async () => {
        const onCompleted = vi.fn();
        const settledPayment = {
            attempt_id: "attempt-settled",
            attempt_status: "COMPLETED",
            transaction_id: "transaction-settled",
            transaction_status: "COMPLETED",
            contribution_status: "COMPLETED",
            settlement_confirmed: true,
            payment_provider: "DARAJA",
        };
        window.sessionStorage.setItem("micopesa.mpesa.lastPaymentAttempt", "attempt-settled");
        getStkPushStatus.mockResolvedValue(settledPayment);

        render(
            <ToastProvider>
                <DepositModal open onClose={vi.fn()} onCompleted={onCompleted} />
            </ToastProvider>,
        );

        await waitFor(() => {
            expect(onCompleted).toHaveBeenCalledWith(
                settledPayment,
                { balance: { current_balance: 0 }, contributions: [] },
            );
        });
        expect(await screen.findByText("Deposit successful.")).toBeInTheDocument();
        expect(initiateStkPush).not.toHaveBeenCalled();
        expect(confirmSimulatedPayment).not.toHaveBeenCalled();
    });

    it("shows a generic expired-session message when saved-attempt lookup fails", async () => {
        window.sessionStorage.setItem("micopesa.mpesa.lastPaymentAttempt", "attempt-expired-session");
        getStkPushStatus.mockRejectedValue(Object.assign(new Error("sensitive provider details"), {
            status: 401,
        }));

        render(
            <ToastProvider>
                <DepositModal open onClose={vi.fn()} />
            </ToastProvider>,
        );

        expect(await screen.findByText(
            "Your session has expired. Sign in again before checking this payment.",
        )).toBeInTheDocument();
        expect(screen.queryByText("sensitive provider details")).not.toBeInTheDocument();
        expect(initiateStkPush).not.toHaveBeenCalled();
        expect(confirmSimulatedPayment).not.toHaveBeenCalled();
    });

    it("restores an attempt by saved idempotency key without submitting a new request", async () => {
        window.sessionStorage.setItem("micopesa.mpesa.paymentIdempotencyKey", "saved-key-1");
        getStkPushStatusByIdempotencyKey.mockResolvedValue({
            attempt_id: "attempt-by-key",
            attempt_status: "PENDING",
            transaction_status: "PENDING",
            contribution_status: "PENDING",
            payment_provider: "DARAJA",
        });
        getStkPushStatus.mockResolvedValue({
            attempt_id: "attempt-by-key",
            attempt_status: "PENDING",
            transaction_status: "PENDING",
            contribution_status: "PENDING",
            payment_provider: "DARAJA",
        });

        render(
            <ToastProvider>
                <DepositModal open onClose={vi.fn()} />
            </ToastProvider>,
        );

        await waitFor(() => {
            expect(getStkPushStatusByIdempotencyKey).toHaveBeenCalledWith("saved-key-1");
            expect(getStkPushStatus).toHaveBeenCalledWith("attempt-by-key");
        });
        expect(initiateStkPush).not.toHaveBeenCalled();
        expect(confirmSimulatedPayment).not.toHaveBeenCalled();
    });
});
