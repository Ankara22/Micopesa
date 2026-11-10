const bcrypt = require("bcrypt");
const { Client } = require("pg");
const { validateKycTestDatabaseUrl } = require("./kycIntegrationDatabaseGuard");

const FIXTURE_EMAIL = "micopesa-admin@example.test";
const SALT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 8;

function getValidatedTarget(environment = process.env) {
    const connectionString = environment.DATABASE_URL;
    if (typeof connectionString !== "string" || connectionString.length === 0) {
        throw new Error("DATABASE_URL is required.");
    }

    const target = validateKycTestDatabaseUrl(connectionString);
    let username;
    try {
        username = decodeURIComponent(target.url.username);
    } catch {
        throw new Error("Database target is not the approved disposable target.");
    }
    if (
        target.databaseName !== "micopesa_registration_test" ||
        target.url.hostname !== "127.0.0.1" ||
        target.url.port !== "5544" ||
        username !== "micopesa_test" ||
        target.url.searchParams.size !== 0
    ) {
        throw new Error("Database target is not the approved disposable target.");
    }

    return { connectionString, target };
}

async function resetSyntheticAdminFixturePassword(
    environment = process.env,
    { createClient = (connectionString) => new Client({ connectionString }) } = {}
) {
    const { connectionString, target } = getValidatedTarget(environment);
    const password = environment.MICOPESA_TEST_ADMIN_PASSWORD;
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
        throw new Error("MICOPESA_TEST_ADMIN_PASSWORD must contain at least 8 characters.");
    }
    if (Buffer.byteLength(password, "utf8") > 72) {
        throw new Error("MICOPESA_TEST_ADMIN_PASSWORD exceeds the supported password length.");
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    if (!(await bcrypt.compare(password, passwordHash))) {
        throw new Error("Password hash verification failed; no account was reset.");
    }

    const client = createClient(connectionString);
    await client.connect();
    let transactionStarted = false;

    try {
        const identity = await client.query(
            "SELECT current_database() AS database_name, current_user AS database_user"
        );
        if (
            identity.rows[0]?.database_name !== target.databaseName ||
            identity.rows[0]?.database_user !== "micopesa_test"
        ) {
            throw new Error("Connected database identity did not match the approved disposable target.");
        }

        await client.query("BEGIN");
        transactionStarted = true;
        const existing = await client.query(
            `SELECT role, email_verified, account_status
             FROM users
             WHERE lower(email) = $1 AND role = 'ADMIN'
             FOR UPDATE`,
            [FIXTURE_EMAIL]
        );
        if (
            existing.rowCount !== 1 ||
            existing.rows[0]?.role !== "ADMIN" ||
            existing.rows[0]?.email_verified !== true ||
            existing.rows[0]?.account_status !== "ACTIVE"
        ) {
            throw new Error("Expected one verified, active synthetic administrator; no account was reset.");
        }

        const result = await client.query(
            `UPDATE users
             SET password_hash = $1, failed_login_attempts = 0, locked_until = NULL
             WHERE lower(email) = $2 AND role = 'ADMIN'
               AND email_verified IS TRUE AND account_status = 'ACTIVE'
             RETURNING role, email_verified, account_status, failed_login_attempts,
                       locked_until, password_hash`,
            [passwordHash, FIXTURE_EMAIL]
        );
        const updated = result.rows[0];
        if (
            result.rowCount !== 1 ||
            updated?.role !== "ADMIN" ||
            updated?.email_verified !== true ||
            updated?.account_status !== "ACTIVE" ||
            updated?.failed_login_attempts !== 0 ||
            updated?.locked_until !== null ||
            !(await bcrypt.compare(password, updated?.password_hash || ""))
        ) {
            throw new Error("Expected exactly one verified, active synthetic administrator with a verified password; reset was rolled back.");
        }

        await client.query("COMMIT");
        transactionStarted = false;
        return { administratorsUpdated: result.rowCount };
    } catch (error) {
        if (transactionStarted) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                const code = typeof rollbackError.code === "string"
                    ? rollbackError.code
                    : "UNKNOWN";
                throw new Error(`Password reset failed; rollback could not be confirmed (${code}).`);
            }
        }
        throw error;
    } finally {
        await client.end();
    }
}

if (require.main === module) {
    resetSyntheticAdminFixturePassword()
        .then(({ administratorsUpdated }) => {
            console.log(`Synthetic administrator password reset; accounts updated: ${administratorsUpdated}.`);
        })
        .catch((error) => {
            const safeMessage = error.message.startsWith("MICOPESA_TEST_ADMIN_PASSWORD") ||
                error.message === "DATABASE_URL is required." ||
                error.message === "Database target is not the approved disposable target."
                ? error.message
                : "Password reset was not completed. Verify the disposable target and fixture, then retry.";
            console.error(safeMessage);
            process.exitCode = 1;
        });
}

module.exports = { getValidatedTarget, resetSyntheticAdminFixturePassword };
