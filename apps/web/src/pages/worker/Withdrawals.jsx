import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import { getEligibility, submitClaim, getMyClaims } from "../../services/withdrawalService";
import Card from "../../components/ui/Card";
import DataTable from "../../components/ui/DataTable";
import StatusBadge from "../../components/ui/StatusBadge";
import FormField from "../../components/ui/FormField";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import ErrorState from "../../components/ui/ErrorState";
import SkeletonLoader from "../../components/ui/SkeletonLoader";
import LoadingState from "../../components/ui/LoadingState";
import { useToast } from "../../components/ui/ToastContext";
import { formatDateTime, formatKes } from "../../i18n/formatters";

function Withdrawals() {
    const { t, i18n } = useTranslation();
    const eligibilityApi = useApi(getEligibility, []);
    const claimsApi = useApi(getMyClaims, []);
    const toast = useToast();

    const [requestOpen, setRequestOpen] = useState(false);
    const [amount, setAmount] = useState("");
    const [phone, setPhone] = useState("");
    const [reason, setReason] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const submissionInProgressRef = useRef(false);
    const columns = [
        { key: "requested_at", header: t("worker.withdrawals.requested"), render: (row) => formatDateTime(row.requested_at, i18n.language) },
        { key: "amount_requested", header: t("worker.withdrawals.tableAmount"), render: (row) => formatKes(row.amount_requested, i18n.language) || t("worker.common.notAvailable") },
        { key: "destination_phone", header: t("worker.withdrawals.tableDestination") },
        { key: "withdrawal_reason", header: t("worker.withdrawals.tableReason"), render: (row) => row.withdrawal_reason || "-" },
        { key: "claim_status", header: t("worker.withdrawals.tableStatus"), render: (row) => <StatusBadge status={row.claim_status} label={t(`worker.common.statuses.${row.claim_status}`, { defaultValue: row.claim_status })} /> },
    ];

    useEffect(() => {
        if (eligibilityApi.error) toast.error(t("worker.common.errors.load"));
    }, [eligibilityApi.error, toast, t]);

    async function handleSubmit(e) {
        e.preventDefault();
        if (submissionInProgressRef.current) return;
        if (!amount || !phone || !reason.trim()) {
            toast.error(t("worker.withdrawals.required"));
            return;
        }

        submissionInProgressRef.current = true;
        setSubmitting(true);
        try {
            const result = await submitClaim({
                amount_requested: Number(amount),
                destination_phone: phone,
                withdrawal_reason: reason.trim(),
            });
            claimsApi.setData((claims) => [result.claim, ...(claims || [])]);
            toast.success(t("worker.withdrawals.submitted"));
            setAmount("");
            setPhone("");
            setReason("");
            setRequestOpen(false);
            const [eligibility, claims] = await Promise.all([
                eligibilityApi.refetch(),
                claimsApi.refetch(),
            ]);
            if (!eligibility || !claims) {
                toast.info(t("worker.withdrawals.refreshError"));
            }
        } catch {
            toast.error(t("worker.withdrawals.submitError"));
        } finally {
            submissionInProgressRef.current = false;
            setSubmitting(false);
        }
    }

    const eligibility = eligibilityApi.data;

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">{t("worker.withdrawals.title")}</h1>
                    <p className="page-subtitle">{t("worker.withdrawals.subtitle")}</p>
                </div>
            </div>

            <Card title={t("worker.withdrawals.eligibility")}>
                {eligibilityApi.loading && eligibilityApi.data === null ? (
                    <SkeletonLoader variant="metrics" count={1} label={t("worker.withdrawals.checking")} />
                ) : eligibilityApi.error && eligibilityApi.data === null ? (
                    <ErrorState message={t("worker.common.errors.load")} title={t("worker.common.unableToLoad")} retryLabel={t("worker.common.tryAgain")} onRetry={eligibilityApi.refetch} />
                ) : (
                    <>
                        {eligibilityApi.refreshing && <LoadingState message={t("worker.withdrawals.refreshing")} />}
                        {eligibilityApi.error && <ErrorState message={t("worker.common.errors.load")} title={t("worker.common.unableToLoad")} retryLabel={t("worker.common.tryAgain")} onRetry={eligibilityApi.refetch} />}
                        {eligibility && (
                            <>
                                <p>
                                    {t("worker.withdrawals.status")}{" "}
                                    {eligibility.eligible ? (
                                        <span className="badge badge-green">{t("worker.withdrawals.eligible")}</span>
                                    ) : (
                                        <span className="badge badge-red">{t("worker.withdrawals.notEligible")}</span>
                                    )}
                                </p>
                                {eligibility.reasons?.length > 0 && (
                                    <ul>
                                        {eligibility.reasons.map((reason) => (
                                            <li key={reason}>
                                                {typeof reason === "string" && reason.startsWith("Account status is ")
                                                    ? t("worker.withdrawals.reasons.inactiveAccount")
                                                    : reason === "Available balance must be greater than zero"
                                                        ? t("worker.withdrawals.reasons.noAvailableBalance")
                                                        : reason === "An existing withdrawal claim is already pending review"
                                                            ? t("worker.withdrawals.reasons.pendingClaim")
                                                            : t("worker.withdrawals.unknownReason")}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                <p>{t("worker.withdrawals.currentBalance")} {formatKes(eligibility.current_balance, i18n.language) || t("worker.common.notAvailable")}</p>
                                <p>{t("worker.withdrawals.reserved")} {formatKes(eligibility.reserved_withdrawal_amount, i18n.language) || t("worker.common.notAvailable")}</p>
                                <p><strong>{t("worker.withdrawals.availableBalance")} {formatKes(eligibility.available_balance, i18n.language) || t("worker.common.notAvailable")}</strong></p>
                            </>
                        )}
                    </>
                )}
            </Card>

            <div className="section card">
                <h2 className="card-title">{t("worker.withdrawals.requestTitle")}</h2>
                <p className="page-subtitle">{t("worker.withdrawals.requestSubtitle")}</p>
                <div className="form-actions" style={{ justifyContent: "flex-start", marginTop: 16 }}>
                    <Button
                        variant="primary"
                        onClick={() => setRequestOpen(true)}
                        disabled={!eligibility?.eligible || eligibilityApi.loading}
                    >
                        {t("worker.withdrawals.requestButton")}
                    </Button>
                </div>
            </div>

            <Modal open={requestOpen} title={t("worker.withdrawals.modalTitle")} closeLabel={t("worker.common.close")} onClose={() => setRequestOpen(false)}>
                <form className="form-grid" onSubmit={handleSubmit}>
                    <FormField
                        id="amount_requested"
                        label={t("worker.withdrawals.amount")}
                        type="number"
                        min="1"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        required
                    />
                    <FormField
                        id="destination_phone"
                        label={t("worker.withdrawals.destination")}
                        type="tel"
                        placeholder="+254700000000"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        required
                        disabled={submitting}
                    />
                    <FormField
                        id="withdrawal_reason"
                        label={t("worker.withdrawals.reason")}
                        as="textarea"
                        maxLength="255"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        required
                        disabled={submitting}
                    />
                    <div className="form-actions">
                        <Button type="button" variant="secondary" disabled={submitting} onClick={() => setRequestOpen(false)}>
                            {t("worker.withdrawals.cancel")}
                        </Button>
                        <Button type="submit" variant="primary" loading={submitting}>
                            {t("worker.withdrawals.submit")}
                        </Button>
                    </div>
                </form>
            </Modal>

            <div className="section">
                <h2 className="card-title">{t("worker.withdrawals.history")}</h2>
                <DataTable
                    columns={columns}
                    rows={claimsApi.data}
                    rowKey="claim_id"
                    loading={claimsApi.loading}
                    refreshing={claimsApi.refreshing}
                    error={claimsApi.error ? t("worker.common.errors.load") : null}
                    onRetry={claimsApi.refetch}
                    emptyMessage={t("worker.withdrawals.empty")}
                    loadingLabel={t("worker.common.loadingRecords")}
                    refreshingLabel={t("worker.common.refreshingRecords")}
                    errorTitle={t("worker.common.unableToLoad")}
                    retryLabel={t("worker.common.tryAgain")}
                    unexpectedDataMessage={t("worker.common.unexpectedData")}
                />
            </div>
        </div>
    );
}

export default Withdrawals;
