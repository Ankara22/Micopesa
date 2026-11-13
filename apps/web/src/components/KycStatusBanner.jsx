import { useTranslation } from "react-i18next";

function KycStatusBanner({ status }) {
    const { t } = useTranslation();
    if (status !== "PENDING" && status !== "REJECTED") return null;

    const statusKey = status.toLowerCase();
    return (
        <aside
            className={`kyc-status-banner kyc-status-banner--${statusKey}`}
            role={status === "REJECTED" ? "alert" : "note"}
        >
            {t(`worker.profile.kycAccess.${statusKey}`)}
        </aside>
    );
}

export default KycStatusBanner;
