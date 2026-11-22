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
const workerIdentityMocks = vi.hoisted(() => ({
    completeWorkerRegistration: vi.fn(),
    resendWorkerRegistrationCode: vi.fn(),
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
vi.mock("../../services/workerIdentityApi", () => workerIdentityMocks);

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

function fillLoginForm(identifier = "0712000000", password = "correct-password") {
    fireEvent.change(screen.getByLabelText(/Email address|Verified phone number/), { target: { value: identifier } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
}

describe("authentication pages", () => {
    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
    });

    it("validates phone and email formats before login submission", () => {
        renderAuth();
        fillLoginForm("07123");
        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
        expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid Kenyan mobile number.");
        expect(authMocks.login).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Sign in with email instead" }));
        fillLoginForm("not-an-email");
        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
        expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid email address.");
        expect(authMocks.login).not.toHaveBeenCalled();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        authMocks.login.mockResolvedValue({
            success: true,
            user: { user_id: "worker-1", role: "WORKER" },
        });
        authMocks.register.mockResolvedValue({
            success: true,
            challengeId: "registration-challenge",
        });
        workerIdentityMocks.completeWorkerRegistration.mockResolvedValue({
            data: { account_status: "ACTIVE", kyc_status: "PENDING" },
        });
        workerIdentityMocks.resendWorkerRegistrationCode.mockResolvedValue({ status: "success" });
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
        expect(screen.getByLabelText("Verified phone number")).toHaveAttribute("type", "tel");
        expect(screen.getByLabelText("Verified phone number")).toHaveAttribute("inputmode", "numeric");
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
        expect(screen.getByLabelText("Optional email address")).not.toBeRequired();
        expect(screen.getByLabelText("Date of birth")).toBeRequired();
    });

    it("sanitizes phone characters on input, paste, and autocomplete changes", () => {
        renderAuth();
        const phoneInput = screen.getByLabelText("Verified phone number");

        fireEvent.change(phoneInput, { target: { value: "0712abc3456" } });
        expect(phoneInput).toHaveValue("07123456");

        fireEvent.change(phoneInput, { target: { value: "Letters+254 (700) 123-456" } });
        expect(phoneInput).toHaveValue("+254700123456");

        fireEvent.change(phoneInput, { target: { value: "++254700123456+abc" } });
        expect(phoneInput).toHaveValue("+254700123456");
    });

    it("preserves local leading zeroes and submits a sanitized international phone", async () => {
        renderAuth();
        const phoneInput = screen.getByLabelText("Verified phone number");
        fireEvent.change(phoneInput, { target: { value: "0712345678" } });
        fireEvent.change(screen.getByLabelText("Password"), { target: { value: "my-password" } });
        expect(phoneInput).toHaveValue("0712345678");

        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
        expect(await screen.findByRole("heading", { name: "Worker dashboard" })).toBeInTheDocument();
        expect(authMocks.login).toHaveBeenCalledWith("0712345678", "my-password");
    });

    it("leaves legitimate email and password characters unchanged", async () => {
        renderAuth();
        fireEvent.click(screen.getByRole("button", { name: "Sign in with email instead" }));
        const emailInput = screen.getByLabelText("Email address");
        const passwordInput = screen.getByLabelText("Password");

        fireEvent.change(emailInput, { target: { value: "Letters+tag@example.com" } });
        fireEvent.change(passwordInput, { target: { value: "P@ssw0rd!+?" } });

        expect(emailInput).toHaveValue("Letters+tag@example.com");
        expect(passwordInput).toHaveValue("P@ssw0rd!+?");

        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
        expect(await screen.findByRole("heading", { name: "Worker dashboard" })).toBeInTheDocument();
        expect(authMocks.login).toHaveBeenCalledWith("Letters+tag@example.com", "P@ssw0rd!+?");
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
        fillLoginForm("0712345678", "correct-password");
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

        expect(await screen.findByText(/If an eligible account or registration matches this address/)).toBeInTheDocument();
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

    it("starts phone-verified registration with an optional email", async () => {
        renderAuth("/register");
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "  Amina Worker  " } });
        fireEvent.change(screen.getByLabelText("Optional email address"), { target: { value: "  AMINA@example.com " } });
        fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "  0712345678  " } });
        fireEvent.change(screen.getByLabelText("National ID"), { target: { value: "12345678" } });
        fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1990-04-15" } });
        fireEvent.change(screen.getByRole("combobox", { name: "Occupation" }), {
            target: { value: "MARKET_VENDOR" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));

        expect(await screen.findByRole("heading", { name: "Create account" })).toBeInTheDocument();
        expect(screen.getByLabelText("Six-digit verification code")).toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveTextContent(
            "If the supplied details can be used, a verification code will be sent to the phone number.",
        );
        expect(authMocks.register).toHaveBeenCalledWith(
            "Amina Worker",
            "amina@example.com",
            "0712345678",
            "MARKET_VENDOR",
            "12345678",
            "1990-04-15",
        );
        expect(screen.getByRole("button", { name: "Send another code" })).toBeInTheDocument();
        expect(screen.queryByLabelText("Role")).not.toBeInTheDocument();
    });

    it("does not require an email address for phone registration", async () => {
        renderAuth("/register");
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Amina Worker" } });
        fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "0712345678" } });
        fireEvent.change(screen.getByLabelText("National ID"), { target: { value: "12345678" } });
        fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1990-04-15" } });
        fireEvent.change(screen.getByRole("combobox", { name: "Occupation" }), {
            target: { value: "MARKET_VENDOR" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));

        expect(await screen.findByLabelText("Six-digit verification code")).toBeInTheDocument();
        expect(authMocks.register).toHaveBeenCalledWith(
            "Amina Worker",
            null,
            "0712345678",
            "MARKET_VENDOR",
            "12345678",
            "1990-04-15",
        );
    });

    it("validates an optional email only when one is provided", () => {
        renderAuth("/register");
        fireEvent.change(screen.getByLabelText("Optional email address"), { target: { value: "invalid" } });
        fireEvent.blur(screen.getByLabelText("Optional email address"));
        expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));
        expect(authMocks.register).not.toHaveBeenCalled();
    });

    it("validates required fields before registration starts", () => {
        renderAuth("/register");
        fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));
        expect(screen.getByText("Date of birth is required.")).toBeInTheDocument();
        expect(authMocks.register).not.toHaveBeenCalled();
    });

    it("rejects an invalid Kenyan phone number before registration", () => {
        renderAuth("/register");
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Amina Worker" } });
        fireEvent.change(screen.getByLabelText("Optional email address"), { target: { value: "amina@example.com" } });
        fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "07000000001" } });
        fireEvent.change(screen.getByLabelText("National ID"), { target: { value: "12345678" } });
        fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1990-04-15" } });
        fireEvent.change(screen.getByRole("combobox", { name: "Occupation" }), {
            target: { value: "MARKET_VENDOR" },
        });

        fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));

        expect(screen.getByText("Enter a valid Kenyan mobile number.")).toBeInTheDocument();
        expect(authMocks.register).not.toHaveBeenCalled();
    });

    it("shows National ID validation in Kiswahili", async () => {
        await i18n.changeLanguage("sw");
        renderAuth("/register");
        fireEvent.change(screen.getByLabelText("Jina kamili"), { target: { value: "Amina Worker" } });
        fireEvent.change(screen.getByLabelText("Anwani ya barua pepe (si lazima)"), {
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
        fireEvent.click(screen.getByRole("button", { name: "Tuma msimbo wa uthibitishaji" }));

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
        fireEvent.change(screen.getByLabelText("Optional email address"), { target: { value: "amina@example.com" } });
        fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "0712345678" } });
        fireEvent.change(screen.getByLabelText("National ID"), { target: { value: "12345678" } });
        fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1990-04-15" } });
        fireEvent.change(screen.getByLabelText(label), { target: { value } });
        fireEvent.change(screen.getByRole("combobox", { name: "Occupation" }), {
            target: { value: "MARKET_VENDOR" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));

        expect(screen.getByText(message)).toBeInTheDocument();
        expect(authMocks.register).not.toHaveBeenCalled();
    });

    it("verifies the phone, creates the password, signs in immediately and keeps KYC pending", async () => {
        renderAuth("/register");
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Amina Worker" } });
        fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "0712345678" } });
        fireEvent.change(screen.getByLabelText("National ID"), { target: { value: "12345678" } });
        fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1990-04-15" } });
        fireEvent.change(screen.getByRole("combobox", { name: "Occupation" }), {
            target: { value: "MARKET_VENDOR" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));
        await screen.findByLabelText("Six-digit verification code");
        fireEvent.change(screen.getByLabelText("Six-digit verification code"), { target: { value: "123abc4567" } });
        expect(screen.getByLabelText("Six-digit verification code")).toHaveValue("123456");
        fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secure-password" } });
        fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "secure-password" } });
        fireEvent.click(screen.getByRole("button", { name: "Verify code and create account" }));

        expect(await screen.findByRole("heading", { name: "Worker dashboard" })).toBeInTheDocument();
        expect(authMocks.login).toHaveBeenCalledWith("+254712345678", "secure-password");
        expect(workerIdentityMocks.completeWorkerRegistration).toHaveBeenCalledWith({
            challengeId: "registration-challenge",
            code: "123456",
            password: "secure-password",
        });
    });

    it("offers sign-in if account creation succeeds but immediate login fails", async () => {
        authMocks.login.mockResolvedValueOnce({
            success: false,
            message: "Temporary login failure",
        });
        renderAuth("/register");
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Amina Worker" } });
        fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "0712345678" } });
        fireEvent.change(screen.getByLabelText("National ID"), { target: { value: "12345678" } });
        fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1990-04-15" } });
        fireEvent.change(screen.getByRole("combobox", { name: "Occupation" }), {
            target: { value: "MARKET_VENDOR" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));
        await screen.findByLabelText("Six-digit verification code");
        fireEvent.change(screen.getByLabelText("Six-digit verification code"), { target: { value: "123456" } });
        fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secure-password" } });
        fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "secure-password" } });
        fireEvent.click(screen.getByRole("button", { name: "Verify code and create account" }));

        expect(await screen.findByRole("heading", { name: "Account created" })).toBeInTheDocument();
        expect(screen.getByRole("alert")).toHaveTextContent(
            "Your account was created, but automatic sign-in failed. Please sign in to continue.",
        );
        expect(screen.getByRole("link", { name: "Continue to sign in" })).toHaveAttribute("href", "/login");
        expect(screen.getByText(/pending KYC review/)).toBeInTheDocument();
    });

    it("resends the phone code without exposing registration eligibility", async () => {
        renderAuth("/register");
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Amina Worker" } });
        fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "0712345678" } });
        fireEvent.change(screen.getByLabelText("National ID"), { target: { value: "12345678" } });
        fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1990-04-15" } });
        fireEvent.change(screen.getByRole("combobox", { name: "Occupation" }), {
            target: { value: "MARKET_VENDOR" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));
        await screen.findByLabelText("Six-digit verification code");
        fireEvent.click(screen.getByRole("button", { name: "Send another code" }));
        expect(await screen.findByRole("status")).toHaveTextContent(
            "If the registration challenge is still eligible, a new verification code may be sent.",
        );
        expect(workerIdentityMocks.resendWorkerRegistrationCode)
            .toHaveBeenCalledWith("registration-challenge");
    });

    it("disables duplicate registration submissions while account creation is pending", async () => {
        let resolveRegistration;
        authMocks.register.mockReturnValueOnce(new Promise((resolve) => {
            resolveRegistration = resolve;
        }));
        renderAuth("/register");
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Amina Worker" } });
        fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "0712345678" } });
        fireEvent.change(screen.getByLabelText("National ID"), { target: { value: "12345678" } });
        fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "1990-04-15" } });
        fireEvent.change(screen.getByRole("combobox", { name: "Occupation" }), {
            target: { value: "MARKET_VENDOR" },
        });
        const form = screen.getByRole("button", { name: "Send verification code" }).closest("form");

        fireEvent.submit(form);
        fireEvent.submit(form);

        expect(authMocks.register).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("button", { name: "Sending code…" })).toBeDisabled();

        resolveRegistration({ success: true, challengeId: "registration-challenge" });
        expect(await screen.findByLabelText("Six-digit verification code")).toBeInTheDocument();
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

    it("rejects passwords that exceed bcrypt's UTF-8 byte limit", () => {
        renderAuth("/verify-email?token=opaque-test-token&flow=registration");
        const longPassword = "a".repeat(73);
        fireEvent.change(screen.getByLabelText("Choose a password"), {
            target: { value: longPassword },
        });
        fireEvent.change(screen.getByLabelText("Confirm password"), {
            target: { value: longPassword },
        });
        fireEvent.click(screen.getByRole("button", { name: "Verify email and create account" }));

        expect(screen.getByRole("alert")).toHaveTextContent(
            "Your password must not exceed 72 UTF-8 bytes.",
        );
        expect(authMocks.verifyEmail).not.toHaveBeenCalled();
    });

    it("shows staff sign-in and separate phone-verification next steps after email verification", async () => {
        authMocks.verifyEmail.mockResolvedValueOnce({ next_step: "STAFF_SIGN_IN" });
        renderAuth("/verify-email?token=opaque-test-token&flow=email-verification");
        fireEvent.click(screen.getByRole("button", { name: "Verify email address" }));

        expect(await screen.findByRole("status")).toHaveTextContent(
            "Your email address is verified and your account is active.",
        );
        expect(screen.getByRole("status")).toHaveTextContent(
            "Phone verification remains separate.",
        );
    });
});
