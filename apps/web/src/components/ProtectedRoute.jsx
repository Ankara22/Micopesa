import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import SkeletonLoader from "./ui/SkeletonLoader";
import ErrorState from "./ui/ErrorState";

/**
 * Wraps a route element and only renders it if the user is authenticated
 * (and, if `allowedRoles` is provided, holds one of those roles).
 *
 * - Not authenticated -> redirect to /login (remembers the attempted
 *   location so Login can send the user back afterwards).
 * - Authenticated but wrong role -> redirect to /unauthorized.
 */
function ProtectedRoute({ children, allowedRoles }) {
    const { isAuthenticated, isLoading, user, refreshUser, logout } = useAuth();
    const location = useLocation();
    const [validatedPath, setValidatedPath] = useState(null);
    const [roleRefreshError, setRoleRefreshError] = useState({ path: null, message: "" });

    useEffect(() => {
        if (!isAuthenticated || typeof refreshUser !== "function") return undefined;
        let current = true;
        let validating = false;
        const validateCurrentRole = async () => {
            if (validating) return;
            validating = true;
            try {
                const refreshed = await refreshUser();
                if (current && refreshed) {
                    setValidatedPath(location.pathname);
                } else if (current) {
                    setRoleRefreshError({
                        path: location.pathname,
                        message: "Your session changed while permissions were being checked. Please retry.",
                    });
                }
            } catch (error) {
                if (!current) return;
                if (error.status === 401 || error.status === 403) {
                    await logout?.();
                    return;
                }
                setRoleRefreshError({
                    path: location.pathname,
                    message: "We could not verify your current access. Please retry.",
                });
            } finally {
                validating = false;
            }
        };
        // Validate authorization against /me when navigation changes and periodically.
        validateCurrentRole();
        const interval = window.setInterval(validateCurrentRole, 30000);
        return () => {
            current = false;
            window.clearInterval(interval);
        };
    }, [isAuthenticated, location.pathname, refreshUser, logout]);

    if (isLoading) {
        return <SkeletonLoader variant="dashboard" count={3} label="Checking your sign-in and loading the app" />;
    }

    if (!isAuthenticated) {
        return <Navigate to="/login" state={{ from: location }} replace />;
    }

    if (user?.force_password_change && location.pathname !== "/change-password") {
        return <Navigate to="/change-password" replace />;
    }

    if (typeof refreshUser === "function" && validatedPath !== location.pathname) {
        if (roleRefreshError.path === location.pathname) {
            return <ErrorState message={roleRefreshError.message} onRetry={() => {
                setValidatedPath(null);
                refreshUser().then((refreshed) => {
                    if (refreshed) {
                        setRoleRefreshError({ path: null, message: "" });
                        setValidatedPath(location.pathname);
                    } else {
                        setRoleRefreshError({
                            path: location.pathname,
                            message: "Your session changed while permissions were being checked. Please retry.",
                        });
                    }
                }).catch((error) => {
                    if (error.status === 401 || error.status === 403) {
                        logout?.();
                        return;
                    }
                    setRoleRefreshError({
                        path: location.pathname,
                        message: "We could not verify your current access. Please retry.",
                    });
                });
            }} />;
        }
        return <SkeletonLoader variant="dashboard" count={3} label="Checking your current role and permissions" />;
    }

    if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
        return <Navigate to="/unauthorized" replace />;
    }

    return children;
}

export default ProtectedRoute;
