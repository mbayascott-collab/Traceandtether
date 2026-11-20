import assert from "node:assert/strict";
import test from "node:test";
import { landedCostReceiptClearingCsv, type LandedCostOrder } from "./api";

const order: LandedCostOrder = {
  id: 14,
  orderNumber: "PO-014",
  supplierId: 6,
  supplierName: "Supplier, East",
  status: "partially_received",
  currency: "CNY",
  exchangeRateToZmw: "3.20",
  orderedAt: "2026-11-01",
  expectedAt: null,
  notes: null,
  allocations: [],
  lines: [{
    id: 31,
    productId: 9,
    productName: "Widget",
    sku: "W-9",
    quantityOrdered: 10,
    unitPrice: "20.00",
    allocatedExpensesZmw: "100.00",
    purchaseUnitCostZmw: "64.00",
    landedUnitCostZmw: "74.00",
  }],
  adjustmentPreview: {
    allocatedExpensesZmw: "100.00",
    receiptClearedTotalZmw: "40.00",
    priorAdjustmentsClearedZmw: "10.00",
    clearingBalanceZmw: "50.00",
    adjustmentAvailableZmw: "30.00",
    unpostedClearingZmw: "20.00",
    canPost: true,
    hasNegativeLine: false,
    adjustments: [],
    receipts: [{
      journalEntryId: 88,
      entryNumber: "JE-0088",
      entryDate: "2026-11-18",
      memo: 'Receipt, "checked"',
      shipmentReference: "SHIP-4",
      productName: '=HYPERLINK("https://example.test","Widget")',
      sku: "W-9",
      quantity: 4,
      clearedAmountZmw: "40.00",
    }],
    lines: [{
      lineId: 31,
      productId: 9,
      productName: "Widget",
      stockedQuantity: 4,
      onHand: 3,
      averageUnitCostZmw: "74.00",
      adjustmentZmw: "30.00",
      inventoryZmw: "22.50",
      cogsZmw: "7.50",
    }],
  },
};

function csvColumnCount(row: string): number {
  let columns = 1;
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    if (row[index] === '"') {
      if (quoted && row[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (row[index] === "," && !quoted) columns += 1;
  }
  return columns;
}

test("receipt clearing CSV includes receipt evidence, totals, and product split", () => {
  const rows = landedCostReceiptClearingCsv(order).split("\r\n");

  assert.equal(csvColumnCount(rows[0]), 24);
  assert.match(rows[0], /"Journal memo","Date","Shipment"/);
  assert.match(rows[1], /"Reconciliation total","PO-014","Supplier, East"/);
  assert.match(rows[1], /"100\.00","40\.00","10\.00","50\.00","30\.00","20\.00"/);
  assert.match(rows[2], /"Receipt clearing","PO-014","Supplier, East","88","JE-0088","Receipt, ""checked""","2026-11-18","SHIP-4"/);
  assert.match(rows[2], /"'=HYPERLINK\(""https:\/\/example\.test"",""Widget""\)","W-9","4","40\.00"/);
  assert.match(rows[3], /"Product correction","PO-014","Supplier, East"/);
  assert.match(rows[3], /"4","3","74\.00","30\.00","22\.50","7\.50"$/);
});

test("receipt clearing CSV preserves 24 columns for each record and requires a preview", () => {
  const csv = landedCostReceiptClearingCsv(order);
  const dataRows = csv.split("\r\n");
  assert.equal(dataRows.length, 4);
  assert.deepEqual(dataRows.map(csvColumnCount), [24, 24, 24, 24]);
  assert.throws(
    () => landedCostReceiptClearingCsv({ ...order, adjustmentPreview: null }),
    /details are unavailable/,
  );
});
