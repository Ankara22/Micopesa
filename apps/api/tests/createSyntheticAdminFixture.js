const bcrypt = require("bcrypt");
const { Client } = require("pg");
const { validateKycTestDatabaseUrl } = require("./kycIntegrationDatabaseGuard");

const FIXTURE_EMAIL = "micopesa-admin@example.test";
const FIXTURE_NAME = "MicoPesa Synthetic Admin";
const FIXTURE_PHONE = "TEST-ADMIN-0001";
const SALT_ROUNDS = 10;

function getValidatedTarget(environment = process.env) {
    const connectionString = environment.DATABASE_URL;
    if (typeof connectionString !== "string" || connectionString.length === 0) {
        throw new Error("DATABASE_URL is required.");
    }

    const target = validateKycTestDatabaseUrl(connectionString);
    if (
        target.databaseName !== "micopesa_registration_test" ||
        target.url.hostname !== "127.0.0.1" ||
        target.url.port !== "5544" ||
        decodeURIComponent(target.url.username) !== "micopesa_test" ||
        target.url.searchParams.size !== 0
    ) {
        throw new Error("Refusing to run: target must be exactly the approved disposable database.");
    }

    return { connectionString, target };
}

async function createSyntheticAdminFixture(environment = process.env) {
    const { connectionString, target } = getValidatedTarget(environment);
    const password = environment.MICOPESA_TEST_ADMIN_PASSWORD;
    if (typeof password !== "string" || password.length < 8) {
        throw new Error("MICOPESA_TEST_ADMIN_PASSWORD must contain at least 8 characters.");
    }
    if (Buffer.byteLength(password, "utf8") > 72) {
        throw new Error("MICOPESA_TEST_ADMIN_PASSWORD exceeds the supported password length.");
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const client = new Client({ connectionString });
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
            `SELECT user_id FROM users
             WHERE lower(email) = $1 OR phone = $2
             LIMIT 1
             FOR UPDATE`,
            [FIXTURE_EMAIL, FIXTURE_PHONE]
        );
        if (existing.rows.length > 0) {
            throw new Error("Synthetic administrator fixture already exists; refusing to overwrite an account.");
        }

        const inserted = await client.query(
            `INSERT INTO users
                (full_name, phone, email, email_verified, password_hash, role,
                 login_method, account_status, is_temp_password, force_password_change)
             VALUES ($1, $2, $3, TRUE, $4, 'ADMIN', 'EMAIL', 'ACTIVE', FALSE, FALSE)
             RETURNING role`,
            [FIXTURE_NAME, FIXTURE_PHONE, FIXTURE_EMAIL, passwordHash]
        );
        if (inserted.rows[0]?.role !== "ADMIN") {
            throw new Error("Synthetic administrator fixture role verification failed.");
        }

        await client.query("COMMIT");
        transactionStarted = false;
        return { role: inserted.rows[0].role };
    } catch (error) {
        if (transactionStarted) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                const code = typeof rollbackError.code === "string"
                    ? rollbackError.code
                    : "UNKNOWN";
                throw new Error(`Fixture operation failed; rollback could not be confirmed (${code}).`);
            }
        }
        throw error;
    } finally {
        await client.end();
    }
}

if (require.main === module) {
    createSyntheticAdminFixture()
        .then(({ role }) => {
            console.log(`Synthetic fixture created; verified role: ${role}.`);
        })
        .catch((error) => {
            console.error("Synthetic administrator fixture was not created:", error.message);
            process.exitCode = 1;
        });
}

module.exports = { createSyntheticAdminFixture, getValidatedTarget };
