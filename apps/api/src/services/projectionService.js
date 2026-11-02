const MAX_MONEY = 9999999999.99;
const MAX_ANNUAL_RATE = 0.2;
const MAX_AGE = 100;

function parseMoney(value, field, { allowZero }) {
    const text = typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : typeof value === "string" ? value.trim() : "";
    if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) {
        throw new TypeError(`${field} must be a valid KES amount with no more than 2 decimal places`);
    }
    const amount = Number(text);

    if (!Number.isFinite(amount)) {
        throw new TypeError(`${field} must be a finite KES amount`);
    }
    if (amount > MAX_MONEY || amount < 0 || (!allowZero && amount === 0)) {
        throw new RangeError(`${field} must be ${allowZero ? "between 0" : "greater than 0"} and ${MAX_MONEY.toFixed(2)} KES`);
    }
    return amount;
}

function parseAge(value, field) {
    const age = typeof value === "string" && /^\d{1,3}$/.test(value.trim())
        ? Number(value.trim())
        : value;
    if (!Number.isInteger(age) || age < 1 || age > MAX_AGE) {
        throw new RangeError(`${field} must be a whole number between 1 and ${MAX_AGE}`);
    }
    return age;
}

function round2(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

function validateProjectionInputs({
    currentBalance,
    monthlyContribution,
    targetAmount,
    targetAge,
    currentAge,
}) {
    try {
        parseMoney(currentBalance, "current_balance", { allowZero: true });
        parseMoney(monthlyContribution, "monthly_contribution_target", { allowZero: true });
        parseMoney(targetAmount, "target_amount", { allowZero: false });
        const parsedCurrentAge = parseAge(currentAge, "current_age");
        const parsedTargetAge = parseAge(targetAge, "target_retirement_age");
        if (parsedTargetAge <= parsedCurrentAge) {
            return "target_retirement_age must be greater than current_age";
        }
        return null;
    } catch (error) {
        return error.message;
    }
}

function calculateProjection({
    currentBalance,
    monthlyContribution,
    targetAmount,
    targetAge,
    currentAge,
    annualRate = 0.08,
}) {
    const validationError = validateProjectionInputs({
        currentBalance,
        monthlyContribution,
        targetAmount,
        targetAge,
        currentAge,
    });
    if (validationError) {
        const error = new TypeError(validationError);
        error.code = "PROJECTION_INVALID";
        throw error;
    }

    if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > MAX_ANNUAL_RATE) {
        const error = new RangeError(`annualRate must be between 0 and ${MAX_ANNUAL_RATE}`);
        error.code = "PROJECTION_INVALID";
        throw error;
    }

    const balance = parseMoney(currentBalance, "current_balance", { allowZero: true });
    const contribution = parseMoney(monthlyContribution, "monthly_contribution_target", { allowZero: true });
    const goal = parseMoney(targetAmount, "target_amount", { allowZero: false });
    const startingAge = parseAge(currentAge, "current_age");
    const retirementAge = parseAge(targetAge, "target_retirement_age");
    const projectionYears = retirementAge - startingAge;
    const months = projectionYears * 12;
    const monthlyRate = annualRate / 12;
    const logMonthlyFactor = Math.log1p(monthlyRate);
    const totalPlannedContributions = contribution * months;

    function balanceAtMonth(month) {
        if (monthlyRate === 0) return balance + contribution * month;
        const growthFactor = Math.exp(month * logMonthlyFactor);
        const annuityFactor = Math.expm1(month * logMonthlyFactor) / monthlyRate;
        return balance * growthFactor + contribution * annuityFactor;
    }

    const yearByYear = Array.from({ length: projectionYears + 1 }, (_unused, year) => {
        const projectedBalance = balanceAtMonth(year * 12);
        if (!Number.isFinite(projectedBalance) || projectedBalance > MAX_MONEY) {
            const error = new RangeError("Projection exceeds the supported KES amount range");
            error.code = "PROJECTION_INVALID";
            throw error;
        }
        return {
            year,
            age: startingAge + year,
            projectedBalance: round2(projectedBalance),
            totalContributions: round2(contribution * year * 12),
        };
    });

    const projectedBalance = yearByYear[yearByYear.length - 1].projectedBalance;
    const roundedContributions = round2(totalPlannedContributions);
    const estimatedGrowth = round2(projectedBalance - balance - roundedContributions);

    return {
        currentAge: startingAge,
        targetAge: retirementAge,
        projectionYears,
        months,
        startingBalance: round2(balance),
        monthlyContribution: round2(contribution),
        annualRate,
        totalPlannedContributions: roundedContributions,
        projectedBalance,
        estimatedGrowth,
        isTargetReachable: projectedBalance >= goal,
        yearByYear,
    };
}

module.exports = {
    MAX_AGE,
    MAX_ANNUAL_RATE,
    MAX_MONEY,
    calculateProjection,
    validateProjectionInputs,
};
