const { verifyTokenString } = require("../utils/token");

/**
 * Validates the JWT sent in the "Authorization: Bearer <token>" header and
 * attaches { userId, role } to req.user for downstream handlers.
 */
const pool = require("../db/database");
const VALID_ROLES = ["WORKER", "FUND_MANAGER", "REGULATOR", "ADMIN"];

async function requireAuth(req, res, next) {
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

    let decoded;
    try {
        decoded = verifyTokenString(token);
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

    if (!decoded || typeof decoded.userId !== "string" || decoded.userId.trim() === "") {
        return res.status(401).json({
            status: "error",
            message: "Invalid authentication token",
        });
    }

    let result;
    try {
        result = await pool.query(
            `SELECT user_id, role, account_status, auth_version, force_password_change,
                    is_temp_password FROM users WHERE user_id = $1`,
            [decoded.userId]
        );
    } catch (error) {
        console.error("Authentication user lookup failed:", error);
        return res.status(500).json({
            status: "error",
            message: "Authentication service temporarily unavailable",
        });
    }

    const user = result.rows[0];
    if (!user) {
        return res.status(401).json({
            status: "error",
            message: "Invalid authentication token",
        });
    }

    if (user.account_status !== "ACTIVE") {
        return res.status(403).json({
            status: "error",
            message: "This account is not active",
        });
    }

    const authVersion = Number.isInteger(user.auth_version) ? user.auth_version : 0;
    if (
        (decoded.authVersion === undefined ? authVersion !== 0 : decoded.authVersion !== authVersion) ||
        !VALID_ROLES.includes(user.role)
    ) {
        return res.status(401).json({
            status: "error",
            message: "Your session is no longer valid. Please sign in again.",
        });
    }

    const passwordChangeAllowedPaths = new Set(["/me", "/logout", "/change-password"]);
    if (user.force_password_change && !passwordChangeAllowedPaths.has(req.path)) {
        return res.status(403).json({
            status: "error",
            code: "PASSWORD_CHANGE_REQUIRED",
            message: "Change your temporary password before continuing.",
        });
    }

    req.user = {
        userId: user.user_id,
        role: user.role,
        forcePasswordChange: Boolean(user.force_password_change),
        isTempPassword: Boolean(user.is_temp_password),
    };
    return next();
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