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
import Modal from "../../components/ui/Modal";
import Button from "../../components/ui/Button";
import { revealKycNationalId } from "../../services/adminService";

function formatDateOfBirth(value) {
    if (!value) return "—";

    // Preserve date-only values without timezone conversion.
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));

    if (match) {
        return `${match[3]}/${match[2]}/${match[1]}`;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";

    return [
        String(date.getDate()).padStart(2, "0"),
        String(date.getMonth() + 1).padStart(2, "0"),
        date.getFullYear(),
    ].join("/");
}

function KycReview() {
    const { t } = useTranslation();
    const toast = useToast();
    const submissionsApi = useApi(listPendingKycApplications, []);
    const [reviewingId, setReviewingId] = useState(null);
    const [revealingSubmission, setRevealingSubmission] = useState(null);
    const [revealReason, setRevealReason] = useState("");
    const [revealedNationalId, setRevealedNationalId] = useState("");
    const [revealing, setRevealing] = useState(false);
    const [revealError, setRevealError] = useState("");

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

    async function revealNationalId(event) {
        event.preventDefault();
        if (revealing || revealReason.trim().length < 10 || revealReason.trim().length > 500) return;
        setRevealing(true);
        setRevealError("");
        try {
            const result = await revealKycNationalId(
                revealingSubmission.kyc_id,
                revealReason.trim(),
            );
            if (typeof result?.national_id !== "string" || !result.national_id) {
                throw new Error(t("adminKycReview.revealError"));
            }
            setRevealedNationalId(result.national_id);
        } catch (error) {
            setRevealError(error.message || t("adminKycReview.revealError"));
        } finally {
            setRevealing(false);
        }
    }

    function closeRevealModal() {
        if (revealing) return;
        setRevealingSubmission(null);
        setRevealReason("");
        setRevealedNationalId("");
        setRevealError("");
    }

    const columns = [
        { key: "full_name", header: t("adminKycReview.worker") },
        { key: "email", header: t("adminKycReview.email") },
        { key: "phone", header: t("adminKycReview.phone") },
        {
    key: "date_of_birth",
    header: t("adminKycReview.dateOfBirth"),
    render: (submission) => formatDateOfBirth(submission.date_of_birth),
},
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
                    <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={Boolean(reviewingId)}
                        onClick={() => {
                            setRevealingSubmission(submission);
                            setRevealReason("");
                            setRevealedNationalId("");
                            setRevealError("");
                        }}
                    >
                        {t("adminKycReview.revealNationalId")}
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
            <Modal
                open={Boolean(revealingSubmission)}
                title={t("adminKycReview.revealTitle")}
                onClose={closeRevealModal}
                footer={revealedNationalId
                    ? <Button type="button" variant="secondary" onClick={closeRevealModal}>{t("adminKycReview.close")}</Button>
                    : <Button
                        type="submit"
                        form="national-id-reveal-form"
                        variant="primary"
                        loading={revealing}
                        disabled={revealing || revealReason.trim().length < 10 || revealReason.trim().length > 500}
                    >
                        {t("adminKycReview.revealNationalId")}
                    </Button>}
            >
                {revealingSubmission && (
                    <>
                        <p>{t("adminKycReview.revealWarning", { name: revealingSubmission.full_name })}</p>
                        {revealError && <p role="alert">{revealError}</p>}
                        {revealedNationalId ? (
                            <p className="admin-revealed-identifier" role="status">
                                {t("adminKycReview.revealedNationalId")}: <strong>{revealedNationalId}</strong>
                            </p>
                        ) : (
                            <form id="national-id-reveal-form" className="form-grid" onSubmit={revealNationalId}>
                                <label htmlFor="national-id-reveal-reason">{t("adminKycReview.revealReason")}</label>
                                <textarea
                                    id="national-id-reveal-reason"
                                    rows={4}
                                    minLength={10}
                                    maxLength={500}
                                    value={revealReason}
                                    onChange={(event) => setRevealReason(event.target.value)}
                                    disabled={revealing}
                                    required
                                />
                            </form>
                        )}
                    </>
                )}
            </Modal>
        </AdminPage>
    );
}

export default KycReview;
