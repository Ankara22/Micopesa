import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import ProtectedRoute from "../components/ProtectedRoute";
import AppLayout from "../layouts/AppLayout";
import AdminLayout from "../layouts/AdminLayout";
import { DASHBOARD_BY_ROLE } from "./roleRoutes";
import SkeletonLoader from "../components/ui/SkeletonLoader";

const Login = lazy(() => import("../pages/auth/Login"));
const Register = lazy(() => import("../pages/auth/Register"));
const ForgotPassword = lazy(() => import("../pages/auth/ForgotPassword"));
const ResetPassword = lazy(() => import("../pages/auth/ResetPassword"));
const VerifyEmail = lazy(() => import("../pages/auth/VerifyEmail"));
const ChangeTemporaryPassword = lazy(() => import("../pages/auth/ChangeTemporaryPassword"));
const Unauthorized = lazy(() => import("../pages/Unauthorized"));

const WorkerDashboard = lazy(() => import("../pages/worker/Dashboard"));
const WorkerAnalytics = lazy(() => import("../pages/worker/Analytics"));
const WorkerContributions = lazy(() => import("../pages/worker/Contributions"));
const WorkerBalanceHistory = lazy(() => import("../pages/worker/BalanceHistory"));
const WorkerFunds = lazy(() => import("../pages/worker/Funds"));
const WorkerRetirementPlan = lazy(() => import("../pages/worker/RetirementPlan"));
const WorkerRetirementProjection = lazy(() => import("../pages/worker/RetirementProjection"));
const WorkerWithdrawals = lazy(() => import("../pages/worker/Withdrawals"));
const WorkerFinancialLiteracy = lazy(() => import("../pages/worker/FinancialLiteracy"));
const WorkerNotifications = lazy(() => import("../pages/worker/Notifications"));
const WorkerProfile = lazy(() => import("../pages/worker/Profile"));

const ManagerDashboard = lazy(() => import("../pages/manager/Dashboard"));
const ManagerAnalytics = lazy(() => import("../pages/manager/Analytics"));
const ManagerFunds = lazy(() => import("../pages/manager/Funds"));
const ManagerWithdrawalRequests = lazy(() => import("../pages/manager/WithdrawalRequests"));
const PayoutAuthorizations = lazy(() => import("../pages/payout/PayoutAuthorizations"));
const ManagerOperationalReports = lazy(() => import("../pages/manager/OperationalReports"));
const ManagerAuditLogs = lazy(() => import("../pages/manager/AuditLogs"));
const ManagerProfile = lazy(() => import("../pages/manager/Profile"));

const RegulatorDashboard = lazy(() => import("../pages/regulator/Dashboard"));
const RegulatorAnalytics = lazy(() => import("../pages/regulator/Analytics"));
const RegulatorFundOversight = lazy(() => import("../pages/regulator/FundOversight"));
const RegulatorComplianceReports = lazy(() => import("../pages/regulator/ComplianceReports"));
const RegulatorParameters = lazy(() => import("../pages/regulator/RegulatoryParameters"));
const RegulatorKycOversight = lazy(() => import("../pages/regulator/KycOversight"));
const RegulatorAuditLogs = lazy(() => import("../pages/regulator/AuditLogs"));
const RegulatorProfile = lazy(() => import("../pages/regulator/Profile"));
const RoleNotifications = lazy(() => import("../pages/notifications/RoleNotifications"));
const NotificationAuditPage = lazy(() => import("../pages/notifications/NotificationAuditPage"));
const ReportsPage = lazy(() => import("../pages/reports/ReportsPage"));

const AdminDashboard = lazy(() => import("../pages/admin/Dashboard"));
const AdminKycReview = lazy(() => import("../pages/admin/KycReview"));
const AdminAnalytics = lazy(() => import("../pages/admin/Analytics"));
const AdminUserManagement = lazy(() => import("../pages/admin/UserManagement"));
const AdminRolesPermissions = lazy(() => import("../pages/admin/RolesPermissions"));
const AdminRegulatorScopes = lazy(() => import("../pages/admin/RegulatorScopes"));
const AdminSystemSettings = lazy(() => import("../pages/admin/SystemSettings"));
const AdminNotifications = lazy(() => import("../pages/admin/Notifications"));
const AdminSystemActivity = lazy(() => import("../pages/admin/SystemActivity"));
const AdminAuditLogs = lazy(() => import("../pages/admin/AuditLogs"));
const AdminProfile = lazy(() => import("../pages/admin/Profile"));

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
        <Suspense fallback={
            <SkeletonLoader variant="dashboard" count={3} label="Loading page" />
        }>
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
                <Route path="/regulator/regulatory-parameters" element={<RegulatorParameters />} />
                <Route path="/regulator/kyc-oversight" element={<RegulatorKycOversight />} />
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
                <Route path="/admin/kyc-review" element={<AdminKycReview />} />
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

            {/* PAYOUT_OFFICER */}
            <Route
                element={
                    <ProtectedRoute allowedRoles={["PAYOUT_OFFICER"]}>
                        <AppLayout />
                    </ProtectedRoute>
                }
            >
                <Route path="/payout/authorizations" element={<PayoutAuthorizations />} />
                <Route path="/payout/profile" element={<ManagerProfile />} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
    );
}

export default AppRoutes;
