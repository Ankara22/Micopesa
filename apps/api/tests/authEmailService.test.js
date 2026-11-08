const { after, afterEach, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const nodemailer = require("nodemailer");
const pool = require("../src/db/database");
const authEmailService = require("../src/services/authEmailService");
const mobileSasaService = require("../src/services/mobileSasaService");

const originalQuery = pool.query;
const originalCreateTransport = nodemailer.createTransport;
const originalMobileSasaSendEmail = mobileSasaService.sendEmail;
const originalConsoleInfo = console.info;
const originalConsoleError = console.error;
const originalEnvironment = {
    GMAIL_USER: process.env.GMAIL_USER,
    GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD,
    FRONTEND_BASE_URL: process.env.FRONTEND_BASE_URL,
    EMAIL_PROVIDER: process.env.EMAIL_PROVIDER,
    MOBILESASA_EMAIL_ENABLED: process.env.MOBILESASA_EMAIL_ENABLED,
    MOBILE_SASA_EMAIL_API_TOKEN: process.env.MOBILE_SASA_EMAIL_API_TOKEN,
    MOBILE_SASA_EMAIL_FROM: process.env.MOBILE_SASA_EMAIL_FROM,
    MOBILE_SASA_EMAIL_DOMAIN_UUID: process.env.MOBILE_SASA_EMAIL_DOMAIN_UUID,
};
let queryCount;

beforeEach(() => {
    queryCount = 0;
    process.env.GMAIL_USER = "  MicoPesa.Test@GMAIL.COM ";
    process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
    process.env.FRONTEND_BASE_URL = "https://micopesa.example.test";
    process.env.EMAIL_PROVIDER = "GMAIL";
    pool.query = async () => {
        queryCount += 1;
        return { rows: [] };
    };
});

afterEach(() => {
    mobileSasaService.sendEmail = originalMobileSasaSendEmail;
});

after(() => {
    pool.query = originalQuery;
    nodemailer.createTransport = originalCreateTransport;
    console.info = originalConsoleInfo;
    console.error = originalConsoleError;
    for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

test("sends through Gmail using normalized credentials and confirms SMTP acceptance only", async () => {
    let options;
    let message;
    nodemailer.createTransport = (transportOptions) => {
        options = transportOptions;
        return {
            sendMail: async (outgoing) => {
                message = outgoing;
                return { accepted: ["worker@example.test"], rejected: [], messageId: "smtp-message-id" };
            },
        };
    };
    console.info = () => {};

    const result = await authEmailService.sendEmail({
        to: "worker@example.test",
        subject: "Verify your MicoPesa email",
        text: "Verification instructions",
    });

    assert.equal(options.service, "gmail");
    assert.deepEqual(options.auth, {
        user: "micopesa.test@gmail.com",
        pass: "abcdefghijklmnop",
    });
    assert.equal(message.from, "micopesa.test@gmail.com");
    assert.equal(message.to, "worker@example.test");
    assert.equal(result.messageId, "smtp-message-id");
});

test("provider authentication/send rejection is observable without logging recipients, links, or credentials", async () => {
    const secret = process.env.GMAIL_APP_PASSWORD.replace(/\s/g, "");
    nodemailer.createTransport = () => ({
        sendMail: async () => {
            const error = new Error(
                `Rejected worker@example.test: https://example.test/verify?token=${"a".repeat(45)} ${secret}`
            );
            error.code = "EAUTH";
            error.responseCode = 535;
            throw error;
        },
    });
    const logged = [];
    console.error = (message) => logged.push(message);

    await assert.rejects(
        authEmailService.sendEmail({
            to: "worker@example.test",
            subject: "Verify",
            text: "Private token URL",
        }),
        (error) => {
            assert.equal(error.code, "EMAIL_SMTP_DELIVERY_FAILED");
            assert.equal(error.smtpCode, "EAUTH");
            authEmailService.logEmailDeliveryFailure("EMAIL_VERIFICATION", error);
            return true;
        },
    );

    const diagnostic = logged.join("\n");
    assert.match(diagnostic, /EAUTH/);
    assert.match(diagnostic, /535/);
    assert.doesNotMatch(diagnostic, /worker@example\.test|https:\/\/|a{40}|abcdefghijklmnop/);
});

test("missing Gmail SMTP configuration fails before a verification token is persisted", async () => {
    delete process.env.GMAIL_APP_PASSWORD;
    await assert.rejects(
        authEmailService.issueEmailToken({
            userId: "mock-user",
            email: "worker@example.test",
            purpose: "EMAIL_VERIFICATION",
        }),
        (error) => error.code === "EMAIL_SMTP_CONFIGURATION_MISSING"
            && error.missingVariables.includes("GMAIL_APP_PASSWORD"),
    );
    assert.equal(queryCount, 0);
});

test("SMTP must explicitly accept the user's recipient before delivery is reported", async () => {
    nodemailer.createTransport = () => ({
        sendMail: async () => ({ accepted: [], rejected: ["worker@example.test"] }),
    });
    await assert.rejects(
        authEmailService.sendEmail({
            to: "worker@example.test",
            subject: "Verify",
            text: "Instructions",
        }),
        (error) => error.code === "EMAIL_SMTP_RECIPIENT_REJECTED",
    );
});

test("authentication verification and reset templates can select Mobile Sasa", async () => {
    process.env.EMAIL_PROVIDER = "MOBILE_SASA";
    process.env.MOBILESASA_EMAIL_ENABLED = "true";
    process.env.MOBILE_SASA_EMAIL_API_TOKEN = "mbs_test-token";
    process.env.MOBILE_SASA_EMAIL_FROM = "notifications@example.test";
    const messages = [];
    mobileSasaService.sendEmail = async (message) => {
        messages.push(message);
        return {
            accepted: true,
            status: "PROVIDER_ACCEPTED",
            deliveryResult: { provider: "MOBILE_SASA", accepted: 1, suppressed: 0, failed: 0 },
        };
    };
    nodemailer.createTransport = () => {
        assert.fail("Mobile Sasa selection must not fall back to Gmail.");
    };

    await authEmailService.issueEmailToken({
        userId: "mock-user",
        email: "worker@example.test",
        purpose: "EMAIL_VERIFICATION",
    });
    await authEmailService.issueEmailToken({
        userId: "mock-user",
        email: "worker@example.test",
        purpose: "PASSWORD_RESET",
    });

    assert.equal(messages.length, 2);
    assert.match(messages[0].subject, /Verify your MicoPesa email/);
    assert.match(messages[0].text, /\/verify-email\?token=/);
    assert.match(messages[0].html, /\/verify-email\?token=/);
    assert.match(messages[1].subject, /Reset your MicoPesa password/);
    assert.match(messages[1].text, /\/reset-password\?token=/);
    assert.match(messages[1].html, /\/reset-password\?token=/);
});

test("an ambiguous Mobile Sasa authentication email outcome never triggers Gmail fallback", async () => {
    process.env.EMAIL_PROVIDER = "MOBILE_SASA";
    process.env.MOBILESASA_EMAIL_ENABLED = "true";
    process.env.MOBILE_SASA_EMAIL_API_TOKEN = "mbs_test-token";
    process.env.MOBILE_SASA_EMAIL_FROM = "notifications@example.test";
    let gmailCalls = 0;
    mobileSasaService.sendEmail = async () => {
        const error = new Error("Provider outcome is unknown.");
        error.code = "EMAIL_UNKNOWN_OUTCOME";
        throw error;
    };
    nodemailer.createTransport = () => {
        gmailCalls += 1;
        throw new Error("Gmail must not be used as automatic fallback.");
    };

    await assert.rejects(authEmailService.sendEmail({
        to: "worker@example.test",
        subject: "Reset password",
        text: "Reset instructions",
    }), { code: "EMAIL_UNKNOWN_OUTCOME" });
    assert.equal(gmailCalls, 0);
});
