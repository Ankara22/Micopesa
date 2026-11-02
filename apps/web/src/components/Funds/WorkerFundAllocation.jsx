import { useState } from "react";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import { useAuth } from "../../context/AuthContext";
import {
    getMyAllocations,
    listAvailableFunds,
    replaceMyAllocations,
} from "../../services/fundService";
import ErrorState from "../ui/ErrorState";
import LoadingState from "../ui/LoadingState";
import SkeletonLoader from "../ui/SkeletonLoader";
import StatusBadge from "../ui/StatusBadge";
import Button from "../ui/Button";
import { formatNumber } from "../../i18n/formatters";
import "./worker-fund-allocation.css";

function parsePercentageCents(value) {
    if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
    const [whole, fraction = ""] = value.trim().split(".");
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    return Number.isSafeInteger(cents) && cents > 0 && cents <= 10000 ? cents : null;
}

function validateDraft(draft, t, language) {
    if (draft.length === 0) return t("worker.funds.selectFundError");
    if (draft.some(({ allocation_percentage }) => parsePercentageCents(allocation_percentage) === null)) {
        return t("worker.funds.percentageError");
    }

    const total = draft.reduce(
        (sum, allocation) => sum + parsePercentageCents(allocation.allocation_percentage),
        0
    );
    if (total < 10000) {
        return t("worker.funds.underTotal", {
            total: formatNumber(total / 100, language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
            difference: formatNumber((10000 - total) / 100, language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        });
    }
    if (total > 10000) {
        return t("worker.funds.overTotal", {
            total: formatNumber(total / 100, language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
            difference: formatNumber((total - 10000) / 100, language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        });
    }
    return "";
}

function WorkerFundAllocation() {
    const { t, i18n } = useTranslation();
    const { loginSessionId } = useAuth();
    const fundsApi = useApi(listAvailableFunds, [loginSessionId]);
    const allocationsApi = useApi(getMyAllocations, [loginSessionId]);
    const [draft, setDraft] = useState(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState("");
    const [saveSuccess, setSaveSuccess] = useState("");
    const availableFunds = fundsApi.data || [];
    const currentAllocations = allocationsApi.data || [];
    const isInitialLoading =
        (fundsApi.loading && fundsApi.data === null) ||
        (allocationsApi.loading && allocationsApi.data === null);

    const initialDraft = fundsApi.data && allocationsApi.data
        ? currentAllocations
            .filter((allocation) => availableFunds.some((fund) => fund.fund_id === allocation.fund_id))
            .map((allocation) => ({
                fund_id: allocation.fund_id,
                allocation_percentage: String(allocation.allocation_percentage),
            }))
        : [];
    const selectedAllocations = draft ?? initialDraft;
    const validationMessage = validateDraft(selectedAllocations, t, i18n.language);
    const formatPercentage = (value) => formatNumber(value, i18n.language, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
    const totalCents = selectedAllocations.reduce(
        (sum, allocation) => sum + (parsePercentageCents(allocation.allocation_percentage) || 0),
        0
    );
    const remainingCents = 10000 - totalCents;
    const unavailableExistingAllocations = currentAllocations.filter(
        (allocation) => !availableFunds.some((fund) => fund.fund_id === allocation.fund_id)
    );

    function updateDraft(nextDraft) {
        setDraft(nextDraft);
        setSaveError("");
        setSaveSuccess("");
    }

    function toggleFund(fundId, checked) {
        const nextDraft = selectedAllocations.filter((allocation) => allocation.fund_id !== fundId);
        if (checked) nextDraft.push({ fund_id: fundId, allocation_percentage: "" });
        updateDraft(nextDraft);
    }

    function updatePercentage(fundId, value) {
        updateDraft(selectedAllocations.map((allocation) => allocation.fund_id === fundId
            ? { ...allocation, allocation_percentage: value }
            : allocation));
    }

    async function handleSubmit(event) {
        event.preventDefault();
        if (saving || validationMessage || isInitialLoading) return;
        setSaving(true);
        setSaveError("");
        setSaveSuccess("");
        try {
            await replaceMyAllocations(selectedAllocations.map(({ fund_id, allocation_percentage }) => ({
                fund_id,
                allocation_percentage,
            })));
            setDraft(selectedAllocations);
            const refreshed = await allocationsApi.refetch();
            if (refreshed === null) {
                setSaveError(t("worker.funds.savedButRefreshFailed"));
                return;
            }
            setDraft(null);
            setSaveSuccess(t("worker.funds.saved"));
        } catch {
            setSaveError(t("worker.funds.saveError"));
        } finally {
            setSaving(false);
        }
    }

    return (
        <section className="worker-fund-allocation" aria-labelledby="worker-fund-allocation-title">
            <div className="worker-fund-allocation-heading">
                <div>
                    <p className="worker-dashboard-label">{t("worker.funds.preference")}</p>
                    <h2 id="worker-fund-allocation-title">{t("worker.funds.allocationTitle")}</h2>
                </div>
                {(fundsApi.refreshing || allocationsApi.refreshing) && (
                    <LoadingState message={t("worker.common.refreshingRecords")} />
                )}
            </div>
            <p className="worker-dashboard-supporting">{t("worker.funds.description")}</p>
            <p className="worker-fund-allocation-note">{t("worker.funds.historyNote")}</p>

            {isInitialLoading ? (
                <SkeletonLoader variant="articles" count={2} label={t("worker.funds.loading")} />
            ) : (
                <>
                    {fundsApi.error && (
                        <ErrorState message={t("worker.common.errors.load")} title={t("worker.common.unableToLoad")} retryLabel={t("worker.common.tryAgain")} onRetry={fundsApi.refetch} />
                    )}
                    {allocationsApi.error && (
                        <ErrorState message={t("worker.common.errors.load")} title={t("worker.common.unableToLoad")} retryLabel={t("worker.common.tryAgain")} onRetry={allocationsApi.refetch} />
                    )}

                    {!fundsApi.error && !allocationsApi.error && (
                        <>
                            {currentAllocations.length === 0 ? (
                                <p className="worker-fund-allocation-empty">
                                    {t("worker.funds.noneSet")}
                                </p>
                            ) : (
                                <div className="worker-current-allocation">
                                    <h3>{t("worker.funds.currentDistribution")}</h3>
                                    <ul>
                                        {currentAllocations.map((allocation) => (
                                            <li key={allocation.allocation_id}>
                                                <span>{allocation.fund_name}</span>
                                                <strong>{formatPercentage(allocation.allocation_percentage)}%</strong>
                                                <StatusBadge status={allocation.fund_status} label={t(`worker.common.statuses.${allocation.fund_status}`, { defaultValue: allocation.fund_status })} />
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {availableFunds.length === 0 ? (
                                <p className="worker-fund-allocation-empty">
                                    {t("worker.funds.noActiveFunds")}
                                </p>
                            ) : (
                                <form onSubmit={handleSubmit} noValidate>
                                    <fieldset className="worker-fund-allocation-options" disabled={saving}>
                                        <legend>{t("worker.funds.chooseFunds")}</legend>
                                        {availableFunds.map((fund) => {
                                            const selected = selectedAllocations.some(
                                                (allocation) => allocation.fund_id === fund.fund_id
                                            );
                                            const value = selectedAllocations.find(
                                                (allocation) => allocation.fund_id === fund.fund_id
                                            )?.allocation_percentage ?? "";
                                            const inputId = `allocation-${fund.fund_id}`;
                                            return (
                                                <div className="worker-fund-allocation-option" key={fund.fund_id}>
                                                    <label htmlFor={`select-${fund.fund_id}`}>
                                                        <input
                                                            id={`select-${fund.fund_id}`}
                                                            type="checkbox"
                                                            checked={selected}
                                                            onChange={(event) => toggleFund(fund.fund_id, event.target.checked)}
                                                        />
                                                        <span>
                                                            <strong>{fund.fund_name}</strong>
                                                            <small>
                                                                {t("worker.funds.risk", {
                                                                    level: t(`worker.funds.riskLevels.${String(fund.risk_level || "").toLowerCase()}`, {
                                                                        defaultValue: fund.risk_level || "",
                                                                    }),
                                                                })} · {fund.administrator_name}
                                                                {" · "}{t("worker.funds.expectedReturn", { percent: formatPercentage(fund.expected_return) })}
                                                            </small>
                                                        </span>
                                                    </label>
                                                    {selected && (
                                                        <div className="worker-fund-allocation-input">
                                                            <label htmlFor={inputId}>{t("worker.funds.allocationPercentage")}</label>
                                                            <div>
                                                                <input
                                                                    id={inputId}
                                                                    inputMode="decimal"
                                                                    type="number"
                                                                    min="0.01"
                                                                    max="100"
                                                                    step="0.01"
                                                                    value={value}
                                                                    onChange={(event) => updatePercentage(fund.fund_id, event.target.value)}
                                                                    required
                                                                />
                                                                <span>%</span>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </fieldset>

                                    <div className="worker-fund-allocation-total" aria-live="polite">
                                        <span>{t("worker.funds.currentTotal")} <strong>{formatPercentage(totalCents / 100)}%</strong></span>
                                        <span>
                                            {remainingCents >= 0 ? t("worker.funds.remaining") : t("worker.funds.overBy")}
                                            : <strong>{formatPercentage(Math.abs(remainingCents) / 100)}%</strong>
                                        </span>
                                    </div>
                                    {validationMessage && <p className="worker-fund-allocation-validation" role="alert">{validationMessage}</p>}
                                    {saveError && <p className="worker-fund-allocation-error" role="alert">{saveError}</p>}
                                    {saveSuccess && <p className="worker-fund-allocation-success" role="status">{saveSuccess}</p>}
                                    {unavailableExistingAllocations.length > 0 && (
                                        <p className="worker-fund-allocation-note">
                                            {t("worker.funds.inactiveNote")}
                                        </p>
                                    )}
                                    <Button type="submit" variant="primary" loading={saving} disabled={saving || Boolean(validationMessage)}>
                                        {t("worker.funds.save")}
                                    </Button>
                                </form>
                            )}
                        </>
                    )}
                </>
            )}
        </section>
    );
}

export default WorkerFundAllocation;
