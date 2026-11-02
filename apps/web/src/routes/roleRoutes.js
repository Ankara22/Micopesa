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

export const PROFILE_BY_ROLE = {
    WORKER: "/worker/profile",
    FUND_MANAGER: "/manager/profile",
    REGULATOR: "/regulator/profile",
    ADMIN: "/admin/profile",
};

export const ROLE_LABEL = {
    WORKER: "Worker",
    FUND_MANAGER: "Fund Manager",
    REGULATOR: "Regulator",
    ADMIN: "Administrator",
};

export const ROLE_NAV = {
    WORKER: [
        { label: "Dashboard", translationKey: "navigation.dashboard", path: "/worker/dashboard" },
        { label: "Contributions", translationKey: "navigation.contributions", path: "/worker/contributions" },
        { label: "Balance History", translationKey: "navigation.balanceHistory", path: "/worker/balance" },
        { label: "My Funds & Allocation", translationKey: "navigation.myFunds", path: "/worker/funds" },
        { label: "Retirement Plan", translationKey: "navigation.retirementPlan", path: "/worker/retirement-plan" },
        { label: "Retirement Projection", translationKey: "navigation.retirementProjection", path: "/worker/retirement-projection" },
        { label: "Withdrawals", translationKey: "navigation.withdrawals", path: "/worker/withdrawals" },
        { label: "Financial Literacy", translationKey: "navigation.financialLiteracy", path: "/worker/literacy" },
        { label: "Notifications", translationKey: "navigation.notifications", path: "/worker/notifications" },
        { label: "Profile", translationKey: "navigation.profile", path: "/worker/profile" },
    ],
    FUND_MANAGER: [
        { label: "Dashboard", translationKey: "navigation.dashboard", path: "/manager/dashboard" },
        { label: "Manage Funds", translationKey: "navigation.manageFunds", path: "/manager/funds" },
        { label: "Fund Analytics", translationKey: "navigation.fundAnalytics", path: "/manager/analytics" },
        { label: "Withdrawal Requests", translationKey: "navigation.withdrawalRequests", path: "/manager/withdrawal-requests" },
        { label: "Operational Reports", translationKey: "navigation.operationalReports", path: "/manager/reports" },
        { label: "Operational Audit Logs", translationKey: "navigation.operationalAuditLogs", path: "/manager/audit-logs" },
        { label: "Notifications", translationKey: "navigation.notifications", path: "/manager/notifications" },
        { label: "Profile", translationKey: "navigation.profile", path: "/manager/profile" },
    ],
    REGULATOR: [
        { label: "Dashboard", translationKey: "navigation.dashboard", path: "/regulator/dashboard" },
        { label: "Fund Oversight", translationKey: "navigation.fundOversight", path: "/regulator/funds" },
        { label: "Compliance Reports", translationKey: "navigation.complianceReports", path: "/regulator/compliance-reports" },
        { label: "Operational Audit Logs", translationKey: "navigation.operationalAuditLogs", path: "/regulator/audit-logs" },
        { label: "Notifications", translationKey: "navigation.notifications", path: "/regulator/notifications" },
        { label: "Profile", translationKey: "navigation.profile", path: "/regulator/profile" },
    ],
    ADMIN: [
        { label: "Dashboard", translationKey: "navigation.dashboard", path: "/admin/dashboard" },
        { label: "User Management", translationKey: "navigation.userManagement", path: "/admin/users" },
        { label: "Roles & Permissions", translationKey: "navigation.rolesPermissions", path: "/admin/roles" },
        { label: "System Settings", translationKey: "navigation.systemSettings", path: "/admin/settings" },
        { label: "Notifications", translationKey: "navigation.notifications", path: "/admin/notifications" },
        { label: "System Activity", translationKey: "navigation.systemActivity", path: "/admin/activity" },
        { label: "System Audit Logs", translationKey: "navigation.systemAuditLogs", path: "/admin/audit-logs" },
        { label: "Profile", translationKey: "navigation.profile", path: "/admin/profile" },
    ],
};
