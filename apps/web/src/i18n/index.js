import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import sw from "./locales/sw.json";

export const SUPPORTED_LANGUAGES = ["en", "sw"];
export const LANGUAGE_STORAGE_KEY = "micopesa.language";

export function getStoredLanguage() {
    try {
        const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
        return SUPPORTED_LANGUAGES.includes(stored) ? stored : "en";
    } catch (error) {
        console.warn("Unable to read the saved interface language:", error.name || "STORAGE_ERROR");
        return "en";
    }
}

function persistLanguage(language) {
    document.documentElement.lang = language;
    try {
        window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch (error) {
        console.warn("Unable to save the interface language:", error.name || "STORAGE_ERROR");
    }
}

export function getLocalizationOptions() {
    return {
        resources: {
            en: { translation: JSON.parse(JSON.stringify(en)) },
            sw: { translation: JSON.parse(JSON.stringify(sw)) },
        },
        lng: getStoredLanguage(),
        fallbackLng: "en",
        supportedLngs: SUPPORTED_LANGUAGES,
        defaultNS: "translation",
        interpolation: { escapeValue: false },
        returnNull: false,
        react: { useSuspense: false },
    };
}

if (!i18n.isInitialized) {
    i18n.use(initReactI18next).init(getLocalizationOptions());
    i18n.on("languageChanged", persistLanguage);
}

document.documentElement.lang = i18n.language || "en";

export default i18n;
