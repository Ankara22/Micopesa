const SMS_ENDPOINT = "https://api.africastalking.com/version1/messaging";

async function sendSms({ to, message }) {
    const username = process.env.AT_USERNAME?.trim();
    const apiKey = process.env.AT_API_KEY?.trim();
    if (!username || !apiKey) {
        const error = new Error("Africa's Talking SMS configuration is missing");
        error.code = "SMS_CONFIGURATION_MISSING";
        throw error;
    }

    const body = new URLSearchParams({ username, to, message });
    const senderId = process.env.AT_SENDER_ID?.trim();
    if (senderId) body.set("from", senderId);

    let response;
    try {
        response = await fetch(SMS_ENDPOINT, {
            method: "POST",
            headers: {
                apiKey,
                Accept: "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: body.toString(),
        });
    } catch (cause) {
        const error = new Error("Africa's Talking SMS request failed");
        error.code = "SMS_NETWORK_ERROR";
        error.cause = cause;
        throw error;
    }

    let payload;
    try {
        payload = await response.json();
    } catch (cause) {
        const error = new Error("Africa's Talking returned an invalid response");
        error.code = "SMS_INVALID_RESPONSE";
        error.cause = cause;
        throw error;
    }

    const recipients = payload?.SMSMessageData?.Recipients;
    const accepted = response.ok &&
        Array.isArray(recipients) &&
        recipients.length === 1 &&
        recipients[0]?.status === "Success";
    if (!accepted) {
        const error = new Error("Africa's Talking did not accept the SMS");
        error.code = recipients?.[0]?.statusCode || `SMS_HTTP_${response.status}`;
        throw error;
    }

    return {
        accepted: true,
        messageId: typeof recipients[0].messageId === "string" ? recipients[0].messageId : null,
    };
}

module.exports = { sendSms };
