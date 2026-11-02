import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ProtectedRoute from "./ProtectedRoute";

const authMock = vi.hoisted(() => ({ useAuth: vi.fn() }));

vi.mock("../context/AuthContext", () => ({
    useAuth: authMock.useAuth,
}));

describe("ProtectedRoute loading", () => {
    afterEach(cleanup);

    it("does not render a protected dashboard while session restoration is pending", () => {
        authMock.useAuth.mockReturnValue({
            isAuthenticated: false,
            isLoading: true,
            user: null,
        });

        render(
            <MemoryRouter initialEntries={["/worker/dashboard"]}>
                <Routes>
                    <Route
                        path="/worker/dashboard"
                        element={
                            <ProtectedRoute allowedRoles={["WORKER"]}>
                                <h1>Worker dashboard</h1>
                            </ProtectedRoute>
                        }
                    />
                    <Route path="/login" element={<h1>Login page</h1>} />
                </Routes>
            </MemoryRouter>
        );

        expect(screen.getByRole("status", { name: "Checking your sign-in and loading the app" }))
            .toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "Worker dashboard" })).not.toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "Login page" })).not.toBeInTheDocument();
    });

    it("keeps retirement-projection routes limited to authenticated workers", () => {
        authMock.useAuth.mockReturnValue({
            isAuthenticated: true,
            isLoading: false,
            user: { role: "ADMIN" },
        });

        render(
            <MemoryRouter initialEntries={["/worker/retirement-projection"]}>
                <Routes>
                    <Route
                        path="/worker/retirement-projection"
                        element={
                            <ProtectedRoute allowedRoles={["WORKER"]}>
                                <h1>Retirement Projection</h1>
                            </ProtectedRoute>
                        }
                    />
                    <Route path="/unauthorized" element={<h1>Unauthorized</h1>} />
                </Routes>
            </MemoryRouter>
        );

        expect(screen.getByRole("heading", { name: "Unauthorized" })).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "Retirement Projection" })).not.toBeInTheDocument();
    });

    it("refreshes a stale local role before allowing access to its former protected page", async () => {
        const user = { role: "REGULATOR" };
        authMock.useAuth.mockReturnValue({
            isAuthenticated: true,
            isLoading: false,
            user,
            refreshUser: vi.fn(async () => {
                user.role = "WORKER";
                return user;
            }),
            logout: vi.fn(),
        });

        render(
            <MemoryRouter initialEntries={["/regulator/dashboard"]}>
                <Routes>
                    <Route
                        path="/regulator/dashboard"
                        element={
                            <ProtectedRoute allowedRoles={["REGULATOR"]}>
                                <h1>Regulator dashboard</h1>
                            </ProtectedRoute>
                        }
                    />
                    <Route path="/unauthorized" element={<h1>Unauthorized</h1>} />
                </Routes>
            </MemoryRouter>
        );

        expect(await screen.findByRole("heading", { name: "Unauthorized" })).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "Regulator dashboard" })).not.toBeInTheDocument();
    });
});
