const PAYMENT_PROVIDERS = new Set(["DARAJA", "SIMULATOR"]);
const SIMULATOR_OUTCOMES = new Set(["SUCCESS", "PENDING", "FAILED", "UNKNOWN"]);
const DARAJA_ENVIRONMENTS = new Set(["sandbox", "production"]);

function configurationError(message, statusCode = 503) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = "PAYMENT_PROVIDER_CONFIGURATION_ERROR";
    return error;
}

function getDarajaSetting(environment, canonicalName, legacyName, normalize = (value) => value) {
    const aliases = Array.isArray(legacyName) ? legacyName : legacyName ? [legacyName] : [];
    const values = [canonicalName, ...aliases]
        .map((name) => ({
            name,
            value: environment[name] == null ? "" : String(environment[name]).trim(),
        }))
        .filter(({ value }) => value);
    if (values.some(({ value }) => normalize(value) !== normalize(values[0]?.value || ""))) {
        const conflictingNames = values.map(({ name }) => name).join(", ");
        throw configurationError(
            `${canonicalName} conflicts with compatibility settings (${conflictingNames}).`
        );
    }
    return values[0]?.value || null;
}

function getPaymentProviderConfiguration(environment = process.env) {
    const provider = environment.MPESA_PAYMENT_PROVIDER?.trim().toUpperCase() || "DARAJA";
    if (!PAYMENT_PROVIDERS.has(provider)) {
        throw configurationError("MPESA_PAYMENT_PROVIDER must be DARAJA or SIMULATOR.");
    }

    const darajaEnvironment = getDarajaSetting(
        environment,
        "DARAJA_ENV",
        ["MPESA_DARAJA_ENVIRONMENT", "MPESA_ENVIRONMENT"],
        (value) => value.toLowerCase()
    )?.toLowerCase() || null;
    if (darajaEnvironment && !DARAJA_ENVIRONMENTS.has(darajaEnvironment)) {
        throw configurationError(
            "MPESA_DARAJA_ENVIRONMENT must be sandbox or production."
        );
    }

    const simulatorOutcome = environment.MPESA_SIMULATOR_OUTCOME?.trim().toUpperCase() || "SUCCESS";
    if (!SIMULATOR_OUTCOMES.has(simulatorOutcome)) {
        throw configurationError(
            "MPESA_SIMULATOR_OUTCOME must be SUCCESS, PENDING, FAILED, or UNKNOWN."
        );
    }

    const environmentName = environment.NODE_ENV?.trim().toLowerCase() || "unspecified";
    const sandboxEnabled = environment.MPESA_SANDBOX_ENABLED === "true";
    const livePaymentsEnabled = environment.MPESA_LIVE_PAYMENTS_ENABLED === "true";
    if (provider === "DARAJA") {
        if (sandboxEnabled && livePaymentsEnabled) {
            throw configurationError("Sandbox and live M-Pesa dispatch cannot both be enabled.");
        }
        if (
            (sandboxEnabled && darajaEnvironment !== "sandbox") ||
            (livePaymentsEnabled && darajaEnvironment !== "production")
        ) {
            throw configurationError("M-Pesa dispatch flags conflict with the selected environment.");
        }
    }
    const simulatorAllowedEnvironment = ["development", "demo", "test"].includes(environmentName);
    const simulatorEnabled =
        provider === "SIMULATOR" &&
        environment.MPESA_SIMULATOR_ENABLED === "true" &&
        simulatorAllowedEnvironment &&
        environmentName !== "production";
    const providerDispatchEnabled = environment.MPESA_PROVIDER_DISPATCH_ENABLED === "true";
    const sandboxPaymentEnabled =
        provider === "DARAJA" &&
        darajaEnvironment === "sandbox" &&
        sandboxEnabled &&
        providerDispatchEnabled;
    const livePaymentEnabled =
        provider === "DARAJA" &&
        darajaEnvironment === "production" &&
        livePaymentsEnabled &&
        providerDispatchEnabled;
    const paymentEnabled = provider === "SIMULATOR"
        ? simulatorEnabled
        : sandboxPaymentEnabled || livePaymentEnabled;

    return {
        provider,
        darajaEnvironment,
        providerDispatchEnabled,
        sandboxPaymentEnabled,
        livePaymentEnabled,
        paymentEnabled,
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
    getDarajaSetting,
    getPaymentProviderConfiguration,
};
