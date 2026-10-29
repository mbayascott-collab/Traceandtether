import assert from "node:assert/strict";
import test from "node:test";
import { calculateProductProfitability, toMinorUnits } from "./money";

test("calculates estimated profit with exact decimal arithmetic", () => {
  assert.deepEqual(calculateProductProfitability("10.01", "3.33"), {
    estimatedGrossProfitZmw: "6.68",
    estimatedGrossMarginPercent: "66.73",
  });
});

test("reports negative estimated profit without confusing margin and markup", () => {
  assert.deepEqual(calculateProductProfitability("8.00", "10.00"), {
    estimatedGrossProfitZmw: "-2.00",
    estimatedGrossMarginPercent: "-25.00",
  });
});

test("does not calculate a margin when the selling price is zero", () => {
  assert.deepEqual(calculateProductProfitability("0.00", "10.00"), {
    estimatedGrossProfitZmw: "-10.00",
    estimatedGrossMarginPercent: null,
  });
});

test("returns no profitability estimate when either input is missing", () => {
  assert.deepEqual(calculateProductProfitability(null, "10.00"), {
    estimatedGrossProfitZmw: null,
    estimatedGrossMarginPercent: null,
  });
});

test("parses two-decimal currency values without floating-point conversion", () => {
  assert.equal(toMinorUnits("120.05"), 12_005n);
  assert.equal(toMinorUnits("not-money"), null);
});
