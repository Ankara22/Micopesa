import "./ui.css";

function SkeletonLoader({ variant = "metrics", count = 4, label = "Loading content" }) {
    if (variant === "chart") {
        return (
            <div className="skeleton-chart" role="status" aria-label={label}>
                <span className="skeleton-shimmer" />
            </div>
        );
    }

    return (
        <div className={`skeleton-grid skeleton-${variant}`} role="status" aria-label={label}>
            {Array.from({ length: count }, (_, index) => (
                <div className="skeleton-card" key={index}>
                    <span className="skeleton-shimmer skeleton-label" />
                    <span className="skeleton-shimmer skeleton-value" />
                    <span className="skeleton-shimmer skeleton-hint" />
                </div>
            ))}
        </div>
    );
}

export default SkeletonLoader;
