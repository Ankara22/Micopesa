function AuthLayout({ children }) {
    return (
        <main className="auth-page">
            <div className="auth-decoration" aria-hidden="true" />
            <div className="auth-shell">
                <aside className="auth-intro">
                    <div className="auth-brand" aria-label="MicoPesa">
                        <span className="auth-brand-mark" aria-hidden="true">
                            <svg viewBox="0 0 32 32" focusable="false">
                                <path d="M7 23V9l9 8 9-8v14" />
                                <path d="M12 23v-5m8 5v-5" />
                            </svg>
                        </span>
                        <span>MicoPesa</span>
                    </div>
                    <div className="auth-intro-copy">
                        <p className="auth-eyebrow">Micro-pension account</p>
                        <h2>Make room for your future.</h2>
                        <p>
                            Sign in to manage your MicoPesa account, or register to
                            get started with your micro-pension journey.
                        </p>
                    </div>
                    <p className="auth-intro-footnote">
                        A clear view of your account, contributions and retirement plan.
                    </p>
                </aside>
                <section className="auth-panel" aria-label="Account access">
                    {children}
                </section>
            </div>
        </main>
    );
}

export default AuthLayout;
