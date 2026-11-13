import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "../../i18n";
import Login from "./Login";
import Register from "./Register";
import VerifyEmail from "./VerifyEmail";

const authMocks = vi.hoisted(() => ({
    login: vi.fn(),
    register: vi.fn(),
    requestEmailVerificationForAddress: vi.fn(),
    verifyEmail: vi.fn(),
}));

vi.mock("../../context/AuthContext", () => ({
    useAuth: () => ({
        login: authMocks.login,
        register: authMocks.register,
    }),
}));
vi.mock("../../services/authEmailApi", () => ({
    requestEmailVerificationForAddress: authMocks.requestEmailVerificationForAddress,
    verifyEmail: authMocks.verifyEmail,
}));

function renderAuth(initialEntry = "/login") {
    return render(
        <MemoryRouter initialEntries={[initialEntry]}>
            <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/register" element={<Register />} />
                <Route path="/verify-email" element={<VerifyEmail />} />
                <Route path="/worker/dashboard" element={<h1>Worker dashboard</h1>} />
                <Route path="/manager/dashboard" element={<h1>Manager dashboard</h1>} />
                <Route path="/regulator/dashboard" element={<h1>Regulator dashboard</h1>} />
                <Route path="/admin/dashboard" element={<h1>Admin dashboard</h1>} />
            </Routes>
        </MemoryRouter>,
    );
}

function fillLoginForm(identifier = "07120000000", password = "correct-password") {
    fireEvent.change(screen.getByLabelText(/Email address|Verified phone number/), { target: { value: identifier } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
}

describe("authentication pages", () => {
    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
    });

    beforeEach(() => {
        vi.clearAllMocks();
        authMocks.login.mockResolvedValue({
            success: true,
            user: { role: "WORKER" },
        });
        authMocks.register.mockResolvedValue({
            success: true,
            user: { role: "WORKER" },
            verificationEmailSent: true,
        });
        authMocks.requestEmailVerificationForAddress.mockResolvedValue({
            message: "If an unverified email-login account matches this address, verification instructions can be sent.",
        });
        authMocks.verifyEmail.mockResolvedValue({ status: "success" });
    });

    it("presents verified phone as primary login and offers email as an alternative", () => {
        const { container } = renderAuth();

        expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
        expect(container.querySelector(".auth-art img"))
            .toHaveAttribute("src", "/images/micopesa-login-reference-hd.png");
        expect(screen.getByLabelText("Verified phone number")).toHaveAttribute("autocomplete", "tel");
        expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
        expect(screen.getByRole("link", { name: "Create an account" })).toHaveAttribute("href", "/register");

        fireEvent.click(screen.getByRole("button", { name: "Sign in with email instead" }));
        expect(screen.getByLabelText("Email address")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Sign in with phone" }));
        expect(screen.getByLabelText("Verified phone number")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("link", { name: "Create an account" }));
        expect(screen.getByRole("heading", { name: "Create account" })).toBeInTheDocument();
        expect(screen.getByRole("combobox", { name: "Occupation" })).toBeInTheDocument();
        expect(container.querySelector(".auth-art img"))
            .toHaveAttribute("src", "/images/micopesa-signup-reference-hd.png");
        expect(screen.getByLabelText("Email address (used to sign in)")).toBeRequired();
    });

    it("validates required login fields and displays authentication errors", async () => {
        renderAuth();

        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
        expect(screen.getByRole("alert")).toHaveTextContent("Phone number and password are required.");
        expect(authMocks.login).not.toHaveBeenCalled();

        fillLoginForm();
        authMocks.login.mockResolvedValueOnce({
            success: false,
            message: "Invalid phone number or password",
        });
        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "We couldn't sign you in. Check your details or try again later.",
        );
        expect(screen.queryByText("Invalid phone number or password")).not.toBeInTheDocument();
    });

    it("does not present an API failure as incorrect credentials", async () => {
        authMocks.login.mockResolvedValueOnce({
            success: false,
            status: 500,
            message: "Login failed due to a server error",
        });
        renderAuth();
        fillLoginForm("07000000001", "correct-password");
        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "The sign-in service is temporarily unavailable. Please try again later.",
        );
        expect(screen.queryByText(/Check your details/)).not.toBeInTheDocument();
    });

    it("submits the phone/password login contract and redirects by authenticated role", async () => {
        authMocks.login.mockResolvedValueOnce({
            success: true,
            user: { role: "FUND_MANAGER" },
        });
        renderAuth();
        fillLoginForm("  +254700123456  ", "my-password");

        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

        expect(await screen.findByRole("heading", { name: "Manager dashboard" })).toBeInTheDocument();
        expect(authMocks.login).toHaveBeenCalledWith("+254700123456", "my-password");
    });

    it("accepts a verified email identifier without changing the existing login contract", async () => {
        renderAuth();
        fireEvent.click(screen.getByRole("button", { name: "Sign in with email instead" }));
        fillLoginForm("verified@example.com", "my-password");

        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

        expect(await screen.findByRole("heading", { name: "Worker dashboard" })).toBeInTheDocument();
        expect(authMocks.login).toHaveBeenCalledWith("verified@example.com", "my-password");
    });

    it("offers a generic verification resend path without exposing account existence", async () => {
        renderAuth();
        fireEvent.click(screen.getByRole("button", { name: "Sign in with email instead" }));
        fillLoginForm("new@example.com");
        fireEvent.click(screen.getByRole("button", { name: "Resend verification email" }));

        expect(await screen.findByText(/If an unverified email-login account matches this address/)).toBeInTheDocument();
        expect(authMocks.requestEmailVerificationForAddress).toHaveBeenCalledWith("new@example.com");
    });

    it.each([
        ["WORKER", "Worker dashboard"],
        ["FUND_MANAGER", "Manager dashboard"],
        ["REGULATOR", "Regulator dashboard"],
        ["ADMIN", "Admin dashboard"],
    ])("redirects the next login using the authoritative %s role", async (role, dashboardName) => {
        authMocks.login.mockResolvedValueOnce({ success: true, user: { role } });
        renderAuth();
        fillLoginForm();

        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

        expect(await screen.findByRole("heading", { name: dashboardName })).toBeInTheDocument();
    });

    it("disables duplicate login submissions while authentication is pending", async () => {
        let resolveLogin;
        authMocks.login.mockReturnValueOnce(new Promise((resolve) => {
            resolveLogin = resolve;
        }));
        renderAuth();
        fillLoginForm();
        const form = screen.getByRole("button", { name: "Sign in" }).closest("form");

        fireEvent.submit(form);
        fireEvent.submit(form);

        expect(authMocks.login).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();

        resolveLogin({ success: true, user: { role: "WORKER" } });
        expect(await screen.findByRole("heading", { name: "Worker dashboard" })).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    });

    it("submits public registration fields and requires email verification before sign-in", async () => {
        renderAuth("/register");
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "  Amina Worker  " } });
        fireEvent.change(screen.getByLabelText("Email address (used to sign in)"), { target: { value: "  AMINA@example.com " } });
        fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "  0712345678  " } });
        fireEvent.change(screen.getByLabelText("National ID"), { target: { value: "12345678" } });
        fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1990-04-15" } });
        fireEvent.change(screen.getByRole("combobox", { name: "Occupation" }), {
            target: { value: "MARKET_VENDOR" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Create account" }));

        expect(await screen.findByRole("heading", { name: "Verify your email" })).toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveTextContent(
            "If we can complete your registration, verification instructions will be sent.",
        );
        expect(authMocks.register).toHaveBeenCalledWith(
            "Amina Worker",
            "amina@example.com",
            "0712345678",
            "MARKET_VENDOR",
            "12345678",
            "1990-04-15",
        );
        expect(screen.queryByText("amina@example.com")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Resend verification email" })).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Role")).not.toBeInTheDocument();
    });

    it("validates the required email field and format before registration", () => {
        renderAuth("/register");
        fireEvent.click(screen.getByRole("button", { name: "Create account" }));
        expect(screen.getByText("Email address is required.")).toBeInTheDocument();
        expect(authMocks.register).not.toHaveBeenCalled();

        fireEvent.change(screen.getByLabelText("Email address (used to sign in)"), { target: { value: "invalid" } });
        fireEvent.blur(screen.getByLabelText("Email address (used to sign in)"));
        expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
        expect(authMocks.register).not.toHaveBeenCalled();
    });

    it("shows National ID validation in Kiswahili", async () => {
        await i18n.changeLanguage("sw");
        renderAuth("/register");
        fireEvent.change(screen.getByLabelText("Jina kamili"), { target: { value: "Amina Worker" } });
        fireEvent.change(screen.getByLabelText("Anwani ya barua pepe (utaitumia kuingia)"), {
            target: { value: "amina@example.com" },
        });
        fireEvent.change(screen.getByLabelText("Nambari ya simu"), { target: { value: "0712345678" } });
        fireEvent.change(screen.getByLabelText("Nambari ya kitambulisho cha taifa"), {
            target: { value: "123456" },
        });
        fireEvent.change(screen.getByLabelText("Tarehe ya kuzaliwa"), { target: { value: "1990-04-15" } });
        fireEvent.change(screen.getByRole("combobox", { name: "Kazi" }), {
            target: { value: "MARKET_VENDOR" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Fungua akaunti" }));

        expect(screen.getByText("Weka nambari ya kitambulisho cha taifa yenye tarakimu 7 au 8."))
            .toBeInTheDocument();
        expect(authMocks.register).not.toHaveBeenCalled();
    });

    it.each([
        ["National ID", "123456", "Enter a National ID containing 7 or 8 digits."],
        ["Date of birth", "2010-01-01", "Workers must be between 18 and 60 years old."],
        ["Date of birth", "1900-01-01", "Workers must be between 18 and 60 years old."],
    ])("validates registration %s before submitting", (label, value, message) => {
        renderAuth("/register");
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Amina Worker" } });
        fireEvent.change(screen.getByLabelText("Email address (used to sign in)"), { target: { value: "amina@example.com" } });
        fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "0712345678" } });
        fireEvent.change(screen.getByLabelText("National ID"), { target: { value: "12345678" } });
        fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1990-04-15" } });
        fireEvent.change(screen.getByLabelText(label), { target: { value } });
        fireEvent.change(screen.getByRole("combobox", { name: "Occupation" }), {
            target: { value: "MARKET_VENDOR" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Create account" }));

        expect(screen.getByText(message)).toBeInTheDocument();
        expect(authMocks.register).not.toHaveBeenCalled();
    });

    it("shows the same registration acknowledgement without revealing email delivery state", async () => {
        authMocks.register.mockResolvedValueOnce({
            success: true,
            user: { role: "WORKER" },
            verificationEmailSent: false,
        });
        renderAuth("/register");
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Amina Worker" } });
        fireEvent.change(screen.getByLabelText("Email address (used to sign in)"), { target: { value: "amina@example.com" } });
        fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "0712345678" } });
        fireEvent.change(screen.getByLabelText("National ID"), { target: { value: "12345678" } });
        fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1990-04-15" } });
        fireEvent.change(screen.getByRole("combobox", { name: "Occupation" }), {
            target: { value: "MARKET_VENDOR" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Create account" }));

        expect(await screen.findByRole("status")).toHaveTextContent(
            "If we can complete your registration, verification instructions will be sent.",
        );
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Resend verification email" })).not.toBeInTheDocument();
        expect(authMocks.register).toHaveBeenCalledTimes(1);
    });

    it("disables duplicate registration submissions while account creation is pending", async () => {
        let resolveRegistration;
        authMocks.register.mockReturnValueOnce(new Promise((resolve) => {
            resolveRegistration = resolve;
        }));
        renderAuth("/register");
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Amina Worker" } });
        fireEvent.change(screen.getByLabelText("Email address (used to sign in)"), { target: { value: "amina@example.com" } });
        fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "0712345678" } });
        fireEvent.change(screen.getByLabelText("National ID"), { target: { value: "12345678" } });
        fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1990-04-15" } });
        fireEvent.change(screen.getByRole("combobox", { name: "Occupation" }), {
            target: { value: "MARKET_VENDOR" },
        });
        const form = screen.getByRole("button", { name: "Create account" }).closest("form");

        fireEvent.submit(form);
        fireEvent.submit(form);

        expect(authMocks.register).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("button", { name: "Creating account…" })).toBeDisabled();

        resolveRegistration({ success: true, user: { role: "WORKER" } });
        expect(await screen.findByRole("heading", { name: "Verify your email" })).toBeInTheDocument();
    });

    it("shows a field-neutral message when registration finalization cannot be completed", async () => {
        authMocks.verifyEmail.mockRejectedValueOnce({
            response: {
                data: {
                    code: "REGISTRATION_COMPLETION_UNAVAILABLE",
                    message: "We could not complete your registration. Please contact support.",
                },
            },
        });
        renderAuth("/verify-email?token=opaque-test-token&flow=registration");
        expect(authMocks.verifyEmail).not.toHaveBeenCalled();
        fireEvent.change(screen.getByLabelText("Choose a password"), {
            target: { value: "secure-pass-1" },
        });
        fireEvent.change(screen.getByLabelText("Confirm password"), {
            target: { value: "secure-pass-1" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Verify email and create account" }));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "We could not complete your registration. Please contact support.",
        );
        expect(screen.queryByText(/National ID|email address|phone number/i)).not.toBeInTheDocument();
    });

    it("requires a user action and a matching new password to complete registration verification", async () => {
        renderAuth("/verify-email?token=opaque-test-token&flow=registration");
        expect(authMocks.verifyEmail).not.toHaveBeenCalled();
        fireEvent.change(screen.getByLabelText("Choose a password"), { target: { value: "short" } });
        fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "short" } });
        fireEvent.click(screen.getByRole("button", { name: "Verify email and create account" }));
        expect(screen.getByRole("alert")).toHaveTextContent("Your password must be at least 8 characters long.");
        expect(authMocks.verifyEmail).not.toHaveBeenCalled();

        fireEvent.change(screen.getByLabelText("Choose a password"), { target: { value: "secure-pass-1" } });
        fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "different-pass-1" } });
        fireEvent.click(screen.getByRole("button", { name: "Verify email and create account" }));
        expect(screen.getByRole("alert")).toHaveTextContent("The password entries do not match.");
        expect(authMocks.verifyEmail).not.toHaveBeenCalled();

        fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "secure-pass-1" } });
        fireEvent.click(screen.getByRole("button", { name: "Verify email and create account" }));
        expect(await screen.findByRole("status")).toHaveTextContent("Email address verified successfully.");
        expect(authMocks.verifyEmail).toHaveBeenCalledWith("opaque-test-token", "secure-pass-1");
    });
});
