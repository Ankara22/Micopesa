export function normalizeKenyanPhone(value) {
    if (typeof value !== "string") return null;
    const compact = value.trim().replace(/[\s()-]/g, "");
    if (/^0[17]\d{8}$/.test(compact)) return `+254${compact.slice(1)}`;
    if (/^\+?254[17]\d{8}$/.test(compact)) return `+${compact.replace(/^\+/, "")}`;
    return null;
}
