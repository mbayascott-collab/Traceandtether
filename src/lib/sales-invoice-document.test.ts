import assert from "node:assert/strict";
import test from "node:test";
import type { SalesDelivery, SalesOrder } from "./api";
import { salesInvoiceDocument } from "./sales-invoice-document";

const order = {
  id: 4,
  orderNumber: "SO-2026-0004",
  customerId: 7,
  customerName: "Customer",
  status: "fulfilled",
  orderDate: "2026-11-01",
  fulfilledAt: "2026-11-04T10:00:00.000Z",
  deliveryAddress: "Lusaka",
  notes: null,
  totalZmw: "120.00",
  deliveredZmw: "120.00",
  deliveries: [],
  campaignId: null,
  campaignName: null,
  lines: [{
    id: 10, productId: 2, productName: "Bag", sku: "BAG-1", quantity: 6,
    deliveredQuantity: 6, remainingQuantity: 0, unitPriceZmw: "20.00", lineTotalZmw: "120.00",
    stockLocationId: null, stockLocationName: null, stockReservations: [], stockLocations: [],
  }],
} satisfies SalesOrder;

const delivery = {
  id: 11,
  deliveryNumber: "DN-2026-0004-A",
  deliveryDate: "2026-11-03",
  totalZmw: "40.00",
  receipt: null,
  lines: [{
    salesDeliveryLineId: 15, salesOrderLineId: 10, productName: "Bag", sku: "BAG-1",
    quantity: 2, returnedQuantity: 1,
    returns: [{ quantity: 1, reason: "Damaged", createdAt: "2026-11-05T10:00:00.000Z", locationName: "Main" }],
    stockLocations: [], unitPriceZmw: "20.00", lineTotalZmw: "40.00",
  }],
} satisfies SalesDelivery;

test("delivery invoice uses that delivery's original date, lines, quantities, and total after returns", () => {
  assert.deepEqual(salesInvoiceDocument(order, delivery), {
    invoiceRef: "INV-2026-0004-A",
    date: "2026-11-03",
    lines: [{
      id: 10, productName: "Bag", sku: "BAG-1", quantity: 2,
      unitPriceZmw: "20.00", lineTotalZmw: "40.00",
    }],
    totalZmw: "40.00",
  });
});

test("order invoice keeps the complete order lines and amount", () => {
  assert.deepEqual(salesInvoiceDocument(order, null), {
    invoiceRef: "INV-2026-0004",
    date: "2026-11-04T10:00:00.000Z",
    lines: [{
      id: 10, productName: "Bag", sku: "BAG-1", quantity: 6,
      unitPriceZmw: "20.00", lineTotalZmw: "120.00",
    }],
    totalZmw: "120.00",
  });
});
