import { useTranslation } from "react-i18next";
import LanguageSwitcher from "../../components/LanguageSwitcher";

function AuthLayout({ children }) {
    const { t } = useTranslation();

    return (
        <main className="auth-page">
            <div className="auth-decoration" aria-hidden="true" />
            <LanguageSwitcher className="auth-language-switcher" />
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
                        <p className="auth-eyebrow">{t("auth.layout.eyebrow")}</p>
                        <h2>{t("auth.layout.headline")}</h2>
                        <p>
                            {t("auth.layout.description")}
                        </p>
                    </div>
                    <p className="auth-intro-footnote">
                        {t("auth.layout.footnote")}
                    </p>
                </aside>
                <section className="auth-panel" aria-label={t("auth.layout.accountAccess")}>
                    {children}
                </section>
            </div>
        </main>
    );
}

export default AuthLayout;
