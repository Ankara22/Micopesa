const { after, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const nodemailer = require("nodemailer");
const pool = require("../src/db/database");
const authEmailService = require("../src/services/authEmailService");

const originalQuery = pool.query;
const originalCreateTransport = nodemailer.createTransport;
const originalConsoleInfo = console.info;
const originalConsoleError = console.error;
const originalEnvironment = {
    GMAIL_USER: process.env.GMAIL_USER,
    GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD,
    FRONTEND_BASE_URL: process.env.FRONTEND_BASE_URL,
};
let queryCount;

beforeEach(() => {
    queryCount = 0;
    process.env.GMAIL_USER = "  MicoPesa.Test@GMAIL.COM ";
    process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
    process.env.FRONTEND_BASE_URL = "https://micopesa.example.test";
    pool.query = async () => {
        queryCount += 1;
        return { rows: [] };
    };
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
