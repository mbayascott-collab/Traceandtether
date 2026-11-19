import assert from "node:assert/strict";
import test from "node:test";
import { inventoryMovementHistoryCsv, type InventoryMovement } from "./api";

const movements: InventoryMovement[] = [
  {
    id: 8, productId: 3, productName: "=SUM(A1:A2)", sku: "SKU-3", kind: "opening_stock",
    quantityDelta: 5, reason: 'Counted, then checked "twice"\nby owner', reference: "+COUNT-1",
    locationId: 2, locationName: "Main, east", salesDeliveryLineId: null, correctionOfMovementId: null,
    createdAt: "2026-11-19T10:15:00.000Z",
    evidenceFiles: [
      { id: 12, fileName: "count, signed.pdf", mimeType: "application/pdf" },
      { id: 13, fileName: "=formula.jpg", mimeType: "image/jpeg" },
    ],
  },
  {
    id: 9, productId: 3, productName: "=SUM(A1:A2)", sku: "SKU-3", kind: "opening_stock_reversal",
    quantityDelta: -5, reason: "Correction", reference: null, locationId: 2, locationName: "Main, east",
    salesDeliveryLineId: null, correctionOfMovementId: 8, createdAt: "2026-11-19T11:15:00.000Z",
    evidenceFiles: [],
  },
];

test("stock movement CSV includes the displayed movement details and correction links", () => {
  const csv = inventoryMovementHistoryCsv(movements);
  const rows = csv.split("\r\n");

  assert.equal(rows.length, 3);
  assert.equal(
    rows[0],
    '"Movement ID","Date (UTC)","Product","SKU","Location","Type","Quantity change","Reason","Correction link","Reference","Evidence filenames"',
  );
  assert.equal(
    rows[1],
    `"8","2026-11-19T10:15:00.000Z","'=SUM(A1:A2)","SKU-3","Main, east","opening stock","5","Counted, then checked ""twice""\nby owner","Corrected by #9","'+COUNT-1","count, signed.pdf; '=formula.jpg"`,
  );
  assert.equal(
    rows[2],
    `"9","2026-11-19T11:15:00.000Z","'=SUM(A1:A2)","SKU-3","Main, east","opening stock reversal","-5","Correction","Reverses #8","",""`,
  );
});

test("stock movement CSV escaping does not modify the source ledger records", () => {
  const before = structuredClone(movements);
  inventoryMovementHistoryCsv(movements);
  assert.deepEqual(movements, before);
});
