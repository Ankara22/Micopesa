import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Button from "../ui/Button";
import Card from "../ui/Card";
import { selectFinancialInsights } from "./insightEngine";
import { formatKes } from "../../i18n/formatters";
import "./FinancialInsights.css";

let sessionSnapshot = null;

function FinancialInsights({
    balance,
    contributions,
    plan,
    projection,
    sessionKey,
    loading = false,
    dataReady = !loading,
    dataUnavailable = false,
    error = null,
    layout = "grid",
}) {
    const { t, i18n } = useTranslation();
    const cachedSnapshot = sessionSnapshot?.sessionKey === sessionKey ? sessionSnapshot : null;
    const [refreshIndex, setRefreshIndex] = useState(cachedSnapshot?.refreshIndex || 0);
    const [selection, setSelection] = useState(cachedSnapshot?.selection || null);
    const selectedKeyRef = useRef(cachedSnapshot?.selectionKey || null);
    const selectionKey = `${sessionKey || "worker-session"}:${refreshIndex}`;

    useEffect(() => {
        if (!dataReady || selectedKeyRef.current === selectionKey) return;
        if (dataUnavailable && selection?.sessionKey === sessionKey) {
            selectedKeyRef.current = selectionKey;
            sessionSnapshot = {
                sessionKey,
                refreshIndex,
                selectionKey,
                selection,
            };
            return;
        }

        const insights = selectFinancialInsights(
            { balance, contributions, plan, projection, dataUnavailable },
            selectionKey
        );
        selectedKeyRef.current = selectionKey;
        const nextSelection = { sessionKey, insights, dataUnavailable };
        sessionSnapshot = {
            sessionKey,
            refreshIndex,
            selectionKey,
            selection: nextSelection,
        };
        // Keep this session/refresh snapshot stable across background data refreshes.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSelection(nextSelection);
    }, [
        balance,
        contributions,
        dataReady,
        dataUnavailable,
        plan,
        projection,
        selection,
        selection?.sessionKey,
        selectionKey,
        refreshIndex,
        sessionKey,
    ]);
    const refreshLimited = dataUnavailable
        && selection?.sessionKey === sessionKey
        && !selection.dataUnavailable;

    if (loading) {
        return (
            <section className="worker-dashboard-literacy" aria-labelledby="worker-insights-title">
                <div className="worker-dashboard-section-heading">
                    <div>
                        <p className="worker-dashboard-label">{t("worker.literacy.insightLabel")}</p>
                        <h2 id="worker-insights-title">{t("worker.literacy.insightTitle")}</h2>
                    </div>
                </div>
                <p role="status">{t("worker.literacy.loadingInsights")}</p>
            </section>
        );
    }

    if (error) {
        return (
            <section className="worker-dashboard-literacy" aria-labelledby="worker-insights-title">
                <div className="worker-dashboard-section-heading">
                    <div>
                        <p className="worker-dashboard-label">{t("worker.literacy.insightLabel")}</p>
                        <h2 id="worker-insights-title">{t("worker.literacy.insightTitle")}</h2>
                    </div>
                </div>
                <p role="alert">{t("worker.literacy.insightsError")}</p>
            </section>
        );
    }

    const insights = selection?.sessionKey === sessionKey ? selection.insights : null;

    return (
        <section className="worker-dashboard-literacy" aria-labelledby="worker-insights-title">
            <div className="worker-dashboard-section-heading">
                <div>
                    <p className="worker-dashboard-label">{t("worker.literacy.insightLabel")}</p>
                    <h2 id="worker-insights-title">{t("worker.literacy.insightTitle")}</h2>
                </div>
                <Button
                    variant="secondary"
                    onClick={() => setRefreshIndex((index) => index + 1)}
                    aria-label={t("worker.literacy.refreshAria")}
                >
                    {t("worker.literacy.refreshInsights")}
                </Button>
            </div>
            <p className="worker-dashboard-insight-note">
                {t("worker.literacy.insightNote")}
            </p>
            {dataUnavailable && (
                <p className="worker-dashboard-insight-note" role="status">
                    {t("worker.literacy.dataUnavailable")}
                </p>
            )}
            {refreshLimited && (
                <p className="worker-dashboard-insight-note" role="status">
                    {t("worker.literacy.keptInsights")}
                </p>
            )}
            {!insights ? (
                <p role="status">{t("worker.literacy.preparingInsights")}</p>
            ) : insights.length === 0 ? (
                <p className="worker-dashboard-supporting">{t("worker.literacy.noInsights")}</p>
            ) : (
                <div className={`worker-dashboard-insight-grid${layout === "stacked" ? " is-stacked" : ""}`} aria-live="polite">
                    {insights.map((insight) => (
                        <Card
                            key={insight.id}
                            title={t(`worker.literacy.insights.${insight.id}.title`, { defaultValue: insight.title })}
                            className="worker-dashboard-insight-card"
                        >
                            <p>{t(`worker.literacy.insights.${insight.id}.explanation`, {
                                ...insight.translationValues,
                                amount: formatKes(insight.translationValues?.amount, i18n.language),
                                target: formatKes(insight.translationValues?.target, i18n.language),
                                projected: formatKes(insight.translationValues?.projected, i18n.language),
                                defaultValue: insight.explanation,
                            })}</p>
                            {insight.nextStep && (
                                <p className="worker-dashboard-insight-next">
                                    {t(`worker.literacy.insights.${insight.id}.nextStep`, { defaultValue: insight.nextStep })}
                                </p>
                            )}
                        </Card>
                    ))}
                </div>
            )}
        </section>
    );
}

export default FinancialInsights;
