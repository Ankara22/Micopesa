import { useTranslation } from "react-i18next";
import LanguageSwitcher from "../../components/LanguageSwitcher";

function AuthLayout({ children, variant = "default" }) {
    const { t } = useTranslation();
    const referenceImage = variant === "register"
        ? "/images/micopesa-signup-reference-hd.png"
        : "/images/micopesa-login-reference-hd.png";
    const usesReferenceImage = variant === "login" || variant === "register";

    return (
        <main className={`auth-page auth-page--${variant}`}>
            <div className="auth-decoration" aria-hidden="true" />
            <LanguageSwitcher className="auth-language-switcher" />
            <div className={`auth-shell auth-shell--${variant}`}>
                {usesReferenceImage ? (
                    <>
                        <div className="auth-art" aria-hidden="true">
                            <img src={referenceImage} alt="" />
                        </div>
                        <div className="auth-intro" aria-hidden="true" />
                    </>
                ) : (
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
                            <p>{t("auth.layout.description")}</p>
                        </div>
                        <p className="auth-intro-footnote">{t("auth.layout.footnote")}</p>
                    </aside>
                )}
                <section
                    className={`auth-panel auth-panel--${variant}`}
                    aria-label={t("auth.layout.accountAccess")}
                >
                    {children}
                </section>
            </div>
        </main>
    );
}

export default AuthLayout;
