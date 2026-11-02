import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { initiateMyContribution } from "../../services/accountService";
import ErrorState from "../ui/ErrorState";
import Button from "../ui/Button";
import FormField from "../ui/FormField";
import Modal from "../ui/Modal";
import { useToast } from "../ui/ToastContext";
import "./contribution.css";

function ContributionModal({
    open,
    onClose,
    availableFunds,
    allocations,
    loading,
    error,
    onRetry,
    onCreated,
}) {
    const { t } = useTranslation();
    const toast = useToast();
    const [amount, setAmount] = useState("");
    const [channel, setChannel] = useState("BANK");
    const [selectedFundIds, setSelectedFundIds] = useState([]);
    const [submitting, setSubmitting] = useState(false);
    const [formError, setFormError] = useState("");

    const eligibleAllocations = useMemo(() => {
        const availableFundIds = new Set(availableFunds.map((fund) => fund.fund_id));
        const seenFundIds = new Set();
        return allocations.filter((allocation) => {
            if (!availableFundIds.has(allocation.fund_id) || seenFundIds.has(allocation.fund_id)) {
                return false;
            }
            seenFundIds.add(allocation.fund_id);
            return true;
        });
    }, [allocations, availableFunds]);

    function toggleFund(fundId) {
        setSelectedFundIds((current) => current.includes(fundId)
            ? current.filter((selectedId) => selectedId !== fundId)
            : [...current, fundId]);
        setFormError("");
    }

    async function handleSubmit(event) {
        event.preventDefault();
        if (submitting) return;
        if (selectedFundIds.length === 0) {
            setFormError(t("worker.contributions.selectFundError"));
            return;
        }
        setSubmitting(true);
        setFormError("");
        try {
            await initiateMyContribution({
                amount,
                channel,
                fund_ids: selectedFundIds,
            });
            const refreshed = await onCreated?.();
            onClose();
            setAmount("");
            setSelectedFundIds([]);
            toast.info(t("worker.contributions.recordedPending"));
            if (refreshed === false) {
                toast.error(t("worker.contributions.historyRefreshError"));
            }
        } catch {
            setFormError(t("worker.contributions.recordError"));
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Modal open={open} title={t("worker.contributions.modalTitle")} closeLabel={t("worker.common.close")} onClose={() => {
            if (!submitting) onClose();
        }}>
            <form className="form-grid" onSubmit={handleSubmit} aria-busy={submitting}>
                <p className="contribution-safety-note" role="note">
                    {t("worker.contributions.safetyNote")}
                </p>

                {loading && <p role="status">{t("worker.contributions.loadingFunds")}</p>}
                {error && (
                    <ErrorState
                        message={t("worker.common.errors.load")}
                        title={t("worker.common.unableToLoad")}
                        retryLabel={t("worker.common.tryAgain")}
                        onRetry={onRetry}
                    />
                )}

                {!loading && !error && eligibleAllocations.length === 0 && (
                    <p role="status">
                        {t("worker.contributions.noEligibleFunds")}
                    </p>
                )}

                {!loading && !error && eligibleAllocations.length > 0 && (
                    <fieldset className="contribution-funds" disabled={submitting}>
                        <legend>{t("worker.contributions.selectFunds")}</legend>
                        <p>{t("worker.contributions.allocationSnapshot")}</p>
                        {eligibleAllocations.map((allocation) => (
                            <label className="contribution-fund-option" key={allocation.fund_id}>
                                <input
                                    type="checkbox"
                                    checked={selectedFundIds.includes(allocation.fund_id)}
                                    onChange={() => toggleFund(allocation.fund_id)}
                                />
                                <span>{allocation.fund_name}</span>
                                <strong>{Number(allocation.allocation_percentage).toFixed(2)}%</strong>
                            </label>
                        ))}
                    </fieldset>
                )}

                <FormField
                    id="contribution-amount"
                    label={t("worker.contributions.amountKes")}
                    type="number"
                    min="0.01"
                    max="9999999999.99"
                    step="0.01"
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => {
                        setAmount(event.target.value);
                        setFormError("");
                    }}
                    disabled={submitting}
                    required
                />
                <FormField
                    id="contribution-channel"
                    label={t("worker.contributions.intendedChannel")}
                    as="select"
                    options={[
                        { value: "BANK", label: t("worker.contributions.bankTransfer") },
                        { value: "USSD", label: t("worker.contributions.ussd") },
                    ]}
                    value={channel}
                    onChange={(event) => setChannel(event.target.value)}
                    disabled={submitting}
                />

                {formError && <p className="form-error" role="alert">{formError}</p>}

                <div className="form-actions">
                    <Button type="button" variant="secondary" disabled={submitting} onClick={onClose}>
                        {t("worker.contributions.cancel")}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        loading={submitting}
                        disabled={loading || Boolean(error) || eligibleAllocations.length === 0}
                    >
                        {t("worker.contributions.createPending")}
                    </Button>
                </div>
            </form>
        </Modal>
    );
}

export default ContributionModal;
