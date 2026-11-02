import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import ErrorState from "../ui/ErrorState";
import SkeletonLoader from "../ui/SkeletonLoader";

const CATEGORY_KEYS = ["saving", "contributions", "funds", "withdrawals"];

function ArticleLibrary({ articles, loading, error, onRetry }) {
    const { t } = useTranslation();
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState("all");
    const [expandedArticle, setExpandedArticle] = useState(null);

    const localizedArticles = useMemo(() => (articles || []).map((article) => {
        const key = `worker.literacy.articles.${article.id}`;
        return {
            ...article,
            category: t(`${key}.category`, { defaultValue: "other" }),
            title: t(`${key}.title`, { defaultValue: article.title }),
            summary: t(`${key}.summary`, { defaultValue: article.summary }),
            body: t(`${key}.body`, { defaultValue: article.body }),
        };
    }), [articles, t]);
    const filteredArticles = localizedArticles.filter((article) => {
        const matchesCategory = category === "all" || article.category === category;
        const searchableText = `${article.title} ${article.summary} ${article.body}`.toLocaleLowerCase();
        return matchesCategory && searchableText.includes(query.trim().toLocaleLowerCase());
    });

    if (loading) {
        return <SkeletonLoader variant="articles" count={3} label={t("worker.literacy.loadingArticles")} />;
    }

    if (error) {
        return (
            <ErrorState
                message={t("worker.literacy.articleError")}
                title={t("worker.common.unableToLoad")}
                retryLabel={t("worker.common.tryAgain")}
                onRetry={onRetry}
            />
        );
    }

    return (
        <section className="financial-literacy-articles" aria-labelledby="financial-literacy-articles-title">
            <header>
                <h2 id="financial-literacy-articles-title">{t("worker.literacy.articlesTitle")}</h2>
                <p>{t("worker.literacy.articlesSubtitle")}</p>
            </header>
            <div className="financial-literacy-filters">
                <label>
                    <span>{t("worker.literacy.searchLabel")}</span>
                    <input
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("worker.literacy.searchPlaceholder")}
                    />
                </label>
                <label>
                    <span>{t("worker.literacy.categoryLabel")}</span>
                    <select value={category} onChange={(event) => setCategory(event.target.value)}>
                        <option value="all">{t("worker.literacy.allCategories")}</option>
                        {CATEGORY_KEYS.map((key) => (
                            <option value={key} key={key}>{t(`worker.literacy.category${key[0].toUpperCase()}${key.slice(1)}`)}</option>
                        ))}
                    </select>
                </label>
            </div>
            {filteredArticles.length === 0 ? (
                <p className="financial-literacy-empty" role="status">{t("worker.literacy.noArticles")}</p>
            ) : (
                <div className="financial-literacy-article-list">
                    {filteredArticles.map((article) => {
                        const expanded = expandedArticle === article.id;
                        const contentId = `literacy-article-${article.id}`;
                        return (
                            <article className="financial-literacy-article" key={article.id}>
                                <span className="financial-literacy-category">
                                    {t(`worker.literacy.category${article.category[0]?.toUpperCase()}${article.category.slice(1)}`, {
                                        defaultValue: t("worker.literacy.allCategories"),
                                    })}
                                </span>
                                <h3>{article.title}</h3>
                                <p>{article.summary}</p>
                                <button
                                    type="button"
                                    aria-expanded={expanded}
                                    aria-controls={contentId}
                                    onClick={() => setExpandedArticle(expanded ? null : article.id)}
                                >
                                    {expanded ? t("worker.literacy.closeArticle") : t("worker.literacy.readMore")}
                                </button>
                                {expanded && <div id={contentId} className="financial-literacy-article-body"><p>{article.body}</p></div>}
                            </article>
                        );
                    })}
                </div>
            )}
        </section>
    );
}

export default ArticleLibrary;
