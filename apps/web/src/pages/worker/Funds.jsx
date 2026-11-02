import WorkerFundAllocation from "../../components/Funds/WorkerFundAllocation";
import { useTranslation } from "react-i18next";
import "./worker-dashboard.css";

function WorkerFunds() {
    const { t } = useTranslation();
    return (
        <div className="worker-dashboard">
            <header className="page-header">
                <div>
                    <p className="worker-dashboard-eyebrow">{t("worker.funds.eyebrow")}</p>
                    <h1 className="page-title">{t("worker.funds.title")}</h1>
                    <p className="page-subtitle">{t("worker.funds.subtitle")}</p>
                </div>
            </header>
            <WorkerFundAllocation />
        </div>
    );
}

export default WorkerFunds;
