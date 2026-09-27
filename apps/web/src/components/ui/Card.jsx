import "./ui.css";

function Card({ title, children, className = "" }) {
    return (
        <div className={`card ${className}`.trim()}>
            {title && <h2 className="card-title">{title}</h2>}
            {children}
        </div>
    );
}

/** A single dashboard metric tile. Use inside a .stat-card-grid wrapper. */
function StatCard({ label, value, hint }) {
    return (
        <div className="stat-card">
            <span className="stat-card-label">{label}</span>
            <span className="stat-card-value">{value}</span>
            {hint && <span className="stat-card-hint">{hint}</span>}
        </div>
    );
}

export default Card;
export { StatCard };
