const {
    assertTestMode,
    parseDisposableTestDatabaseUrl,
    isLoopbackAddress,
} = require("../../../tests/scripts/testDatabaseSafety");

function validateKycTestDatabaseUrl(value, environment = process.env) {
    assertTestMode(environment);
    return parseDisposableTestDatabaseUrl(value, "MICOPESA_TEST_DATABASE_URL");
}

module.exports = { isLoopbackAddress, validateKycTestDatabaseUrl };
