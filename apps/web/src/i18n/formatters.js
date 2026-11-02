import i18n from "./index";

function getLocale(language = i18n.resolvedLanguage || i18n.language) {
    return language === "sw" ? "sw-KE" : "en-KE";
}

export function formatKes(value, language) {
    if (value === null || value === undefined || value === "") return null;
    const amount = Number(value);
    if (!Number.isFinite(amount)) return null;
    return `KSh ${new Intl.NumberFormat(getLocale(language), {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(amount)}`;
}

export function formatDate(value, language, options = {}) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(getLocale(language), options).format(date);
}

export function formatDateTime(value, language) {
    return formatDate(value, language, { dateStyle: "medium", timeStyle: "short" });
}

export function formatNumber(value, language, options = {}) {
    if (value === null || value === undefined || value === "") return "";
    const number = Number(value);
    if (!Number.isFinite(number)) return "";
    return new Intl.NumberFormat(getLocale(language), options).format(number);
}
