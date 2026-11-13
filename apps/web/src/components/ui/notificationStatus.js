export function normalizeNotificationStatus(status) {
    return status === "SENT" ? "PROVIDER_ACCEPTED" : status;
}

export function getCombinedNotificationStatus(notifications) {
    const statuses = notifications
        .map((notification) => normalizeNotificationStatus(notification.delivery_status));
    if (!statuses.length) return "UNKNOWN";
    if (statuses.every((status) => status === "PROVIDER_ACCEPTED" || status === "DELIVERED")) {
        return statuses.every((status) => status === "DELIVERED")
            ? "DELIVERED"
            : "PROVIDER_ACCEPTED";
    }
    if (statuses.some((status) => status === "PROVIDER_ACCEPTED" || status === "DELIVERED")) {
        return "PARTIALLY_SENT";
    }
    if (statuses.every((status) => status === "FAILED")) return "FAILED";
    if (statuses.every((status) => status === "SKIPPED")) return "SKIPPED";
    if (statuses.some((status) => status === "PROCESSING")) return "PROCESSING";
    if (statuses.some((status) => status === "PENDING")) return "PENDING";
    if (statuses.some((status) => status === "UNKNOWN")) return "UNKNOWN";
    if (statuses.some((status) => status === "FAILED")) return "FAILED";
    return statuses[0];
}
