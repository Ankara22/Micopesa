const {
    getNotificationSmsConfigurationStatus,
} = require("./smsService");
const {
    getEmailProviderConfigurationStatus,
} = require("./adminEmailNotificationService");
const { getWebPushConfigurationStatus } = require("./webPushService");
const {
    isDevelopmentDeliveryRuntime,
} = require("./communicationDeliveryPolicy");

function getNotificationSmsProvider(environment = process.env) {
    return environment.NOTIFICATION_SMS_PROVIDER?.trim().toUpperCase() ||
        environment.TRANSACTIONAL_SMS_PROVIDER?.trim().toUpperCase() ||
        "AFRICAS_TALKING";
}

function disabled(channel, reasonCode, provider = null, details = {}) {
    return {
        channel,
        enabled: false,
        reason_code: reasonCode,
        provider,
        missing_variables: details.missingVariables || [],
        disabled_variables: details.disabledVariables || [],
        invalid_variables: details.invalidVariables || [],
    };
}

function enabled(channel, provider) {
    return {
        channel,
        enabled: true,
        reason_code: null,
        provider,
        missing_variables: [],
        disabled_variables: [],
        invalid_variables: [],
    };
}

function requireFlags(channel, names, environment, provider) {
    const disabledFlags = names.filter((name) => environment[name] !== "true");
    if (!disabledFlags.length) return null;
    const missingVariables = disabledFlags.filter((name) =>
        typeof environment[name] !== "string" || !environment[name].trim()
    );
    const disabledVariables = disabledFlags.filter((name) =>
        environment[name] === "false"
    );
    return disabled(
        channel,
        "system_delivery_disabled",
        provider,
        {
            missingVariables,
            disabledVariables,
            invalidVariables: disabledFlags.filter((name) =>
                typeof environment[name] === "string" &&
                environment[name].trim() &&
                environment[name] !== "false"
            ),
        }
    );
}

function providerStatus(channel, provider, status) {
    if (status.available) return enabled(channel, provider);
    const reasonCode = status.errorCode?.includes("UNSUPPORTED")
        ? "provider_unsupported"
        : status.invalidVariables?.length
            ? "provider_configuration_invalid"
            : "provider_configuration_missing";
    return disabled(channel, reasonCode, provider, {
        missingVariables: status.missingVariables,
        invalidVariables: status.invalidVariables,
    });
}

function getNotificationChannelAvailability(channel, environment = process.env) {
    const normalizedChannel = typeof channel === "string" ? channel.toUpperCase() : "";
    const development = isDevelopmentDeliveryRuntime(environment);
    const production = environment.NODE_ENV === "production";

    if (!development && !production) {
        return disabled(normalizedChannel, "environment_unsupported");
    }

    if (normalizedChannel === "SMS") {
        const provider = getNotificationSmsProvider(environment);
        if (development) {
            const requiredFlags = [
                "COMMUNICATIONS_DEV_DELIVERY_ENABLED",
                "COMMUNICATIONS_DEV_SMS_ENABLED",
                ...(provider === "MOBILE_SASA" ? ["MOBILESASA_NOTIFICATION_SMS_ENABLED"] : []),
            ];
            const flags = requireFlags(
                normalizedChannel,
                requiredFlags,
                environment,
                provider
            );
            if (flags) return flags;
            if (provider !== "MOBILE_SASA") {
                return disabled(normalizedChannel, "provider_unsupported", provider, {
                    invalidVariables: ["NOTIFICATION_SMS_PROVIDER"],
                });
            }
        } else {
            const requiredFlags = [
                "SMS_DISPATCHER_ENABLED",
                ...(provider === "MOBILE_SASA" ? ["MOBILESASA_NOTIFICATION_SMS_ENABLED"] : []),
            ];
            const flags = requireFlags(
                normalizedChannel,
                requiredFlags,
                environment,
                provider
            );
            if (flags) return flags;
        }
        return providerStatus(
            normalizedChannel,
            provider,
            getNotificationSmsConfigurationStatus(provider, environment)
        );
    }

    if (normalizedChannel === "EMAIL") {
        const status = getEmailProviderConfigurationStatus(environment);
        const provider = status.provider;
        if (development) {
            const flags = requireFlags(
                normalizedChannel,
                ["COMMUNICATIONS_DEV_DELIVERY_ENABLED", "COMMUNICATIONS_DEV_EMAIL_ENABLED"],
                environment,
                provider
            );
            if (flags) return flags;
            if (provider !== "GMAIL") {
                return disabled(normalizedChannel, "provider_unsupported", provider, {
                    invalidVariables: ["EMAIL_PROVIDER"],
                });
            }
        } else {
            const flags = requireFlags(
                normalizedChannel,
                ["NOTIFICATION_DISPATCHER_ENABLED", "EMAIL_NOTIFICATIONS_ENABLED"],
                environment,
                provider
            );
            if (flags) return flags;
        }
        return providerStatus(normalizedChannel, provider, status);
    }

    if (normalizedChannel === "PUSH") {
        if (!production) {
            return disabled(normalizedChannel, "environment_unsupported", "WEB_PUSH", {
                invalidVariables: ["NODE_ENV"],
            });
        }
        const flags = requireFlags(
            normalizedChannel,
            ["NOTIFICATION_DISPATCHER_ENABLED", "WEB_PUSH_ENABLED"],
            environment,
            "WEB_PUSH"
        );
        if (flags) return flags;
        return providerStatus(
            normalizedChannel,
            "WEB_PUSH",
            getWebPushConfigurationStatus(environment)
        );
    }

    return disabled(normalizedChannel, "channel_unsupported");
}

function getNotificationChannelAvailabilityMap(environment = process.env) {
    return Object.fromEntries(["SMS", "EMAIL", "PUSH"].map((channel) => [
        channel.toLowerCase(),
        getNotificationChannelAvailability(channel, environment),
    ]));
}

module.exports = {
    getNotificationChannelAvailability,
    getNotificationChannelAvailabilityMap,
    getNotificationSmsProvider,
};
