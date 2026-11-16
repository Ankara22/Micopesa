const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    assertDevelopmentRecipientAllowed,
    assertDevelopmentDeliveryEnabled,
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

test("development delivery supports registered recipients without reading manual allowlists", () => {
    assert.equal(normalizeRecipient("SMS", " +254 (712) 345-678 "), "+254712345678");
    assert.equal(normalizeRecipient("EMAIL", " Tester@Example.Test "), "tester@example.test");
    assert.equal(isDevelopmentChannelConfigured("SMS", enabledEnvironment), true);
    assert.equal(isDevelopmentChannelConfigured("EMAIL", enabledEnvironment), true);
    assert.doesNotThrow(() => assertDevelopmentRecipientAllowed(
        "SMS", "+254712345678", enabledEnvironment
    ));
    assert.doesNotThrow(() => assertDevelopmentRecipientAllowed(
        "EMAIL", "TESTER@example.test", enabledEnvironment
    ));
    assert.throws(() => assertDevelopmentRecipientAllowed("SMS", "0711111111", enabledEnvironment), {
        code: "SMS_DEVELOPMENT_RECIPIENT_NOT_ALLOWED",
    });
    assert.throws(() => assertDevelopmentRecipientAllowed("EMAIL", "other@example.test", enabledEnvironment), {
        code: "EMAIL_DEVELOPMENT_RECIPIENT_NOT_ALLOWED",
    });
    assert.throws(() => assertDevelopmentRecipientAllowed("SMS", "+254712345678", {
        ...enabledEnvironment,
        COMMUNICATIONS_DEV_ALLOWED_PHONES: "",
    }), { code: "SMS_DEVELOPMENT_ALLOWLIST_EMPTY" });
    assert.throws(() => assertDevelopmentRecipientAllowed("EMAIL", "tester@example.test", {
        ...enabledEnvironment,
        COMMUNICATIONS_DEV_ALLOWED_EMAILS: "invalid",
    }), { code: "EMAIL_DEVELOPMENT_ALLOWLIST_EMPTY" });
});

test("development delivery still fails closed when global or channel switches are disabled", () => {
    assert.throws(() => assertDevelopmentDeliveryEnabled("SMS", {
        ...enabledEnvironment,
        COMMUNICATIONS_DEV_DELIVERY_ENABLED: "false",
    }), { code: "SMS_DEVELOPMENT_DELIVERY_DISABLED" });
    assert.equal(isDevelopmentChannelConfigured("EMAIL", {
        ...enabledEnvironment,
        COMMUNICATIONS_DEV_EMAIL_ENABLED: "false",
    }), false);
    assert.throws(() => assertDevelopmentDeliveryEnabled("EMAIL", {
        ...enabledEnvironment,
        COMMUNICATIONS_DEV_EMAIL_ENABLED: "false",
    }), { code: "EMAIL_DEVELOPMENT_DELIVERY_DISABLED" });
});

test("an unset local NODE_ENV still requires every explicit development delivery switch", () => {
    const environment = { ...enabledEnvironment, NODE_ENV: undefined };
    assert.doesNotThrow(() => assertDevelopmentDeliveryEnabled("SMS", environment));
    assert.throws(() => assertDevelopmentDeliveryEnabled("SMS", {
        ...environment,
        COMMUNICATIONS_DEV_DELIVERY_ENABLED: "false",
    }), { code: "SMS_DEVELOPMENT_DELIVERY_DISABLED" });
});

test("non-production, non-development runtimes cannot send development notifications", () => {
    const environment = { ...enabledEnvironment, NODE_ENV: "test" };
    assert.equal(isDevelopmentChannelConfigured("SMS", environment), false);
    assert.throws(() => assertDevelopmentDeliveryEnabled("SMS", environment), {
        code: "SMS_PRODUCTION_ONLY",
    });
});
