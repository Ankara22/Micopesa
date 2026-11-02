const DARAJA_BASE_URL = "https://sandbox.safaricom.co.ke";
const REQUEST_TIMEOUT_MS = 15000;
const TOKEN_REFRESH_MARGIN_MS = 60000;

let cachedAccessToken = null;
let accessTokenExpiresAt = 0;

function getConfiguration() {
    const { MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_PASSKEY, MPESA_SHORTCODE, MPESA_CALLBACK_URL } = process.env;
    const missing = [
        ["MPESA_CONSUMER_KEY", MPESA_CONSUMER_KEY],
        ["MPESA_CONSUMER_SECRET", MPESA_CONSUMER_SECRET],
        ["MPESA_PASSKEY", MPESA_PASSKEY],
        ["MPESA_SHORTCODE", MPESA_SHORTCODE],
        ["MPESA_CALLBACK_URL", MPESA_CALLBACK_URL],
    ].filter(([, value]) => !value);

    if (missing.length) {
        const error = new Error(`M-Pesa configuration is incomplete: ${missing.map(([name]) => name).join(", ")}`);
        error.statusCode = 503;
        throw error;
    }

    let callbackUrl;
    try {
        callbackUrl = new URL(MPESA_CALLBACK_URL);
    } catch {
        const error = new Error("MPESA_CALLBACK_URL must be a valid HTTPS URL");
        error.statusCode = 503;
        throw error;
    }
    if (callbackUrl.protocol !== "https:") {
        const error = new Error("MPESA_CALLBACK_URL must use HTTPS");
        error.statusCode = 503;
        throw error;
    }

    return { consumerKey: MPESA_CONSUMER_KEY, consumerSecret: MPESA_CONSUMER_SECRET, passkey: MPESA_PASSKEY, shortcode: MPESA_SHORTCODE, callbackUrl: callbackUrl.toString() };
}

async function requestJson(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const requestStage = options.requestStage;
    const requestOptions = { ...options };
    delete requestOptions.requestStage;
    try {
        const response = await fetch(url, { ...requestOptions, signal: controller.signal });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
            const error = new Error("M-Pesa service request failed");
            error.statusCode = 502;
            error.requestStage = requestStage;
            error.providerHttpStatus = response.status;
            error.providerResultCode = body?.ResponseCode ?? body?.errorCode ?? null;
            error.paymentOutcomeUnknown = requestStage === "stk_push" && response.status >= 500;
            throw error;
        }
        if (!body || typeof body !== "object") {
            const error = new Error("M-Pesa returned an invalid response");
            error.statusCode = 502;
            error.requestStage = requestStage;
            error.providerHttpStatus = response.status;
            error.paymentOutcomeUnknown = requestStage === "stk_push";
            throw error;
        }
        return { body, httpStatus: response.status };
    } catch (error) {
        if (error.name === "AbortError") {
            const timeoutError = new Error("M-Pesa service request timed out");
            timeoutError.statusCode = 504;
            timeoutError.requestStage = requestStage;
            timeoutError.paymentOutcomeUnknown = requestStage === "stk_push";
            throw timeoutError;
        }
        if (error instanceof TypeError) {
            error.statusCode = 502;
            error.requestStage = requestStage;
            error.paymentOutcomeUnknown = requestStage === "stk_push";
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function getAccessToken(configuration = getConfiguration()) {
    if (cachedAccessToken && Date.now() < accessTokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
        return cachedAccessToken;
    }

    const authorization = Buffer.from(`${configuration.consumerKey}:${configuration.consumerSecret}`).toString("base64");
    const { body: response } = await requestJson(
        `${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
        { headers: { Authorization: `Basic ${authorization}` }, requestStage: "oauth" }
    );
    if (typeof response.access_token !== "string" || !response.access_token) {
        const error = new Error("M-Pesa did not return an access token");
        error.statusCode = 502;
        throw error;
    }

    cachedAccessToken = response.access_token;
    const expiresIn = Number(response.expires_in);
    accessTokenExpiresAt = Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000;
    return cachedAccessToken;
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

function normalizePhoneNumber(phoneNumber) {
    if (typeof phoneNumber !== "string") {
        throw new Error("Enter a valid Kenyan M-Pesa phone number.");
    }
    const compact = phoneNumber.trim().replace(/[\s()-]/g, "");
    let normalized;
    if (/^0[17]\d{8}$/.test(compact)) normalized = `254${compact.slice(1)}`;
    else if (/^\+?254[17]\d{8}$/.test(compact)) normalized = compact.replace(/^\+/, "");
    if (!normalized || !/^254[17]\d{8}$/.test(normalized)) {
        throw new Error("Enter a valid Kenyan M-Pesa phone number, such as 0712345678.");
    }
    return normalized;
}

async function initiateStkPush({ phoneNumber, amount }) {
    const configuration = getConfiguration();
    const timestamp = getDarajaTimestamp();
    const password = Buffer.from(`${configuration.shortcode}${configuration.passkey}${timestamp}`).toString("base64");
    const accessToken = await getAccessToken(configuration);
    const normalizedPhone = normalizePhoneNumber(phoneNumber);

    const { body: response, httpStatus } = await requestJson(`${DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`, {
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
            Amount: amount,
            PartyA: normalizedPhone,
            PartyB: configuration.shortcode,
            PhoneNumber: normalizedPhone,
            CallBackURL: configuration.callbackUrl,
            AccountReference: "MicoPesa",
            TransactionDesc: "Pension contribution",
        }),
        requestStage: "stk_push",
    });

    if (String(response.ResponseCode) !== "0" || !response.CheckoutRequestID) {
        const error = new Error("M-Pesa did not accept the STK Push request");
        error.statusCode = 502;
        error.requestStage = "stk_push";
        error.providerResultCode = response.ResponseCode ?? null;
        error.paymentOutcomeUnknown = String(response.ResponseCode) === "0" || !response.ResponseCode;
        throw error;
    }

    console.info(JSON.stringify({
        event: "mpesa.stk_push.accepted",
        provider_http_status: httpStatus,
        provider_response_code: String(response.ResponseCode),
        checkout_request_id: response.CheckoutRequestID,
    }));

    return {
        checkoutRequestId: response.CheckoutRequestID,
        normalizedPhone,
    };
}

function assertConfigured() {
    getConfiguration();
}

function maskPhoneNumber(phoneNumber) {
    return typeof phoneNumber === "string" ? `***${phoneNumber.slice(-4)}` : "unavailable";
}

module.exports = { initiateStkPush, normalizePhoneNumber, assertConfigured, maskPhoneNumber };
