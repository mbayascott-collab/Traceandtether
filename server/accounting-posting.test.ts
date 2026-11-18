import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeliveryCostTotals, buildOpeningBalanceLines, buildOpeningStockLines, cashAccountKeyForMethod, cents, formatCents, journalLinesAreBalanced,
  operatingExpenseAccountKey, splitLandedCostCorrection, weightedAverageUnitCostCents,
} from "./accounting-posting";

test("parses and formats ZMW using exact minor units", () => {
  assert.equal(cents("123456.78"), 12_345_678n);
  assert.equal(formatCents(12_345_678n), "123456.78");
});

test("sums delivery costs in exact cents and flags deliveries without recorded cost", () => {
  const result = buildDeliveryCostTotals(
    [
      { deliveryId: 10, orderId: 1, deliveryDate: "2026-11-05", productId: 4 },
      { deliveryId: 11, orderId: 1, deliveryDate: "2026-11-06", productId: 5 },
      { deliveryId: 12, orderId: 2, deliveryDate: "2026-10-31", productId: 4 },
    ],
    [
      { deliveryId: 10, productId: 4, debitZmw: "12.34" },
      { deliveryId: 10, productId: 4, debitZmw: "0.01" },
    ],
    (date) => date >= "2026-11-01",
  );
  assert.equal(result.productCostByOrder.get(1), 1_235n);
  assert.deepEqual([...result.ordersMissingCost], [1]);
  assert.equal(result.productCostByOrder.has(2), false);
});

test("accepts only positive balanced journal lines", () => {
  assert.equal(journalLinesAreBalanced([
    { accountKey: "inventory", debitZmw: "120.50" },
    { accountKey: "accounts_payable", creditZmw: "120.50" },
  ]), true);
  assert.equal(journalLinesAreBalanced([
    { accountKey: "inventory", debitZmw: "120.50" },
    { accountKey: "accounts_payable", creditZmw: "120.49" },
  ]), false);
  assert.equal(journalLinesAreBalanced([]), false);
});

test("opening balances balance with a clearly described opening equity offset", () => {
  const lines = buildOpeningBalanceLines({
    cashOnHandZmw: "30.00",
    bankZmw: "50.00",
    mobileMoneyZmw: "20.00",
    otherFundsZmw: "0.00",
    receivablesZmw: "25.50",
    payablesZmw: "40.00",
    loansPayableZmw: "0.00",
    ownerEquityZmw: "50.00",
  });
  assert.equal(journalLinesAreBalanced(lines), true);
  assert.deepEqual(lines.slice(0, 3).map((line) => [line.accountKey, line.debitZmw]), [
    ["cash_on_hand", "30.00"],
    ["bank_account", "50.00"],
    ["mobile_money", "20.00"],
  ]);
  assert.deepEqual(lines.at(-1), {
    accountKey: "opening_balance_equity",
    creditZmw: "35.50",
    description: "Balancing amount for opening assets and liabilities",
  });
});

test("opening balance equity can have a debit balance when credits exceed assets", () => {
  const lines = buildOpeningBalanceLines({
    cashOnHandZmw: "10.00",
    bankZmw: "0.00",
    mobileMoneyZmw: "0.00",
    otherFundsZmw: "0.00",
    receivablesZmw: "0.00",
    payablesZmw: "0.00",
    loansPayableZmw: "0.00",
    ownerEquityZmw: "15.00",
  });
  assert.equal(journalLinesAreBalanced(lines), true);
  assert.equal(lines.at(-1)?.debitZmw, "5.00");
});

test("opening stock debits product inventory and credits opening balance equity", () => {
  const lines = buildOpeningStockLines(42, "102.00");
  assert.equal(journalLinesAreBalanced(lines), true);
  assert.deepEqual(lines.map((line) => [line.accountKey, line.productId, line.debitZmw, line.creditZmw]), [
    ["inventory", 42, "102.00", undefined],
    ["opening_balance_equity", undefined, undefined, "102.00"],
  ]);
});

test("rounds the current weighted-average cost in exact ZMW cents", () => {
  assert.equal(weightedAverageUnitCostCents(100n, 3), 33n);
  assert.equal(weightedAverageUnitCostCents(101n, 2), 51n);
  assert.equal(weightedAverageUnitCostCents(100n, 0), 0n);
});

test("splits late import costs by the weighted-average value still represented in stock", () => {
  const split = splitLandedCostCorrection({
    amountCents: 2_000n, inventoryValueCents: 6_000n, onHand: 6, totalReceiptQuantity: 10,
  });
  assert.deepEqual(split, { averageUnitCostCents: 1_000n, inventoryCents: 1_200n, cogsCents: 800n });
  assert.equal(splitLandedCostCorrection({
    amountCents: 2_000n, inventoryValueCents: 0n, onHand: 0, totalReceiptQuantity: 10,
  }).cogsCents, 2_000n);
  assert.equal(splitLandedCostCorrection({
    amountCents: 2_000n, inventoryValueCents: 12_000n, onHand: 10, totalReceiptQuantity: 10,
  }).inventoryCents, 2_000n);
});

test("maps each payment method to its own balance account", () => {
  assert.equal(cashAccountKeyForMethod("cash"), "cash_on_hand");
  assert.equal(cashAccountKeyForMethod("bank_transfer"), "bank_account");
  assert.equal(cashAccountKeyForMethod("mobile_money"), "mobile_money");
  assert.equal(cashAccountKeyForMethod("other"), "other_funds");
});

test("maps ordinary expense categories to the correct report accounts", () => {
  assert.equal(operatingExpenseAccountKey("rent"), "rent_expense");
  assert.equal(operatingExpenseAccountKey("office_supplies"), "office_supplies_expense");
  assert.equal(operatingExpenseAccountKey("utilities"), "utilities_expense");
  assert.equal(operatingExpenseAccountKey("other"), "other_operating_expense");
});
