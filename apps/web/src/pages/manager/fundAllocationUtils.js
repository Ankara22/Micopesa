function parseDate(value) {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(String(value));
    if (!match) return null;
    const [, year, month, day] = match.map(Number);
    const timestamp = Date.UTC(year, month - 1, day);
    const date = new Date(timestamp);
    return date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
        ? date
        : null;
}

function parsePercentage(value) {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const percentage = Number(value);
    return Number.isFinite(percentage) && percentage > 0 && percentage <= 100
        ? percentage
        : null;
}

export function getAllocationTrend(allocationEntries, asOf = new Date()) {
    if (!Array.isArray(allocationEntries)) return [];
    const currentMonth = new Date(Date.UTC(asOf.getFullYear(), asOf.getMonth(), 1));
    const asOfExclusive = Date.UTC(asOf.getFullYear(), asOf.getMonth(), asOf.getDate() + 1);
    const months = Array.from({ length: 12 }, (_, index) => {
        const date = new Date(Date.UTC(
            currentMonth.getUTCFullYear(),
            currentMonth.getUTCMonth() - 11 + index,
            1
        ));
        return {
            date,
            key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`,
            month: date.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" }),
        };
    });
    const series = months.map(({ date, key, month }) => {
        const point = { month, key };
        allocationEntries.forEach((entry) => {
            const fund = entry?.fund;
            if (!fund?.fund_id) return;
            const allocations = Array.isArray(entry.allocations) ? entry.allocations : [];
            const dataKey = `fund_${fund.fund_id}`;
            const monthEndExclusive = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
            const effectiveWindowEnd = Math.min(monthEndExclusive, asOfExclusive);
            const percentagePoints = allocations.reduce((total, allocation) => {
                const starts = parseDate(allocation.effective_from);
                const ends = allocation.effective_to ? parseDate(allocation.effective_to) : null;
                const percentage = parsePercentage(allocation.percentage);
                const isValid = starts &&
                    (!allocation.effective_to || ends) &&
                    percentage !== null;
                const overlapsMonth = isValid &&
                    starts.getTime() < effectiveWindowEnd &&
                    (!ends || ends >= date);
                return overlapsMonth ? total + percentage : total;
            }, 0);
            point[dataKey] = (point[dataKey] || 0) + percentagePoints;
        });
        return point;
    });

    return series.some((point) => Object.keys(point)
        .some((key) => key.startsWith("fund_") && point[key] > 0))
        ? series
        : [];
}

export function getCurrentAllocationBreakdown(funds, allocationEntries, asOf = new Date()) {
    const currentDate = Date.UTC(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
    const fundTotals = (Array.isArray(funds) ? funds : []).map((fund) => {
        const entry = (Array.isArray(allocationEntries) ? allocationEntries : [])
            .find((item) => String(item?.fund?.fund_id) === String(fund.fund_id));
        const allocations = Array.isArray(entry?.allocations) ? entry.allocations : [];
        const percentagePoints = allocations.reduce((total, allocation) => {
            const starts = parseDate(allocation.effective_from);
            const ends = allocation.effective_to ? parseDate(allocation.effective_to) : null;
            const percentage = parsePercentage(allocation.percentage);
            const current = starts &&
                starts.getTime() <= currentDate &&
                (!allocation.effective_to || (ends && ends.getTime() >= currentDate));
            return current && percentage !== null ? total + percentage : total;
        }, 0);

        return { fund_id: fund.fund_id, fund_name: fund.fund_name, percentagePoints };
    });
    const totalPercentagePoints = fundTotals.reduce((total, item) => total + item.percentagePoints, 0);

    return fundTotals.map((item) => ({
        ...item,
        allocationShare: totalPercentagePoints > 0
            ? (item.percentagePoints / totalPercentagePoints) * 100
            : 0,
    }));
}
