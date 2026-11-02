const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const smsService = require("../src/services/smsService");

const originalFetch = global.fetch;
const originalEnvironment = {
    AT_USERNAME: process.env.AT_USERNAME,
    AT_API_KEY: process.env.AT_API_KEY,
    AT_SENDER_ID: process.env.AT_SENDER_ID,
};

after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

test("reports missing SMS configuration without making a network request", async () => {
    delete process.env.AT_USERNAME;
    delete process.env.AT_API_KEY;
    global.fetch = async () => assert.fail("Missing configuration must not send a request");
    await assert.rejects(smsService.sendSms({ to: "+254712345678", message: "test" }), {
        code: "SMS_CONFIGURATION_MISSING",
    });
});

test("returns acceptance separately from inbox delivery on provider success", async () => {
    process.env.AT_USERNAME = "sandbox";
    process.env.AT_API_KEY = "test-key";
    let request;
    global.fetch = async (url, options) => {
        request = { url, options };
        return {
            ok: true,
            status: 201,
            json: async () => ({
                SMSMessageData: {
                    Recipients: [{ status: "Success", statusCode: 101, messageId: "message-id" }],
                },
            }),
        };
    };
    const result = await smsService.sendSms({ to: "+254712345678", message: "temporary credential" });
    assert.equal(result.accepted, true);
    assert.equal(result.messageId, "message-id");
    assert.equal(request.url, "https://api.africastalking.com/version1/messaging");
    assert.equal(request.options.headers.apiKey, "test-key");
    assert.match(request.options.body, /temporary\+credential/);
});

test("rejects provider-reported SMS failure", async () => {
    process.env.AT_USERNAME = "sandbox";
    process.env.AT_API_KEY = "test-key";
    global.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
            SMSMessageData: {
                Recipients: [{ status: "Failed", statusCode: 402, messageId: "" }],
            },
        }),
    });
    await assert.rejects(smsService.sendSms({ to: "+254712345678", message: "test" }), {
        code: 402,
    });
});
