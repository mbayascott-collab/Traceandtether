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

test("shared shipment expense keeps the global allocation when viewed by purchase order", () => {
  const allLines = [
    { lineId: 1, quantityOrdered: 2, unitPrice: "10.00" },
    { lineId: 2, quantityOrdered: 2, unitPrice: "20.00" },
  ];
  const sharedExpense = { expenseId: 15, amount: "12.00", exchangeRateToZmw: "2", basis: "value" as const };
  const shipmentAllocation = allocateLandedCosts(allLines, [sharedExpense], "1");
  assert.deepEqual(shipmentAllocation.allocations.map((item) => item.amountZmw), ["8.00", "16.00"]);

  const firstOrder = allocateLandedCosts([allLines[0]], [{
    ...sharedExpense,
    lineAllocations: shipmentAllocation.allocations.filter((item) => item.lineId === 1),
  }], "1");
  const secondOrder = allocateLandedCosts([allLines[1]], [{
    ...sharedExpense,
    lineAllocations: shipmentAllocation.allocations.filter((item) => item.lineId === 2),
  }], "1");

  assert.equal(firstOrder.lines[0].allocatedExpensesZmw, "8.00");
  assert.equal(secondOrder.lines[0].allocatedExpensesZmw, "16.00");
  assert.equal(
    Number(firstOrder.lines[0].allocatedExpensesZmw) + Number(secondOrder.lines[0].allocatedExpensesZmw),
    24,
  );
});

test("shared expense shares do not reallocate the full bill to each order", () => {
  const result = allocateLandedCosts(
    [{ lineId: 2, quantityOrdered: 4, unitPrice: "3.00" }],
    [{
      expenseId: 16, amount: "100.00", exchangeRateToZmw: "1", basis: "quantity",
      lineAllocations: [{ lineId: 2, amountZmw: "7.25" }],
    }],
    "1",
  );
  assert.equal(result.lines[0].allocatedExpensesZmw, "7.25");
});

test("shared value-basis expenses compare orders in ZMW when currencies differ", () => {
  const result = allocateLandedCosts(
    [
      { lineId: 1, quantityOrdered: 1, unitPrice: "100.00", valueExchangeRateToZmw: "0.5" },
      { lineId: 2, quantityOrdered: 1, unitPrice: "75.00", valueExchangeRateToZmw: "1" },
    ],
    [{ expenseId: 17, amount: "1.25", exchangeRateToZmw: "1", basis: "value" }],
    "1",
  );
  assert.deepEqual(result.allocations.map((item) => item.amountZmw), ["0.50", "0.75"]);
});
