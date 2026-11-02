import { Link } from "react-router-dom";
import useApi from "../../hooks/useApi";
import { getFundPerformance } from "../../services/fundManagerApi";
import { useAuth } from "../../context/AuthContext";
import { StatCard } from "../../components/ui/Card";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import ErrorState from "../../components/ui/ErrorState";
import LoadingState from "../../components/ui/LoadingState";
import "./fund-manager-dashboard.css";

const MANAGER_LINKS = [
    { label: "Manage Funds", description: "Create and manage your fund records.", to: "/manager/funds" },
    { label: "Fund Analytics", description: "Review current allocation shares and dated history.", to: "/manager/analytics" },
    { label: "Withdrawal Requests", description: "Review worker withdrawal requests.", to: "/manager/withdrawal-requests" },
    { label: "Reports", description: "Open operational reports.", to: "/manager/reports" },
    { label: "Audit Logs", description: "Review recorded operational actions.", to: "/manager/audit-logs" },
    { label: "Profile", description: "View your manager profile.", to: "/manager/profile" },
];

function formatCurrency(value) {
    if (value === undefined || value === null || value === "" || !Number.isFinite(Number(value))) return "Unavailable";
    return `KSh ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCount(value) {
    return value !== undefined && value !== null && Number.isFinite(Number(value))
        ? Number(value).toLocaleString()
        : "Unavailable";
}

function formatPercentage(value) {
    if (value === undefined || value === null || value === "" || !Number.isFinite(Number(value))) return "Unavailable";
    return `${Number(value).toFixed(2)}%`;
}

function FundManagerDashboard() {
    const { user } = useAuth();
    const performanceApi = useApi(getFundPerformance, []);
    const performance = performanceApi.data;
    const firstName = user?.full_name?.trim().split(/\s+/)[0];

    return (
        <div className="fund-manager-dashboard">
            <header className="page-header fund-manager-dashboard-header">
                <div>
                    <p className="fund-manager-eyebrow">Fund management</p>
                    <h1 className="page-title">{firstName ? `Welcome, ${firstName}` : "Fund Manager Dashboard"}</h1>
                    <p className="page-subtitle">A concise overview of managed funds and pension accounts.</p>
                </div>
            </header>

            <section aria-label="Fund management summary">
                {performanceApi.refreshing && <LoadingState message="Refreshing fund summary..." />}
                {performanceApi.loading && performanceApi.data === null ? (
                    <SkeletonLoader variant="metrics" count={4} label="Loading fund summary" />
                ) : performanceApi.error && performanceApi.data === null ? (
                    <ErrorState message={performanceApi.error} onRetry={performanceApi.refetch} />
                ) : (
                    <>
                        {performanceApi.error && <ErrorState message={performanceApi.error} onRetry={performanceApi.refetch} />}
                        <div className="stat-card-grid fund-manager-summary">
                            <StatCard label="Total pension account balances" value={formatCurrency(performance?.total_assets)} hint="Across all pension accounts" />
                            <StatCard label="Active pension accounts" value={formatCount(performance?.active_accounts)} />
                            <StatCard label="Managed funds" value={formatCount(performance?.funds_managed)} />
                            <StatCard label="Average expected return" value={formatPercentage(performance?.average_yield)} hint="Configured average for active managed funds" />
                        </div>
                    </>
                )}
            </section>

            <nav className="fund-manager-dashboard-section fund-manager-quick-links" aria-label="Fund Manager features">
                <p className="fund-manager-eyebrow">Your workspace</p>
                <h2>Go to a feature</h2>
                <ul>
                    {MANAGER_LINKS.map((item) => (
                        <li key={item.to}>
                            <Link to={item.to}>
                                <span>{item.label}</span>
                                <small>{item.description}</small>
                            </Link>
                        </li>
                    ))}
                </ul>
            </nav>
        </div>
    );
}

export default FundManagerDashboard;
