import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInstance } from "i18next";
import { MemoryRouter } from "react-router-dom";
import Header from "../layouts/Header";
import AuthLayout from "../pages/auth/AuthLayout";
import Login from "../pages/auth/Login";
import { ToastProvider } from "../components/ui/ToastContext";
import i18n, { getLocalizationOptions, getStoredLanguage, LANGUAGE_STORAGE_KEY } from "./index";

const authMock = vi.hoisted(() => ({
    login: vi.fn(),
    logout: vi.fn(),
}));

vi.mock("../context/AuthContext", () => ({
    useAuth: () => ({
        user: { role: "WORKER", full_name: "Test Worker" },
        login: authMock.login,
        logout: authMock.logout,
    }),
}));

function renderGuestPage() {
    return render(
        <AuthLayout>
            <h1>{i18n.t("auth.login.title")}</h1>
        </AuthLayout>,
    );
}

describe("shared localization", () => {
    beforeEach(() => {
        i18n.changeLanguage("en");
        window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
        document.documentElement.lang = "en";
        vi.clearAllMocks();
        authMock.login.mockResolvedValue({ success: false, status: 401 });
    });

    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
        window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    });

    it("defaults to English when there is no saved language", async () => {
        const freshInstance = createInstance();
        await freshInstance.init(getLocalizationOptions());

        expect(freshInstance.language).toBe("en");
        expect(freshInstance.t("auth.login.title")).toBe("Sign in");
    });

    it("uses English when the saved language code is unsupported", async () => {
        window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "fr");
        const freshInstance = createInstance();
        await freshInstance.init(getLocalizationOptions());

        expect(freshInstance.language).toBe("en");
        expect(getStoredLanguage()).toBe("en");
    });

    it("switches between Kiswahili and English and updates the document language", async () => {
        renderGuestPage();
        const language = screen.getByRole("combobox", { name: "Language" });

        fireEvent.change(language, { target: { value: "sw" } });
        expect(await screen.findByRole("heading", { name: "Jipange kwa maisha yako ya baadaye." })).toBeInTheDocument();
        expect(document.documentElement).toHaveAttribute("lang", "sw");

        fireEvent.change(screen.getByRole("combobox", { name: "Lugha" }), { target: { value: "en" } });
        expect(await screen.findByRole("heading", { name: "Make room for your future." })).toBeInTheDocument();
        expect(document.documentElement).toHaveAttribute("lang", "en");
    });

    it("persists the selected language and restores it in a fresh localization instance", async () => {
        renderGuestPage();
        fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "sw" } });
        expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("sw");

        const freshInstance = createInstance();
        await freshInstance.init(getLocalizationOptions());
        expect(freshInstance.language).toBe("sw");
        expect(getStoredLanguage()).toBe("sw");
    });

    it("falls back to the English resource when a Kiswahili key is missing", async () => {
        const options = getLocalizationOptions();
        delete options.resources.sw.translation.auth.login.title;
        const fallbackInstance = createInstance();
        await fallbackInstance.init(options);
        await fallbackInstance.changeLanguage("sw");

        expect(fallbackInstance.t("auth.login.title")).toBe("Sign in");
    });

    it("provides the selector on guest and authenticated headers", () => {
        const guest = renderGuestPage();
        expect(screen.getByRole("combobox", { name: "Language" })).toBeInTheDocument();
        guest.unmount();

        render(
            <ToastProvider>
                <MemoryRouter>
                    <Header />
                </MemoryRouter>
            </ToastProvider>,
        );
        expect(screen.getByRole("combobox", { name: "Language" })).toBeInTheDocument();
    });

    it("changes language without resetting active login fields", () => {
        render(
            <MemoryRouter>
                <Login />
            </MemoryRouter>,
        );
        const phone = screen.getByLabelText("Verified phone number");
        const password = screen.getByLabelText("Password");
        fireEvent.change(phone, { target: { value: "0712345098" } });
        fireEvent.change(password, { target: { value: "working-password" } });
        fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "sw" } });

        expect(screen.getByLabelText("Nambari ya simu iliyothibitishwa")).toHaveValue("0712345098");
        expect(screen.getByLabelText("Nenosiri")).toHaveValue("working-password");
    });
});
