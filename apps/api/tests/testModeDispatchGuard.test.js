const { test } = require("node:test");
const assert = require("node:assert/strict");
const { testModeDispatchGuard } = require("../src/middleware/testModeDispatchGuard");

function createResponse() {
    return {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

test("test mode permits read-only notification endpoints to reach their authorized routes", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
        let continued = false;
        const response = createResponse();

        testModeDispatchGuard(
            { method },
            response,
            () => {
                continued = true;
            }
        );

        assert.equal(continued, true, `${method} request should pass through`);
        assert.equal(response.statusCode, null);
    }
});

test("test mode blocks notification dispatch and other mutating requests", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        let continued = false;
        const response = createResponse();

        testModeDispatchGuard(
            { method },
            response,
            () => {
                continued = true;
            }
        );

        assert.equal(continued, false, `${method} request must not reach a dispatch route`);
        assert.equal(response.statusCode, 503);
        assert.deepEqual(response.body, {
            status: "error",
            message: "External dispatch is disabled in test mode.",
        });
    }
});
