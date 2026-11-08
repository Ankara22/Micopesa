import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import ProtectedRoute from "../components/ProtectedRoute";
import AppLayout from "../layouts/AppLayout";
import AdminLayout from "../layouts/AdminLayout";
import { DASHBOARD_BY_ROLE } from "./roleRoutes";
import SkeletonLoader from "../components/ui/SkeletonLoader";

// Public pages
import Login from "../pages/auth/Login";
import Register from "../pages/auth/Register";
import ForgotPassword from "../pages/auth/ForgotPassword";
import ResetPassword from "../pages/auth/ResetPassword";
import VerifyEmail from "../pages/auth/VerifyEmail";
import ChangeTemporaryPassword from "../pages/auth/ChangeTemporaryPassword";
import Unauthorized from "../pages/Unauthorized";

// Worker pages
import WorkerDashboard from "../pages/worker/Dashboard";
import WorkerAnalytics from "../pages/worker/Analytics";
import WorkerContributions from "../pages/worker/Contributions";
import WorkerBalanceHistory from "../pages/worker/BalanceHistory";
import WorkerFunds from "../pages/worker/Funds";
import WorkerRetirementPlan from "../pages/worker/RetirementPlan";
import WorkerRetirementProjection from "../pages/worker/RetirementProjection";
import WorkerWithdrawals from "../pages/worker/Withdrawals";
import WorkerFinancialLiteracy from "../pages/worker/FinancialLiteracy";
import WorkerNotifications from "../pages/worker/Notifications";
import WorkerProfile from "../pages/worker/Profile";

// Fund manager pages
import ManagerDashboard from "../pages/manager/Dashboard";
import ManagerAnalytics from "../pages/manager/Analytics";
import ManagerFunds from "../pages/manager/Funds";
import ManagerWithdrawalRequests from "../pages/manager/WithdrawalRequests";
import ManagerOperationalReports from "../pages/manager/OperationalReports";
import ManagerAuditLogs from "../pages/manager/AuditLogs";
import ManagerProfile from "../pages/manager/Profile";

// Regulator pages
import RegulatorDashboard from "../pages/regulator/Dashboard";
import RegulatorAnalytics from "../pages/regulator/Analytics";
import RegulatorFundOversight from "../pages/regulator/FundOversight";
import RegulatorComplianceReports from "../pages/regulator/ComplianceReports";
import RegulatorAuditLogs from "../pages/regulator/AuditLogs";
import RegulatorProfile from "../pages/regulator/Profile";
import RoleNotifications from "../pages/notifications/RoleNotifications";
import NotificationAuditPage from "../pages/notifications/NotificationAuditPage";
import ReportsPage from "../pages/reports/ReportsPage";

// Admin pages
import AdminDashboard from "../pages/admin/Dashboard";
import AdminAnalytics from "../pages/admin/Analytics";
import AdminUserManagement from "../pages/admin/UserManagement";
import AdminRolesPermissions from "../pages/admin/RolesPermissions";
import AdminRegulatorScopes from "../pages/admin/RegulatorScopes";
import AdminSystemSettings from "../pages/admin/SystemSettings";
import AdminNotifications from "../pages/admin/Notifications";
import AdminSystemActivity from "../pages/admin/SystemActivity";
import AdminAuditLogs from "../pages/admin/AuditLogs";
import AdminProfile from "../pages/admin/Profile";

/** Sends "/" to the signed-in user's own dashboard, or to /login otherwise. */
function HomeRedirect() {
    const { isAuthenticated, isLoading, user } = useAuth();

    if (isLoading) {
        return <SkeletonLoader variant="dashboard" count={3} label="Restoring your MicoPesa session" />;
    }

    if (!isAuthenticated) {
        return <Navigate to="/login" replace />;
    }

    return <Navigate to={DASHBOARD_BY_ROLE[user.role] || "/login"} replace />;
}

function AppRoutes() {
    return (
        <Routes>
            <Route path="/" element={<HomeRedirect />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/verify-email" element={<VerifyEmail />} />
            <Route
                path="/change-password"
                element={
                    <ProtectedRoute>
                        <ChangeTemporaryPassword />
                    </ProtectedRoute>
                }
            />
            <Route path="/unauthorized" element={<Unauthorized />} />

            {/* WORKER */}
            <Route
                element={
                    <ProtectedRoute allowedRoles={["WORKER"]}>
                        <AppLayout />
                    </ProtectedRoute>
                }
            >
                <Route path="/worker/dashboard" element={<WorkerDashboard />} />
                <Route path="/worker/analytics" element={<WorkerAnalytics />} />
                <Route path="/worker/contributions" element={<WorkerContributions />} />
                <Route path="/worker/balance" element={<WorkerBalanceHistory />} />
                <Route path="/worker/funds" element={<WorkerFunds />} />
                <Route path="/worker/retirement-plan" element={<WorkerRetirementPlan />} />
                <Route path="/worker/retirement-projection" element={<WorkerRetirementProjection />} />
                <Route path="/worker/withdrawals" element={<WorkerWithdrawals />} />
                <Route path="/worker/literacy" element={<WorkerFinancialLiteracy />} />
                <Route path="/worker/notifications" element={<WorkerNotifications />} />
                <Route path="/worker/profile" element={<WorkerProfile />} />
            </Route>

            {/* FUND_MANAGER */}
            <Route
                element={
                    <ProtectedRoute allowedRoles={["FUND_MANAGER"]}>
                        <AppLayout />
                    </ProtectedRoute>
                }
            >
                <Route path="/manager/dashboard" element={<ManagerDashboard />} />
                <Route path="/manager/funds" element={<ManagerFunds />} />
                <Route path="/manager/analytics" element={<ManagerAnalytics />} />
                <Route path="/manager/withdrawal-requests" element={<ManagerWithdrawalRequests />} />
                <Route path="/manager/reports" element={<ManagerOperationalReports />} />
                <Route path="/manager/audit-logs" element={<ManagerAuditLogs />} />
                <Route path="/manager/notifications" element={<RoleNotifications />} />
                <Route path="/manager/notification-audit-log" element={<NotificationAuditPage />} />
                <Route path="/manager/reports-exports" element={<ReportsPage />} />
                <Route path="/manager/report-history" element={<ReportsPage historyOnly />} />
                <Route path="/manager/profile" element={<ManagerProfile />} />
            </Route>

            {/* REGULATOR */}
            <Route
                element={
                    <ProtectedRoute allowedRoles={["REGULATOR"]}>
                        <AppLayout />
                    </ProtectedRoute>
                }
            >
                <Route path="/regulator/dashboard" element={<RegulatorDashboard />} />
                <Route path="/regulator/analytics" element={<RegulatorAnalytics />} />
                <Route path="/regulator/funds" element={<RegulatorFundOversight />} />
                <Route path="/regulator/compliance-reports" element={<RegulatorComplianceReports />} />
                <Route path="/regulator/audit-logs" element={<RegulatorAuditLogs />} />
                <Route path="/regulator/notifications" element={<RoleNotifications />} />
                <Route path="/regulator/notification-audit-log" element={<NotificationAuditPage />} />
                <Route path="/regulator/reports" element={<ReportsPage />} />
                <Route path="/regulator/report-history" element={<ReportsPage historyOnly />} />
                <Route path="/regulator/profile" element={<RegulatorProfile />} />
            </Route>

            {/* ADMIN */}
            <Route
                element={
                    <ProtectedRoute allowedRoles={["ADMIN"]}>
                        <AdminLayout />
                    </ProtectedRoute>
                }
            >
                <Route path="/admin/dashboard" element={<AdminDashboard />} />
                <Route path="/admin/analytics" element={<AdminAnalytics />} />
                <Route path="/admin/users" element={<AdminUserManagement />} />
                <Route path="/admin/roles" element={<AdminRolesPermissions />} />
                <Route path="/admin/regulator-scopes" element={<AdminRegulatorScopes />} />
                <Route path="/admin/settings" element={<AdminSystemSettings />} />
                <Route path="/admin/notifications" element={<AdminNotifications />} />
                <Route path="/admin/notification-audit-log" element={<NotificationAuditPage />} />
                <Route path="/admin/reports" element={<ReportsPage />} />
                <Route path="/admin/report-history" element={<ReportsPage historyOnly />} />
                <Route path="/admin/activity" element={<AdminSystemActivity />} />
                <Route path="/admin/audit-logs" element={<AdminAuditLogs />} />
                <Route path="/admin/profile" element={<AdminProfile />} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    );
}

export default AppRoutes;
