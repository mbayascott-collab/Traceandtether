import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { inventoryMovementHistoryCsv, type InventoryItem, type InventoryMovement } from "../lib/api";
import { InventoryOverviewTable, MovementTable } from "./InventoryWorkspace";

test("inventory table keeps zero-stock products with a non-zero location value visible", () => {
  const product: InventoryItem = {
    id: 41,
    name: "Zero-stock item with remaining value",
    sku: "ZERO-VALUE-41",
    unit: "piece",
    status: "active",
    onHand: 0,
    reserved: 0,
    available: 0,
    stockValueZmw: "24.50",
    averageUnitCostZmw: "0.00",
    locations: [{
      id: null,
      name: "Unassigned",
      onHand: 0,
      reserved: 0,
      available: 0,
      stockValueZmw: "24.50",
    }],
  };

  const markup = renderToStaticMarkup(createElement(InventoryOverviewTable, { products: [product] }));

  assert.match(markup, /Zero-stock item with remaining value/);
  assert.match(markup, /ZERO-VALUE-41/);
  assert.match(markup, /Unassigned: 0 \/ 0 \/ ZMW 24\.50/);
  assert.match(markup, /<td>0<\/td>/);
  assert.match(markup, /ZMW 24\.50/);
});

test("stock movement history and CSV include receipts and both sides of transfers", () => {
  const movements: InventoryMovement[] = [
    {
      id: 11,
      productId: 41,
      productName: "Recorded item",
      sku: "REC-41",
      kind: "stock_receipt",
      quantityDelta: 8,
      reason: "Shipment received",
      reference: "SHIP-41",
      locationId: 1,
      locationName: "Main warehouse",
      salesDeliveryLineId: null,
      correctionOfMovementId: null,
      createdAt: "2026-11-19T10:00:00.000Z",
      evidenceFiles: [],
    },
    {
      id: 12,
      productId: 41,
      productName: "Recorded item",
      sku: "REC-41",
      kind: "stock_transfer_out",
      quantityDelta: -3,
      reason: "Move to shop",
      reference: "MOVE-41",
      locationId: 1,
      locationName: "Main warehouse",
      salesDeliveryLineId: null,
      correctionOfMovementId: null,
      createdAt: "2026-11-19T11:00:00.000Z",
      evidenceFiles: [],
    },
    {
      id: 13,
      productId: 41,
      productName: "Recorded item",
      sku: "REC-41",
      kind: "stock_transfer_in",
      quantityDelta: 3,
      reason: "Move to shop",
      reference: "MOVE-41",
      locationId: 2,
      locationName: "Shop",
      salesDeliveryLineId: null,
      correctionOfMovementId: null,
      createdAt: "2026-11-19T11:00:00.000Z",
      evidenceFiles: [],
    },
  ];

  const markup = renderToStaticMarkup(createElement(MovementTable, {
    movements,
    onCorrect: () => {},
    onSubmit: async () => {},
  }));
  const csv = inventoryMovementHistoryCsv(movements);

  assert.match(markup, /stock receipt/);
  assert.match(markup, /stock transfer out/);
  assert.match(markup, /stock transfer in/);
  assert.match(markup, /SHIP-41/);
  assert.match(markup, /MOVE-41/);
  assert.match(markup, /Showing 3 of 3 movements/);
  assert.match(csv, /stock receipt/);
  assert.match(csv, /stock transfer out/);
  assert.match(csv, /stock transfer in/);
  assert.match(csv, /SHIP-41/);
  assert.match(csv, /MOVE-41/);
});

test("movement history offers count selection for bulk evidence downloads", () => {
  const movement: InventoryMovement = {
    id: 21,
    productId: 41,
    productName: "Counted item",
    sku: "COUNT-41",
    kind: "opening_stock",
    quantityDelta: 2,
    reason: "Initial count",
    reference: null,
    locationId: 1,
    locationName: "Main warehouse",
    salesDeliveryLineId: null,
    correctionOfMovementId: null,
    createdAt: "2026-11-19T10:00:00.000Z",
    evidenceFiles: [{ id: null, fileName: "count.pdf", mimeType: "application/pdf" }],
  };

  const markup = renderToStaticMarkup(createElement(MovementTable, {
    movements: [movement],
    onCorrect: () => {},
    onSubmit: async () => {},
  }));

  assert.match(markup, /Select all matching counts/);
  assert.match(markup, /Download evidence for 0 counts/);
  assert.match(markup, /Select count evidence for Counted item 2026-11-19/);
  assert.match(markup, /archives are limited to 25 records and 50 MB/);
});
