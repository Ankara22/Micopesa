const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createMpesaService,
    getConfiguration,
    normalizePhoneNumber,
    validateAmount,
} = require("../src/services/mpesaService");

const configuration = {
    consumerKey: "offline-test-consumer-key",
    consumerSecret: "offline-test-consumer-secret",
    passkey: "offline-test-passkey",
    shortcode: "174379",
    callbackUrl: "https://demo.example.test/api/mpesa/callback",
};

function response(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    };
}

function assertDarajaUrl(url, expectedPath) {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "https:");
    assert.equal(parsed.hostname, "sandbox.safaricom.co.ke");
    assert.equal(parsed.pathname, expectedPath);
}

function oauthResponse(overrides = {}) {
    return response({
        access_token: "offline-mock-access-token",
        expires_in: "3600",
        ...overrides,
    });
}

function stkResponse(overrides = {}) {
    return response({
        ResponseCode: "0",
        MerchantRequestID: "merchant_mock_001",
        CheckoutRequestID: "checkout_mock_001",
        ...overrides,
    });
}

function queryResponse(overrides = {}) {
    return response({
        ResponseCode: "0",
        ResponseDescription: "The service request has been accepted successfully",
        MerchantRequestID: "merchant_mock_001",
        CheckoutRequestID: "checkout_mock_001",
        ResultCode: "0",
        ResultDesc: "The service request is processed successfully",
        ...overrides,
    });
}

function createService(fetchImpl, options = {}) {
    return createMpesaService({
        configurationProvider: () => ({ ...configuration }),
        fetchImpl,
        clock: options.clock || (() => Date.UTC(2026, 0, 2, 3, 4, 5)),
        timeoutMs: options.timeoutMs ?? 100,
        tokenRefreshMarginMs: options.tokenRefreshMarginMs ?? 60000,
    });
}

test("normalizes accepted Kenyan phone formats", () => {
    assert.equal(normalizePhoneNumber("0712 345 678"), "254712345678");
    assert.equal(normalizePhoneNumber("(0712) 345-678"), "254712345678");
    assert.equal(normalizePhoneNumber("+254 712 345 678"), "254712345678");
    assert.equal(normalizePhoneNumber("254112345678"), "254112345678");
});

test("rejects invalid Kenyan phone numbers without making a provider request", async () => {
    let requestCount = 0;
    const service = createService(async () => {
        requestCount += 1;
        throw new Error("Unexpected request");
    });

    for (const phoneNumber of [
        "",
        "071234567",
        "0612345678",
        "254612345678",
        "+12345678901",
        "0712345678abc",
        null,
    ]) {
        assert.throws(() => normalizePhoneNumber(phoneNumber), { statusCode: 400 });
        await assert.rejects(
            service.initiateStkPush({ phoneNumber, amount: 10 }),
            { statusCode: 400 }
        );
    }
    assert.equal(requestCount, 0);
});

test("accepts positive whole-KES amounts and rejects fractional or unsafe values", () => {
    assert.equal(validateAmount(1), 1);
    assert.equal(validateAmount("2500"), 2500);
    for (const amount of [0, -1, 1.5, "1.5", "0", "1e3", "NaN", Number.MAX_SAFE_INTEGER + 1, null]) {
        assert.throws(() => validateAmount(amount), { statusCode: 400 });
    }
});

test("validates required configuration and HTTPS callback URLs without revealing values", () => {
    assert.deepEqual(getConfiguration({
        MPESA_CONSUMER_KEY: configuration.consumerKey,
        MPESA_CONSUMER_SECRET: configuration.consumerSecret,
        MPESA_PASSKEY: configuration.passkey,
        MPESA_SHORTCODE: configuration.shortcode,
        MPESA_CALLBACK_URL: configuration.callbackUrl,
    }), configuration);

    assert.throws(
        () => getConfiguration({ MPESA_CONSUMER_KEY: "do-not-show-consumer-key" }),
        (error) => {
            assert.equal(error.statusCode, 503);
            assert.match(error.message, /MPESA_CONSUMER_SECRET/);
            assert.doesNotMatch(error.message, /do-not-show-consumer-key/);
            return true;
        }
    );
    for (const callbackUrl of [
        "http://demo.example.test/callback",
        "not a URL",
        "https://user:password@demo.example.test/callback",
        "https://demo.example.test/callback#fragment",
    ]) {
        assert.throws(() => getConfiguration({
            MPESA_CONSUMER_KEY: configuration.consumerKey,
            MPESA_CONSUMER_SECRET: configuration.consumerSecret,
            MPESA_PASSKEY: configuration.passkey,
            MPESA_SHORTCODE: configuration.shortcode,
            MPESA_CALLBACK_URL: callbackUrl,
        }), { statusCode: 503 });
    }
});

test("generates OAuth token and constructs a safe STK Push payload", async () => {
    const requests = [];
    const service = createService(async (url, options) => {
        requests.push({ url, options });
        if (url.includes("/oauth/")) {
            assertDarajaUrl(url, "/oauth/v1/generate");
            return oauthResponse();
        }
        assertDarajaUrl(url, "/mpesa/stkpush/v1/processrequest");
        return stkResponse();
    });

    const result = await service.initiateStkPush({ phoneNumber: "0712 345 678", amount: "2500" });
    assert.deepEqual(result, {
        merchantRequestId: "merchant_mock_001",
        checkoutRequestId: "checkout_mock_001",
        normalizedPhone: "254712345678",
    });
    assert.equal(requests.length, 2);

    const payload = JSON.parse(requests[1].options.body);
    assert.equal(payload.BusinessShortCode, configuration.shortcode);
    assert.match(payload.Password, /^[A-Za-z0-9+/]+=*$/);
    assert.equal(payload.Timestamp, "20260102060405");
    assert.equal(payload.TransactionType, "CustomerPayBillOnline");
    assert.equal(payload.Amount, 2500);
    assert.equal(payload.PartyA, "254712345678");
    assert.equal(payload.PartyB, configuration.shortcode);
    assert.equal(payload.PhoneNumber, "254712345678");
    assert.equal(payload.CallBackURL, configuration.callbackUrl);
    assert.equal(requests[1].options.headers.Authorization, "Bearer offline-mock-access-token");
});

test("does not call OAuth or Daraja when the amount is invalid", async () => {
    let requestCount = 0;
    const service = createService(async () => {
        requestCount += 1;
        throw new Error("Unexpected request");
    });

    await assert.rejects(
        service.initiateStkPush({ phoneNumber: "0712345678", amount: 2.25 }),
        { statusCode: 400 }
    );
    assert.equal(requestCount, 0);
});

test("reuses OAuth tokens and refreshes them inside the configured expiry margin", async () => {
    let now = 0;
    let oauthRequests = 0;
    const service = createService(async (url) => {
        assertDarajaUrl(url, "/oauth/v1/generate");
        oauthRequests += 1;
        return oauthResponse({ access_token: `offline-token-${oauthRequests}`, expires_in: "120" });
    }, { clock: () => now, tokenRefreshMarginMs: 60000 });

    assert.equal(await service.getAccessToken(), "offline-token-1");
    now = 1000;
    assert.equal(await service.getAccessToken(), "offline-token-1");
    now = 60000;
    assert.equal(await service.getAccessToken(), "offline-token-2");
    assert.equal(oauthRequests, 2);
});

test("coalesces concurrent OAuth refreshes", async () => {
    let oauthRequests = 0;
    let resolveOauth;
    const service = createService((url) => {
        assertDarajaUrl(url, "/oauth/v1/generate");
        oauthRequests += 1;
        return new Promise((resolve) => {
            resolveOauth = () => resolve(oauthResponse());
        });
    });

    const first = service.getAccessToken();
    const second = service.getAccessToken();
    assert.equal(oauthRequests, 1);
    resolveOauth();
    assert.deepEqual(await Promise.all([first, second]), [
        "offline-mock-access-token",
        "offline-mock-access-token",
    ]);
});

test("rejects OAuth errors and malformed token responses", async () => {
    const rejected = createService(async (url) => {
        assertDarajaUrl(url, "/oauth/v1/generate");
        return response({ error: "unauthorized" }, 401);
    });
    await assert.rejects(rejected.getAccessToken(), { statusCode: 502, requestStage: "oauth" });

    for (const body of [
        { expires_in: "3600" },
        { access_token: "offline-token", expires_in: "not-a-number" },
        { access_token: "offline-token", expires_in: 0 },
    ]) {
        const malformed = createService(async (url) => {
            assertDarajaUrl(url, "/oauth/v1/generate");
            return response(body);
        });
        await assert.rejects(malformed.getAccessToken(), { statusCode: 502, requestStage: "oauth" });
    }
});

test("reports rejected STK requests without treating a known rejection as ambiguous", async () => {
    const service = createService(async (url) => {
        if (url.includes("/oauth/")) return oauthResponse();
        assertDarajaUrl(url, "/mpesa/stkpush/v1/processrequest");
        return stkResponse({ ResponseCode: "1" });
    });

    await assert.rejects(
        service.initiateStkPush({ phoneNumber: "0712345678", amount: 20 }),
        (error) => {
            assert.equal(error.statusCode, 502);
            assert.equal(error.requestStage, "stk_push");
            assert.equal(error.providerResultCode, "1");
            assert.equal(error.paymentOutcomeUnknown, undefined);
            return true;
        }
    );
});

test("treats a provider server error during STK Push as an unknown payment outcome", async () => {
    const service = createService(async (url) => {
        if (url.includes("/oauth/")) return oauthResponse();
        assertDarajaUrl(url, "/mpesa/stkpush/v1/processrequest");
        return response({ errorCode: "internal_error" }, 503);
    });

    await assert.rejects(
        service.initiateStkPush({ phoneNumber: "0712345678", amount: 20 }),
        { statusCode: 502, requestStage: "stk_push", paymentOutcomeUnknown: true }
    );
});

test("marks malformed accepted STK responses as having an unknown payment outcome", async () => {
    const service = createService(async (url) => {
        if (url.includes("/oauth/")) return oauthResponse();
        assertDarajaUrl(url, "/mpesa/stkpush/v1/processrequest");
        return stkResponse({ MerchantRequestID: undefined });
    });

    await assert.rejects(
        service.initiateStkPush({ phoneNumber: "0712345678", amount: 20 }),
        { statusCode: 502, paymentOutcomeUnknown: true }
    );
});

test("constructs an STK Push Query request and validates the matching response", async () => {
    const requests = [];
    const service = createService(async (url, options) => {
        requests.push({ url, options });
        if (url.includes("/oauth/")) {
            assertDarajaUrl(url, "/oauth/v1/generate");
            return oauthResponse();
        }
        assertDarajaUrl(url, "/mpesa/stkpushquery/v1/query");
        return queryResponse();
    });

    const result = await service.queryStkPush({ checkoutRequestId: "checkout_mock_001" });
    assert.deepEqual(result, {
        merchantRequestId: "merchant_mock_001",
        checkoutRequestId: "checkout_mock_001",
        resultCode: "0",
        resultDescription: "The service request is processed successfully",
    });
    const payload = JSON.parse(requests[1].options.body);
    assert.equal(payload.BusinessShortCode, configuration.shortcode);
    assert.equal(payload.Timestamp, "20260102060405");
    assert.equal(payload.CheckoutRequestID, "checkout_mock_001");
    assert.match(payload.Password, /^[A-Za-z0-9+/]+=*$/);
});

test("rejects invalid STK Query identifiers before provider requests", async () => {
    let requestCount = 0;
    const service = createService(async () => {
        requestCount += 1;
        throw new Error("Unexpected request");
    });

    for (const checkoutRequestId of ["", "not valid", "x".repeat(101), null]) {
        await assert.rejects(service.queryStkPush({ checkoutRequestId }), { statusCode: 400 });
    }
    assert.equal(requestCount, 0);
});

test("handles STK Query provider failures, mismatched IDs, and malformed responses safely", async () => {
    const rejected = createService(async (url) => {
        if (url.includes("/oauth/")) return oauthResponse();
        assertDarajaUrl(url, "/mpesa/stkpushquery/v1/query");
        return queryResponse({ ResponseCode: "1" });
    });
    await assert.rejects(
        rejected.queryStkPush({ checkoutRequestId: "checkout_mock_001" }),
        { statusCode: 502, requestStage: "stk_query", paymentOutcomeUnknown: true }
    );

    const mismatched = createService(async (url) => {
        if (url.includes("/oauth/")) return oauthResponse();
        return queryResponse({ CheckoutRequestID: "different_checkout" });
    });
    await assert.rejects(
        mismatched.queryStkPush({ checkoutRequestId: "checkout_mock_001" }),
        { statusCode: 502, paymentOutcomeUnknown: true }
    );

    const malformed = createService(async (url) => {
        if (url.includes("/oauth/")) return oauthResponse();
        return queryResponse({ ResultCode: undefined });
    });
    await assert.rejects(
        malformed.queryStkPush({ checkoutRequestId: "checkout_mock_001" }),
        { statusCode: 502, paymentOutcomeUnknown: true }
    );
});

test("marks an STK Push network timeout as ambiguous instead of failed", async () => {
    const service = createService(async (url, options) => {
        if (url.includes("/oauth/")) return oauthResponse();
        assertDarajaUrl(url, "/mpesa/stkpush/v1/processrequest");
        return new Promise((resolve, reject) => {
            options.signal.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
            }, { once: true });
        });
    }, { timeoutMs: 5 });

    await assert.rejects(
        service.initiateStkPush({ phoneNumber: "0712345678", amount: 20 }),
        (error) => {
            assert.equal(error.statusCode, 504);
            assert.equal(error.requestStage, "stk_push");
            assert.equal(error.paymentOutcomeUnknown, true);
            return true;
        }
    );
});

test("sanitizes network failures and never contacts a non-Daraja host", async () => {
    const service = createService(async (url) => {
        assertDarajaUrl(url, "/oauth/v1/generate");
        throw new TypeError("network failed with offline-test-consumer-secret");
    });

    await assert.rejects(
        service.getAccessToken(),
        (error) => {
            assert.equal(error.statusCode, 502);
            assert.doesNotMatch(error.message, /offline-test-consumer-secret/);
            return true;
        }
    );
});
