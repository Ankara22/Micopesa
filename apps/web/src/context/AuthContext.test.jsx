import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";

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
        login,
        register,
        loginSessionId,
        logout,
        beginProfileRequest,
        syncProfile,
    } = useAuth();
    const [profileResult, setProfileResult] = React.useState("");
    const [loginOutcome, setLoginOutcome] = React.useState("");

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

    return (
        <div>
            <span data-testid="user-id">{user?.user_id || "signed-out"}</span>
            <span data-testid="user-name">{user?.full_name || ""}</span>
            <span data-testid="user-email">{user?.email || ""}</span>
            <span data-testid="user-photo">{String(user?.profile_photo_available ?? "")}</span>
            <span>Login session: {loginSessionId}</span>
            <span data-testid="profile-result">{profileResult}</span>
            <span data-testid="login-outcome">{loginOutcome}</span>
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
            <button onClick={logout}>Sign out</button>
        </div>
    );
}

function loginResponse(userId, name, email, photoAvailable, token) {
    return {
        data: {
            data: {
                token,
                user: {
                    user_id: userId,
                    full_name: name,
                    email,
                    profile_photo_available: photoAvailable,
                    role: "WORKER",
                },
            },
        },
    };
}

function profileResponse(userId, fullName, email, photoAvailable) {
    return {
        data: {
            data: {
                user: {
                    user_id: userId,
                    full_name: fullName,
                    email,
                    profile_photo_available: photoAvailable,
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
        await waitFor(() => expect(screen.getByTestId("user-id")).toHaveTextContent("signed-out"));
        pendingProfile.resolve(profileResponse("account-a-id", "A Private Name", "private-a@example.com", true));
        await waitFor(() => expect(screen.getByTestId("profile-result")).toHaveTextContent("ignored"));

        expect(screen.getByTestId("user-name")).toBeEmptyDOMElement();
        expect(screen.getByTestId("user-email")).toBeEmptyDOMElement();
        expect(screen.getByTestId("user-photo")).toBeEmptyDOMElement();
        pendingLogout.resolve({});
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
});
