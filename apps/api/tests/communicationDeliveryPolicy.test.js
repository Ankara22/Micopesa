const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    assertDevelopmentRecipientAllowed,
    isDevelopmentChannelConfigured,
    normalizeRecipient,
} = require("../src/services/communicationDeliveryPolicy");

const enabledEnvironment = {
    NODE_ENV: "development",
    COMMUNICATIONS_DEV_DELIVERY_ENABLED: "true",
    COMMUNICATIONS_DEV_SMS_ENABLED: "true",
    COMMUNICATIONS_DEV_EMAIL_ENABLED: "true",
    COMMUNICATIONS_DEV_ALLOWED_PHONES: "0712 345 678",
    COMMUNICATIONS_DEV_ALLOWED_EMAILS: "  Tester@Example.Test ",
};

test("normalizes development allowlist recipients before exact comparison", () => {
    assert.equal(normalizeRecipient("SMS", " +254 (712) 345-678 "), "+254712345678");
    assert.equal(normalizeRecipient("EMAIL", " Tester@Example.Test "), "tester@example.test");
    assert.equal(isDevelopmentChannelConfigured("SMS", enabledEnvironment), true);
    assert.equal(isDevelopmentChannelConfigured("EMAIL", enabledEnvironment), true);
    assert.doesNotThrow(() =>
        assertDevelopmentRecipientAllowed("SMS", "+254712345678", enabledEnvironment));
    assert.doesNotThrow(() =>
        assertDevelopmentRecipientAllowed("EMAIL", "TESTER@example.test", enabledEnvironment));
});

test("development delivery fails closed when disabled or allowlists are empty", () => {
    assert.throws(() => assertDevelopmentRecipientAllowed("SMS", "0712345678", {
        ...enabledEnvironment,
        COMMUNICATIONS_DEV_DELIVERY_ENABLED: "false",
    }), { code: "SMS_DEVELOPMENT_DELIVERY_DISABLED" });
    assert.throws(() => assertDevelopmentRecipientAllowed("EMAIL", "tester@example.test", {
        ...enabledEnvironment,
        COMMUNICATIONS_DEV_ALLOWED_EMAILS: "",
    }), { code: "EMAIL_DEVELOPMENT_ALLOWLIST_EMPTY" });
    assert.equal(isDevelopmentChannelConfigured("EMAIL", {
        ...enabledEnvironment,
        COMMUNICATIONS_DEV_ALLOWED_EMAILS: "not-an-email",
    }), false);
});

test("an unset local NODE_ENV still requires every explicit development delivery switch", () => {
    const environment = { ...enabledEnvironment, NODE_ENV: undefined };
    assert.doesNotThrow(() =>
        assertDevelopmentRecipientAllowed("SMS", "0712345678", environment));
    assert.throws(() => assertDevelopmentRecipientAllowed("SMS", "0712345678", {
        ...environment,
        COMMUNICATIONS_DEV_DELIVERY_ENABLED: "false",
    }), { code: "SMS_DEVELOPMENT_DELIVERY_DISABLED" });
});

test("development delivery rejects recipients outside the allowlist without exposing it", () => {
    assert.throws(() => assertDevelopmentRecipientAllowed("SMS", "0711111111", enabledEnvironment), {
        code: "SMS_DEVELOPMENT_RECIPIENT_NOT_ALLOWED",
    });
    assert.throws(() => assertDevelopmentRecipientAllowed("EMAIL", "other@example.test", enabledEnvironment), {
        code: "EMAIL_DEVELOPMENT_RECIPIENT_NOT_ALLOWED",
    });
});
