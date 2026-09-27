import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import api from "../services/api";

const TOKEN_KEY = "micopesa_token";

const AuthContext = createContext(undefined);

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);

    // Bumped on every explicit login/register/logout so that a slow,
    // still-in-flight request from an earlier session (e.g. the initial
    // GET /api/auth/me issued on mount) can detect it is stale and avoid
    // clobbering a newer session's state when it finally resolves.
    const sessionVersionRef = useRef(0);

    const clearSession = useCallback(() => {
        sessionVersionRef.current += 1;
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setUser(null);
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
                    setUser(response.data.data.user);
                    setToken(storedToken);
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

    const login = useCallback(async (phone, password) => {
        setError(null);
        try {
            const response = await api.post("/api/auth/login", { phone, password });
            const { token: newToken, user: loggedInUser } = response.data.data;
            sessionVersionRef.current += 1;
            localStorage.setItem(TOKEN_KEY, newToken);
            setToken(newToken);
            setUser(loggedInUser);
            return { success: true, user: loggedInUser };
        } catch (err) {
            setError(err.message);
            return { success: false, message: err.message };
        }
    }, []);

    const register = useCallback(async (full_name, phone, password) => {
        setError(null);
        try {
            const response = await api.post("/api/auth/register", { full_name, phone, password });
            const { token: newToken, user: newUser } = response.data.data;
            sessionVersionRef.current += 1;
            localStorage.setItem(TOKEN_KEY, newToken);
            setToken(newToken);
            setUser(newUser);
            return { success: true, user: newUser };
        } catch (err) {
            setError(err.message);
            return { success: false, message: err.message };
        }
    }, []);

    const logout = useCallback(async () => {
        try {
            await api.post("/api/auth/logout");
        } catch {
            // Best-effort only: the API's JWTs are stateless, so logout is
            // primarily a client-side action. We still clear the local
            // session below regardless of whether this call succeeds.
        } finally {
            clearSession();
        }
    }, [clearSession]);

    const value = {
        user,
        token,
        isAuthenticated: Boolean(token && user),
        isLoading,
        error,
        login,
        register,
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
