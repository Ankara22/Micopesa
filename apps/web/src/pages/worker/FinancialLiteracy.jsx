import useApi from "../../hooks/useApi";
import { getArticles } from "../../services/literacyService";
import LoadingState from "../../components/ui/LoadingState";
import ErrorState from "../../components/ui/ErrorState";
import Card from "../../components/ui/Card";

function FinancialLiteracy() {
    const articlesApi = useApi(getArticles, []);

    if (articlesApi.loading) return <LoadingState message="Loading articles..." />;
    if (articlesApi.error) return <ErrorState message={articlesApi.error} onRetry={articlesApi.refetch} />;

    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Financial Literacy</h1>
                    <p className="page-subtitle">Tips and guidance to help you save smarter for retirement.</p>
                </div>
            </div>

            <div className="form-grid">
                {(articlesApi.data || []).map((article) => (
                    <Card key={article.id} title={article.title}>
                        <p style={{ fontWeight: 600, marginTop: 0 }}>{article.summary}</p>
                        <p style={{ margin: 0 }}>{article.body}</p>
                    </Card>
                ))}
            </div>
        </div>
    );
}

export default FinancialLiteracy;
