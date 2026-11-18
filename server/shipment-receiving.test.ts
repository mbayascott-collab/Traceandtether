import assert from "node:assert/strict";
import test from "node:test";
import { calculatePurchaseReceiptPosting, journalLinesAreBalanced } from "./accounting-posting";
import {
  purchaseOrderReceiptStatus, shipmentReceiptStatus, validateShipmentReceipt,
} from "./shipment-receiving";

const shipmentLines = [
  { id: 11, purchaseOrderLineId: 101, quantityShipped: 4, quantityStocked: 0 },
  { id: 12, purchaseOrderLineId: 202, quantityShipped: 2, quantityStocked: 0 },
];
const orderLines = [
  { id: 101, purchaseOrderId: 1, quantityOrdered: 4 },
  { id: 202, purchaseOrderId: 2, quantityOrdered: 2 },
];

function validationError(
  requestedQuantities: Map<number, number>,
  options: { priorReceipts?: Map<number, number>; orderStatuses?: Map<number, string> } = {},
) {
  return validateShipmentReceipt({
    shipmentLines,
    requestedQuantities,
    purchaseOrderLines: orderLines,
    otherReceivedByLine: options.priorReceipts ?? new Map(),
    purchaseOrderStatuses: options.orderStatuses ?? new Map([[1, "ordered"], [2, "ordered"]]),
  });
}

test("accepts a partial receipt for a consolidated shipment and keeps each order partially received", () => {
  const partial = [{ quantityReceived: 2 }, { quantityReceived: 1 }];
  assert.equal(validationError(new Map([[11, 2], [12, 1]])), null);
  assert.equal(shipmentReceiptStatus(partial, shipmentLines), "partially_received");
  assert.equal(purchaseOrderReceiptStatus([orderLines[0]!], new Map([[101, 2]])), "partially_received");
  assert.equal(purchaseOrderReceiptStatus([orderLines[1]!], new Map([[202, 1]])), "partially_received");
});

test("accepts a full receipt and marks every purchase order received", () => {
  const full = [{ quantityReceived: 4 }, { quantityReceived: 2 }];
  assert.equal(validationError(new Map([[11, 4], [12, 2]])), null);
  assert.equal(shipmentReceiptStatus(full, shipmentLines), "received");
  assert.equal(purchaseOrderReceiptStatus([orderLines[0]!], new Map([[101, 4]])), "received");
  assert.equal(purchaseOrderReceiptStatus([orderLines[1]!], new Map([[202, 2]])), "received");
});

test("rejects quantities beyond shipped or ordered amounts and protects cancelled orders", () => {
  assert.match(validationError(new Map([[11, 5], [12, 0]])) ?? "", /quantity shipped/);
  assert.match(
    validationError(new Map([[11, 2], [12, 0]]), { priorReceipts: new Map([[101, 3]]) }) ?? "",
    /quantity ordered/,
  );
  assert.match(
    validationError(new Map([[11, 1], [12, 1]]), { orderStatuses: new Map([[1, "cancelled"], [2, "ordered"]]) }) ?? "",
    /cancelled/i,
  );
});

test("posts each consolidated receipt at its own order-line cost", () => {
  const supplierOne = calculatePurchaseReceiptPosting({
    productId: 31, quantity: 2, unitPrice: "10.00", exchangeRateToZmw: "2.00000000",
    quantityOrdered: 4, quantityPreviouslyStocked: 0, allocatedExpensesZmw: "8.00",
  });
  const supplierTwo = calculatePurchaseReceiptPosting({
    productId: 47, quantity: 1, unitPrice: "3.50", exchangeRateToZmw: "10.00000000",
    quantityOrdered: 2, quantityPreviouslyStocked: 0, allocatedExpensesZmw: "6.00",
  });

  assert.equal(supplierOne.goodsCost, 4_000n);
  assert.equal(supplierOne.landedCost, 400n);
  assert.deepEqual(supplierOne.lines.map((line) => [line.accountKey, line.productId, line.debitZmw, line.creditZmw]), [
    ["inventory", 31, "44.00", undefined],
    ["accounts_payable", undefined, undefined, "40.00"],
    ["landed_cost_clearing", undefined, undefined, "4.00"],
  ]);
  assert.equal(supplierTwo.goodsCost, 3_500n);
  assert.equal(supplierTwo.landedCost, 300n);
  assert.deepEqual(supplierTwo.lines.map((line) => [line.accountKey, line.productId, line.debitZmw, line.creditZmw]), [
    ["inventory", 47, "38.00", undefined],
    ["accounts_payable", undefined, undefined, "35.00"],
    ["landed_cost_clearing", undefined, undefined, "3.00"],
  ]);
  assert.equal(journalLinesAreBalanced(supplierOne.lines), true);
  assert.equal(journalLinesAreBalanced(supplierTwo.lines), true);
});
