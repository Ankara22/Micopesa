require("../src/config/loadEnvironment");

const {
    createEmailTransporter,
    getEmailConfiguration,
    safeSmtpMessage,
    sendEmailWithTransporter,
} = require("../src/services/authEmailService");

function getFrontendBaseUrlStatus() {
    const value = process.env.FRONTEND_BASE_URL;
    if (!value) return "missing";
    try {
        const url = new URL(value);
        const validProtocol = ["http:", "https:"].includes(url.protocol);
        const validProductionProtocol = process.env.NODE_ENV !== "production" || url.protocol === "https:";
        return validProtocol && validProductionProtocol && !url.username && !url.password
            ? "valid"
            : "invalid";
    } catch {
        return "invalid";
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length !== 0 && (args.length !== 2 || args[0] !== "--send")) {
        console.error("Usage: node apps/api/scripts/emailDiagnostic.js [--send <recipient-email>]");
        process.exitCode = 2;
        return;
    }
    const recipient = args[1];
    if (recipient && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
        console.error("The requested recipient address is not valid.");
        process.exitCode = 2;
        return;
    }

    const missing = [];
    const invalid = [];
    const rawUser = process.env.GMAIL_USER;
    const rawPassword = process.env.GMAIL_APP_PASSWORD;
    if (!rawUser?.trim()) missing.push("GMAIL_USER");
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawUser.trim())) invalid.push("GMAIL_USER");
    if (!rawPassword?.replace(/\s/g, "")) missing.push("GMAIL_APP_PASSWORD");
    else if (!/^[A-Za-z0-9]{16}$/.test(rawPassword.replace(/\s/g, ""))) {
        invalid.push("GMAIL_APP_PASSWORD");
    }
    const frontendStatus = getFrontendBaseUrlStatus();
    if (frontendStatus === "missing") missing.push("FRONTEND_BASE_URL");
    else if (frontendStatus === "invalid") invalid.push("FRONTEND_BASE_URL");
    if (missing.length) console.log(`Missing required variables: ${missing.join(", ")}`);
    if (invalid.length) console.log(`Invalid variables: ${invalid.join(", ")}`);
    if (missing.length || invalid.length) {
        process.exitCode = 1;
        return;
    }

    const configuration = getEmailConfiguration();
    const transporter = createEmailTransporter(configuration);
    try {
        await transporter.verify();
        console.log("SMTP verification: successful (connection and authentication accepted).");
    } catch (error) {
        console.error(JSON.stringify({
            event: "email.smtp.verify.failed",
            errorClass: error?.name || "Error",
            smtpCode: typeof error?.code === "string" ? error.code : undefined,
            responseCode: Number.isInteger(error?.responseCode) ? error.responseCode : undefined,
            diagnostic: safeSmtpMessage(error),
        }));
        transporter.close();
        process.exitCode = 1;
        return;
    }

    if (recipient) {
        try {
            const result = await sendEmailWithTransporter(transporter, {
                to: recipient,
                subject: "MicoPesa SMTP delivery test",
                text: "This single message was sent by the manually requested MicoPesa SMTP diagnostic.",
                purpose: "MANUAL_DIAGNOSTIC",
            });
            console.log(`SMTP acceptance: confirmed${result.messageId ? ` (message ID ${result.messageId})` : ""}. Inbox delivery: not confirmed; check the recipient inbox and Gmail Sent folder.`);
        } catch (error) {
            console.error(JSON.stringify({
                event: "email.smtp.send.failed",
                errorClass: error?.name || "Error",
                smtpCode: typeof error?.code === "string" ? error.code : undefined,
                responseCode: Number.isInteger(error?.responseCode) ? error.responseCode : undefined,
                diagnostic: safeSmtpMessage(error),
            }));
            process.exitCode = 1;
        }
    } else {
        console.log("No message sent. Add --send <recipient-email> to request exactly one diagnostic email.");
    }
    transporter.close();
}

main().catch((error) => {
    console.error(JSON.stringify({
        event: "email.smtp.diagnostic.failed",
        errorClass: error?.name || "Error",
        smtpCode: typeof error?.code === "string" ? error.code : undefined,
        responseCode: Number.isInteger(error?.responseCode) ? error.responseCode : undefined,
        diagnostic: safeSmtpMessage(error),
    }));
    process.exitCode = 1;
});
