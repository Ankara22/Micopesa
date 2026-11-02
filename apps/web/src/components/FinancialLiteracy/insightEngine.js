const INSIGHT_COUNT = 3;

function formatCurrency(value) {
    return `KSh ${value.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })}`;
}

function getCompletedContributions(contributions) {
    if (!Array.isArray(contributions)) return [];
    return contributions.filter((contribution) => {
        const amount = Number(contribution?.amount);
        return contribution?.contribution_status === "COMPLETED" &&
            contribution?.transaction_status === "COMPLETED" &&
            Number.isFinite(amount) && amount > 0;
    });
}

function hashSeed(seed) {
    let hash = 0;
    for (const character of String(seed || "")) {
        hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
    }
    return Math.abs(hash);
}

function buildInsights({ balance, contributions, plan, projection, dataUnavailable = false }) {
    const insights = [];
    const completed = getCompletedContributions(contributions);
    const totalContributed = completed.reduce((total, item) => total + Number(item.amount), 0);

    if (completed.length > 0) {
        insights.push({
            id: "recorded-contributions",
            title: "Your recorded contributions",
            explanation: `${completed.length} completed contribution${completed.length === 1 ? "" : "s"} total ${formatCurrency(totalContributed)} in your account history.`,
            nextStep: "Review your contribution history to see how your savings have built over time.",
            translationValues: { count: completed.length, amount: totalContributed },
        });

        const months = new Set(
            completed
                .map((item) => {
                    const date = new Date(item.created_at);
                    return Number.isNaN(date.getTime())
                        ? null
                        : `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
                })
                .filter(Boolean)
        );
        if (months.size > 1) {
            insights.push({
                id: "contribution-rhythm",
                title: "Saving can fit changing work patterns",
                explanation: `Your completed contributions appear in ${months.size} different months. Informal-sector income can vary, so a flexible approach may be more practical than a fixed schedule.`,
                nextStep: "Choose a contribution rhythm that feels manageable for your circumstances.",
                translationValues: { months: months.size },
            });
        }
    } else if (contributions === null || contributions === undefined) {
        insights.push({
            id: "contribution-records-unavailable",
            title: "Contribution history is not available right now",
            explanation: "Personal contribution details could not be loaded, so these tips use general savings guidance rather than estimates about your account.",
            nextStep: "Try refreshing the dashboard when your connection is available.",
            translationValues: {},
        });
    } else {
        insights.push({
            id: "starting-small",
            title: "Every savings journey starts somewhere",
            explanation: "There are no completed contributions in the available history yet. There is no required starting amount; your plan should fit your income and essential needs.",
            nextStep: "Explore contribution options when you are ready.",
            translationValues: {},
        });
    }

    const currentBalance = Number(balance?.current_balance);
    if (Number.isFinite(currentBalance) && currentBalance >= 0) {
        insights.push({
            id: "balance-awareness",
            title: "Know what is currently recorded",
            explanation: `Your pension account currently records a balance of ${formatCurrency(currentBalance)}. This is the account balance returned by MicoPesa, not a forecast of future growth.`,
            nextStep: "Compare your balance with your contribution history to understand your current position.",
            translationValues: { amount: currentBalance },
        });
    } else if (balance === null || balance === undefined) {
        insights.push({
            id: "balance-unavailable",
            title: "Your account balance is not available right now",
            explanation: "The current balance could not be loaded, so no account-specific balance figure is shown.",
            nextStep: "Try refreshing the dashboard later.",
            translationValues: {},
        });
    }

    const targetAmount = Number(plan?.target_amount);
    const projectedAmount = Number(projection?.projected_amount);
    if (plan && projection &&
        Number.isFinite(targetAmount) && targetAmount > 0 &&
        Number.isFinite(projectedAmount) && projectedAmount >= 0) {
        insights.push({
            id: "retirement-estimate",
            title: "Use your retirement projection as a planning estimate",
            explanation: `Your current plan targets ${formatCurrency(targetAmount)}; its projection estimates ${formatCurrency(projectedAmount)} at retirement. It is an estimate based on assumptions, not a guaranteed outcome.`,
            nextStep: "Review your target and planned contributions if your circumstances or goals change.",
            translationValues: { target: targetAmount, projected: projectedAmount },
        });
    } else if (!plan || !projection) {
        insights.push({
            id: "retirement-goal",
            title: "A retirement goal can help guide your saving",
            explanation: "A personal projection is available after a retirement plan is created. Any projection is an estimate and should not be treated as a promise.",
            nextStep: "Explore the retirement plan page when you are ready to set a goal.",
            translationValues: {},
        });
    }

    insights.push(
        {
            id: "income-flexibility",
            title: "Plan around variable income",
            explanation: "For workers with changing weekly or seasonal income, it can help to first account for essentials and then consider what amount, if any, is comfortable to save.",
            nextStep: "Revisit your approach as your income changes; pausing or adjusting is a valid choice.",
            translationValues: {},
        },
        {
            id: "emergency-savings",
            title: "Keep short-term needs in view",
            explanation: "Retirement saving is one part of financial wellbeing. Planning for near-term essentials and unexpected costs can also matter when deciding what you can set aside.",
            nextStep: "Consider your immediate needs before making any financial decision.",
            translationValues: {},
        },
        {
            id: "understand-records",
            title: "Check transaction status, not just an attempt",
            explanation: "A contribution attempt is different from a completed contribution. Use the recorded status in your account history when reviewing what has been added.",
            nextStep: "If a contribution status looks unresolved, contact support rather than assuming it completed.",
            translationValues: {},
        }
    );

    if (dataUnavailable) {
        insights.push({
            id: "personalization-limited",
            title: "Personalization is limited right now",
            explanation: "Some account information could not be retrieved. The remaining insights are general education and do not infer missing financial details.",
            nextStep: null,
            translationValues: {},
        });
    }

    return insights;
}

function selectFinancialInsights(data, seed) {
    const candidates = buildInsights(data);
    if (candidates.length <= INSIGHT_COUNT) return candidates;

    const start = hashSeed(seed) % candidates.length;
    const selected = [];
    for (let offset = 0; offset < candidates.length && selected.length < INSIGHT_COUNT; offset += 1) {
        selected.push(candidates[(start + offset) % candidates.length]);
    }
    return selected;
}

export { buildInsights, getCompletedContributions, selectFinancialInsights };
