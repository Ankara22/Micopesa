import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

/**
 * Wraps a route element and only renders it if the user is authenticated
 * (and, if `allowedRoles` is provided, holds one of those roles).
 *
 * - Not authenticated -> redirect to /login (remembers the attempted
 *   location so Login can send the user back afterwards).
 * - Authenticated but wrong role -> redirect to /unauthorized.
 */
function ProtectedRoute({ children, allowedRoles }) {
    const { isAuthenticated, isLoading, user } = useAuth();
    const location = useLocation();

    if (isLoading) {
        return (
            <div className="auth-loading">
                <p>Loading...</p>
            </div>
        );
    }

    if (!isAuthenticated) {
        return <Navigate to="/login" state={{ from: location }} replace />;
    }

    if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
        return <Navigate to="/unauthorized" replace />;
    }

    return children;
}

export default ProtectedRoute;
