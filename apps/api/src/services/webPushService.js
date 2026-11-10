const webPush = require("web-push");

const ENDPOINT_HOSTS = [
    "fcm.googleapis.com",
    "push.services.mozilla.com",
    "web.push.apple.com",
    "notify.windows.com",
];
const SAFE_PATH = /^\/(?!\/)[A-Za-z0-9/_?&=.%#-]{0,500}$/;

function createPushError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function getWebPushConfiguration(environment = process.env) {
    const publicKey = environment.WEB_PUSH_PUBLIC_KEY?.trim();
    const privateKey = environment.WEB_PUSH_PRIVATE_KEY?.trim();
    const subject = environment.WEB_PUSH_SUBJECT?.trim();
    if (!publicKey || !privateKey || !subject) {
        throw createPushError("Web Push configuration is incomplete.", "PUSH_CONFIGURATION_MISSING");
    }
    if (!/^(mailto:[^\s@]+@[^\s@]+\.[^\s@]+|https:\/\/[^\s]+)$/.test(subject)) {
        throw createPushError("Web Push contact subject is invalid.", "PUSH_CONFIGURATION_INVALID");
    }
    return { publicKey, privateKey, subject };
}

function validatePushEndpoint(value, { allowLocalhost = false } = {}) {
    let endpoint;
    try {
        endpoint = new URL(value);
    } catch {
        return false;
    }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) {
        if (!(allowLocalhost &&
            endpoint.protocol === "http:" &&
            ["localhost", "127.0.0.1"].includes(endpoint.hostname) &&
            !endpoint.username &&
            !endpoint.password &&
            !endpoint.hash)) return false;
    }
    return allowLocalhost && ["localhost", "127.0.0.1"].includes(endpoint.hostname) ||
        ENDPOINT_HOSTS.some((host) => endpoint.hostname === host || endpoint.hostname.endsWith(`.${host}`));
}

function validatePushNavigation(value) {
    return typeof value === "string" && SAFE_PATH.test(value) && !value.startsWith("/\\");
}

function createWebPushService({
    repository,
    environment = process.env,
    webPushImpl = webPush,
}) {
    if (!repository ||
        typeof repository.listPushSubscriptions !== "function" ||
        typeof repository.removePushSubscription !== "function") {
        throw new TypeError("A push subscription repository is required.");
    }

    function getPublicKey() {
        return getWebPushConfiguration(environment).publicKey;
    }

    async function sendToUser({ userId, title, body, url = "/worker/notifications" }) {
        if (environment.NODE_ENV !== "production") {
            throw createPushError("Push delivery is disabled outside production.", "PUSH_PRODUCTION_ONLY");
        }
        if (environment.WEB_PUSH_ENABLED !== "true") {
            throw createPushError("Web Push delivery is not enabled.", "PUSH_CONFIGURATION_MISSING");
        }
        const configuration = getWebPushConfiguration(environment);
        if (typeof title !== "string" || !title.trim() || title.length > 100 ||
            typeof body !== "string" || !body.trim() || body.length > 5000 ||
            !validatePushNavigation(url)) {
            throw createPushError("Push notification content is invalid.", "PUSH_INVALID_INPUT");
        }

        webPushImpl.setVapidDetails(
            configuration.subject,
            configuration.publicKey,
            configuration.privateKey
        );
        const subscriptions = await repository.listPushSubscriptions(userId);
        if (!subscriptions.length) {
            throw createPushError("No active push subscriptions were found.", "PUSH_NO_SUBSCRIPTIONS");
        }

        const payload = JSON.stringify({ title: title.trim(), body: body.trim(), url });
        const results = await Promise.all(subscriptions.map(async (row) => {
            if (!validatePushEndpoint(row.endpoint)) {
                await repository.removePushSubscription(row.subscription_id);
                return "expired";
            }
            try {
                await webPushImpl.sendNotification({
                    endpoint: row.endpoint,
                    keys: { p256dh: row.p256dh_key, auth: row.auth_key },
                }, payload, { TTL: 60 });
                return "accepted";
            } catch (error) {
                if ([404, 410].includes(error?.statusCode)) {
                    await repository.removePushSubscription(row.subscription_id);
                    return "expired";
                }
                if (error?.statusCode === 429) return "rejected";
                if (Number.isInteger(error?.statusCode) &&
                    error.statusCode >= 400 && error.statusCode < 500) return "failed";
                return "unknown";
            }
        }));

        const deliveryResult = results.reduce((summary, result) => {
            summary[result] += 1;
            return summary;
        }, { accepted: 0, expired: 0, failed: 0, rejected: 0, unknown: 0 });
        if (deliveryResult.accepted > 0) {
            return { accepted: true, status: "PROVIDER_ACCEPTED", deliveryResult };
        }
        if (deliveryResult.rejected > 0) {
            throw createPushError("The push service explicitly rate-limited the request.", "PUSH_RETRYABLE_REJECTION");
        }
        if (deliveryResult.unknown > 0) {
            throw createPushError("The push service outcome is unknown.", "PUSH_UNKNOWN_OUTCOME");
        }
        throw createPushError("No push service accepted the notification.", "PUSH_PROVIDER_REJECTED");
    }

    return { getPublicKey, sendToUser };
}

module.exports = {
    createWebPushService,
    getWebPushConfiguration,
    validatePushEndpoint,
    validatePushNavigation,
};
