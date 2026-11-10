const DARAJA_BASE_URL = "https://sandbox.safaricom.co.ke";
const REQUEST_TIMEOUT_MS = 15000;
const TOKEN_REFRESH_MARGIN_MS = 60000;

function createServiceError(message, statusCode, requestStage, options = {}) {
    const error = new Error(message);
    error.statusCode = statusCode;
    if (requestStage) error.requestStage = requestStage;
    if (options.paymentOutcomeUnknown) error.paymentOutcomeUnknown = true;
    if (options.providerHttpStatus) error.providerHttpStatus = options.providerHttpStatus;
    if (options.providerResultCode !== undefined) error.providerResultCode = options.providerResultCode;
    return error;
}

function getConfiguration(environment = process.env) {
    const configuration = {
        consumerKey: environment.MPESA_CONSUMER_KEY?.trim(),
        consumerSecret: environment.MPESA_CONSUMER_SECRET?.trim(),
        passkey: environment.MPESA_PASSKEY?.trim(),
        shortcode: environment.MPESA_SHORTCODE?.trim(),
        callbackUrl: environment.MPESA_CALLBACK_URL?.trim(),
    };
    const envNames = {
        consumerKey: "MPESA_CONSUMER_KEY",
        consumerSecret: "MPESA_CONSUMER_SECRET",
        passkey: "MPESA_PASSKEY",
        shortcode: "MPESA_SHORTCODE",
        callbackUrl: "MPESA_CALLBACK_URL",
    };
    const missing = Object.entries(configuration)
        .filter(([, value]) => !value)
        .map(([name]) => envNames[name]);

    if (missing.length) {
        throw createServiceError(`M-Pesa configuration is incomplete: ${missing.join(", ")}`, 503);
    }
    if (!/^\d{5,6}$/.test(configuration.shortcode)) {
        throw createServiceError("MPESA_SHORTCODE must contain 5 or 6 digits.", 503);
    }

    let callbackUrl;
    try {
        callbackUrl = new URL(configuration.callbackUrl);
    } catch {
        throw createServiceError("MPESA_CALLBACK_URL must be a valid HTTPS URL.", 503);
    }
    if (
        callbackUrl.protocol !== "https:" ||
        !callbackUrl.hostname ||
        callbackUrl.username ||
        callbackUrl.password ||
        callbackUrl.hash
    ) {
        throw createServiceError("MPESA_CALLBACK_URL must be a valid HTTPS URL without credentials or a fragment.", 503);
    }

    return { ...configuration, callbackUrl: callbackUrl.toString() };
}

function validateAmount(amount) {
    const validType = typeof amount === "number" ||
        (typeof amount === "string" && /^\d+$/.test(amount.trim()));
    const value = typeof amount === "string" ? Number(amount.trim()) : amount;
    if (!validType || !Number.isSafeInteger(value) || value <= 0) {
        throw createServiceError("Amount must be a positive whole number of Kenyan shillings.", 400);
    }
    return value;
}

function normalizePhoneNumber(phoneNumber) {
    if (typeof phoneNumber !== "string") {
        throw createServiceError("Enter a valid Kenyan M-Pesa phone number.", 400);
    }
    const compact = phoneNumber.trim().replace(/[\s()-]/g, "");
    let normalized;
    if (/^0[17]\d{8}$/.test(compact)) normalized = `254${compact.slice(1)}`;
    else if (/^\+?254[17]\d{8}$/.test(compact)) normalized = compact.replace(/^\+/, "");
    if (!normalized || !/^254[17]\d{8}$/.test(normalized)) {
        throw createServiceError("Enter a valid Kenyan M-Pesa phone number.", 400);
    }
    return normalized;
}

function getDarajaTimestamp(now = new Date()) {
    const values = Object.fromEntries(
        new Intl.DateTimeFormat("en-GB", {
            timeZone: "Africa/Nairobi",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
        }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
    );
    return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
}

function requireIdentifier(value, label, requestStage) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
        throw createServiceError(
            `M-Pesa returned an invalid ${label}.`,
            502,
            requestStage,
            { paymentOutcomeUnknown: requestStage === "stk_push" || requestStage === "stk_query" }
        );
    }
    return value;
}

function normalizeProviderCode(value) {
    if (typeof value === "number" && Number.isInteger(value)) return String(value);
    if (typeof value === "string" && /^-?\d{1,10}$/.test(value)) return value;
    return null;
}

function createMpesaService({
    configurationProvider = getConfiguration,
    fetchImpl = (...args) => fetch(...args),
    clock = () => Date.now(),
    timeoutMs = REQUEST_TIMEOUT_MS,
    tokenRefreshMarginMs = TOKEN_REFRESH_MARGIN_MS,
} = {}) {
    let cachedAccessToken = null;
    let accessTokenExpiresAt = 0;
    let cachedConfigurationKey = null;
    let tokenRefreshPromise = null;
    let tokenRefreshConfigurationKey = null;

    async function requestJson(url, options, requestStage) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
            response = await fetchImpl(url, { ...options, signal: controller.signal });
        } catch (cause) {
            clearTimeout(timeout);
            throw createServiceError(
                cause?.name === "AbortError" ? "M-Pesa service request timed out." : "M-Pesa service is unavailable.",
                cause?.name === "AbortError" ? 504 : 502,
                requestStage,
                { paymentOutcomeUnknown: requestStage === "stk_push" || requestStage === "stk_query" }
            );
        }

        let body = null;
        try {
            body = await response.json();
        } catch {
            body = null;
        } finally {
            clearTimeout(timeout);
        }

        if (!response.ok) {
            const resultCode = normalizeProviderCode(body?.ResponseCode ?? body?.errorCode);
            throw createServiceError(
                "M-Pesa service request was rejected.",
                502,
                requestStage,
                {
                    providerHttpStatus: response.status,
                    ...(resultCode === null ? {} : { providerResultCode: resultCode }),
                    paymentOutcomeUnknown:
                        (requestStage === "stk_push" && response.status >= 500) ||
                        requestStage === "stk_query",
                }
            );
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            throw createServiceError(
                "M-Pesa returned an invalid response.",
                502,
                requestStage,
                { providerHttpStatus: response.status, paymentOutcomeUnknown: requestStage === "stk_push" || requestStage === "stk_query" }
            );
        }
        return { body, httpStatus: response.status };
    }

    function configurationKey(configuration) {
        return require("node:crypto")
            .createHash("sha256")
            .update(`${configuration.consumerKey}\u0000${configuration.consumerSecret}`)
            .digest("hex");
    }

    async function getAccessToken(configuration = configurationProvider()) {
        const key = configurationKey(configuration);
        if (cachedConfigurationKey !== key) {
            cachedAccessToken = null;
            accessTokenExpiresAt = 0;
            cachedConfigurationKey = key;
        }
        if (cachedAccessToken && clock() < accessTokenExpiresAt - tokenRefreshMarginMs) {
            return cachedAccessToken;
        }
        if (tokenRefreshPromise && tokenRefreshConfigurationKey === key) {
            return tokenRefreshPromise;
        }

        tokenRefreshConfigurationKey = key;
        tokenRefreshPromise = (async () => {
            const authorization = Buffer.from(
                `${configuration.consumerKey}:${configuration.consumerSecret}`
            ).toString("base64");
            const { body: response } = await requestJson(
                `${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
                { headers: { Authorization: `Basic ${authorization}` } },
                "oauth"
            );
            const expiresIn = Number(response.expires_in);
            if (
                typeof response.access_token !== "string" ||
                response.access_token.trim() === "" ||
                response.access_token.trim() !== response.access_token ||
                !Number.isFinite(expiresIn) ||
                !Number.isSafeInteger(expiresIn) ||
                expiresIn <= 0
            ) {
                throw createServiceError("M-Pesa returned an invalid OAuth token response.", 502, "oauth");
            }

            if (cachedConfigurationKey === key) {
                cachedAccessToken = response.access_token;
                accessTokenExpiresAt = clock() + expiresIn * 1000;
            }
            return response.access_token;
        })();
        try {
            return await tokenRefreshPromise;
        } finally {
            if (tokenRefreshConfigurationKey === key) {
                tokenRefreshPromise = null;
                tokenRefreshConfigurationKey = null;
            }
        }
    }

    async function initiateStkPush({ phoneNumber, amount }) {
        const normalizedPhone = normalizePhoneNumber(phoneNumber);
        const wholeKesAmount = validateAmount(amount);
        const configuration = configurationProvider();
        const accessToken = await getAccessToken(configuration);
        const timestamp = getDarajaTimestamp(new Date(clock()));
        const password = Buffer.from(
            `${configuration.shortcode}${configuration.passkey}${timestamp}`
        ).toString("base64");
        const { body: response, httpStatus } = await requestJson(
            `${DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    BusinessShortCode: configuration.shortcode,
                    Password: password,
                    Timestamp: timestamp,
                    TransactionType: "CustomerPayBillOnline",
                    Amount: wholeKesAmount,
                    PartyA: normalizedPhone,
                    PartyB: configuration.shortcode,
                    PhoneNumber: normalizedPhone,
                    CallBackURL: configuration.callbackUrl,
                    AccountReference: "MicoPesa",
                    TransactionDesc: "Pension contribution",
                }),
            },
            "stk_push"
        );

        const responseCode = normalizeProviderCode(response.ResponseCode);
        if (responseCode !== "0") {
            throw createServiceError(
                "M-Pesa did not accept the STK Push request.",
                502,
                "stk_push",
                {
                    ...(responseCode === null ? {} : { providerResultCode: responseCode }),
                    paymentOutcomeUnknown: responseCode === null,
                }
            );
        }
        const merchantRequestId = requireIdentifier(response.MerchantRequestID, "merchant request ID", "stk_push");
        const checkoutRequestId = requireIdentifier(response.CheckoutRequestID, "checkout request ID", "stk_push");
        if (!httpStatus) throw createServiceError("M-Pesa returned an invalid STK Push response.", 502, "stk_push", { paymentOutcomeUnknown: true });

        return {
            merchantRequestId,
            checkoutRequestId,
            normalizedPhone,
        };
    }

    async function queryStkPush({ checkoutRequestId }) {
        if (
            typeof checkoutRequestId !== "string" ||
            !/^[A-Za-z0-9_-]{1,100}$/.test(checkoutRequestId)
        ) {
            throw createServiceError("A valid M-Pesa checkout request ID is required.", 400);
        }
        const configuration = configurationProvider();
        const accessToken = await getAccessToken(configuration);
        const timestamp = getDarajaTimestamp(new Date(clock()));
        const password = Buffer.from(
            `${configuration.shortcode}${configuration.passkey}${timestamp}`
        ).toString("base64");
        const { body: response } = await requestJson(
            `${DARAJA_BASE_URL}/mpesa/stkpushquery/v1/query`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    BusinessShortCode: configuration.shortcode,
                    Password: password,
                    Timestamp: timestamp,
                    CheckoutRequestID: checkoutRequestId,
                }),
            },
            "stk_query"
        );

        const responseCode = normalizeProviderCode(response.ResponseCode);
        if (responseCode !== "0") {
            throw createServiceError(
                "M-Pesa could not confirm the STK Push status.",
                502,
                "stk_query",
                {
                    ...(responseCode === null ? {} : { providerResultCode: responseCode }),
                    paymentOutcomeUnknown: true,
                }
            );
        }
        const merchantRequestId = requireIdentifier(response.MerchantRequestID, "merchant request ID", "stk_query");
        const returnedCheckoutRequestId = requireIdentifier(response.CheckoutRequestID, "checkout request ID", "stk_query");
        if (returnedCheckoutRequestId !== checkoutRequestId) {
            throw createServiceError(
                "M-Pesa returned a status for a different checkout request.",
                502,
                "stk_query",
                { paymentOutcomeUnknown: true }
            );
        }
        const resultCode = normalizeProviderCode(response.ResultCode);
        if (resultCode === null || typeof response.ResultDesc !== "string" || response.ResultDesc.length > 255) {
            throw createServiceError(
                "M-Pesa returned an invalid STK Push status response.",
                502,
                "stk_query",
                { paymentOutcomeUnknown: true }
            );
        }
        return {
            merchantRequestId,
            checkoutRequestId: returnedCheckoutRequestId,
            resultCode,
            resultDescription: response.ResultDesc,
        };
    }

    return {
        assertConfigured() {
            configurationProvider();
        },
        getAccessToken,
        initiateStkPush,
        queryStkPush,
    };
}

const defaultService = createMpesaService();

function maskPhoneNumber(phoneNumber) {
    return typeof phoneNumber === "string" ? `***${phoneNumber.slice(-4)}` : "unavailable";
}

module.exports = {
    assertConfigured: defaultService.assertConfigured,
    createMpesaService,
    getConfiguration,
    getDarajaTimestamp,
    initiateStkPush: defaultService.initiateStkPush,
    maskPhoneNumber,
    normalizePhoneNumber,
    queryStkPush: defaultService.queryStkPush,
    validateAmount,
};
