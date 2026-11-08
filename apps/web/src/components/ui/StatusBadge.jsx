import "./ui.css";
import { normalizeNotificationStatus } from "./notificationStatus";

const COLOR_MAP = {
    ACTIVE: "green",
    COMPLETED: "green",
    APPROVED: "green",
    ACCEPTED: "green",
    VERIFIED: "green",
    PAID: "green",
    DELIVERED: "green",

    PENDING: "yellow",
    SUBMITTED: "yellow",
    TIMED_OUT: "yellow",
    UNKNOWN: "yellow",

    REJECTED: "red",
    FAILED: "red",
    SUSPENDED: "red",
    CANCELLED: "red",
    EXPIRED: "red",

    INACTIVE: "gray",
    CLOSED: "gray",
    DRAFT: "gray",

    PROCESSING: "blue",
    PROVIDER_ACCEPTED: "blue",
};

/** Renders a colored pill for any of the app's *_status enum values. */
function StatusBadge({ status, label }) {
    if (!status) return null;
    const normalizedStatus = normalizeNotificationStatus(status);
    const color = COLOR_MAP[normalizedStatus] || "gray";
    return <span className={`badge badge-${color}`}>{label || normalizedStatus}</span>;
}

export default StatusBadge;
