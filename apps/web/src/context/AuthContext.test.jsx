import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";
import WorkerDashboard from "../pages/worker/Dashboard";

const apiMocks = vi.hoisted(() => ({
    get: vi.fn(),
    post: vi.fn(),
}));

vi.mock("../services/api", () => ({ default: apiMocks }));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function SessionProbe() {
    const {
        user,
        token,
        login,
        register,
        loginSessionId,
        logout,
        beginProfileRequest,
        syncProfile,
    } = useAuth();
    const [profileResult, setProfileResult] = React.useState("");
    const [loginOutcome, setLoginOutcome] = React.useState("");
    const [logoutOutcome, setLogoutOutcome] = React.useState("");

    async function attemptLogin(identifier) {
        const result = await login(identifier, "password");
        setLoginOutcome(`${result.success}:${result.status ?? "none"}`);
    }

    async function loadProfile() {
        const request = beginProfileRequest();
        if (!request) {
            setProfileResult("ignored");
            return;
        }
        const response = await apiMocks.get("/api/profile/me");
        setProfileResult(syncProfile(response.data.data.user, request) ? "applied" : "ignored");
    }

    async function signOut() {
        setLogoutOutcome(String(await logout()));
    }

    return (
        <div>
            <span data-testid="user-id">{user?.user_id || "signed-out"}</span>
            <span data-testid="user-role">{user?.role || "signed-out"}</span>
            <span data-testid="auth-token">{token || "signed-out"}</span>
            <span data-testid="user-name">{user?.full_name || ""}</span>
            <span data-testid="user-email">{user?.email || ""}</span>
            <span data-testid="user-phone-verified">{String(user?.phone_verified ?? "")}</span>
            <span data-testid="user-pending-email">{user?.pending_email || ""}</span>
            <span data-testid="user-photo">{String(user?.profile_photo_available ?? "")}</span>
            <span>Login session: {loginSessionId}</span>
            <span data-testid="profile-result">{profileResult}</span>
            <span data-testid="login-outcome">{loginOutcome}</span>
            <span data-testid="logout-outcome">{logoutOutcome}</span>
            <button onClick={() => attemptLogin("account-a")}>Sign in as A</button>
            <button onClick={() => attemptLogin("account-b")}>Sign in as B</button>
            <button onClick={() => register(
                "New Worker",
                "new@example.com",
                "07000000001",
                "OTHER_INFORMAL_WORKER",
                "12345678",
                "1990-04-15",
            )}>
                Register new worker
            </button>
            <button onClick={loadProfile}>Load profile</button>
            <button onClick={signOut}>Sign out</button>
        </div>
    );
}

function DashboardAfterLoginProbe() {
    const { user, login } = useAuth();
    return (
        <div>
            <button onClick={() => login("worker-account", "password")}>Sign in to worker dashboard</button>
            {user && <MemoryRouter><WorkerDashboard /></MemoryRouter>}
        </div>
    );
}

function loginResponse(userId, name, email, photoAvailable, token, phoneVerified = false, pendingEmail = null, role = "WORKER") {
    return {
        data: {
            data: {
                token,
                user: {
                    user_id: userId,
                    full_name: name,
                    email,
                    profile_photo_available: photoAvailable,
                    phone_verified: phoneVerified,
                    pending_email: pendingEmail,
                    role,
                },
            },
        },
    };
}

function profileResponse(userId, fullName, email, photoAvailable, phoneVerified = false, pendingEmail = null) {
    return {
        data: {
            data: {
                user: {
                    user_id: userId,
                    full_name: fullName,
                    email,
                    profile_photo_available: photoAvailable,
                    phone_verified: phoneVerified,
                    pending_email: pendingEmail,
                    updated_at: `2026-10-26T14:00:0${photoAvailable ? "1" : "2"}.000Z`,
                },
            },
        },
    };
}

function renderProbe() {
    return render(
        <AuthProvider>
            <SessionProbe />
        </AuthProvider>
    );
}

describe("AuthContext session-bound profile synchronization", () => {
    afterEach(cleanup);

    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
        apiMocks.get.mockResolvedValue({ data: { data: { user: null } } });
        apiMocks.post.mockImplementation((url, payload) => {
            if (url === "/api/auth/logout") return Promise.resolve({});
            if (url === "/api/auth/register") {
                return Promise.resolve({
                    data: { data: { user: { user_id: "new-user", role: "WORKER", email_verified: false } } },
                });
            }
            const isAccountB = payload.identifier === "account-b";
            return Promise.resolve(loginResponse(
                isAccountB ? "account-b-id" : "account-a-id",
                isAccountB ? "Account B" : "Account A",
                isAccountB ? "b@example.com" : "a@example.com",
                isAccountB,
                isAccountB ? "token-b" : "token-a"
            ));
        });
    });

    it("does not create an authenticated session after email-policy registration", async () => {
        renderProbe();
        fireEvent.click(screen.getByRole("button", { name: "Register new worker" }));

        await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith("/api/auth/register", {
            full_name: "New Worker",
            email: "new@example.com",
            phone: "07000000001",
            occupation: "OTHER_INFORMAL_WORKER",
            national_id: "12345678",
            date_of_birth: "1990-04-15",
        }));
        expect(screen.getByTestId("user-id")).toHaveTextContent("signed-out");
        expect(localStorage.getItem("micopesa_token")).toBeNull();
    });

    it("sends the identifier/password contract and preserves server failure status", async () => {
        apiMocks.post.mockRejectedValueOnce({
            status: 500,
            message: "Login failed due to a server error",
        });

        renderProbe();
        fireEvent.click(screen.getByRole("button", { name: "Sign in as A" }));

        await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith("/api/auth/login", {
            identifier: "account-a",
            password: "password",
        }));
        await waitFor(() => expect(screen.getByTestId("login-outcome")).toHaveTextContent("false:500"));
        expect(screen.getByTestId("user-id")).toHaveTextContent("signed-out");
    });

    it("keeps phone verification and pending email state through login and profile refresh", async () => {
        apiMocks.post.mockResolvedValueOnce(loginResponse(
            "account-a-id",
            "Account A",
            "a@example.com",
            false,
            "token-a",
            false,
            "pending@example.com",
        ));
        apiMocks.get.mockResolvedValueOnce(profileResponse(
            "account-a-id",
            "Account A",
            "a@example.com",
            false,
            true,
            "next@example.com",
        ));
        renderProbe();
        fireEvent.click(screen.getByRole("button", { name: "Sign in as A" }));

        await waitFor(() => expect(screen.getByTestId("user-phone-verified")).toHaveTextContent("false"));
        expect(screen.getByTestId("user-pending-email")).toHaveTextContent("pending@example.com");
        fireEvent.click(screen.getByRole("button", { name: "Load profile" }));
        await waitFor(() => expect(screen.getByTestId("user-phone-verified")).toHaveTextContent("true"));
        expect(screen.getByTestId("user-pending-email")).toHaveTextContent("next@example.com");
    });

    it("ignores a profile response that completes after sign-out", async () => {
        const pendingProfile = deferred();
        const pendingLogout = deferred();
        apiMocks.get.mockReturnValueOnce(pendingProfile.promise);
        apiMocks.post.mockImplementation((url) =>
            url === "/api/auth/logout" ? pendingLogout.promise : Promise.resolve(loginResponse(
                "account-a-id", "Account A", "a@example.com", true, "token-a"
            ))
        );

        renderProbe();
        fireEvent.click(screen.getByRole("button", { name: "Sign in as A" }));
        await waitFor(() => expect(screen.getByTestId("user-id")).toHaveTextContent("account-a-id"));
        fireEvent.click(screen.getByRole("button", { name: "Load profile" }));
        await waitFor(() => expect(apiMocks.get).toHaveBeenCalledWith("/api/profile/me"));

        fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
        fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
        await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith("/api/auth/logout"));
        expect(apiMocks.post.mock.calls.filter(([url]) => url === "/api/auth/logout")).toHaveLength(1);
        expect(screen.getByTestId("user-id")).toHaveTextContent("account-a-id");
        expect(localStorage.getItem("micopesa_token")).toBe("token-a");

        pendingProfile.resolve(profileResponse("account-a-id", "A Private Name", "private-a@example.com", true));
        await waitFor(() => expect(screen.getByTestId("profile-result")).toHaveTextContent("ignored"));

        pendingLogout.resolve({});
        await waitFor(() => expect(screen.getByTestId("user-id")).toHaveTextContent("signed-out"));
        expect(screen.getByTestId("user-name")).toBeEmptyDOMElement();
        expect(screen.getByTestId("user-email")).toBeEmptyDOMElement();
        expect(screen.getByTestId("user-photo")).toBeEmptyDOMElement();
        expect(localStorage.getItem("micopesa_token")).toBeNull();
        await waitFor(() => expect(screen.getByTestId("logout-outcome")).toHaveTextContent("true"));
    });

    it("clears the local session even when the explicit logout request fails", async () => {
        apiMocks.post.mockImplementation((url) => {
            if (url === "/api/auth/logout") return Promise.reject(new Error("network unavailable"));
            if (url === "/api/auth/login") {
                return Promise.resolve(loginResponse(
                    "account-a-id", "Account A", "a@example.com", false, "token-a"
                ));
            }
            return Promise.resolve({});
        });
        renderProbe();
        fireEvent.click(screen.getByRole("button", { name: "Sign in as A" }));
        await waitFor(() => expect(screen.getByTestId("user-id")).toHaveTextContent("account-a-id"));

        fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

        await waitFor(() => {
            expect(screen.getByTestId("user-id")).toHaveTextContent("signed-out");
            expect(screen.getByTestId("auth-token")).toHaveTextContent("signed-out");
        });
        expect(localStorage.getItem("micopesa_token")).toBeNull();
        await waitFor(() => expect(screen.getByTestId("logout-outcome")).toHaveTextContent("false"));
    });

    it("clears an existing session when an explicit login attempt fails", async () => {
        apiMocks.post
            .mockResolvedValueOnce(loginResponse("account-a-id", "Account A", "a@example.com", false, "token-a"))
            .mockRejectedValueOnce({ status: 401, message: "Invalid phone number or password" });
        renderProbe();
        fireEvent.click(screen.getByRole("button", { name: "Sign in as A" }));
        await waitFor(() => expect(screen.getByTestId("user-id")).toHaveTextContent("account-a-id"));

        fireEvent.click(screen.getByRole("button", { name: "Sign in as B" }));
        await waitFor(() => expect(screen.getByTestId("login-outcome")).toHaveTextContent("false:401"));
        expect(screen.getByTestId("user-id")).toHaveTextContent("signed-out");
        expect(screen.getByTestId("user-role")).toHaveTextContent("signed-out");
        expect(screen.getByTestId("auth-token")).toHaveTextContent("signed-out");
        expect(localStorage.getItem("micopesa_token")).toBeNull();
    });

    it("clears the current session when an authenticated request reports an invalid session", async () => {
        apiMocks.post.mockResolvedValueOnce(loginResponse(
            "account-a-id", "Account A", "a@example.com", false, "token-a"
        ));
        renderProbe();
        fireEvent.click(screen.getByRole("button", { name: "Sign in as A" }));
        await waitFor(() => expect(screen.getByTestId("user-id")).toHaveTextContent("account-a-id"));

        localStorage.removeItem("micopesa_token");
        window.dispatchEvent(new Event("micopesa:auth-invalid"));

        await waitFor(() => {
            expect(screen.getByTestId("user-id")).toHaveTextContent("signed-out");
            expect(screen.getByTestId("auth-token")).toHaveTextContent("signed-out");
        });
    });

    it("does not merge a delayed account A response after account B signs in", async () => {
        const pendingProfile = deferred();
        apiMocks.get.mockReturnValueOnce(pendingProfile.promise);
        renderProbe();

        fireEvent.click(screen.getByRole("button", { name: "Sign in as A" }));
        await waitFor(() => expect(screen.getByTestId("user-id")).toHaveTextContent("account-a-id"));
        fireEvent.click(screen.getByRole("button", { name: "Load profile" }));
        await waitFor(() => expect(apiMocks.get).toHaveBeenCalledTimes(1));

        fireEvent.click(screen.getByRole("button", { name: "Sign in as B" }));
        await waitFor(() => expect(screen.getByTestId("user-id")).toHaveTextContent("account-b-id"));
        pendingProfile.resolve(profileResponse("account-a-id", "A Private Name", "private-a@example.com", false));
        await waitFor(() => expect(screen.getByTestId("profile-result")).toHaveTextContent("ignored"));

        expect(screen.getByTestId("user-name")).toHaveTextContent("Account B");
        expect(screen.getByTestId("user-email")).toHaveTextContent("b@example.com");
        expect(screen.getByTestId("user-photo")).toHaveTextContent("true");
        expect(screen.queryByText("A Private Name")).not.toBeInTheDocument();
        expect(screen.queryByText("private-a@example.com")).not.toBeInTheDocument();
    });

    it("applies only the latest of two profile requests completed in reverse order", async () => {
        const firstProfile = deferred();
        const secondProfile = deferred();
        apiMocks.get
            .mockReturnValueOnce(firstProfile.promise)
            .mockReturnValueOnce(secondProfile.promise);
        renderProbe();
        fireEvent.click(screen.getByRole("button", { name: "Sign in as A" }));
        await waitFor(() => expect(screen.getByTestId("user-id")).toHaveTextContent("account-a-id"));

        fireEvent.click(screen.getByRole("button", { name: "Load profile" }));
        await waitFor(() => expect(apiMocks.get).toHaveBeenCalledTimes(1));
        fireEvent.click(screen.getByRole("button", { name: "Load profile" }));
        await waitFor(() => expect(apiMocks.get).toHaveBeenCalledTimes(2));

        secondProfile.resolve(profileResponse("account-a-id", "Latest Name", "latest@example.com", true));
        await waitFor(() => expect(screen.getByTestId("user-name")).toHaveTextContent("Latest Name"));
        firstProfile.resolve(profileResponse("account-a-id", "Stale Name", "stale@example.com", false));
        await waitFor(() => expect(screen.getByTestId("profile-result")).toHaveTextContent("ignored"));

        expect(screen.getByTestId("user-name")).toHaveTextContent("Latest Name");
        expect(screen.getByTestId("user-email")).toHaveTextContent("latest@example.com");
        expect(screen.getByTestId("user-photo")).toHaveTextContent("true");
    });

    it("merges a valid profile response for the current authenticated user", async () => {
        apiMocks.get.mockResolvedValueOnce(
            profileResponse("account-a-id", "Updated A", "updated-a@example.com", true)
        );
        renderProbe();
        fireEvent.click(screen.getByRole("button", { name: "Sign in as A" }));
        await waitFor(() => expect(screen.getByTestId("user-id")).toHaveTextContent("account-a-id"));
        fireEvent.click(screen.getByRole("button", { name: "Load profile" }));

        await waitFor(() => {
            expect(screen.getByTestId("user-name")).toHaveTextContent("Updated A");
            expect(screen.getByTestId("user-email")).toHaveTextContent("updated-a@example.com");
            expect(screen.getByTestId("user-photo")).toHaveTextContent("true");
        });
        expect(screen.getByTestId("profile-result")).toHaveTextContent("applied");
    });

    it("assigns a distinct generation to each successful login", async () => {
        renderProbe();
        fireEvent.click(screen.getByRole("button", { name: "Sign in as A" }));
        await waitFor(() => expect(screen.getByText("Login session: 1")).toBeInTheDocument());
        fireEvent.click(screen.getByRole("button", { name: "Sign in as B" }));
        await waitFor(() => expect(screen.getByText("Login session: 2")).toBeInTheDocument());
    });

    it("replaces the authenticated user, role, and token when switching accounts", async () => {
        apiMocks.post
            .mockResolvedValueOnce(loginResponse(
                "account-a-id", "Account A", "a@example.com", false, "token-a"
            ))
            .mockResolvedValueOnce(loginResponse(
                "account-b-id", "Account B", "b@example.com", true, "token-b", false, null, "ADMIN"
            ));
        renderProbe();
        fireEvent.click(screen.getByRole("button", { name: "Sign in as A" }));
        await waitFor(() => expect(screen.getByTestId("user-id")).toHaveTextContent("account-a-id"));
        expect(screen.getByTestId("user-role")).toHaveTextContent("WORKER");

        fireEvent.click(screen.getByRole("button", { name: "Sign in as B" }));
        await waitFor(() => {
            expect(screen.getByTestId("user-id")).toHaveTextContent("account-b-id");
            expect(screen.getByTestId("user-role")).toHaveTextContent("ADMIN");
            expect(screen.getByTestId("auth-token")).toHaveTextContent("token-b");
        });
        expect(localStorage.getItem("micopesa_token")).toBe("token-b");
    });

    it("loads the worker dashboard after a successful login with the current session", async () => {
        apiMocks.post.mockResolvedValueOnce(loginResponse(
            "worker-dashboard-user",
            "Dashboard Worker",
            "worker@example.com",
            false,
            "dashboard-session-token"
        ));
        apiMocks.get.mockImplementation((url) => {
            if (url === "/api/accounts/my-balance") {
                return Promise.resolve({ data: { data: { current_balance: "12300.00", account_status: "ACTIVE" } } });
            }
            if (url === "/api/accounts/my-contributions") {
                return Promise.resolve({ data: { data: [{ amount: "300.00", contribution_status: "COMPLETED" }] } });
            }
            if (url === "/api/retirement/my-plan") {
                return Promise.resolve({ data: { data: { plan: { target_amount: "600000.00", target_age: 60 } } } });
            }
            return Promise.resolve({ data: { data: { user: null } } });
        });
        render(
            <AuthProvider>
                <DashboardAfterLoginProbe />
            </AuthProvider>
        );

        fireEvent.click(screen.getByRole("button", { name: "Sign in to worker dashboard" }));

        expect(await screen.findByRole("heading", { name: /Good .*Dashboard/ })).toBeInTheDocument();
        expect(await screen.findByText("KSh 12,300.00")).toBeInTheDocument();
        expect(screen.getByText("Recorded total KSh 300.00")).toBeInTheDocument();
        expect(screen.getByText("Goal KSh 600,000.00")).toBeInTheDocument();
        expect(localStorage.getItem("micopesa_token")).toBe("dashboard-session-token");
        expect(apiMocks.get).toHaveBeenCalledWith("/api/accounts/my-balance");
        expect(apiMocks.get).toHaveBeenCalledWith("/api/accounts/my-contributions");
        expect(apiMocks.get).toHaveBeenCalledWith("/api/retirement/my-plan");
    });
});
