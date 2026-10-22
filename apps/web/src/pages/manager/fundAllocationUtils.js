function parseDate(value) {
    if (!value) return null;
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
}

export function getCurrentAllocationBreakdown(funds, allocationEntries, asOf = new Date()) {
    const currentDate = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
    const fundTotals = funds.map((fund) => {
        const entry = allocationEntries.find((item) => String(item.fund.fund_id) === String(fund.fund_id));
        const percentagePoints = (entry?.allocations || []).reduce((total, allocation) => {
            const starts = parseDate(allocation.effective_from);
            const ends = allocation.effective_to ? parseDate(allocation.effective_to) : null;
            const percentage = Number(allocation.percentage);
            const current = starts && starts <= currentDate && (!allocation.effective_to || (ends && ends >= currentDate));
            return current && Number.isFinite(percentage) && percentage > 0 ? total + percentage : total;
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
