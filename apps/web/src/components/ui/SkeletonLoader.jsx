import "./ui.css";

function SkeletonLoader({ variant = "metrics", count = 4, label = "Loading content" }) {
    if (variant === "chart") {
        return (
            <div className="skeleton-chart" role="status" aria-label={label} aria-live="polite">
                <span className="skeleton-shimmer" aria-hidden="true" />
            </div>
        );
    }

    if (variant === "table") {
        return (
            <div className="skeleton-table" role="status" aria-label={label} aria-live="polite">
                {Array.from({ length: count }, (_, index) => (
                    <span className="skeleton-shimmer skeleton-table-row" key={index} aria-hidden="true" />
                ))}
            </div>
        );
    }

    if (variant === "articles") {
        return (
            <div className="skeleton-articles" role="status" aria-label={label} aria-live="polite">
                {Array.from({ length: count }, (_, index) => (
                    <div className="skeleton-article" key={index} aria-hidden="true">
                        <span className="skeleton-shimmer skeleton-article-title" />
                        <span className="skeleton-shimmer skeleton-article-line" />
                        <span className="skeleton-shimmer skeleton-article-line" />
                        <span className="skeleton-shimmer skeleton-article-line skeleton-article-line-short" />
                    </div>
                ))}
            </div>
        );
    }

    if (variant === "form") {
        return (
            <div className="skeleton-form" role="status" aria-label={label} aria-live="polite">
                {Array.from({ length: count }, (_, index) => (
                    <div className="skeleton-form-field" key={index} aria-hidden="true">
                        <span className="skeleton-shimmer skeleton-form-label" />
                        <span className="skeleton-shimmer skeleton-form-control" />
                    </div>
                ))}
                <span className="skeleton-shimmer skeleton-form-action" aria-hidden="true" />
            </div>
        );
    }

    if (variant === "profile") {
        return (
            <div className="skeleton-profile" role="status" aria-label={label} aria-live="polite">
                <span className="skeleton-shimmer skeleton-profile-avatar" aria-hidden="true" />
                <div className="skeleton-profile-fields" aria-hidden="true">
                    {Array.from({ length: 4 }, (_, index) => (
                        <span className="skeleton-shimmer skeleton-profile-field" key={index} />
                    ))}
                </div>
            </div>
        );
    }

    if (variant === "dashboard") {
        return (
            <div className="skeleton-dashboard" role="status" aria-label={label} aria-live="polite">
                <div className="skeleton-grid skeleton-metrics" aria-hidden="true">
                    {Array.from({ length: count }, (_, index) => (
                        <SkeletonCard key={index} />
                    ))}
                </div>
                <div className="skeleton-dashboard-sections" aria-hidden="true">
                    <span className="skeleton-shimmer skeleton-section-block" />
                    <span className="skeleton-shimmer skeleton-section-block" />
                </div>
            </div>
        );
    }

    return (
        <div className={`skeleton-grid skeleton-${variant}`} role="status" aria-label={label} aria-live="polite">
            {Array.from({ length: count }, (_, index) => (
                <SkeletonCard key={index} />
            ))}
        </div>
    );
}

function SkeletonCard() {
    return (
        <div className="skeleton-card">
            <span className="skeleton-shimmer skeleton-label" />
            <span className="skeleton-shimmer skeleton-value" />
            <span className="skeleton-shimmer skeleton-hint" />
        </div>
    );
}

export default SkeletonLoader;
