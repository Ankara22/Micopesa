import "./admin-page.css";

export function AdminPage({ title, subtitle, actions, children }) {
    return (
        <div className="admin-page">
            <header className="admin-page-header">
                <div>
                    <h1 className="admin-page-title">{title}</h1>
                    <p className="admin-page-subtitle">{subtitle}</p>
                </div>
                {actions && <div className="admin-page-actions">{actions}</div>}
            </header>
            {children}
        </div>
    );
}

export function AdminCard({ title, description, actions, className = "", children }) {
    return (
        <section className={`admin-card ${className}`.trim()}>
            {(title || description || actions) && (
                <div className="admin-card-header">
                    <div>
                        {title && <h2 className="admin-card-title">{title}</h2>}
                        {description && <p className="admin-card-description">{description}</p>}
                    </div>
                    {actions && <div className="admin-card-actions">{actions}</div>}
                </div>
            )}
            {children}
        </section>
    );
}
