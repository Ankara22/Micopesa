const MAX_AMOUNT_CENTS = 999999999999n;

export function isValidMoneyInput(value, { allowZero = false } = {}) {
    if (typeof value !== "string") return false;
    const text = value.trim();
    if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) return false;

    const [whole, fraction = ""] = text.split(".");
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    return cents <= MAX_AMOUNT_CENTS && (allowZero ? cents >= 0n : cents > 0n);
}
