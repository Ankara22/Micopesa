const { verifyTokenString } = require("../utils/token");

/**
 * Validates the JWT sent in the "Authorization: Bearer <token>" header and
 * attaches { userId, role } to req.user for downstream handlers.
 */
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
            status: "error",
            message: "Missing or malformed Authorization header. Expected 'Bearer <token>'.",
        });
    }

    const token = authHeader.slice("Bearer ".length).trim();

    if (!token) {
        return res.status(401).json({
            status: "error",
            message: "Missing or malformed Authorization header. Expected 'Bearer <token>'.",
        });
    }

    try {
        const decoded = verifyTokenString(token);
        req.user = {
            userId: decoded.userId,
            role: decoded.role,
        };
        return next();
    } catch (error) {
        if (error.name === "TokenExpiredError") {
            return res.status(401).json({
                status: "error",
                message: "Your session has expired. Please log in again.",
            });
        }
        return res.status(401).json({
            status: "error",
            message: "Invalid authentication token",
        });
    }
}

// Backward-compatible alias - existing routes (e.g. accountRoutes.js) import
// this middleware as `verifyToken`.
const verifyToken = requireAuth;

/**
 * Restricts a route to one or more roles. Must be used after requireAuth.
 * Supports both call styles:
 *   requireRole('ADMIN')
 *   requireRole('FUND_MANAGER', 'REGULATOR')
 *   requireRole(['WORKER'])   <- array form, kept for backward compatibility
 */
function requireRole(...roles) {
    const allowedRoles = roles.flat();

    return (req, res, next) => {
        if (!req.user || !req.user.role) {
            return res.status(401).json({
                status: "error",
                message: "Authentication required",
            });
        }

        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                status: "error",
                message: "You do not have permission to perform this action",
            });
        }

        return next();
    };
}

module.exports = { requireAuth, verifyToken, requireRole };