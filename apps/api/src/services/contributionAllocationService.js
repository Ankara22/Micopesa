function parseAmountCents(amount) {
    const text = typeof amount === "number" ? String(amount) : typeof amount === "string" ? amount.trim() : "";
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
    const [whole, fraction = ""] = text.split(".");
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    if (cents <= 0n || cents > 999999999999n) return null;
    return { text, cents };
}

function parsePercentageHundredths(value) {
    const text = String(value ?? "").trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
    const [whole, fraction = ""] = text.split(".");
    const hundredths = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    return Number.isSafeInteger(hundredths) && hundredths > 0 && hundredths <= 10000
        ? hundredths
        : null;
}

function distributeContributionAmount(amountCents, allocations) {
    const weighted = allocations.map((allocation) => {
        const weight = parsePercentageHundredths(allocation.percentage);
        if (weight === null) throw new Error("Stored fund allocation percentage is invalid");
        return { ...allocation, weight: BigInt(weight) };
    }).sort((left, right) => left.fund_id.localeCompare(right.fund_id));
    const totalWeight = weighted.reduce((sum, allocation) => sum + allocation.weight, 0n);
    if (totalWeight <= 0n) throw new Error("No positive fund allocation weights were found");

    let allocatedCents = 0n;
    const shares = weighted.map((allocation) => {
        const numerator = amountCents * allocation.weight;
        const shareCents = numerator / totalWeight;
        allocatedCents += shareCents;
        return {
            ...allocation,
            shareCents,
            remainder: numerator % totalWeight,
        };
    });

    let remainingCents = amountCents - allocatedCents;
    const byLargestRemainder = [...shares].sort((left, right) => {
        if (left.remainder > right.remainder) return -1;
        if (left.remainder < right.remainder) return 1;
        return left.fund_id.localeCompare(right.fund_id);
    });
    for (let index = 0; remainingCents > 0n; index += 1, remainingCents -= 1n) {
        byLargestRemainder[index % byLargestRemainder.length].shareCents += 1n;
    }

    let percentagesUsed = 0;
    return shares.map((allocation, index) => {
        const percentage = index === shares.length - 1
            ? Number((100 - percentagesUsed).toFixed(10))
            : Number(((Number(allocation.weight) / Number(totalWeight)) * 100).toFixed(10));
        percentagesUsed += percentage;
        const cents = allocation.shareCents.toString().padStart(3, "0");
        return {
            allocation_id: allocation.allocation_id,
            fund_id: allocation.fund_id,
            fund_name: allocation.fund_name,
            allocation_percentage: percentage.toFixed(10),
            allocated_amount: `${cents.slice(0, -2)}.${cents.slice(-2)}`,
        };
    });
}

module.exports = {
    distributeContributionAmount,
    parseAmountCents,
    parsePercentageHundredths,
};
