import { Link } from "react-router-dom";
import useApi from "../../hooks/useApi";
import { listFunds } from "../../services/fundService";
import { getPendingClaims } from "../../services/withdrawalService";
import { listReports } from "../../services/complianceReportService";
import { StatCard } from "../../components/ui/Card";
import LoadingState from "../../components/ui/LoadingState";
import ErrorState from "../../components/ui/ErrorState";
import Button from "../../components/ui/Button";

function ManagerDashboard() {
    const fundsApi = useApi(listFunds, []);
    const pendingApi = useApi(getPendingClaims, []);
    const reportsApi = useApi(listReports, []);

    const loading = fundsApi.loading || pendingApi.loading || reportsApi.loading;
    if (loading) return <LoadingState message="Loading your dashboard..." />;
    if (fundsApi.error) return <ErrorState message={fundsApi.error} onRetry={fundsApi.refetch} />;

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Fund Manager Dashboard</h1>
                    <p className="page-subtitle">Overview of your funds and pending work.</p>
                </div>
            </div>

            <div className="stat-card-grid">
                <StatCard label="Funds Managed" value={(fundsApi.data || []).length} />
                <StatCard label="Pending Withdrawal Requests" value={(pendingApi.data || []).length} />
                <StatCard label="Compliance Reports Filed" value={(reportsApi.data || []).length} />
            </div>

            <div className="section card">
                <h2 className="card-title">Quick actions</h2>
                <div className="form-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
                    <Link to="/manager/withdrawal-requests">
                        <Button variant="primary">Review Withdrawal Requests</Button>
                    </Link>
                    <Link to="/manager/funds">
                        <Button variant="secondary">Manage Funds</Button>
                    </Link>
                    <Link to="/manager/reports">
                        <Button variant="secondary">File a Report</Button>
                    </Link>
                </div>
            </div>
        </div>
    );
}

export default ManagerDashboard;
