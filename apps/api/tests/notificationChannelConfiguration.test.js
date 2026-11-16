const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    getNotificationChannelAvailability,
    getNotificationChannelAvailabilityMap,
} = require("../src/services/notificationChannelConfiguration");
const mobileSasaService = require("../src/services/mobileSasaService");
const { sendSms } = require("../src/services/smsService");

function developmentSmsEnvironment(overrides = {}) {
    return {
        NODE_ENV: "development",
        COMMUNICATIONS_DEV_DELIVERY_ENABLED: "true",
        COMMUNICATIONS_DEV_SMS_ENABLED: "true",
        COMMUNICATIONS_DEV_ALLOWED_PHONES: "+254712345678",
        TRANSACTIONAL_SMS_PROVIDER: "MOBILE_SASA",
        MOBILESASA_TEST_SMS_ENABLED: "true",
        MOBILESASA_SMS_ENABLED: "false",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_mock-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
        ...overrides,
    };
}

test("development notification SMS uses a distinct explicit switch from phone verification", async () => {
    const environment = developmentSmsEnvironment({
        MOBILESASA_NOTIFICATION_SMS_ENABLED: "true",
        MOBILESASA_TEST_SMS_ENABLED: "false",
        MOBILESASA_SMS_ENABLED: "false",
    });
    const availability = getNotificationChannelAvailability("SMS", environment);
    assert.equal(availability.enabled, true);
    const verificationEnvironment = {
        ...environment,
        MOBILESASA_TEST_SMS_ENABLED: "true",
        MOBILESASA_SMS_ENABLED: "false",
    };
    assert.equal(mobileSasaService.isTestSmsConfigured(verificationEnvironment), true);
    assert.equal(mobileSasaService.isPhoneVerificationSmsConfigured(verificationEnvironment), true);

    const requests = [];
    const result = await sendSms({
        to: "+254712345678",
        message: "Synthetic notification",
        trackingId: "notification-1",
    }, {
        environment,
        provider: "MOBILE_SASA",
        notificationDelivery: true,
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            return {
                ok: true,
                status: 200,
                async json() {
                    return { status: true, responseCode: "0200", messageId: "mock-message-1" };
                },
            };
        },
    });

    assert.equal(result.status, "PROVIDER_ACCEPTED");
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /api\.mobilesasa\.com/);
});

test("missing and false notification SMS switches fail closed without looking like provider errors", async () => {
    const environment = developmentSmsEnvironment();
    const availability = getNotificationChannelAvailability("SMS", environment);
    assert.equal(availability.enabled, false);
    assert.equal(availability.reason_code, "system_delivery_disabled");
    assert.deepEqual(availability.missing_variables, ["MOBILESASA_NOTIFICATION_SMS_ENABLED"]);
    assert.deepEqual(availability.disabled_variables, []);
    assert.deepEqual(availability.invalid_variables, []);

    const explicitlyDisabled = getNotificationChannelAvailability("SMS", {
        ...environment,
        MOBILESASA_NOTIFICATION_SMS_ENABLED: "false",
    });
    assert.equal(explicitlyDisabled.enabled, false);
    assert.equal(explicitlyDisabled.reason_code, "system_delivery_disabled");
    assert.deepEqual(explicitlyDisabled.missing_variables, []);
    assert.deepEqual(explicitlyDisabled.disabled_variables, ["MOBILESASA_NOTIFICATION_SMS_ENABLED"]);
    assert.deepEqual(explicitlyDisabled.invalid_variables, []);

    let requestCount = 0;
    await assert.rejects(() => sendSms({
        to: "+254712345678",
        message: "Synthetic notification",
        trackingId: "notification-2",
    }, {
        environment,
        provider: "MOBILE_SASA",
        notificationDelivery: true,
        fetchImpl: async () => {
            requestCount += 1;
            throw new Error("The mocked provider must not be called.");
        },
    }), { code: "SMS_NOTIFICATION_DELIVERY_DISABLED" });
    assert.equal(requestCount, 0);

    await assert.rejects(() => sendSms({
        to: "+254712345678",
        message: "Synthetic notification",
        trackingId: "notification-3",
    }, {
        environment: {
            ...environment,
            MOBILESASA_NOTIFICATION_SMS_ENABLED: "false",
        },
        provider: "MOBILE_SASA",
        notificationDelivery: true,
        fetchImpl: async () => {
            requestCount += 1;
            throw new Error("The mocked provider must not be called.");
        },
    }), { code: "SMS_NOTIFICATION_DELIVERY_DISABLED" });
    assert.equal(requestCount, 0);
    assert.equal(mobileSasaService.isPhoneVerificationSmsConfigured(environment), true);
    assert.equal(mobileSasaService.isTestSmsConfigured(environment), true);
});

test("notification SMS provider credentials are validated independently of notification and test switches", () => {
    const enabled = developmentSmsEnvironment({
        MOBILESASA_NOTIFICATION_SMS_ENABLED: "true",
        MOBILESASA_SMS_ENABLED: "false",
        MOBILESASA_TEST_SMS_ENABLED: "false",
    });
    assert.equal(getNotificationChannelAvailability("SMS", enabled).enabled, true);

    const missingCredentials = getNotificationChannelAvailability("SMS", {
        ...enabled,
        MOBILE_SASA_SMS_API_TOKEN: "",
    });
    assert.equal(missingCredentials.enabled, false);
    assert.equal(missingCredentials.reason_code, "provider_configuration_missing");
    assert.ok(missingCredentials.missing_variables.includes("MOBILE_SASA_SMS_API_TOKEN"));

    const invalidCredentials = getNotificationChannelAvailability("SMS", {
        ...enabled,
        MOBILE_SASA_SMS_API_TOKEN: "invalid-token",
    });
    assert.equal(invalidCredentials.enabled, false);
    assert.equal(invalidCredentials.reason_code, "provider_configuration_invalid");
    assert.ok(invalidCredentials.invalid_variables.includes("MOBILE_SASA_SMS_API_TOKEN"));
});

test("production SMS availability validates both supported providers and required credentials", () => {
    const africaTalking = {
        NODE_ENV: "production",
        SMS_DISPATCHER_ENABLED: "true",
        NOTIFICATION_SMS_PROVIDER: "AFRICAS_TALKING",
        AT_ENVIRONMENT: "production",
        AT_USERNAME: "production-account",
        AT_API_KEY: "mock-api-key",
    };
    assert.equal(getNotificationChannelAvailability("SMS", africaTalking).enabled, true);

    const mobileSasa = {
        NODE_ENV: "production",
        SMS_DISPATCHER_ENABLED: "true",
        NOTIFICATION_SMS_PROVIDER: "MOBILE_SASA",
        MOBILESASA_NOTIFICATION_SMS_ENABLED: "true",
        MOBILESASA_SMS_ENABLED: "false",
        MOBILE_SASA_SMS_API_TOKEN: "mbs_mock-token",
        MOBILE_SASA_SMS_SENDER_ID: "MicoPesa",
    };
    assert.equal(getNotificationChannelAvailability("SMS", mobileSasa).enabled, true);
    const disabledMobileSasa = getNotificationChannelAvailability("SMS", {
        ...mobileSasa,
        MOBILESASA_NOTIFICATION_SMS_ENABLED: "false",
    });
    assert.equal(disabledMobileSasa.enabled, false);
    assert.equal(disabledMobileSasa.reason_code, "system_delivery_disabled");
    assert.deepEqual(disabledMobileSasa.disabled_variables, ["MOBILESASA_NOTIFICATION_SMS_ENABLED"]);

    const missingCredentials = getNotificationChannelAvailability("SMS", {
        NODE_ENV: "production",
        SMS_DISPATCHER_ENABLED: "true",
        NOTIFICATION_SMS_PROVIDER: "AFRICAS_TALKING",
        AT_ENVIRONMENT: "production",
    });
    assert.equal(missingCredentials.enabled, false);
    assert.equal(missingCredentials.reason_code, "provider_configuration_missing");
    assert.deepEqual(missingCredentials.missing_variables, ["AT_USERNAME", "AT_API_KEY"]);

    const invalidCredentials = getNotificationChannelAvailability("SMS", {
        ...africaTalking,
        AT_ENVIRONMENT: "sandbox",
        AT_USERNAME: "sandbox",
    });
    assert.equal(invalidCredentials.enabled, false);
    assert.equal(invalidCredentials.reason_code, "provider_configuration_invalid");
    assert.deepEqual(invalidCredentials.invalid_variables, ["AT_ENVIRONMENT", "AT_USERNAME"]);
});

test("email and push availability use the same validated provider configuration as dispatch", () => {
    const production = {
        NODE_ENV: "production",
        NOTIFICATION_DISPATCHER_ENABLED: "true",
        EMAIL_NOTIFICATIONS_ENABLED: "true",
        EMAIL_PROVIDER: "GMAIL",
        GMAIL_USER: "sender@example.test",
        GMAIL_APP_PASSWORD: "abcdefghijklmnop",
        WEB_PUSH_ENABLED: "true",
        WEB_PUSH_PUBLIC_KEY: "mock-public-key",
        WEB_PUSH_PRIVATE_KEY: "mock-private-key",
        WEB_PUSH_SUBJECT: "mailto:ops@example.test",
    };
    const channels = getNotificationChannelAvailabilityMap(production);
    assert.equal(channels.email.enabled, true);
    assert.equal(channels.push.enabled, true);

    const invalidEmail = getNotificationChannelAvailability("EMAIL", {
        ...production,
        GMAIL_APP_PASSWORD: "invalid-format",
    });

    test("development email requires both delivery switches and valid provider configuration", () => {
        const development = {
            NODE_ENV: "development",
            COMMUNICATIONS_DEV_DELIVERY_ENABLED: "true",
            COMMUNICATIONS_DEV_EMAIL_ENABLED: "true",
            EMAIL_PROVIDER: "GMAIL",
            GMAIL_USER: "sender@example.test",
            GMAIL_APP_PASSWORD: "abcdefghijklmnop",
        };
        assert.equal(getNotificationChannelAvailability("EMAIL", development).enabled, true);

        for (const switchName of [
            "COMMUNICATIONS_DEV_DELIVERY_ENABLED",
            "COMMUNICATIONS_DEV_EMAIL_ENABLED",
        ]) {
            const disabled = getNotificationChannelAvailability("EMAIL", {
                ...development,
                [switchName]: "false",
            });
            assert.equal(disabled.enabled, false);
            assert.equal(disabled.reason_code, "system_delivery_disabled");
            assert.deepEqual(disabled.disabled_variables, [switchName]);
        }

        const missingProvider = getNotificationChannelAvailability("EMAIL", {
            ...development,
            GMAIL_USER: "",
        });
        assert.equal(missingProvider.enabled, false);
        assert.equal(missingProvider.reason_code, "provider_configuration_missing");

        const invalidProvider = getNotificationChannelAvailability("EMAIL", {
            ...development,
            GMAIL_APP_PASSWORD: "invalid-format",
        });
        assert.equal(invalidProvider.enabled, false);
        assert.equal(invalidProvider.reason_code, "provider_configuration_invalid");
    });
    assert.equal(invalidEmail.enabled, false);
    assert.equal(invalidEmail.reason_code, "provider_configuration_invalid");
    assert.deepEqual(invalidEmail.invalid_variables, ["GMAIL_APP_PASSWORD"]);

    const unavailablePush = getNotificationChannelAvailability("PUSH", {
        ...production,
        WEB_PUSH_ENABLED: "false",
    });
    assert.equal(unavailablePush.enabled, false);
    assert.equal(unavailablePush.reason_code, "system_delivery_disabled");
    assert.deepEqual(unavailablePush.disabled_variables, ["WEB_PUSH_ENABLED"]);
    assert.deepEqual(unavailablePush.invalid_variables, []);
});
