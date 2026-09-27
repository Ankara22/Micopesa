// Retirement projection math.
//
// Model: standard monthly-compounding future-value-of-annuity formula.
//   r = ANNUAL_RATE / 12                          (monthly growth rate)
//   n = (targetAge - currentAge) * 12             (number of monthly periods)
//   projectedBalance = currentBalance * (1 + r)^n
//                     + monthlyContribution * (((1 + r)^n - 1) / r)
//
// This is a pure calculation module - no database access here.

const ANNUAL_RATE = 0.08;
const MONTHLY_RATE = ANNUAL_RATE / 12;

function round2(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * @param {Object} params
 * @param {number} params.currentBalance - current pension account balance
 * @param {number} params.monthlyContribution - assumed monthly contribution
 * @param {number} params.targetAmount - the worker's savings goal
 * @param {number} params.targetAge - the age at which the worker wants to retire
 * @param {number} params.currentAge - the worker's current age
 * @returns {{
 *   projectedBalance: number,
 *   totalContributions: number,
 *   expectedYield: number,
 *   isTargetReachable: boolean,
 *   months: number,
 *   annualRate: number,
 * }}
 */
function calculateProjection({ currentBalance, monthlyContribution, targetAmount, targetAge, currentAge }) {
    const months = Math.round((targetAge - currentAge) * 12);

    // Degenerate case: target age already reached (or in the past). There is
    // no future growth period to project over, so the projection is simply
    // the current balance as-is.
    if (months <= 0) {
        const projectedBalance = round2(currentBalance);
        return {
            projectedBalance,
            totalContributions: 0,
            expectedYield: 0,
            isTargetReachable: projectedBalance >= targetAmount,
            months: 0,
            annualRate: ANNUAL_RATE,
        };
    }

    const growthFactor = Math.pow(1 + MONTHLY_RATE, months);
    const projectedBalance =
        currentBalance * growthFactor +
        monthlyContribution * ((growthFactor - 1) / MONTHLY_RATE);
    const totalContributions = monthlyContribution * months;
    const expectedYield = projectedBalance - currentBalance - totalContributions;

    return {
        projectedBalance: round2(projectedBalance),
        totalContributions: round2(totalContributions),
        expectedYield: round2(expectedYield),
        isTargetReachable: projectedBalance >= targetAmount,
        months,
        annualRate: ANNUAL_RATE,
    };
}

module.exports = { calculateProjection, ANNUAL_RATE, MONTHLY_RATE };
