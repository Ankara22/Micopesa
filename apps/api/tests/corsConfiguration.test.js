const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createCorsOptions,
    getAllowedCorsOrigins,
} = require("../src/config/corsConfiguration");

test("development CORS uses explicit local origins", () => {
    assert.deepEqual(getAllowedCorsOrigins({ NODE_ENV: "development" }), [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]);
});

test("production CORS requires explicit HTTPS origins", () => {
    assert.deepEqual(getAllowedCorsOrigins({
        NODE_ENV: "production",
        CORS_ALLOWED_ORIGINS: "https://app.example.test,https://admin.example.test",
    }), [
        "https://app.example.test",
        "https://admin.example.test",
    ]);
    assert.throws(
        () => getAllowedCorsOrigins({ NODE_ENV: "production" }),
        { code: "CORS_ORIGINS_CONFIGURATION_MISSING" }
    );
    for (const origin of [
        "http://app.example.test",
        "https://app.example.test/path",
        "*",
        "https://user:password@app.example.test",
    ]) {
        assert.throws(
            () => getAllowedCorsOrigins({
                NODE_ENV: "production",
                CORS_ALLOWED_ORIGINS: origin,
            }),
            { code: "CORS_ORIGINS_CONFIGURATION_INVALID" }
        );
    }
});

test("CORS responds only to configured browser origins", async () => {
    const options = createCorsOptions({
        NODE_ENV: "production",
        CORS_ALLOWED_ORIGINS: "https://app.example.test",
    });
    const isAllowed = (origin) => new Promise((resolve, reject) => {
        options.origin(origin, (error, allowed) => error ? reject(error) : resolve(allowed));
    });

    assert.equal(await isAllowed("https://app.example.test"), true);
    assert.equal(await isAllowed("https://untrusted.example.test"), false);
    assert.equal(await isAllowed(undefined), true);
});
