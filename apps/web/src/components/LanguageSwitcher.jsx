import { useTranslation } from "react-i18next";
import { SUPPORTED_LANGUAGES } from "../i18n";
import "./language-switcher.css";

function LanguageSwitcher({ className = "" }) {
    const { i18n, t } = useTranslation();
    const language = SUPPORTED_LANGUAGES.includes(i18n.resolvedLanguage)
        ? i18n.resolvedLanguage
        : "en";

    return (
        <label className={`language-switcher ${className}`.trim()}>
            <span className="language-switcher-label">{t("language.label")}</span>
            <select
                value={language}
                onChange={(event) => i18n.changeLanguage(event.target.value)}
                aria-label={t("language.label")}
            >
                <option value="en">{t("language.english")}</option>
                <option value="sw">{t("language.swahili")}</option>
            </select>
        </label>
    );
}

export default LanguageSwitcher;
