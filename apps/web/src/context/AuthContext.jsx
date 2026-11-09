import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import api from "../services/api";

const TOKEN_KEY = "micopesa_token";

const AuthContext = createContext(undefined);

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
    const [loginSessionId, setLoginSessionId] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);

    // Bumped on every explicit login/register/logout so that a slow,
    // still-in-flight request from an earlier session (e.g. the initial
    // GET /api/auth/me issued on mount) can detect it is stale and avoid
    // clobbering a newer session's state when it finally resolves.
    const sessionVersionRef = useRef(0);
    const authSessionRef = useRef({ userId: null, token: null, generation: 0 });
    const authUserRef = useRef(null);
    const profileRequestIdRef = useRef(0);

    const clearSession = useCallback(() => {
        const generation = ++sessionVersionRef.current;
        profileRequestIdRef.current += 1;
        authSessionRef.current = { userId: null, token: null, generation };
        authUserRef.current = null;
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setUser(null);
        setLoginSessionId(generation);
    }, []);

    // On initial mount, if a token is already stored, verify it's still
    // valid and restore the user session via GET /api/auth/me.
    useEffect(() => {
        let isMounted = true;
        const versionAtStart = sessionVersionRef.current;

        async function restoreSession() {
            const storedToken = localStorage.getItem(TOKEN_KEY);

            if (!storedToken) {
                if (isMounted) setIsLoading(false);
                return;
            }

            try {
                const response = await api.get("/api/auth/me");
                const isStale = sessionVersionRef.current !== versionAtStart;
                if (isMounted && !isStale) {
                    const currentUser = response.data.data.user;
                    const generation = ++sessionVersionRef.current;
                    profileRequestIdRef.current += 1;
                    authSessionRef.current = {
                        userId: currentUser.user_id,
                        token: storedToken,
                        generation,
                    };
                    authUserRef.current = currentUser;
                    setUser(currentUser);
                    setToken(storedToken);
                    setLoginSessionId(generation);
                }
            } catch {
                // Token is invalid/expired - clear it silently and fall
                // back to the logged-out state (only if nothing newer has
                // happened in the meantime).
                if (isMounted && sessionVersionRef.current === versionAtStart) clearSession();
            } finally {
                if (isMounted) setIsLoading(false);
            }
        }

        restoreSession();

        return () => {
            isMounted = false;
        };
    }, [clearSession]);

    const login = useCallback(async (identifier, password) => {
        setError(null);
        try {
            const response = await api.post("/api/auth/login", { identifier, password });
            const { token: newToken, user: loggedInUser } = response.data.data;
            const generation = ++sessionVersionRef.current;
            profileRequestIdRef.current += 1;
            authSessionRef.current = {
                userId: loggedInUser.user_id,
                token: newToken,
                generation,
            };
            authUserRef.current = loggedInUser;
            localStorage.setItem(TOKEN_KEY, newToken);
            setToken(newToken);
            setUser(loggedInUser);
            setLoginSessionId(generation);
            return { success: true, user: loggedInUser };
        } catch (err) {
            setError(err.message);
            return {
                success: false,
                message: err.message,
                status: Number.isInteger(err?.status) ? err.status : null,
            };
        }
    }, []);

    const changeTemporaryPassword = useCallback(async (newPassword) => {
        const response = await api.post("/api/auth/change-password", { new_password: newPassword });
        const newToken = response.data.data.token;
        const currentUser = authUserRef.current;
        if (!currentUser) throw new Error("Your session is no longer available. Please sign in again.");

        const updatedUser = {
            ...currentUser,
            is_temp_password: false,
            force_password_change: false,
        };
        const generation = ++sessionVersionRef.current;
        profileRequestIdRef.current += 1;
        authSessionRef.current = { userId: updatedUser.user_id, token: newToken, generation };
        authUserRef.current = updatedUser;
        localStorage.setItem(TOKEN_KEY, newToken);
        setToken(newToken);
        setUser(updatedUser);
        setLoginSessionId(generation);
        return updatedUser;
    }, []);

    const refreshUser = useCallback(async () => {
        const versionAtStart = sessionVersionRef.current;
        const tokenAtStart = localStorage.getItem(TOKEN_KEY);
        if (!tokenAtStart) {
            throw new Error("Your session is no longer available. Please sign in again.");
        }

        const response = await api.get("/api/auth/me");
        if (
            sessionVersionRef.current !== versionAtStart ||
            localStorage.getItem(TOKEN_KEY) !== tokenAtStart
        ) {
            return null;
        }

        const currentUser = response.data.data.user;
        authUserRef.current = currentUser;
        setUser(currentUser);
        return currentUser;
    }, []);

    const beginProfileRequest = useCallback(() => {
        const session = authSessionRef.current;
        if (!session.userId || !session.token || localStorage.getItem(TOKEN_KEY) !== session.token) {
            return null;
        }
        return {
            userId: session.userId,
            token: session.token,
            generation: session.generation,
            requestId: ++profileRequestIdRef.current,
        };
    }, []);

    const isProfileRequestCurrent = useCallback((request) => {
        const session = authSessionRef.current;
        return Boolean(
            request &&
            request.requestId === profileRequestIdRef.current &&
            request.generation === sessionVersionRef.current &&
            request.generation === session.generation &&
            request.userId === session.userId &&
            request.token === session.token &&
            authUserRef.current?.user_id === request.userId &&
            localStorage.getItem(TOKEN_KEY) === request.token
        );
    }, []);

    const syncProfile = useCallback((profile, request, { photoUpdated = false } = {}) => {
        if (!isProfileRequestCurrent(request) || profile?.user_id !== request.userId) return false;
        const current = authUserRef.current;
        if (!current || current.user_id !== profile.user_id) return false;
        const updatedUser = {
            ...current,
            full_name: profile.full_name,
            email: profile.email,
            email_verified: profile.email_verified,
            pending_email: profile.pending_email,
            updated_at: profile.updated_at,
            profile_photo_available: profile.profile_photo_available,
            profile_photo_version: photoUpdated
                ? (current.profile_photo_version || 0) + 1
                : current.profile_photo_version || 0,
        };
        authUserRef.current = updatedUser;
        setUser(updatedUser);
        return true;
    }, [isProfileRequestCurrent]);

    const logout = useCallback(async () => {
        const generation = ++sessionVersionRef.current;
        profileRequestIdRef.current += 1;
        authSessionRef.current = { userId: null, token: null, generation };
        authUserRef.current = null;
        setUser(null);
        setToken(null);
        setLoginSessionId(generation);
        try {
            await api.post("/api/auth/logout");
        } catch {
            // Best-effort only: the API's JWTs are stateless, so logout is
            // primarily a client-side action. The local session is cleared below.
        } finally {
            if (sessionVersionRef.current === generation) {
                localStorage.removeItem(TOKEN_KEY);
            }
        }
    }, []);
    const register = useCallback(async (full_name, email, phone, password, occupation, national_id, date_of_birth) => {
        setError(null);
        try {
            const payload = { full_name, email, phone, password, occupation };
            if (national_id !== undefined) payload.national_id = national_id;
            if (date_of_birth !== undefined) payload.date_of_birth = date_of_birth;
            const response = await api.post("/api/auth/register", payload);
            const { user: newUser, verificationEmailSent } = response.data.data;
            return { success: true, user: newUser, verificationEmailSent };
        } catch (err) {
            setError(err.message);
            return { success: false, message: err.message };
        }
    }, []);

    const value = {
        user,
        token,
        loginSessionId,
        isAuthenticated: Boolean(token && user),
        isLoading,
        error,
        login,
        changeTemporaryPassword,
        register,
        refreshUser,
        beginProfileRequest,
        isProfileRequestCurrent,
        syncProfile,
        logout,
    };

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}
