import { Link } from "react-router-dom";
import useApi from "../../hooks/useApi";
import { listFunds } from "../../services/fundService";
import { listReports } from "../../services/complianceReportService";
import { StatCard } from "../../components/ui/Card";
import LoadingState from "../../components/ui/LoadingState";
import ErrorState from "../../components/ui/ErrorState";
import Button from "../../components/ui/Button";

function RegulatorDashboard() {
    const fundsApi = useApi(listFunds, []);
    const reportsApi = useApi(listReports, []);

    if (fundsApi.loading || reportsApi.loading) return <LoadingState message="Loading your dashboard..." />;
    if (fundsApi.error) return <ErrorState message={fundsApi.error} onRetry={fundsApi.refetch} />;

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Regulator Dashboard</h1>
                    <p className="page-subtitle">Platform-wide oversight of funds and compliance.</p>
                </div>
            </div>

            <div className="stat-card-grid">
                <StatCard label="Funds Under Oversight" value={(fundsApi.data || []).length} />
                <StatCard label="Compliance Reports Filed" value={(reportsApi.data || []).length} />
            </div>

            <div className="section card">
                <h2 className="card-title">Quick actions</h2>
                <div className="form-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
                    <Link to="/regulator/funds">
                        <Button variant="primary">Review Fund Performance</Button>
                    </Link>
                    <Link to="/regulator/compliance-reports">
                        <Button variant="secondary">View Compliance Reports</Button>
                    </Link>
                </div>
            </div>
        </div>
    );
}

export default RegulatorDashboard;
