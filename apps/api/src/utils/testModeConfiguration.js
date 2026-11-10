const { isIP } = require("node:net");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const {
    TEST_DATABASE_HOST,
    TEST_DATABASE_NAME,
    TEST_DATABASE_PORT,
    parseDisposableTestDatabaseUrl,
} = require("../../../../tests/scripts/testDatabaseSafety");

const TEST_MODE_FLAG = "MICOPESA_TEST_MODE";
const EMAIL_CAPTURE_FLAG = "MICOPESA_EMAIL_CAPTURE";
const EMAIL_CAPTURE_DIRECTORY = "MICOPESA_EMAIL_CAPTURE_DIR";
const DATABASE_ENV_OVERRIDES = [
    "PGHOST",
    "PGHOSTADDR",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "PGSERVICE",
    "PGSERVICEFILE",
];

function isLoopbackAddress(address) {
    if (typeof address !== "string") return false;
    const normalized = address.toLowerCase().split("%")[0].split("/")[0];
    if (normalized === "::1") return true;
    if (normalized.startsWith("::ffff:")) return isLoopbackAddress(normalized.slice(7));
    return isIP(normalized) === 4 && normalized.startsWith("127.");
}

function validateTestDatabaseUrl(connectionString) {
    let target;
    let databaseUser;
    let hasDatabasePassword;
    try {
        target = parseDisposableTestDatabaseUrl(connectionString, "DATABASE_URL");
        databaseUser = decodeURIComponent(target.url.username);
        hasDatabasePassword = decodeURIComponent(target.url.password).length > 0;
    } catch {
        throw new Error(
            `Test mode DATABASE_URL must target ${TEST_DATABASE_HOST}:${TEST_DATABASE_PORT}/${TEST_DATABASE_NAME} and contain valid encoded database credentials.`
        );
    }

    if (!databaseUser || !hasDatabasePassword) {
        throw new Error(
            `Test mode DATABASE_URL must target ${TEST_DATABASE_HOST}:${TEST_DATABASE_PORT}/${TEST_DATABASE_NAME} and include a username and password.`
        );
    }
    return {
        databaseName: target.databaseName,
        databaseUser,
        port: target.port,
    };
}

function assertTestModeWasNotLoadedFromEnvironment(environment, testModeEnabledBeforeEnvironmentLoad) {
    if (testModeEnabledBeforeEnvironmentLoad) return;
    const configuredTestMode = environment[TEST_MODE_FLAG];
    if (
        environment.NODE_ENV === "test" ||
        (configuredTestMode !== undefined && configuredTestMode !== "" && configuredTestMode !== "false")
    ) {
        throw new Error(
            `${TEST_MODE_FLAG} and NODE_ENV=test must be supplied by the process environment, not an environment file.`
        );
    }
}

function validateTestEmailCaptureConfiguration(environment) {
    if (environment[EMAIL_CAPTURE_FLAG] !== "true") {
        throw new Error(`${EMAIL_CAPTURE_FLAG}=true is required in API test mode.`);
    }

    const configuredDirectory = environment[EMAIL_CAPTURE_DIRECTORY];
    if (typeof configuredDirectory !== "string" || !path.isAbsolute(configuredDirectory)) {
        throw new Error(`${EMAIL_CAPTURE_DIRECTORY} must be an absolute directory below the OS temp directory.`);
    }
    const tempDirectory = path.resolve(os.tmpdir());
    const resolvedDirectory = path.resolve(configuredDirectory);
    const relativeDirectory = path.relative(tempDirectory, resolvedDirectory);
    if (
        relativeDirectory === "" ||
        relativeDirectory === ".." ||
        relativeDirectory.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeDirectory)
    ) {
        throw new Error(`${EMAIL_CAPTURE_DIRECTORY} must be an absolute directory below the OS temp directory.`);
    }
}

function assertSafeTestModeConfiguration(environment = process.env) {
    const testModeValue = environment[TEST_MODE_FLAG];
    const testModeRequested = testModeValue === "true";
    if (
        testModeValue !== undefined &&
        testModeValue !== "" &&
        testModeValue !== "false" &&
        !testModeRequested
    ) {
        throw new Error(`${TEST_MODE_FLAG} must be the literal value "true" or "false".`);
    }

    if (environment.NODE_ENV === "test" || testModeRequested) {
        if (!testModeRequested) {
            throw new Error(`${TEST_MODE_FLAG}=true is required when NODE_ENV=test.`);
        }
        if (environment.NODE_ENV !== "test") {
            throw new Error(`${TEST_MODE_FLAG} requires NODE_ENV=test so environment files are not loaded.`);
        }
        if (DATABASE_ENV_OVERRIDES.some((name) => environment[name])) {
            throw new Error("Test mode does not allow PostgreSQL connection environment overrides.");
        }
        validateTestDatabaseUrl(environment.DATABASE_URL);
        validateTestEmailCaptureConfiguration(environment);
    }
}

function initializeTestModeJwtSecret(environment = process.env) {
    if (environment.NODE_ENV !== "test" || environment[TEST_MODE_FLAG] !== "true") {
        return false;
    }

    const secret = typeof environment.JWT_SECRET === "string"
        ? environment.JWT_SECRET.trim()
        : "";
    if (!secret) {
        environment.JWT_SECRET = crypto.randomBytes(32).toString("base64url");
        return true;
    }
    if (secret.length < 32) {
        throw new Error("JWT_SECRET must be at least 32 characters in test mode.");
    }
    environment.JWT_SECRET = secret;
    return false;
}

module.exports = {
    assertSafeTestModeConfiguration,
    assertTestModeWasNotLoadedFromEnvironment,
    initializeTestModeJwtSecret,
    isLoopbackAddress,
    validateTestEmailCaptureConfiguration,
    validateTestDatabaseUrl,
};
