const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getValidatedTarget } = require("./createSyntheticRegulatorFixture");

const safeUrl = "postgres://micopesa_test@127.0.0.1:5544/micopesa_registration_test";

test("synthetic regulator fixture rejects targets outside the exact disposable database", () => {
    const unsafeUrls = [
        "postgres://micopesa_test@127.0.0.1:5433/micopesa_registration_test",
        "postgres://micopesa_test@127.0.0.1:5544/micopesa_other_test",
        "postgres://micopesa_test@localhost:5544/micopesa_registration_test",
        "postgres://other@127.0.0.1:5544/micopesa_registration_test",
        `${safeUrl}?sslmode=disable`,
        "postgres://micopesa_test@example.test:5544/micopesa_registration_test",
    ];

    for (const DATABASE_URL of unsafeUrls) {
        assert.throws(
            () => getValidatedTarget({ DATABASE_URL }),
            /approved disposable database|127\.0\.0\.1|port 5544|micopesa_registration_test|connection-routing options/
        );
    }
});

test("synthetic regulator fixture accepts the approved target", () => {
    const { target } = getValidatedTarget({ DATABASE_URL: safeUrl });

    assert.equal(target.databaseName, "micopesa_registration_test");
    assert.equal(target.url.hostname, "127.0.0.1");
    assert.equal(target.url.port, "5544");
    assert.equal(decodeURIComponent(target.url.username), "micopesa_test");
});
