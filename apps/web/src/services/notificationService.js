// WORKER-facing notifications.
//
// GAP: There is currently NO backend endpoint for a worker to fetch their
// own received notifications. The `notifications` table exists and
// `notifications.user_id` identifies the recipient, but the only route
// mounted in the API is `/api/admin/notifications`, which is ADMIN-only and
// lists ALL notifications platform-wide - it is not scoped to the calling
// user and a WORKER cannot call it (requireRole("ADMIN")).
//
// Per the project instructions, this gap must be reported rather than
// silently worked around with invented data. This function intentionally
// throws a clear, honest error so the Notifications page can surface it via
// the standard ErrorState component instead of pretending to have data.
export async function getMyNotifications() {
    throw new Error(
        "Notifications are not yet available: the backend has no worker-facing " +
            "endpoint to fetch a user's own notifications (e.g. GET /api/notifications/my). " +
            "Only an admin-only endpoint exists today (GET /api/admin/notifications)."
    );
}

export const MY_NOTIFICATIONS_API_AVAILABLE = false;
