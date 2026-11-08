function normalizeKenyanPhone(value) {
    if (typeof value !== "string") return null;
    const compact = value.trim().replace(/[\s()-]/g, "");
    if (/^0[17]\d{8}$/.test(compact)) return `+254${compact.slice(1)}`;
    if (/^\+?254[17]\d{8}$/.test(compact)) return `+${compact.replace(/^\+/, "")}`;
    return null;
}

function normalizedPhoneSql(column) {
    const compact = `regexp_replace(COALESCE(${column}, ''), '[[:space:]()-]', '', 'g')`;
    return `CASE
        WHEN ${compact} ~ '^0[17][0-9]{8}$' THEN '+254' || substring(${compact} from 2)
        WHEN ${compact} ~ '^[+]?254[17][0-9]{8}$' THEN '+' || regexp_replace(${compact}, '^[+]', '')
        ELSE NULLIF(${compact}, '')
    END`;
}

const NORMALIZED_PHONE_SQL = normalizedPhoneSql("phone");

module.exports = { normalizeKenyanPhone, normalizedPhoneSql, NORMALIZED_PHONE_SQL };
