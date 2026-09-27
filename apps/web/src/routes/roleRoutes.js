// Central definition of each role's dashboard path and navigation menu, so
// the Sidebar and the route table (routes/AppRoutes.jsx) can never drift
// apart - both import from this single source of truth.

export const DASHBOARD_BY_ROLE = {
    WORKER: "/worker/dashboard",
    FUND_MANAGER: "/manager/dashboard",
    REGULATOR: "/regulator/dashboard",
    ADMIN: "/admin/dashboard",
};

// The URL prefix each role's pages live under. Used to validate that a
// "redirect back to where you came from" location actually belongs to the
// role that just logged in, so one user's remembered destination can never
// be replayed against a different user/role (see pages/auth/Login.jsx).
export const ROLE_PATH_PREFIX = {
    WORKER: "/worker",
    FUND_MANAGER: "/manager",
    REGULATOR: "/regulator",
    ADMIN: "/admin",
};

export const ROLE_LABEL = {
    WORKER: "Worker",
    FUND_MANAGER: "Fund Manager",
    REGULATOR: "Regulator",
    ADMIN: "Administrator",
};

export const ROLE_NAV = {
    WORKER: [
        { label: "Dashboard", path: "/worker/dashboard" },
        { label: "Contributions / Deposit", path: "/worker/contributions" },
        { label: "Balance & Transaction History", path: "/worker/balance" },
        { label: "Retirement Plan", path: "/worker/retirement-plan" },
        { label: "Retirement Projection", path: "/worker/retirement-projection" },
        { label: "Withdrawals", path: "/worker/withdrawals" },
        { label: "Financial Literacy", path: "/worker/literacy" },
        { label: "Notifications", path: "/worker/notifications" },
        { label: "Profile", path: "/worker/profile" },
    ],
    FUND_MANAGER: [
        { label: "Dashboard", path: "/manager/dashboard" },
        { label: "Funds / Fund Performance", path: "/manager/funds" },
        { label: "Withdrawal Requests", path: "/manager/withdrawal-requests" },
        { label: "Operational Reports", path: "/manager/reports" },
        { label: "Operational Audit Logs", path: "/manager/audit-logs" },
        { label: "Profile", path: "/manager/profile" },
    ],
    REGULATOR: [
        { label: "Dashboard", path: "/regulator/dashboard" },
        { label: "Fund Oversight", path: "/regulator/funds" },
        { label: "Compliance Reports", path: "/regulator/compliance-reports" },
        { label: "Operational Audit Logs", path: "/regulator/audit-logs" },
        { label: "Profile", path: "/regulator/profile" },
    ],
    ADMIN: [
        { label: "Dashboard", path: "/admin/dashboard" },
        { label: "User Management", path: "/admin/users" },
        { label: "Roles & Permissions", path: "/admin/roles" },
        { label: "System Settings", path: "/admin/settings" },
        { label: "Notifications", path: "/admin/notifications" },
        { label: "System Activity", path: "/admin/activity" },
        { label: "System Audit Logs", path: "/admin/audit-logs" },
    ],
};
