import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui/ToastContext";
import Header from "./Header";

const mocks = vi.hoisted(() => ({
    logout: vi.fn(),
}));

vi.mock("../context/AuthContext", () => ({
    useAuth: () => ({
        user: { user_id: "admin-1", role: "ADMIN", full_name: "Test Administrator" },
        logout: mocks.logout,
    }),
}));

describe("Header logout audit feedback", () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    it("notifies the signed-out user when the server could not record logout", async () => {
        mocks.logout.mockResolvedValue(false);
        render(
            <MemoryRouter>
                <ToastProvider>
                    <Header />
                </ToastProvider>
            </MemoryRouter>
        );

        fireEvent.click(screen.getByRole("button", { name: "Log out" }));

        await waitFor(() => expect(mocks.logout).toHaveBeenCalledOnce());
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "You were signed out on this device, but the server could not record the logout event."
        );
    });
});
