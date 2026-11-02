import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../context/AuthContext";
import useApi from "../../hooks/useApi";
import { getMyBalance, getMyContributions } from "../../services/accountService";
import { getRetirementPlan } from "../../services/retirementApi";
import { getArticles } from "../../services/literacyService";
import FinancialInsights from "../../components/FinancialLiteracy/FinancialInsights";
import ArticleLibrary from "../../components/FinancialLiteracy/ArticleLibrary";
import "./financial-literacy.css";

function FinancialLiteracy() {
    const { t } = useTranslation();
    const { loginSessionId } = useAuth();
    const balanceApi = useApi(getMyBalance, [loginSessionId]);
    const contributionsApi = useApi(getMyContributions, [loginSessionId]);
    const fetchPlan = useCallback(
        () => getRetirementPlan().catch((err) => {
            if (err.status === 404) return null;
            throw err;
        }),
        []
    );
    const planApi = useApi(fetchPlan, [loginSessionId]);
    const articlesApi = useApi(getArticles, [loginSessionId]);
    const insightsLoading = (
        (balanceApi.loading && balanceApi.data === null) ||
        (contributionsApi.loading && contributionsApi.data === null) ||
        (planApi.loading && planApi.data === null)
    );
    const plan = planApi.data?.plan;

    return (
        <div className="financial-literacy-page">
            <div className="page-header">
                <div>
                    <h1 className="page-title">{t("worker.literacy.title")}</h1>
                    <p className="page-subtitle">{t("worker.literacy.subtitle")}</p>
                </div>
            </div>

            <ArticleLibrary
                articles={articlesApi.data}
                loading={articlesApi.loading && articlesApi.data === null}
                error={Boolean(articlesApi.error && articlesApi.data === null)}
                onRetry={articlesApi.refetch}
            />

            <FinancialInsights
                key={loginSessionId}
                sessionKey={loginSessionId}
                balance={balanceApi.data}
                contributions={contributionsApi.data}
                plan={plan}
                projection={planApi.data?.projection}
                dataReady={!insightsLoading}
                loading={insightsLoading}
                dataUnavailable={Boolean(balanceApi.error || contributionsApi.error || planApi.error)}
                layout="stacked"
            />
        </div>
    );
}

export default FinancialLiteracy;
