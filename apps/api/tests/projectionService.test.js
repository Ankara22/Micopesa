const { test } = require("node:test");
const assert = require("node:assert/strict");
const { calculateProjection, validateProjectionInputs } = require("../src/services/projectionService");

const baseInput = {
    currentBalance: 12000,
    monthlyContribution: 500,
    targetAmount: 1000000,
    currentAge: 30,
    targetAge: 35,
};

test("zero growth returns starting balance plus regular month-end contributions", () => {
    const result = calculateProjection({ ...baseInput, annualRate: 0 });

    assert.equal(result.projectedBalance, 42000);
    assert.equal(result.totalPlannedContributions, 30000);
    assert.equal(result.estimatedGrowth, 0);
    assert.deepEqual(result.yearByYear.map(({ year, projectedBalance }) => [year, projectedBalance]), [
        [0, 12000],
        [1, 18000],
        [2, 24000],
        [3, 30000],
        [4, 36000],
        [5, 42000],
    ]);
});

test("positive growth compounds monthly and returns a point for each year", () => {
    const result = calculateProjection({ ...baseInput, annualRate: 0.08 });

    assert.equal(result.yearByYear.length, 6);
    assert.equal(result.yearByYear[0].age, 30);
    assert.equal(result.yearByYear[5].age, 35);
    assert.equal(result.yearByYear[5].projectedBalance, result.projectedBalance);
    assert.ok(result.projectedBalance > result.startingBalance + result.totalPlannedContributions);
    assert.ok(result.estimatedGrowth > 0);
});

test("a plan with no future contributions still compounds its credited starting balance", () => {
    const result = calculateProjection({
        ...baseInput,
        monthlyContribution: 0,
        annualRate: 0.08,
    });

    assert.equal(result.totalPlannedContributions, 0);
    assert.ok(result.projectedBalance > result.startingBalance);
});

test("zero starting balance and zero contributions remain zero at zero growth", () => {
    const result = calculateProjection({
        ...baseInput,
        currentBalance: 0,
        monthlyContribution: 0,
        annualRate: 0,
    });

    assert.equal(result.projectedBalance, 0);
    assert.equal(result.estimatedGrowth, 0);
});

test("rejects invalid ages, amounts, and growth assumptions", () => {
    assert.match(validateProjectionInputs({ ...baseInput, currentAge: 0 }), /current_age/);
    assert.match(validateProjectionInputs({ ...baseInput, targetAge: 30 }), /greater than current_age/);
    assert.match(validateProjectionInputs({ ...baseInput, monthlyContribution: -1 }), /monthly_contribution_target/);
    assert.match(validateProjectionInputs({ ...baseInput, currentBalance: -1 }), /current_balance/);
    assert.match(validateProjectionInputs({ ...baseInput, targetAmount: "NaN" }), /target_amount/);
    assert.throws(() => calculateProjection({ ...baseInput, annualRate: 0.21 }), {
        code: "PROJECTION_INVALID",
    });
});

test("rejects unsupported precision and projections outside the stored currency range", () => {
    assert.match(validateProjectionInputs({ ...baseInput, monthlyContribution: 1.234 }), /2 decimal places/);
    assert.throws(() => calculateProjection({
        ...baseInput,
        currentBalance: 9999999999.99,
        currentAge: 1,
        targetAge: 100,
        annualRate: 0.2,
    }), {
        code: "PROJECTION_INVALID",
    });
});
