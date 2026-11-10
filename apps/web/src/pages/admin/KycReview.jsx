import { useState } from "react";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import {
    listPendingKycApplications,
    reviewKycApplication,
} from "../../services/adminService";
import { AdminCard, AdminPage } from "../../components/AdminPage";
import DataTable from "../../components/ui/DataTable";
import { useToast } from "../../components/ui/ToastContext";

function KycReview() {
    const { t } = useTranslation();
    const toast = useToast();
    const submissionsApi = useApi(listPendingKycApplications, []);
    const [reviewingId, setReviewingId] = useState(null);

    async function reviewSubmission(submission, status) {
        setReviewingId(submission.kyc_id);
        try {
            await reviewKycApplication(submission.kyc_id, status);
            toast.success(t(status === "VERIFIED"
                ? "adminKycReview.approved"
                : "adminKycReview.rejected"));
            await submissionsApi.refetch();
        } catch (error) {
            const message = error.data?.code === "KYC_NATIONAL_ID_ALREADY_VERIFIED"
                ? t("adminKycReview.duplicateApprovalBlocked")
                : error.message || t("adminKycReview.actionError");
            toast.error(message);
        } finally {
            setReviewingId(null);
        }
    }

    const columns = [
        { key: "full_name", header: t("adminKycReview.worker") },
        { key: "email", header: t("adminKycReview.email") },
        { key: "phone", header: t("adminKycReview.phone") },
        { key: "date_of_birth", header: t("adminKycReview.dateOfBirth") },
        { key: "masked_national_id", header: t("adminKycReview.nationalId") },
        {
            key: "duplicate_submission",
            header: t("adminKycReview.duplicate"),
            render: (submission) => submission.duplicate_submission
                ? <span className="admin-status-pill">{t("adminKycReview.duplicateFlag")}</span>
                : t("adminKycReview.notFlagged"),
        },
        {
            key: "actions",
            header: t("adminKycReview.actions"),
            render: (submission) => (
                <div className="admin-page-actions">
                    <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={Boolean(reviewingId)}
                        onClick={() => reviewSubmission(submission, "VERIFIED")}
                    >
                        {t("adminKycReview.approve")}
                    </button>
                    <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={Boolean(reviewingId)}
                        onClick={() => reviewSubmission(submission, "REJECTED")}
                    >
                        {t("adminKycReview.reject")}
                    </button>
                </div>
            ),
        },
    ];

    return (
        <AdminPage
            title={t("adminKycReview.title")}
            subtitle={t("adminKycReview.subtitle")}
        >
            <AdminCard
                title={t("adminKycReview.pendingTitle")}
                description={t("adminKycReview.reviewNotice")}
            >
                <DataTable
                    columns={columns}
                    rows={submissionsApi.data}
                    rowKey="kyc_id"
                    loading={submissionsApi.loading}
                    refreshing={submissionsApi.refreshing}
                    error={submissionsApi.error}
                    onRetry={submissionsApi.refetch}
                    emptyMessage={t("adminKycReview.empty")}
                    loadingLabel={t("adminKycReview.loading")}
                    refreshingLabel={t("adminKycReview.refreshing")}
                    errorTitle={t("adminKycReview.errorTitle")}
                    retryLabel={t("adminKycReview.retry")}
                />
            </AdminCard>
        </AdminPage>
    );
}

export default KycReview;
