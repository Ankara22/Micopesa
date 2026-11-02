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

vi.mock("../../services/authEmailApi", () => authEmailMocks);

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
    });

    it("shows a generic reset-request success response and the legacy support path", async () => {
        authEmailMocks.requestPasswordReset.mockResolvedValue({
            message: "If the address is associated with a verified account, a reset request has been processed. Email delivery is not confirmed by this response.",
        });
        renderPage("/forgot-password", <ForgotPassword />);

        expect(screen.getByText(/Recovery for users who cannot access a verified email is handled manually/)).toBeInTheDocument();
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

    it("validates a verification token and displays the server response", async () => {
        authEmailMocks.verifyEmail.mockResolvedValue({ message: "Email address verified successfully." });
        renderPage("/verify-email?token=email-token", <VerifyEmail />);

        await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Email address verified successfully."));
        expect(authEmailMocks.verifyEmail).toHaveBeenCalledWith("email-token");
    });

    it("keeps reset submission disabled without a token", () => {
        renderPage("/reset-password", <ResetPassword />);
        expect(screen.getByRole("button", { name: "Reset password" })).toBeDisabled();
        expect(authEmailMocks.resetPassword).not.toHaveBeenCalled();
    });

    it("reports verification failures", () => {
        authEmailMocks.verifyEmail.mockRejectedValue(new Error("This verification link is invalid or expired."));
        renderPage("/verify-email", <VerifyEmail />);
        expect(screen.getByRole("alert")).toHaveTextContent("This verification link is invalid or expired.");
        expect(authEmailMocks.verifyEmail).not.toHaveBeenCalled();
    });
});
