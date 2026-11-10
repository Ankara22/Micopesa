const PAYMENT_PROVIDERS = new Set(["DARAJA", "SIMULATOR"]);
const SIMULATOR_OUTCOMES = new Set(["SUCCESS", "PENDING", "FAILED", "UNKNOWN"]);

function configurationError(message, statusCode = 503) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = "PAYMENT_PROVIDER_CONFIGURATION_ERROR";
    return error;
}

function getPaymentProviderConfiguration(environment = process.env) {
    const provider = environment.MPESA_PAYMENT_PROVIDER?.trim().toUpperCase() || "DARAJA";
    if (!PAYMENT_PROVIDERS.has(provider)) {
        throw configurationError("MPESA_PAYMENT_PROVIDER must be DARAJA or SIMULATOR.");
    }

    const simulatorOutcome = environment.MPESA_SIMULATOR_OUTCOME?.trim().toUpperCase() || "SUCCESS";
    if (!SIMULATOR_OUTCOMES.has(simulatorOutcome)) {
        throw configurationError(
            "MPESA_SIMULATOR_OUTCOME must be SUCCESS, PENDING, FAILED, or UNKNOWN."
        );
    }

    const environmentName = environment.NODE_ENV?.trim().toLowerCase() || "unspecified";
    const simulatorAllowedEnvironment = ["development", "demo", "test"].includes(environmentName);
    const simulatorEnabled =
        provider === "SIMULATOR" &&
        environment.MPESA_SIMULATOR_ENABLED === "true" &&
        simulatorAllowedEnvironment &&
        environmentName !== "production";

    return {
        provider,
        simulatorEnabled,
        simulatorOutcome,
        environmentName,
    };
}

function assertSimulatorRequest(requestedProvider, environment = process.env) {
    const configuration = getPaymentProviderConfiguration(environment);
    if (configuration.environmentName === "production") {
        throw configurationError("The payment simulator is forbidden in production.", 403);
    }
    if (requestedProvider !== "SIMULATOR") {
        throw configurationError("The requested payment provider is not supported on this route.", 400);
    }
    if (configuration.provider !== requestedProvider) {
        throw configurationError("The requested provider does not match server configuration.", 409);
    }
    if (!configuration.simulatorEnabled) {
        throw configurationError(
            "The payment simulator is disabled. Enable it explicitly in development or demo."
        );
    }
    return configuration;
}

module.exports = {
    assertSimulatorRequest,
    getPaymentProviderConfiguration,
};
