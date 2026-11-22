import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ForgotPassword from "./ForgotPassword";
import ResetPassword from "./ResetPassword";
import VerifyEmail from "./VerifyEmail";

const authEmailMocks = vi.hoisted(() => ({
    requestPasswordReset: vi.fn(),
    resetPassword: vi.fn(),
    verifyEmail: vi.fn(),
}));
const workerIdentityMocks = vi.hoisted(() => ({
    completePhonePasswordReset: vi.fn(),
    requestPhonePasswordReset: vi.fn(),
}));

vi.mock("../../services/authEmailApi", () => authEmailMocks);
vi.mock("../../services/workerIdentityApi", () => workerIdentityMocks);

function renderPage(path, element) {
    return render(
        <MemoryRouter initialEntries={[path]}>
            <Routes>
                <Route path="*" element={element} />
            </Routes>
        </MemoryRouter>,
    );
}

describe("email recovery pages", () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        workerIdentityMocks.requestPhonePasswordReset.mockResolvedValue({
            data: { challenge_id: "phone-recovery-challenge" },
        });
        workerIdentityMocks.completePhonePasswordReset.mockResolvedValue({
            message: "Password reset successfully.",
        });
    });

    it("shows a generic reset-request success response and the legacy support path", async () => {
        authEmailMocks.requestPasswordReset.mockResolvedValue({
            message: "If the address is associated with a verified account, a reset request has been processed. Email delivery is not confirmed by this response.",
        });
        renderPage("/forgot-password", <ForgotPassword />);

        expect(screen.getByText(/Use the verified email or verified Kenyan phone number/)).toBeInTheDocument();
        expect(screen.getByText(/Manual recovery is unavailable here until this deployment publishes an official support channel/)).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "worker@example.com" } });
        fireEvent.click(screen.getByRole("button", { name: "Request reset link" }));

        expect(await screen.findByRole("status")).toHaveTextContent("If the address is associated with a verified account");
        expect(authEmailMocks.requestPasswordReset).toHaveBeenCalledWith("worker@example.com");
    });

    it("publishes only a configured safe official support contact", () => {
        vi.stubEnv("VITE_SUPPORT_CONTACT_URL", "https://support.example.test/recovery");
        renderPage("/forgot-password", <ForgotPassword />);
        expect(screen.getByRole("link", { name: "Contact MicoPesa support" }))
            .toHaveAttribute("href", "https://support.example.test/recovery");
        expect(screen.queryByText(/Manual recovery is unavailable/)).not.toBeInTheDocument();
    });

    it("supports verified-phone recovery without changing the existing email reset path", async () => {
        renderPage("/forgot-password", <ForgotPassword />);
        fireEvent.click(screen.getByRole("button", { name: "Recover by verified phone instead" }));
        fireEvent.change(screen.getByLabelText("Verified Kenyan phone number"), {
            target: { value: "0712345678" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Send recovery code" }));

        expect(await screen.findByLabelText("Six-digit recovery code")).toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveTextContent(
            "If the verified phone belongs to an active account, a recovery code can be sent.",
        );
        expect(workerIdentityMocks.requestPhonePasswordReset).toHaveBeenCalledWith("+254712345678");

        fireEvent.change(screen.getByLabelText("Six-digit recovery code"), {
            target: { value: "12a3456" },
        });
        expect(screen.getByLabelText("Six-digit recovery code")).toHaveValue("123456");
        fireEvent.change(screen.getByLabelText("New password"), {
            target: { value: "new-secure-password" },
        });
        fireEvent.change(screen.getByLabelText("Confirm new password"), {
            target: { value: "new-secure-password" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

        expect(await screen.findByRole("status")).toHaveTextContent(
            "Your password was reset successfully.",
        );
        expect(workerIdentityMocks.completePhonePasswordReset).toHaveBeenCalledWith({
            challengeId: "phone-recovery-challenge",
            phone: "+254712345678",
            code: "123456",
            password: "new-secure-password",
        });
    });

    it("validates reset passwords before submitting and displays a successful reset", async () => {
        authEmailMocks.resetPassword.mockResolvedValue({ message: "Password reset successfully." });
        renderPage("/reset-password?token=verified-reset-token", <ResetPassword />);

        fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-password" } });
        fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "different-password" } });
        fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
        expect(screen.getByRole("alert")).toHaveTextContent("The password entries do not match.");
        expect(authEmailMocks.resetPassword).not.toHaveBeenCalled();

        fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "new-password" } });
        fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
        expect(await screen.findByRole("status")).toHaveTextContent(
            "Your password has been reset. You can now sign in with your new password.",
        );
        expect(authEmailMocks.resetPassword).toHaveBeenCalledWith("verified-reset-token", "new-password");
        await waitFor(() => expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login"));
    });

    it("waits for explicit confirmation before consuming an email-verification token", async () => {
        authEmailMocks.verifyEmail.mockResolvedValue({ message: "Email address verified successfully." });
        renderPage("/verify-email?token=email-token&flow=email-verification", <VerifyEmail />);

        expect(authEmailMocks.verifyEmail).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Verify email address" }));
        expect(await screen.findByRole("status")).toHaveTextContent("Email address verified successfully.");
        expect(authEmailMocks.verifyEmail).toHaveBeenCalledWith("email-token");
    });

    it.each([
        "/verify-email?token=email-token",
        "/verify-email?token=email-token&flow=unexpected",
    ])("rejects a verification link without a supported flow: %s", (path) => {
        renderPage(path, <VerifyEmail />);
        expect(screen.getByRole("alert")).toHaveTextContent(
            "This verification link is missing its flow type or has an invalid one.",
        );
        expect(authEmailMocks.verifyEmail).not.toHaveBeenCalled();
    });

    it("keeps reset submission disabled without a token", () => {
        renderPage("/reset-password", <ResetPassword />);
        expect(screen.getByRole("button", { name: "Reset password" })).toBeDisabled();
        expect(authEmailMocks.resetPassword).not.toHaveBeenCalled();
    });

    it("reports verification failures after the user confirms the request", async () => {
        authEmailMocks.verifyEmail.mockRejectedValue(new Error("This verification link is invalid or expired."));
        renderPage("/verify-email?token=email-token&flow=email-verification", <VerifyEmail />);
        expect(authEmailMocks.verifyEmail).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Verify email address" }));
        return waitFor(() => {
            expect(screen.getByRole("alert")).toHaveTextContent("This verification link is invalid or expired.");
            expect(authEmailMocks.verifyEmail).toHaveBeenCalledWith("email-token");
        });
    });
});
