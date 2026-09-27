import "./ui.css";

const COLOR_MAP = {
    ACTIVE: "green",
    COMPLETED: "green",
    APPROVED: "green",
    ACCEPTED: "green",
    SENT: "green",
    VERIFIED: "green",
    PAID: "green",

    PENDING: "yellow",
    SUBMITTED: "yellow",

    REJECTED: "red",
    FAILED: "red",
    SUSPENDED: "red",
    CANCELLED: "red",
    EXPIRED: "red",

    INACTIVE: "gray",
    CLOSED: "gray",
    DRAFT: "gray",
};

/** Renders a colored pill for any of the app's *_status enum values. */
function StatusBadge({ status }) {
    if (!status) return null;
    const color = COLOR_MAP[status] || "gray";
    return <span className={`badge badge-${color}`}>{status}</span>;
}

export default StatusBadge;
