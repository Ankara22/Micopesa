const bcrypt = require("bcrypt");
const pool = require("../db/database");
const { generateToken } = require("../utils/token");

const SALT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 8;
const VALID_OCCUPATIONS = [
    "BODA_BODA_OPERATOR",
    "MARKET_VENDOR",
    "JUA_KALI_ARTISAN",
    "DOMESTIC_WORKER",
    "CASUAL_LABOURER",
    "SMALL_SCALE_FARMER",
    "OTHER_INFORMAL_WORKER",
];

// Roles a user could theoretically hold, per the users.role CHECK constraint
// in database/schema.sql. Public registration is NOT allowed to assign any
// of these directly from client input - see `register` below.
const VALID_ROLES = ["WORKER", "FUND_MANAGER", "REGULATOR", "ADMIN"];
const PUBLIC_REGISTRATION_ROLE = "WORKER";

/**
 * LOCAL DEVELOPMENT ONLY. When ALLOW_PRIVILEGED_SIGNUP=true, the register
 * endpoint additionally accepts a client-supplied `role` (validated against
 * the exact VALID_ROLES allowlist) so a developer without working
 * ADMIN/FUND_MANAGER/REGULATOR credentials can create test accounts for
 * every role. Read fresh on every call (not cached at module load) so it
 * can be toggled without restarting the server during local testing.
 *
 * Default (absent/false): public registration always forces WORKER,
 * exactly as before. This flag must NEVER be enabled in production.
 */
function isPrivilegedSignupAllowed() {
    return process.env.ALLOW_PRIVILEGED_SIGNUP === "true";
}

/**
 * POST /api/auth/register
 * Body: { full_name, phone, password, occupation, role? }
 *
 * SECURITY: by default, any "role" field sent in the request body is
 * ignored and public registration always creates a WORKER. Elevated roles
 * (FUND_MANAGER, REGULATOR, ADMIN) must normally be provisioned through a
 * separate, privileged workflow (e.g. an ADMIN-only user-management
 * endpoint), not through this public endpoint - unless the local-dev-only
 * ALLOW_PRIVILEGED_SIGNUP flag is enabled (see isPrivilegedSignupAllowed).
 */
async function register(req, res) {
    const { full_name, phone, password, occupation } = req.body;
    const privilegedSignupAllowed = isPrivilegedSignupAllowed();

    if (!full_name || !phone || !password) {
        return res.status(400).json({
            status: "error",
            message: "full_name, phone, and password are required",
        });
    }

    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({
            status: "error",
            message: `password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
        });
    }

    let role = PUBLIC_REGISTRATION_ROLE;
    if (privilegedSignupAllowed && req.body.role !== undefined) {
        if (!VALID_ROLES.includes(req.body.role)) {
            return res.status(400).json({
                status: "error",
                message: `role must be one of: ${VALID_ROLES.join(", ")}`,
            });
        }
        role = req.body.role;
    }

    // WORKER accounts always require a valid occupation (they also get a
    // pension account below). Privileged roles (FUND_MANAGER/REGULATOR/
    // ADMIN) never receive a pension account, so occupation is optional for
    // them, but if one is supplied it must still be a valid value.
    if (role === "WORKER") {
        if (!VALID_OCCUPATIONS.includes(occupation)) {
            return res.status(400).json({
                status: "error",
                message: `occupation must be one of: ${VALID_OCCUPATIONS.join(", ")}`,
            });
        }
    } else if (occupation !== undefined && occupation !== null && occupation !== "" &&
        !VALID_OCCUPATIONS.includes(occupation)) {
        return res.status(400).json({
            status: "error",
            message: `occupation must be one of: ${VALID_OCCUPATIONS.join(", ")}`,
        });
    }

    let client;
    try {
        const existing = await pool.query(
            "SELECT user_id FROM users WHERE phone = $1",
            [phone]
        );

        if (existing.rows.length > 0) {
            return res.status(409).json({
                status: "error",
                message: "A user with this phone number already exists",
            });
        }

        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

        client = await pool.connect();
        await client.query("BEGIN");

        const result = await client.query(
            `INSERT INTO users (full_name, phone, password_hash, role, occupation)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING user_id, full_name, phone, role, occupation, account_status, created_at`,
            [full_name, phone, passwordHash, role, occupation || null]
        );

        const user = result.rows[0];
        if (user.role === "WORKER") {
            await client.query(
                `INSERT INTO pension_accounts (user_id, current_balance, retirement_age)
                 VALUES ($1, 0.00, 60)
                 ON CONFLICT (user_id) DO NOTHING`,
                [user.user_id]
            );
        }
        await client.query("COMMIT");

        const token = generateToken({ userId: user.user_id, role: user.role });

        return res.status(201).json({
            status: "success",
            message: "User registered successfully",
            data: { user, token },
        });
    } catch (error) {
        if (client) {
            await client.query("ROLLBACK").catch(() => {});
        }
        if (error.code === "23505") {
            return res.status(409).json({
                status: "error",
                message: "A user with this phone number already exists",
            });
        }
        console.error("Registration failed:", error);
        return res.status(500).json({
            status: "error",
            message: "Registration failed due to a server error",
        });
    } finally {
        client?.release();
    }
}

/**
 * POST /api/auth/login
 * Body: { phone, password }
 * Verifies the password against `password_hash` and returns a signed JWT
 * containing { userId, role }.
 */
async function login(req, res) {
    const { phone, password } = req.body;

    if (!phone || !password) {
        return res.status(400).json({
            status: "error",
            message: "phone and password are required",
        });
    }

    try {
        const result = await pool.query(
            "SELECT user_id, full_name, phone, password_hash, role, account_status FROM users WHERE phone = $1",
            [phone]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                status: "error",
                message: "Invalid phone number or password",
            });
        }

        const user = result.rows[0];

        if (user.account_status !== "ACTIVE") {
            return res.status(403).json({
                status: "error",
                message: "This account is not active",
            });
        }

        const passwordMatches = await bcrypt.compare(password, user.password_hash);

        if (!passwordMatches) {
            return res.status(401).json({
                status: "error",
                message: "Invalid phone number or password",
            });
        }

        const token = generateToken({ userId: user.user_id, role: user.role });

        return res.status(200).json({
            status: "success",
            message: "Login successful",
            data: {
                token,
                user: {
                    user_id: user.user_id,
                    full_name: user.full_name,
                    phone: user.phone,
                    role: user.role,
                },
            },
        });
    } catch (error) {
        console.error("Login failed:", error);
        return res.status(500).json({
            status: "error",
            message: "Login failed due to a server error",
        });
    }
}

/**
 * POST /api/auth/logout
 * Requires authentication.
 *
 * NOTE: JWTs issued by this API are stateless and there is no session or
 * token-blacklist table in the database schema. This endpoint therefore
 * cannot revoke the presented token server-side; it simply confirms the
 * request was authenticated and instructs the client to discard its token.
 * True server-side revocation would require a new table (e.g. a token
 * denylist) which is out of scope here per the "do not modify schema.sql"
 * constraint - flagged in the final report as a known limitation.
 */
async function logout(req, res) {
    return res.status(200).json({
        status: "success",
        message: "Logged out successfully. Please discard your access token on the client.",
    });
}

/**
 * GET /api/auth/me
 * Requires authentication. Returns the authenticated user's safe profile
 * fields (never password_hash).
 */
async function getMe(req, res) {
    const { userId } = req.user;

    try {
        const result = await pool.query(
            `SELECT user_id, full_name, phone, role, occupation, account_status, created_at
             FROM users
             WHERE user_id = $1`,
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                status: "error",
                message: "User not found",
            });
        }

        return res.status(200).json({
            status: "success",
            data: { user: result.rows[0] },
        });
    } catch (error) {
        console.error("Failed to fetch current user:", error);
        return res.status(500).json({
            status: "error",
            message: "Failed to fetch current user due to a server error",
        });
    }
}

module.exports = { register, login, logout, getMe, VALID_ROLES };