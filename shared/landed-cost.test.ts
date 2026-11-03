import assert from "node:assert/strict";
import test from "node:test";
import { allocateLandedCosts } from "./landed-cost";

test("allocates import costs by line value and preserves every cent", () => {
  const result = allocateLandedCosts(
    [
      { lineId: 1, quantityOrdered: 1, unitPrice: "10.00" },
      { lineId: 2, quantityOrdered: 3, unitPrice: "10.00" },
    ],
    [{ expenseId: 1, amount: "10.00", exchangeRateToZmw: "1", basis: "value" }],
    "1",
  );
  assert.deepEqual(result.allocations.map((item) => item.amountZmw), ["2.50", "7.50"]);
  assert.deepEqual(result.lines.map((line) => line.landedUnitCostZmw), ["12.50", "12.50"]);
});

test("converts purchase and expense amounts using recorded FX with exact rounding", () => {
  const result = allocateLandedCosts(
    [{ lineId: 7, quantityOrdered: 2, unitPrice: "2.00" }],
    [{ expenseId: 4, amount: "10.00", exchangeRateToZmw: "3.5", basis: "quantity" }],
    "3.5",
  );
  assert.equal(result.lines[0].purchaseUnitCostZmw, "7.00");
  assert.equal(result.lines[0].allocatedExpensesZmw, "35.00");
  assert.equal(result.lines[0].landedUnitCostZmw, "24.50");
});

test("distributes indivisible cents deterministically", () => {
  const result = allocateLandedCosts(
    [{ lineId: 2, quantityOrdered: 1, unitPrice: "1.00" }, { lineId: 1, quantityOrdered: 1, unitPrice: "1.00" }],
    [{ expenseId: 8, amount: "0.01", exchangeRateToZmw: "1", basis: "value" }],
    "1",
  );
  assert.equal(result.allocations.find((item) => item.lineId === 1)?.amountZmw, "0.01");
  assert.equal(result.allocations.find((item) => item.lineId === 2)?.amountZmw, "0.00");
});
