const { test } = require("node:test");
const assert = require("node:assert/strict");
const mobileSasaService = require("../src/services/mobileSasaService");
const { isSmsDispatcherEnabled } = require("../src/services/smsDeliveryDispatcher");

const smsEnvironment = {
    NODE_ENV: "production",
    MOBILESASA_SMS_ENABLED: "true",
    MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
    MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
};
const emailEnvironment = {
    NODE_ENV: "production",
    MOBILESASA_EMAIL_ENABLED: "true",
    MOBILE_SASA_EMAIL_API_TOKEN: "mbs_test-token",
    MOBILE_SASA_EMAIL_FROM: "billing@example.test",
    MOBILE_SASA_EMAIL_DOMAIN_UUID: "7c2e91d4-1234-4123-8123-123456789012",
};

function response(payload, { ok = true, status = 200 } = {}) {
    return { ok, status, async json() { return payload; } };
}

test("Mobile Sasa SMS uses the documented v1 endpoint and retains an internal tracking ID", async () => {
    let request;
    const result = await mobileSasaService.sendSms({
        to: "+254712345678",
        message: "Contribution update",
        trackingId: "notification-123",
    }, {
        environment: smsEnvironment,
        fetchImpl: async (url, options) => {
            request = { url, options, body: JSON.parse(options.body) };
            return response({
                status: true,
                responseCode: "0200",
                message: "Accepted",
                messageId: "message-123",
            });
        },
    });

    assert.equal(request.url, "https://api.mobilesasa.com/v1/send/message");
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers.Authorization, "Bearer mbs_test-token");
    assert.deepEqual(request.body, {
        senderID: "MicoPesa",
        phone: "+254712345678",
        message: "Contribution update",
    });
    assert.deepEqual(result, {
        accepted: true,
        status: "PROVIDER_ACCEPTED",
        messageId: "message-123",
        deliveryResult: {
            provider: "MOBILE_SASA",
            responseCode: "0200",
            trackingId: "notification-123",
        },
    });
});

test("Mobile Sasa SMS accepts canonical server-side config names", async () => {
    let request;
    const environment = {
        NODE_ENV: "production",
        MOBILESASA_SMS_ENABLED: "true",
        MOBILESASA_TOKEN: "mbs_canonical-token",
        MOBILESASA_SENDER_ID: "MicoPesa",
    };
    assert.equal(mobileSasaService.isSmsConfigured(environment), true);

    await mobileSasaService.sendSms({
        to: "+254712345678",
        message: "Account update",
        trackingId: "notification-canonical",
    }, {
        environment,
        fetchImpl: async (url, options) => {
            request = { url, body: JSON.parse(options.body) };
            return response({
                status: true,
                responseCode: "0200",
                message: "Accepted",
                messageId: "message-canonical",
            });
        },
    });

    assert.equal(request.url, "https://api.mobilesasa.com/v1/send/message");
    assert.deepEqual(request.body, {
        senderID: "MicoPesa",
        phone: "+254712345678",
        message: "Account update",
    });
});

test("matching canonical and legacy Mobile Sasa config aliases are accepted", () => {
    assert.equal(mobileSasaService.isSmsConfigured({
        ...smsEnvironment,
        MOBILESASA_TOKEN: "mbs_test-token",
        MOBILESASA_SENDER_ID: "MicoPesa",
    }), true);
});

test("conflicting Mobile Sasa canonical and legacy aliases disable dispatch before provider access", async () => {
    let requests = 0;
    const environment = {
        ...smsEnvironment,
        MOBILESASA_TOKEN: "mbs_other-token",
        MOBILESASA_SENDER_ID: "DifferentSender",
    };
    assert.equal(mobileSasaService.isSmsConfigured(environment), false);
    await assert.rejects(() => mobileSasaService.sendSms({
        to: "+254712345678",
        message: "Account update",
        trackingId: "notification-conflict",
    }, {
        environment,
        fetchImpl: async () => {
            requests += 1;
            return response({});
        },
    }), { code: "SMS_CONFIGURATION_MISSING" });
    assert.equal(requests, 0);
});

test("Mobile Sasa duplicate response is unknown and does not become an automatic retry", async () => {
    await assert.rejects(() => mobileSasaService.sendSms({
        to: "+254712345678",
        message: "A possible duplicate",
        trackingId: "notification-124",
    }, {
        environment: smsEnvironment,
        fetchImpl: async () => response({ status: false, responseCode: "0409" }),
    }), (error) => {
        assert.equal(error.code, "SMS_UNKNOWN_OUTCOME");
        assert.equal(error.diagnostics.failureCategory, "unknown_outcome");
        assert.equal(error.diagnostics.responseCode, "0409");
        assert.equal(error.diagnostics.deliveryOutcomeUnknown, true);
        return true;
    });
});

test("Mobile Sasa definitive rejection and explicit rate limiting are distinguished", async () => {
    const request = {
        to: "+254712345678",
        message: "Notice",
        trackingId: "notification-125",
    };
    await assert.rejects(() => mobileSasaService.sendSms(request, {
        environment: smsEnvironment,
        fetchImpl: async () => response({ status: false, responseCode: "0402" }),
    }), { code: "SMS_PROVIDER_REJECTED" });
    await assert.rejects(() => mobileSasaService.sendSms(request, {
        environment: smsEnvironment,
        fetchImpl: async () => response({}, { ok: false, status: 429 }),
    }), (error) => {
        assert.equal(error.code, "SMS_RETRYABLE_REJECTION");
        assert.equal(error.diagnostics.failureCategory, "rate_limiting");
        assert.equal(error.diagnostics.httpStatus, 429);
        assert.equal(error.diagnostics.deliveryOutcomeUnknown, false);
        return true;
    });
});

test("Mobile Sasa emits sanitized request, response, and rejection diagnostics", async () => {
    const records = [];
    const logger = {
        info(record) {
            records.push(JSON.parse(record));
        },
    };
    const error = await mobileSasaService.sendSms({
        to: "+254712345678",
        message: "private onboarding message",
        trackingId: "private-tracking-id",
    }, {
        environment: smsEnvironment,
        logger,
        fetchImpl: async () => response({
            status: false,
            responseCode: "0402",
            message: "private provider response",
        }, { ok: false, status: 422 }),
    }).then(() => null, (caught) => caught);

    assert.equal(error.code, "SMS_PROVIDER_REJECTED");
    assert.deepEqual(error.diagnostics, {
        errorCode: "SMS_PROVIDER_REJECTED",
        errorClass: "Error",
        requestStarted: true,
        httpResponseReceived: true,
        httpStatus: 422,
        responseCode: "0402",
        failureCategory: "provider_rejection",
        deliveryOutcomeUnknown: false,
    });
    assert.deepEqual(records.map(({ event }) => event), [
        "mobilesasa.sms_request_started",
        "mobilesasa.sms_http_response_received",
        "mobilesasa.sms_response_parsed",
    ]);
    assert.equal(records[0].httpResponseReceived, false);
    assert.equal(records[1].httpStatus, 422);
    assert.equal(records[2].responseCode, "0402");
    assert.doesNotMatch(JSON.stringify(records), /private onboarding message|private-tracking-id|private provider response|\+254/);
});

test("Mobile Sasa classifies authentication rejection and strips unsafe response codes", async () => {
    const records = [];
    const error = await mobileSasaService.sendSms({
        to: "+254712345678",
        message: "Notice",
        trackingId: "tracking-127",
    }, {
        environment: smsEnvironment,
        logger: { info: (record) => records.push(JSON.parse(record)) },
        fetchImpl: async () => response({
            status: false,
            responseCode: "401 secret",
            message: "provider detail must not be logged",
        }, { ok: false, status: 401 }),
    }).then(() => null, (caught) => caught);

    assert.equal(error.code, "SMS_PROVIDER_AUTH_FAILED");
    assert.equal(error.diagnostics.failureCategory, "authentication_failure");
    assert.equal(error.diagnostics.httpStatus, 401);
    assert.equal(error.diagnostics.responseCode, null);
    assert.doesNotMatch(JSON.stringify(records), /secret|provider detail|\+254|Notice/);
});

test("Mobile Sasa classifies an authentication response even when its body is not JSON", async () => {
    const error = await mobileSasaService.sendSms({
        to: "+254712345678",
        message: "Notice",
        trackingId: "tracking-130",
    }, {
        environment: smsEnvironment,
        logger: { info() {} },
        fetchImpl: async () => ({
            ok: false,
            status: 403,
            async json() { throw new SyntaxError("private response body"); },
        }),
    }).then(() => null, (caught) => caught);

    assert.equal(error.code, "SMS_PROVIDER_AUTH_FAILED");
    assert.equal(error.diagnostics.failureCategory, "authentication_failure");
    assert.equal(error.diagnostics.httpResponseReceived, true);
    assert.equal(error.diagnostics.httpStatus, 403);
    assert.equal(error.diagnostics.responseCode, null);
    assert.equal(error.diagnostics.deliveryOutcomeUnknown, false);
});

test("Mobile Sasa network and timeout diagnostics preserve uncertain outcomes", async (t) => {
    await t.test("network failure", async () => {
        const error = await mobileSasaService.sendSms({
            to: "+254712345678",
            message: "Notice",
            trackingId: "tracking-128",
        }, {
            environment: smsEnvironment,
            logger: { info() {} },
            fetchImpl: async () => { throw new TypeError("private network detail"); },
        }).then(() => null, (caught) => caught);

        assert.equal(error.code, "SMS_NETWORK_ERROR");
        assert.equal(error.diagnostics.errorClass, "TypeError");
        assert.equal(error.diagnostics.failureCategory, "network_failure");
        assert.equal(error.diagnostics.httpResponseReceived, false);
        assert.equal(error.diagnostics.deliveryOutcomeUnknown, true);
    });

    await t.test("timeout", async () => {
        const error = await mobileSasaService.sendSms({
            to: "+254712345678",
            message: "Notice",
            trackingId: "tracking-129",
        }, {
            environment: smsEnvironment,
            timeoutMs: 5,
            logger: { info() {} },
            fetchImpl: async () => new Promise(() => {}),
        }).then(() => null, (caught) => caught);

        assert.equal(error.code, "SMS_TIMEOUT");
        assert.equal(error.diagnostics.failureCategory, "timeout");
        assert.equal(error.diagnostics.httpResponseReceived, false);
        assert.equal(error.diagnostics.deliveryOutcomeUnknown, true);
    });

    await t.test("response body timeout", async () => {
        const error = await mobileSasaService.sendSms({
            to: "+254712345678",
            message: "Notice",
            trackingId: "tracking-131",
        }, {
            environment: smsEnvironment,
            timeoutMs: 5,
            logger: { info() {} },
            fetchImpl: async () => ({
                ok: true,
                status: 200,
                json: () => new Promise(() => {}),
            }),
        }).then(() => null, (caught) => caught);

        assert.equal(error.code, "SMS_TIMEOUT");
        assert.equal(error.diagnostics.failureCategory, "timeout");
        assert.equal(error.diagnostics.httpResponseReceived, true);
        assert.equal(error.diagnostics.httpStatus, 200);
        assert.equal(error.diagnostics.deliveryOutcomeUnknown, true);
    });
});

test("Mobile Sasa SMS rejects invalid input and missing configuration before sending", async () => {
    let requests = 0;
    const fetchImpl = async () => {
        requests += 1;
        return response({});
    };
    await assert.rejects(() => mobileSasaService.sendSms({
        to: "0712345678",
        message: "Notice",
        trackingId: "notification-126",
    }, { environment: smsEnvironment, fetchImpl }), { code: "SMS_INVALID_INPUT" });
    await assert.rejects(() => mobileSasaService.sendSms({
        to: "+254712345678",
        message: "Notice",
        trackingId: "notification-126",
    }, {
        environment: {
            NODE_ENV: "production",
            MOBILESASA_SMS_ENABLED: "true",
            MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
        },
        fetchImpl,
    }), { code: "SMS_CONFIGURATION_MISSING" });
    assert.equal(requests, 0);
});

test("Mobile Sasa SMS and email stay disabled unless their separate feature flags are enabled", async () => {
    let requests = 0;
    const fetchImpl = async () => {
        requests += 1;
        return response({});
    };

    await assert.rejects(() => mobileSasaService.sendSms({
        to: "+254712345678",
        message: "Notice",
        trackingId: "notification-128",
    }, {
        environment: {
            NODE_ENV: "production",
            MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
            MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
        },
        fetchImpl,
    }), { code: "SMS_CONFIGURATION_MISSING" });
    await assert.rejects(() => mobileSasaService.sendEmail({
        to: "worker@example.test",
        subject: "Notice",
        text: "Notice",
        html: "<p>Notice</p>",
    }, {
        environment: {
            NODE_ENV: "production",
            MOBILE_SASA_EMAIL_API_TOKEN: "mbs_test-token",
            MOBILE_SASA_EMAIL_FROM: "billing@example.test",
        },
        fetchImpl,
    }), { code: "EMAIL_CONFIGURATION_MISSING" });
    assert.equal(requests, 0);
});

test("development self-test SMS uses the existing adapter without enabling normal Mobile Sasa SMS", async () => {
    const developmentEnvironment = {
        NODE_ENV: "development",
        MOBILESASA_TEST_SMS_ENABLED: "true",
        MOBILESASA_SMS_ENABLED: "false",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };
    let request;
    const result = await mobileSasaService.sendTestSms({
        to: "+254712345678",
        trackingId: "test-notification-1",
    }, {
        environment: developmentEnvironment,
        fetchImpl: async (url, options) => {
            request = { url, body: JSON.parse(options.body) };
            return response({
                status: true,
                responseCode: "0200",
                messageId: "test-message-1",
                cost: 1,
            });
        },
    });

    assert.equal(request.url, "https://api.mobilesasa.com/v1/send/message");
    assert.deepEqual(request.body, {
        senderID: "MicoPesa",
        phone: "+254712345678",
        message: "MicoPesa test notification: Your SMS notification service is working. This is a test message. No payment has been made.",
    });
    assert.equal(result.status, "PROVIDER_ACCEPTED");
    assert.equal(mobileSasaService.isSmsConfigured(developmentEnvironment), false);
    await assert.rejects(() => mobileSasaService.sendSms({
        to: "+254712345678",
        message: "Normal notification",
        trackingId: "normal-notification-1",
    }, { environment: developmentEnvironment }), {
        code: "SMS_DEVELOPMENT_DELIVERY_DISABLED",
    });
});

test("development phone verification uses the isolated adapter without enabling dispatch", async () => {
    const environment = {
        NODE_ENV: "development",
        MOBILESASA_TEST_SMS_ENABLED: "true",
        MOBILESASA_SMS_ENABLED: "false",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };
    let body;
    const result = await mobileSasaService.sendPhoneVerificationSms({
        to: "0712345678",
        message: "Your MicoPesa phone verification code is 123456.",
        trackingId: "phone-change-user-1",
    }, {
        environment,
        fetchImpl: async (_url, options) => {
            body = JSON.parse(options.body);
            return response({
                status: true,
                responseCode: "0200",
                messageId: "phone-code-message",
                cost: 1,
            });
        },
    });

    assert.equal(mobileSasaService.isPhoneVerificationSmsConfigured(environment), true);
    assert.equal(body.phone, "+254712345678");
    assert.equal(body.message, "Your MicoPesa phone verification code is 123456.");
    assert.equal(result.status, "PROVIDER_ACCEPTED");
    assert.equal(mobileSasaService.isSmsConfigured(environment), false);
    assert.equal(isSmsDispatcherEnabled(environment), false);
});

test("development test SMS normalizes only the registered Kenyan phone format", async () => {
    const environment = {
        NODE_ENV: "development",
        MOBILESASA_TEST_SMS_ENABLED: "true",
        MOBILESASA_SMS_ENABLED: "false",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };
    let requestBody;
    await mobileSasaService.sendTestSms({
        to: "0712345678",
        trackingId: "test-notification-3",
    }, {
        environment,
        fetchImpl: async (_url, options) => {
            requestBody = JSON.parse(options.body);
            return response({
                status: true,
                responseCode: "0200",
                messageId: "test-message-3",
                cost: 1,
            });
        },
    });
    assert.equal(requestBody.phone, "+254712345678");

    await assert.rejects(() => mobileSasaService.sendTestSms({
        to: "+254212345678",
        trackingId: "test-notification-4",
    }, { environment, fetchImpl: async () => response({}) }), {
        code: "SMS_INVALID_INPUT",
    });
});

test("development test SMS fails closed for missing credentials, disabled switch, or normal SMS enablement", async () => {
    const validBase = {
        NODE_ENV: "development",
        MOBILESASA_TEST_SMS_ENABLED: "true",
        MOBILESASA_SMS_ENABLED: "false",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };
    let requests = 0;
    const fetchImpl = async () => {
        requests += 1;
        return response({});
    };
    for (const environment of [
        { ...validBase, MOBILESASA_TEST_SMS_ENABLED: "false" },
        { ...validBase, MOBILE_SASA_SMS_API_TOKEN: "" },
        { ...validBase, MOBILE_SASA_SMS_SENDER_ID: "" },
        { ...validBase, MOBILESASA_SMS_ENABLED: "true" },
        { ...validBase, NODE_ENV: "test" },
    ]) {
        await assert.rejects(() => mobileSasaService.sendTestSms({
            to: "+254712345678",
            trackingId: "test-notification-2",
        }, { environment, fetchImpl }), {
            code: environment.NODE_ENV !== "development" ||
                environment.MOBILESASA_TEST_SMS_ENABLED !== "true" ||
                environment.MOBILESASA_SMS_ENABLED === "true"
                ? "SMS_TEST_DISABLED"
                : "SMS_CONFIGURATION_MISSING",
        });
    }
    assert.equal(requests, 0);
});

test("Mobile Sasa SMS timeout remains ambiguous", async () => {
    await assert.rejects(() => mobileSasaService.sendSms({
        to: "+254712345678",
        message: "Notice",
        trackingId: "notification-127",
    }, {
        environment: smsEnvironment,
        timeoutMs: 5,
        fetchImpl: async (_url, options) => {
            await new Promise((resolve) => options.signal.addEventListener("abort", resolve));
            throw new Error("aborted");
        },
    }), { code: "SMS_TIMEOUT" });
});

test("Mobile Sasa email sends one sanitized recipient and records acceptance, not delivery", async () => {
    let request;
    const result = await mobileSasaService.sendEmail({
        to: "worker@example.test",
        subject: "Account update",
        text: "Account update",
        html: "<p>Account update</p>",
    }, {
        environment: emailEnvironment,
        fetchImpl: async (url, options) => {
            request = { url, options, body: JSON.parse(options.body) };
            return response({
                success: true,
                data: { accepted: 1, suppressed: 0, failed: 0, cost_total: 1 },
            });
        },
    });

    assert.equal(request.url, "https://api.mobilesasa.com/api/v1/email/send");
    assert.equal(request.options.headers.Authorization, "Bearer mbs_test-token");
    assert.deepEqual(request.body, {
        to: ["worker@example.test"],
        subject: "Account update",
        text: "Account update",
        html: "<p>Account update</p>",
        from: "billing@example.test",
        domain_uuid: "7c2e91d4-1234-4123-8123-123456789012",
    });
    assert.deepEqual(result, {
        accepted: true,
        status: "PROVIDER_ACCEPTED",
        messageId: null,
        deliveryResult: {
            provider: "MOBILE_SASA",
            accepted: 1,
            suppressed: 0,
            failed: 0,
        },
    });
});

test("Mobile Sasa email rejects a suppressed or failed recipient", async () => {
    await assert.rejects(() => mobileSasaService.sendEmail({
        to: "worker@example.test",
        subject: "Account update",
        text: "Account update",
        html: "<p>Account update</p>",
    }, {
        environment: emailEnvironment,
        fetchImpl: async () => response({
            success: true,
            data: { accepted: 0, suppressed: 1, failed: 0 },
        }),
    }), { code: "EMAIL_SUPPRESSED" });
});
