const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateKycTestDatabaseUrl } = require("./kycIntegrationDatabaseGuard");

const testEnvironment = { NODE_ENV: "test" };

test("KYC integration guard accepts only the dedicated disposable database target", () => {
    const target = validateKycTestDatabaseUrl(
        "postgres://127.0.0.1:5544/micopesa_registration_test",
        testEnvironment
    );
    assert.equal(target.databaseName, "micopesa_registration_test");
    assert.equal(target.host, "127.0.0.1");
    assert.equal(target.port, "5544");
});

test("KYC integration guard rejects unsafe targets and missing test mode", () => {
    for (const unsafeUrl of [
        "postgres://127.0.0.1:5433/micopesa_registration_test",
        "postgres://example.com:5544/micopesa_registration_test",
        "postgres://127.0.0.1:5544/micopesa_test",
        "postgres://localhost:5544/micopesa_registration_test",
        "postgres://127.0.0.1:5544/micopesa_registration_test?host=example.com",
    ]) {
        assert.throws(() => validateKycTestDatabaseUrl(unsafeUrl, testEnvironment));
    }
    assert.throws(
        () => validateKycTestDatabaseUrl(
            "postgres://127.0.0.1:5544/micopesa_registration_test",
            {}
        ),
        /NODE_ENV=test/
    );
});
