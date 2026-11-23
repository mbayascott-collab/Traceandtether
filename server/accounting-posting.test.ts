import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { databaseErrorStatus } from "./database-errors";
import { inventoryMovements, journalEntries, paymentStatementLines } from "../shared/schema";
import {
  allocateInventoryValueByLocationCents, allocateLandedCostAdjustments, allocateLandedCostAdjustmentsByDelivery, allocateLandedCostAdjustmentsByOrder, buildDeliveryCostTotals, buildOpeningBalanceLines, buildOpeningStockLines, cashAccountKeyForMethod, cents, formatCents, journalLinesAreBalanced,
  buildOwnerFundLines, openingBalanceDuplicateMessage, operatingExpenseAccountKey, ownerFundAccountKey, reversePostingLines, splitLandedCostCorrection, weightedAverageUnitCostCents,
} from "./accounting-posting";

test("maps concurrent opening-balance duplicates to the already-recorded response", () => {
  const message = openingBalanceDuplicateMessage(false);
  assert.deepEqual(databaseErrorStatus({ cause: { code: "23505" } }, message), {
    status: 409,
    message,
  });
  assert.match(message, /already been recorded/);
});

test("journal source keys are unique to prevent concurrent duplicate opening entries", () => {
  const sourceKeyIndex = getTableConfig(journalEntries).indexes.find(
    ({ config }) => config.name === "journal_entries_source_key_unique",
  );
  assert.equal(sourceKeyIndex?.config.unique, true);
  assert.equal(sourceKeyIndex?.config.columns.length, 1);
});

test("opening-stock corrections are linked at most once per ledger movement", () => {
  const correctionIndex = getTableConfig(inventoryMovements).indexes.find(
    ({ config }) => config.name === "inventory_movements_correction_of_unique",
  );
  assert.equal(correctionIndex?.config.unique, true);
  assert.equal((correctionIndex?.config.columns[0] as { name?: string } | undefined)?.name, "correction_of_movement_id");
});

test("a payment can be matched to only one statement line", () => {
  const matchedPaymentIndex = getTableConfig(paymentStatementLines).indexes.find(
    ({ config }) => config.name === "payment_statement_lines_matched_payment_unique",
  );
  assert.equal(matchedPaymentIndex?.config.unique, true);
  assert.equal(matchedPaymentIndex?.config.columns.length, 1);
  const indexedColumn = matchedPaymentIndex?.config.columns[0] as { name?: string } | undefined;
  assert.equal(indexedColumn?.name, "matched_payment_id");
});

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

test("allocates product landed-cost adjustments once across deliveries by recorded cost", () => {
  const deliveries = [
    { deliveryId: 10, orderId: 1, productId: 4 },
    { deliveryId: 11, orderId: 2, productId: 4 },
    { deliveryId: 12, orderId: 2, productId: 4 },
    { deliveryId: 13, orderId: 3, productId: 5 },
  ];
  const deliveryCostLines = [
    { deliveryId: 10, productId: 4, debitZmw: "1.00" },
    { deliveryId: 11, productId: 4, debitZmw: "2.00" },
    { deliveryId: 12, productId: 4, debitZmw: "0.00" },
    { deliveryId: 13, productId: 5, debitZmw: "9.00" },
  ];
  const adjustmentLines = [
    { productId: 4, debitZmw: "1.00", creditZmw: "0.00" },
    { productId: 5, debitZmw: "0.50", creditZmw: "0.00" },
    { productId: null, debitZmw: "100.00", creditZmw: "0.00" },
  ];
  const allocatedByDelivery = allocateLandedCostAdjustmentsByDelivery(
    deliveries,
    deliveryCostLines,
    adjustmentLines,
  );
  assert.deepEqual([...allocatedByDelivery].sort(([a], [b]) => a - b), [
    [10, 33n], [11, 67n], [13, 50n],
  ]);
  assert.equal([...allocatedByDelivery.values()].reduce((total, value) => total + value, 0n), 150n);

  const allocated = allocateLandedCostAdjustmentsByOrder(
    deliveries,
    deliveryCostLines,
    adjustmentLines,
  );
  assert.deepEqual([...allocated].sort(([a], [b]) => a - b), [[1, 33n], [2, 67n], [3, 50n]]);
  assert.equal([...allocated.values()].reduce((total, value) => total + value, 0n), 150n);
});

test("allocates negative landed-cost reversals deterministically without losing cents", () => {
  const result = allocateLandedCostAdjustments(
    [
      { deliveryId: 10, orderId: 1, productId: 4 },
      { deliveryId: 11, orderId: 2, productId: 4 },
      { deliveryId: 12, orderId: 3, productId: 4 },
    ],
    [
      { deliveryId: 10, productId: 4, debitZmw: "1.00" },
      { deliveryId: 11, productId: 4, debitZmw: "1.00" },
      { deliveryId: 12, productId: 4, debitZmw: "2.00" },
    ],
    [{ productId: 4, debitZmw: "0.00", creditZmw: "0.05" }],
  );
  assert.deepEqual([...result.adjustmentByDelivery].sort(([a], [b]) => a - b), [
    [10, -1n], [11, -1n], [12, -3n],
  ]);
  assert.deepEqual(
    [...result.adjustmentByDeliveryProduct].map(([deliveryId, products]) => [
      deliveryId,
      [...products],
    ]).sort(([a], [b]) => Number(a) - Number(b)),
    [[10, [[4, -1n]]], [11, [[4, -1n]]], [12, [[4, -3n]]]],
  );
  assert.equal([...result.adjustmentByDelivery.values()].reduce((total, value) => total + value, 0n), -5n);
  assert.equal(
    [...result.adjustmentByDeliveryProduct.values()]
      .flatMap((allocations) => [...allocations.values()])
      .reduce((total, value) => total + value, 0n),
    -5n,
  );

  const tiedRemainders = allocateLandedCostAdjustments(
    [
      { deliveryId: 12, orderId: 3, productId: 4 },
      { deliveryId: 10, orderId: 1, productId: 4 },
      { deliveryId: 11, orderId: 2, productId: 4 },
    ],
    [
      { deliveryId: 12, productId: 4, debitZmw: "1.00" },
      { deliveryId: 10, productId: 4, debitZmw: "1.00" },
      { deliveryId: 11, productId: 4, debitZmw: "1.00" },
    ],
    [{ productId: 4, debitZmw: "0.00", creditZmw: "0.02" }],
  );
  assert.deepEqual([...tiedRemainders.adjustmentByDelivery].sort(([a], [b]) => a - b), [
    [10, -1n], [11, -1n], [12, 0n],
  ]);
  assert.equal(
    [...tiedRemainders.adjustmentByDelivery.values()].reduce((total, value) => total + value, 0n),
    -2n,
  );
});

test("does not invent a delivery allocation when product COGS has no delivery-cost basis", () => {
  const missingBasis = allocateLandedCostAdjustments(
    [{ deliveryId: 10, orderId: 1, productId: 4 }],
    [],
    [{ productId: 4, debitZmw: "25.00", creditZmw: "0.00" }],
  );
  assert.equal(missingBasis.adjustmentByDelivery.size, 0);
  assert.deepEqual([...missingBasis.unallocatedByProduct], [[4, 2_500n]]);

  const zeroBasis = allocateLandedCostAdjustments(
    [{ deliveryId: 11, orderId: 2, productId: 5 }],
    [{ deliveryId: 11, productId: 5, debitZmw: "0.00" }],
    [{ productId: 5, debitZmw: "0.00", creditZmw: "12.34" }],
  );
  assert.equal(zeroBasis.adjustmentByDelivery.size, 0);
  assert.deepEqual([...zeroBasis.unallocatedByProduct], [[5, -1_234n]]);
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

test("reverses opening balance lines without changing their accounts or descriptions", () => {
  const original = buildOpeningBalanceLines({
    cashOnHandZmw: "30.00",
    bankZmw: "0.00",
    mobileMoneyZmw: "0.00",
    otherFundsZmw: "0.00",
    receivablesZmw: "0.00",
    payablesZmw: "10.00",
    loansPayableZmw: "0.00",
    ownerEquityZmw: "0.00",
  });
  const reversal = reversePostingLines(original);
  assert.equal(journalLinesAreBalanced(reversal), true);
  assert.deepEqual(reversal.map((line) => [
    line.accountKey, line.debitZmw, line.creditZmw, line.description,
  ]), original.map((line) => [
    line.accountKey, line.creditZmw ?? "0.00", line.debitZmw ?? "0.00", line.description,
  ]));
});

test("opening stock debits product inventory and credits opening balance equity", () => {
  const lines = buildOpeningStockLines(42, "102.00");
  assert.equal(journalLinesAreBalanced(lines), true);
  assert.deepEqual(lines.map((line) => [line.accountKey, line.productId, line.debitZmw, line.creditZmw]), [
    ["inventory", 42, "102.00", undefined],
    ["opening_balance_equity", undefined, undefined, "102.00"],
  ]);
  const reversal = reversePostingLines(lines);
  assert.equal(journalLinesAreBalanced(reversal), true);
  assert.deepEqual(reversal.map((line) => [line.accountKey, line.productId, line.debitZmw, line.creditZmw]), [
    ["inventory", 42, "0.00", "102.00"],
    ["opening_balance_equity", null, "102.00", "0.00"],
  ]);
});

test("rounds the current weighted-average cost in exact ZMW cents", () => {
  assert.equal(weightedAverageUnitCostCents(100n, 3), 33n);
  assert.equal(weightedAverageUnitCostCents(101n, 2), 51n);
  assert.equal(weightedAverageUnitCostCents(100n, 0), 0n);
});

test("parses negative ZMW values without losing the sign of cent-only balances", () => {
  assert.equal(cents("-0.03"), -3n);
  assert.equal(cents("-1.23"), -123n);
});

test("allocates pooled inventory value by location quantity and reconciles every cent", () => {
  const values = allocateInventoryValueByLocationCents(10n, [
    { locationId: 4, onHand: 1 },
    { locationId: 2, onHand: 1 },
    { locationId: 8, onHand: 1 },
  ]);
  assert.deepEqual([...values], [[4, 3n], [2, 4n], [8, 3n]]);
  assert.equal([...values.values()].reduce((total, value) => total + value, 0n), 10n);
});

test("allocates value to unassigned stock and preserves credits when locations have no positive stock", () => {
  const values = allocateInventoryValueByLocationCents(-275n, [
    { locationId: 4, onHand: 0 },
    { locationId: null, onHand: 0 },
  ]);
  assert.equal(values.get(4), 0n);
  assert.equal(values.get(null), -275n);
  assert.equal([...values.values()].reduce((total, value) => total + value, 0n), -275n);
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

test("posts owner funding, loans, and withdrawals to their source accounts with balanced lines", () => {
  const cases = [
    { kind: "owner_contribution", method: "cash", accountKey: "owner_equity", cashKey: "cash_on_hand", isWithdrawal: false },
    { kind: "business_loan", method: "bank_transfer", accountKey: "business_loans_payable", cashKey: "bank_account", isWithdrawal: false },
    { kind: "owner_withdrawal", method: "mobile_money", accountKey: "owner_withdrawals", cashKey: "mobile_money", isWithdrawal: true },
  ] as const;
  for (const { kind, method, accountKey, cashKey, isWithdrawal } of cases) {
    assert.equal(ownerFundAccountKey(kind), accountKey);
    const lines = buildOwnerFundLines(kind, method, "25.50", "Test account");
    assert.equal(journalLinesAreBalanced(lines), true);
    assert.deepEqual(lines.map((line) => line.accountKey), isWithdrawal ? [accountKey, cashKey] : [cashKey, accountKey]);
    assert.deepEqual(lines.map((line) => [line.debitZmw ?? "0.00", line.creditZmw ?? "0.00"]), isWithdrawal
      ? [["25.50", "0.00"], ["0.00", "25.50"]]
      : [["25.50", "0.00"], ["0.00", "25.50"]]);
  }
});
