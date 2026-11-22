import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import {
    getPayoutAuthorizationQueue,
    initiatePayoutOtp,
    resendPayoutOtp,
} from "../../services/withdrawalService";
import DataTable from "../../components/ui/DataTable";
import Button from "../../components/ui/Button";
import StatusBadge from "../../components/ui/StatusBadge";
import { useToast } from "../../components/ui/ToastContext";
import { formatDateTime, formatKes } from "../../i18n/formatters";

function PayoutAuthorizations() {
    const { t, i18n } = useTranslation();
    const queueApi = useApi(getPayoutAuthorizationQueue, []);
    const toast = useToast();
    const [busyClaimId, setBusyClaimId] = useState(null);
    const requestInProgressRef = useRef(false);

    async function handleOtpRequest(claim, resend) {
        if (requestInProgressRef.current) return;
        if (typeof globalThis.crypto?.randomUUID !== "function") {
            toast.error(t("payoutOfficer.idempotencyUnavailable"));
            return;
        }
        requestInProgressRef.current = true;
        setBusyClaimId(claim.claim_id);
        try {
            const send = resend ? resendPayoutOtp : initiatePayoutOtp;
            await send(claim.claim_id, globalThis.crypto.randomUUID());
            toast.success(resend
                ? t("payoutOfficer.resendAccepted")
                : t("payoutOfficer.sendAccepted"));
            const rows = await queueApi.refetch();
            if (!rows) toast.info(t("payoutOfficer.refreshError"));
        } catch (error) {
            toast.error(
                error.response?.data?.message || t("payoutOfficer.requestError")
            );
        } finally {
            requestInProgressRef.current = false;
            setBusyClaimId(null);
        }
    }

    const columns = [
        { key: "worker_name", header: t("payoutOfficer.worker") },
        {
            key: "amount_requested",
            header: t("payoutOfficer.amount"),
            render: (row) => formatKes(row.amount_requested, i18n.language) || "—",
        },
        {
            key: "destination_phone_last_four",
            header: t("payoutOfficer.destination"),
            render: (row) => t("payoutOfficer.destinationLastFour", {
                digits: row.destination_phone_last_four || "----",
            }),
        },
        {
            key: "requested_at",
            header: t("payoutOfficer.requested"),
            render: (row) => formatDateTime(row.requested_at, i18n.language),
        },
        {
            key: "otp_status",
            header: t("payoutOfficer.authorizationStatus"),
            render: (row) => {
                if (row.otp_status === "VERIFIED") {
                    return <StatusBadge status="APPROVED" label={t("payoutOfficer.verifiedUnpaid")} />;
                }
                return (
                    <StatusBadge
                        status={row.otp_status || "PENDING"}
                        label={t(`payoutOfficer.status.${row.otp_status || "NOT_STARTED"}`)}
                    />
                );
            },
        },
        {
            key: "actions",
            header: "",
            render: (row) => {
                if (row.otp_status === "VERIFIED") {
                    return <span>{t("payoutOfficer.noPayoutAction")}</span>;
                }
                const resend = row.otp_status === "ISSUED";
                const blocked = row.account_status !== "ACTIVE" ||
                    row.worker_status !== "ACTIVE" ||
                    row.verified_destination_matches !== true;
                if (blocked) {
                    return <span>{t("payoutOfficer.accountNeedsReview")}</span>;
                }
                return (
                    <Button
                        variant={resend ? "secondary" : "primary"}
                        size="sm"
                        disabled={blocked || busyClaimId === row.claim_id}
                        loading={busyClaimId === row.claim_id}
                        onClick={() => handleOtpRequest(row, resend)}
                    >
                        {t(resend ? "payoutOfficer.resend" : "payoutOfficer.send")}
                    </Button>
                );
            },
        },
    ];

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">{t("payoutOfficer.title")}</h1>
                    <p className="page-subtitle">{t("payoutOfficer.subtitle")}</p>
                </div>
            </div>
            <div className="form-note" role="note">
                {t("payoutOfficer.executionDisabled")}
            </div>
            <DataTable
                columns={columns}
                rows={queueApi.data}
                rowKey="claim_id"
                loading={queueApi.loading}
                refreshing={queueApi.refreshing}
                error={queueApi.error ? t("payoutOfficer.loadError") : null}
                onRetry={queueApi.refetch}
                emptyMessage={t("payoutOfficer.empty")}
            />
        </div>
    );
}

export default PayoutAuthorizations;
