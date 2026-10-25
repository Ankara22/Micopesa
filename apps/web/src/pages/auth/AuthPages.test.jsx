import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Login from "./Login";
import Register from "./Register";

const authMocks = vi.hoisted(() => ({
    login: vi.fn(),
    register: vi.fn(),
}));

vi.mock("../../context/AuthContext", () => ({
    useAuth: () => ({
        login: authMocks.login,
        register: authMocks.register,
    }),
}));

function renderAuth(initialEntry = "/login") {
    return render(
        <MemoryRouter initialEntries={[initialEntry]}>
            <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/register" element={<Register />} />
                <Route path="/worker/dashboard" element={<h1>Worker dashboard</h1>} />
                <Route path="/manager/dashboard" element={<h1>Manager dashboard</h1>} />
                <Route path="/admin/dashboard" element={<h1>Admin dashboard</h1>} />
            </Routes>
        </MemoryRouter>,
    );
}

function fillLoginForm(phone = "+254700123456", password = "correct-password") {
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: phone } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
}

describe("authentication pages", () => {
    afterEach(cleanup);

    beforeEach(() => {
        vi.clearAllMocks();
        authMocks.login.mockResolvedValue({
            success: true,
            user: { role: "WORKER" },
        });
        authMocks.register.mockResolvedValue({
            success: true,
            user: { role: "WORKER" },
        });
    });

    it("renders an accessible phone-based login form and switches to registration", () => {
        renderAuth();

        expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
        expect(screen.getByLabelText("Phone number")).toHaveAttribute("autocomplete", "tel");
        expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
        expect(screen.getByRole("link", { name: "Create an account" })).toHaveAttribute("href", "/register");

        fireEvent.click(screen.getByRole("link", { name: "Create an account" }));
        expect(screen.getByRole("heading", { name: "Create account" })).toBeInTheDocument();
        expect(screen.getByRole("combobox", { name: "Occupation" })).toBeInTheDocument();
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

    it("submits the existing phone/password contract and redirects by authenticated role", async () => {
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

    it("submits only the public registration fields and redirects to the returned role dashboard", async () => {
        renderAuth("/register");
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "  Amina Worker  " } });
        fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "  0712345678  " } });
        fireEvent.change(screen.getByRole("combobox", { name: "Occupation" }), {
            target: { value: "MARKET_VENDOR" },
        });
        fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secure-pass-1" } });
        fireEvent.change(screen.getByLabelText("Confirm password"), {
            target: { value: "secure-pass-1" },
        });

        fireEvent.click(screen.getByRole("button", { name: "Create account" }));

        expect(await screen.findByRole("heading", { name: "Worker dashboard" })).toBeInTheDocument();
        expect(authMocks.register).toHaveBeenCalledWith(
            "Amina Worker",
            "0712345678",
            "secure-pass-1",
            "MARKET_VENDOR",
        );
        expect(screen.queryByLabelText("Role")).not.toBeInTheDocument();
    });

    it("disables duplicate registration submissions while account creation is pending", async () => {
        let resolveRegistration;
        authMocks.register.mockReturnValueOnce(new Promise((resolve) => {
            resolveRegistration = resolve;
        }));
        renderAuth("/register");
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Amina Worker" } });
        fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "0712345678" } });
        fireEvent.change(screen.getByRole("combobox", { name: "Occupation" }), {
            target: { value: "MARKET_VENDOR" },
        });
        fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secure-pass-1" } });
        fireEvent.change(screen.getByLabelText("Confirm password"), {
            target: { value: "secure-pass-1" },
        });
        const form = screen.getByRole("button", { name: "Create account" }).closest("form");

        fireEvent.submit(form);
        fireEvent.submit(form);

        expect(authMocks.register).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("button", { name: "Creating account…" })).toBeDisabled();

        resolveRegistration({ success: true, user: { role: "WORKER" } });
        expect(await screen.findByRole("heading", { name: "Worker dashboard" })).toBeInTheDocument();
    });

    it("validates registration passwords and presents API errors accessibly", async () => {
        renderAuth("/register");
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Amina Worker" } });
        fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "0712345678" } });
        fireEvent.change(screen.getByRole("combobox", { name: "Occupation" }), {
            target: { value: "MARKET_VENDOR" },
        });
        fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
        fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "different" } });
        fireEvent.click(screen.getByRole("button", { name: "Create account" }));

        expect(screen.getByRole("alert")).toHaveTextContent("Password must be at least 8 characters long.");
        expect(authMocks.register).not.toHaveBeenCalled();

        fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secure-pass-1" } });
        fireEvent.change(screen.getByLabelText("Confirm password"), {
            target: { value: "secure-pass-1" },
        });
        authMocks.register.mockResolvedValueOnce({
            success: false,
            message: "Unable to create your account. Please try again.",
        });
        fireEvent.click(screen.getByRole("button", { name: "Create account" }));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Unable to create your account. Please try again.",
        );
    });
});
