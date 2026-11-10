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

    assert.equal(requestUrl, "https://api.mobilesasa.com/v2/send/message");
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
            { code: "SMS_PRODUCTION_ONLY" }
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
