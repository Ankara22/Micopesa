const { test } = require("node:test");
const assert = require("node:assert/strict");
const smsService = require("../src/services/smsService");

const configuredEnvironment = {
    NODE_ENV: "production",
    AT_ENVIRONMENT: "production",
    AT_USERNAME: "micopesa-production",
    AT_API_KEY: "test-key",
    AT_SENDER_ID: "MicoPesa",
};

function providerResponse({ ok = true, status = 201, recipients } = {}) {
    return {
        ok,
        status,
        async json() {
            return { SMSMessageData: { Recipients: recipients } };
        },
    };
}

test("normalizes an accepted Kenyan phone format and returns provider acceptance", async () => {
    let request;
    const result = await smsService.sendSms(
        { to: "0712 345 678", message: "temporary credential" },
        {
            environment: configuredEnvironment,
            fetchImpl: async (url, options) => {
                request = { url, options };
                return providerResponse({
                    recipients: [{ status: "Success", messageId: "message-id" }],
                });
            },
        }
    );

    assert.deepEqual(result, {
        accepted: true,
        messageId: "message-id",
        status: "PROVIDER_ACCEPTED",
    });
    assert.equal(request.url, "https://api.africastalking.com/version1/messaging");
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers.apiKey, "test-key");
    assert.equal(new URLSearchParams(request.options.body).get("to"), "+254712345678");
    assert.equal(new URLSearchParams(request.options.body).get("from"), "MicoPesa");
});

test("accepts an international Kenyan mobile number", async () => {
    let recipient;
    await smsService.sendSms(
        { to: "+254112345678", message: "test" },
        {
            environment: configuredEnvironment,
            fetchImpl: async (_url, options) => {
                recipient = new URLSearchParams(options.body).get("to");
                return providerResponse({
                    recipients: [{ status: "Success", messageId: "message-id" }],
                });
            },
        }
    );

    assert.equal(recipient, "+254112345678");
});

test("phone verification availability follows the configured transactional provider", () => {
    assert.equal(smsService.isPhoneVerificationSmsConfigured({
        ...configuredEnvironment,
        TRANSACTIONAL_SMS_PROVIDER: "AFRICAS_TALKING",
    }), true);
    assert.equal(smsService.isPhoneVerificationSmsConfigured({
        ...configuredEnvironment,
        AT_API_KEY: "",
        TRANSACTIONAL_SMS_PROVIDER: "AFRICAS_TALKING",
    }), false);
    assert.equal(smsService.isPhoneVerificationSmsConfigured({
        NODE_ENV: "production",
        TRANSACTIONAL_SMS_PROVIDER: "MOBILE_SASA",
        MOBILESASA_SMS_ENABLED: "true",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    }), true);
    assert.equal(smsService.isPhoneVerificationSmsConfigured({
        NODE_ENV: "production",
        TRANSACTIONAL_SMS_PROVIDER: "UNSUPPORTED",
    }), false);
    assert.equal(smsService.isPhoneVerificationSmsConfigured({
        ...configuredEnvironment,
        NODE_ENV: "test",
    }), false);
});

test("phone verification configuration reports sanitized development and production selection", () => {
    const development = smsService.getPhoneVerificationSmsConfiguration({
        NODE_ENV: "development",
        MOBILESASA_TEST_SMS_ENABLED: "true",
        MOBILESASA_SMS_ENABLED: "false",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    });
    assert.deepEqual(development, {
        available: true,
        errorCode: null,
        missingVariables: [],
        invalidVariables: [],
        mode: "development-test",
        provider: "MOBILE_SASA",
    });

    const missingDevelopment = smsService.getPhoneVerificationSmsConfiguration({
        NODE_ENV: "development",
        MOBILESASA_SMS_ENABLED: "false",
    });
    assert.equal(missingDevelopment.available, false);
    assert.equal(missingDevelopment.errorCode, "SMS_TEST_DISABLED");
    assert.ok(missingDevelopment.missingVariables.includes("MOBILESASA_TEST_SMS_ENABLED"));
    assert.ok(missingDevelopment.missingVariables.includes("MOBILE_SASA_SMS_API_TOKEN"));
    assert.doesNotMatch(JSON.stringify(missingDevelopment), /mbs_|MicoPesa/);

    const invalidDevelopment = smsService.getPhoneVerificationSmsConfiguration({
        NODE_ENV: "development",
        MOBILESASA_TEST_SMS_ENABLED: "true",
        MOBILESASA_SMS_ENABLED: "true",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    });
    assert.equal(invalidDevelopment.available, false);
    assert.ok(invalidDevelopment.invalidVariables.includes("MOBILESASA_SMS_ENABLED"));

    const africaTalking = smsService.getPhoneVerificationSmsConfiguration({
        ...configuredEnvironment,
        TRANSACTIONAL_SMS_PROVIDER: "AFRICAS_TALKING",
    });
    assert.equal(africaTalking.available, true);
    assert.equal(africaTalking.mode, "production-transactional");
    assert.equal(africaTalking.provider, "AFRICAS_TALKING");

    const mobileSasa = smsService.getPhoneVerificationSmsConfiguration({
        NODE_ENV: "production",
        TRANSACTIONAL_SMS_PROVIDER: "MOBILE_SASA",
        MOBILESASA_SMS_ENABLED: "true",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    });
    assert.equal(mobileSasa.available, true);
    assert.equal(mobileSasa.provider, "MOBILE_SASA");

    const missingTransactional = smsService.getPhoneVerificationSmsConfiguration({
        NODE_ENV: "production",
        TRANSACTIONAL_SMS_PROVIDER: "AFRICAS_TALKING",
        AT_ENVIRONMENT: "production",
        AT_USERNAME: "production-user",
    });
    assert.equal(missingTransactional.available, false);
    assert.deepEqual(missingTransactional.missingVariables, ["AT_API_KEY"]);
});

test("phone verification uses the selected transactional provider", async () => {
    let requestUrl;
    const result = await smsService.sendPhoneVerificationSms({
        to: "+254712345678",
        message: "verification code",
        trackingId: "phone-verification-test",
    }, {
        environment: {
            ...configuredEnvironment,
            TRANSACTIONAL_SMS_PROVIDER: "AFRICAS_TALKING",
        },
        fetchImpl: async (url) => {
            requestUrl = url;
            return providerResponse({
                recipients: [{ status: "Success", messageId: "message-id" }],
            });
        },
    });
    assert.equal(requestUrl, "https://api.africastalking.com/version1/messaging");
    assert.equal(result.status, "PROVIDER_ACCEPTED");
});

test("development phone verification dispatches only through the configured Mobile Sasa test path", async () => {
    const environment = {
        NODE_ENV: "development",
        MOBILESASA_TEST_SMS_ENABLED: "true",
        MOBILESASA_SMS_ENABLED: "false",
        MOBILESASA_NOTIFICATION_SMS_ENABLED: "false",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };
    const configuration = smsService.getPhoneVerificationSmsConfiguration(environment);
    let request;
    const result = await smsService.sendPhoneVerificationSms({
        to: "+254712345678",
        message: "verification code",
        trackingId: "phone-verification-test",
    }, {
        environment,
        fetchImpl: async (url, options) => {
            request = { url, options, body: JSON.parse(options.body) };
            return {
                ok: true,
                status: 200,
                async json() {
                    return { status: true, responseCode: "0200", messageId: "mock-id" };
                },
            };
        },
    });

    assert.equal(configuration.available, true);
    assert.equal(configuration.mode, "development-test");
    assert.equal(request.url, "https://api.mobilesasa.com/v1/send/message");
    assert.equal(request.options.headers.Authorization, "Bearer mbs_test-token");
    assert.equal(request.body.phone, "+254712345678");
    assert.equal(result.status, "PROVIDER_ACCEPTED");
});

test("unavailable development test SMS configuration fails before dispatch with variable names only", async () => {
    let requests = 0;
    const environment = {
        NODE_ENV: "development",
        MOBILESASA_SMS_ENABLED: "false",
    };
    await assert.rejects(smsService.sendPhoneVerificationSms({
        to: "+254712345678",
        message: "verification code",
        trackingId: "phone-verification-test",
    }, {
        environment,
        fetchImpl: async () => { requests += 1; },
    }), (error) => {
        assert.equal(error.code, "SMS_TEST_DISABLED");
        assert.ok(error.diagnostics.missingVariables.includes("MOBILESASA_TEST_SMS_ENABLED"));
        assert.doesNotMatch(JSON.stringify(error.diagnostics), /mbs_|MicoPesa/);
        return true;
    });
    assert.equal(requests, 0);
});

test("availability and production Mobile Sasa dispatch use the same selected provider", async () => {
    const environment = {
        NODE_ENV: "production",
        TRANSACTIONAL_SMS_PROVIDER: "MOBILE_SASA",
        MOBILESASA_SMS_ENABLED: "true",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };
    const configuration = smsService.getPhoneVerificationSmsConfiguration(environment);
    let requestUrl;
    let deliveryProvider;
    const result = await smsService.sendPhoneVerificationSms({
        to: "+254712345678",
        message: "verification code",
        trackingId: "phone-verification-test",
    }, {
        environment,
        fetchImpl: async (url) => {
            requestUrl = url;
            return {
                ok: true,
                status: 200,
                async json() {
                    return { status: true, responseCode: "0200", messageId: "mock-id" };
                },
            };
        },
    });
    deliveryProvider = result.deliveryResult.provider;
    assert.equal(configuration.available, true);
    assert.equal(configuration.provider, deliveryProvider);
    assert.equal(requestUrl, "https://api.mobilesasa.com/v1/send/message");
});

test("phone verification refuses a provider changed after its availability preflight", async () => {
    let requests = 0;
    const expectedConfiguration = {
        available: true,
        mode: "production-transactional",
        provider: "AFRICAS_TALKING",
    };
    await assert.rejects(smsService.sendPhoneVerificationSms({
        to: "+254712345678",
        message: "verification code",
        trackingId: "phone-verification-test",
    }, {
        environment: {
            NODE_ENV: "production",
            TRANSACTIONAL_SMS_PROVIDER: "MOBILE_SASA",
            MOBILESASA_SMS_ENABLED: "true",
            MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
            MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
        },
        providerConfiguration: expectedConfiguration,
        fetchImpl: async () => { requests += 1; },
    }), { code: "SMS_CONFIGURATION_CHANGED" });
    assert.equal(requests, 0);
});

test("notification provider selection does not change direct staff SMS from Africa's Talking", async () => {
    let url;
    await smsService.sendSms(
        { to: "+254712345678", message: "staff access notice" },
        {
            environment: {
                ...configuredEnvironment,
                NOTIFICATION_SMS_PROVIDER: "MOBILE_SASA",
            },
            fetchImpl: async (requestUrl) => {
                url = requestUrl;
                return providerResponse({
                    recipients: [{ status: "Success", messageId: "message-id" }],
                });
            },
        }
    );

    assert.equal(url, "https://api.africastalking.com/version1/messaging");
});

test("notification service selects Mobile Sasa only when explicitly injected by the dispatcher", async () => {
    let requestUrl;
    await smsService.sendSms({
        to: "0712345678",
        message: "notification",
        trackingId: "notification-123",
    }, {
        provider: "MOBILE_SASA",
        environment: {
            NODE_ENV: "production",
            MOBILESASA_SMS_ENABLED: "true",
            MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
            MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
        },
        fetchImpl: async (url) => {
            requestUrl = url;
            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        status: true,
                        responseCode: "0200",
                        messageId: "mobile-sasa-1",
                        cost: 1,
                    };
                },
            };
        },
    });

    assert.equal(requestUrl, "https://api.mobilesasa.com/v1/send/message");
});

test("development SMS supports multiple allowlisted recipients", async () => {
    const requestBodies = [];
    const environment = {
        NODE_ENV: "development",
        COMMUNICATIONS_DEV_DELIVERY_ENABLED: "true",
        COMMUNICATIONS_DEV_SMS_ENABLED: "true",
        COMMUNICATIONS_DEV_ALLOWED_PHONES: "+254712345678,0700000001",
        TRANSACTIONAL_SMS_PROVIDER: "MOBILE_SASA",
        MOBILESASA_SMS_ENABLED: "true",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };
    for (const [to, trackingId] of [
        ["+254712345678", "development-sms-1"],
        ["0700000001", "development-sms-2"],
    ]) {
        const result = await smsService.sendSms({
            to,
            message: "Mocked development delivery",
            trackingId,
        }, {
            environment,
            provider: "MOBILE_SASA",
            fetchImpl: async (_url, options) => {
                requestBodies.push(JSON.parse(options.body));
                return {
                    ok: true,
                    status: 200,
                    async json() {
                        return {
                            status: true,
                            responseCode: "0200",
                            messageId: `accepted-${trackingId}`,
                        };
                    },
                };
            },
        });
        assert.equal(result.status, "PROVIDER_ACCEPTED");
    }

    assert.deepEqual(requestBodies.map((request) => request.phone), [
        "+254712345678",
        "+254700000001",
    ]);
});

test("development SMS is blocked when delivery is disabled or the recipient is invalid", async () => {
    let requests = 0;
    const environment = {
        NODE_ENV: "development",
        COMMUNICATIONS_DEV_DELIVERY_ENABLED: "true",
        COMMUNICATIONS_DEV_SMS_ENABLED: "true",
        MOBILESASA_SMS_ENABLED: "true",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_test-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };
    for (const [overrides, code] of [
        [{ COMMUNICATIONS_DEV_DELIVERY_ENABLED: "false" }, "SMS_DEVELOPMENT_DELIVERY_DISABLED"],
    ]) {
        await assert.rejects(() => smsService.sendSms({
            to: "0712345678",
            message: "Local development test",
            trackingId: "blocked-sms-1",
        }, {
            environment: { ...environment, ...overrides },
            provider: "MOBILE_SASA",
            fetchImpl: async () => { requests += 1; },
        }), { code });
    }
    await assert.rejects(() => smsService.sendSms({
        to: "not-a-phone",
        message: "Local development test",
        trackingId: "blocked-sms-invalid",
    }, {
        environment,
        provider: "MOBILE_SASA",
        fetchImpl: async () => { requests += 1; },
    }), { code: "SMS_INVALID_RECIPIENT" });
    assert.equal(requests, 0);
});

test("rejects invalid Kenyan phone numbers without making a provider request", async () => {
    let requests = 0;
    await assert.rejects(
        smsService.sendSms(
            { to: "12345", message: "test" },
            {
                environment: configuredEnvironment,
                fetchImpl: async () => {
                    requests += 1;
                },
            }
        ),
        { code: "SMS_INVALID_RECIPIENT" }
    );
    assert.equal(requests, 0);
});

test("reports missing provider configuration without making a request", async () => {
    let requests = 0;
    await assert.rejects(
        smsService.sendSms(
            { to: "+254712345678", message: "test" },
            {
                environment: {
                    NODE_ENV: "production",
                    AT_ENVIRONMENT: "production",
                },
                fetchImpl: async () => {
                    requests += 1;
                },
            }
        ),
        { code: "SMS_CONFIGURATION_MISSING" }
    );
    assert.equal(requests, 0);
});

test("does not send from development or test runtimes", async () => {
    let requests = 0;
    for (const nodeEnvironment of ["development", "test"]) {
        await assert.rejects(
            smsService.sendSms(
                { to: "+254712345678", message: "test" },
                {
                    environment: { ...configuredEnvironment, NODE_ENV: nodeEnvironment },
                    fetchImpl: async () => {
                        requests += 1;
                    },
                }
            ),
            {
                code: nodeEnvironment === "development"
                    ? "SMS_DEVELOPMENT_DELIVERY_DISABLED"
                    : "SMS_PRODUCTION_ONLY",
            }
        );
    }
    assert.equal(requests, 0);
});

test("requires explicit production provider mode and rejects sandbox credentials", async (t) => {
    let requests = 0;
    await t.test("provider mode missing", async () => {
        await assert.rejects(
            smsService.sendSms(
                { to: "+254712345678", message: "test" },
                {
                    environment: { ...configuredEnvironment, AT_ENVIRONMENT: undefined },
                    fetchImpl: async () => {
                        requests += 1;
                    },
                }
            ),
            { code: "SMS_ENVIRONMENT_MISMATCH" }
        );
    });
    await t.test("sandbox username", async () => {
        await assert.rejects(
            smsService.sendSms(
                { to: "+254712345678", message: "test" },
                {
                    environment: { ...configuredEnvironment, AT_USERNAME: "sandbox" },
                    fetchImpl: async () => {
                        requests += 1;
                    },
                }
            ),
            { code: "SMS_SANDBOX_CREDENTIALS" }
        );
    });
    assert.equal(requests, 0);
});

test("handles a provider-rejected message with a sanitized error", async () => {
    await assert.rejects(
        smsService.sendSms(
            { to: "+254712345678", message: "test" },
            {
                environment: configuredEnvironment,
                fetchImpl: async () => providerResponse({
                    recipients: [{ status: "Failed", statusCode: 402 }],
                }),
            }
        ),
        { code: "SMS_PROVIDER_REJECTED", message: "The SMS provider did not accept the message." }
    );
});

test("treats a provider server error as an unknown outcome", async () => {
    await assert.rejects(
        smsService.sendSms(
            { to: "+254712345678", message: "test" },
            {
                environment: configuredEnvironment,
                fetchImpl: async () => providerResponse({ ok: false, status: 503 }),
            }
        ),
        {
            code: "SMS_UNKNOWN_OUTCOME",
            message: "The SMS provider outcome could not be established.",
        }
    );
});

test("classifies an explicit rate-limit rejection as safely retryable", async () => {
    await assert.rejects(
        smsService.sendSms(
            { to: "+254712345678", message: "test" },
            {
                environment: configuredEnvironment,
                fetchImpl: async () => providerResponse({ ok: false, status: 429 }),
            }
        ),
        {
            code: "SMS_RETRYABLE_REJECTION",
            message: "The SMS provider explicitly rejected the request for rate limiting.",
        }
    );
});

test("reports network failures without exposing provider or message data", async () => {
    await assert.rejects(
        smsService.sendSms(
            { to: "+254712345678", message: "private message" },
            {
                environment: configuredEnvironment,
                fetchImpl: async () => {
                    throw new Error("sensitive provider response");
                },
            }
        ),
        {
            code: "SMS_NETWORK_ERROR",
            message: "The SMS provider request failed.",
        }
    );
});

test("aborts and rejects a provider request that exceeds its timeout", async () => {
    let requestSignal;
    await assert.rejects(
        smsService.sendSms(
            { to: "+254712345678", message: "test" },
            {
                environment: configuredEnvironment,
                timeoutMs: 5,
                fetchImpl: async (_url, options) => {
                    requestSignal = options.signal;
                    return new Promise(() => {});
                },
            }
        ),
        { code: "SMS_TIMEOUT", message: "The SMS provider request timed out." }
    );
    assert.equal(requestSignal.aborted, true);
});

test("applies the provider timeout while reading the response body", async () => {
    let requestSignal;
    await assert.rejects(
        smsService.sendSms(
            { to: "+254712345678", message: "test" },
            {
                environment: configuredEnvironment,
                timeoutMs: 5,
                fetchImpl: async (_url, options) => {
                    requestSignal = options.signal;
                    return { ok: true, json: () => new Promise(() => {}) };
                },
            }
        ),
        { code: "SMS_TIMEOUT" }
    );
    assert.equal(requestSignal.aborted, true);
});

test("rejects malformed or ambiguous provider responses", async (t) => {
    const cases = [
        ["non-JSON body", async () => ({ ok: true, json: async () => { throw new Error("bad json"); } })],
        ["missing recipients", async () => providerResponse({ recipients: null })],
        ["multiple recipients", async () => providerResponse({
            recipients: [{ status: "Success" }, { status: "Success" }],
        })],
        ["non-success HTTP status", async () => providerResponse({
            ok: false,
            status: 503,
            recipients: [{ status: "Success" }],
        }), "SMS_UNKNOWN_OUTCOME"],
    ];

    for (const [name, fetchImpl, code = "SMS_INVALID_RESPONSE"] of cases) {
        await t.test(name, async () => {
            await assert.rejects(
                smsService.sendSms(
                    { to: "+254712345678", message: "test" },
                    { environment: configuredEnvironment, fetchImpl }
                ),
                { code }
            );
        });
    }
});

test("rejects an empty message before making a provider request", async () => {
    let requests = 0;
    await assert.rejects(
        smsService.sendSms(
            { to: "+254712345678", message: " " },
            {
                environment: configuredEnvironment,
                fetchImpl: async () => {
                    requests += 1;
                },
            }
        ),
        { code: "SMS_INVALID_MESSAGE" }
    );
    assert.equal(requests, 0);
});
