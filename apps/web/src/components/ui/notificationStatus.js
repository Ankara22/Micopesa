export function normalizeNotificationStatus(status) {
    return status === "SENT" ? "PROVIDER_ACCEPTED" : status;
}
