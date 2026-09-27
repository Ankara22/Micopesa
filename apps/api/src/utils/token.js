const jwt = require("jsonwebtoken");

const DEFAULT_EXPIRY = "1d";

/**
 * Reads the JWT secret from the environment. Throws instead of silently
 * signing/verifying with `undefined` so a missing secret fails loudly
 * during development rather than producing insecure tokens.
 */
function getSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error("JWT_SECRET is not set. Configure it in your .env file.");
    }
    return secret;
}

/**
 * Signs a JWT for the given payload (e.g. { userId, role }).
 * Expiry is controlled by JWT_EXPIRES_IN (defaults to "1d").
 */
function generateToken(payload) {
    const expiresIn = process.env.JWT_EXPIRES_IN || DEFAULT_EXPIRY;
    return jwt.sign(payload, getSecret(), { expiresIn });
}

/**
 * Verifies a raw JWT string and returns its decoded payload, or throws
 * (jwt.TokenExpiredError / JsonWebTokenError) if invalid/expired.
 */
function verifyTokenString(token) {
    return jwt.verify(token, getSecret());
}

module.exports = { generateToken, verifyTokenString };
