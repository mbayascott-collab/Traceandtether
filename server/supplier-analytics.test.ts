import assert from "node:assert/strict";
import test from "node:test";
import { supplierDeliveryMetrics } from "./supplier-analytics";

test("compares recorded shipment dates and uses the purchase order date when shipment expectation is absent", () => {
  const metrics = supplierDeliveryMetrics(
    [
      { id: 1, supplierId: 7, supplierName: "North", status: "received", expectedAt: "2025-01-10" },
      { id: 2, supplierId: 7, supplierName: "North", status: "received", expectedAt: null },
    ],
    [
      { id: 11, purchaseOrderId: 1, status: "received", expectedAt: null, receivedAt: "2025-01-12" },
      { id: 12, purchaseOrderId: 2, status: "received", expectedAt: "2025-01-20", receivedAt: "2025-01-18" },
    ],
    [],
    "2025-02-01",
  );

  assert.deepEqual(metrics.get(7), {
    onTimeDeliveries: 1,
    lateDeliveries: 1,
    measuredDeliveries: 2,
    averageDeliveryVarianceDays: "0.0",
    overdueOpenOrders: 0,
    missingExpectedDateOrders: 0,
    missingActualDateOrders: 0,
    incompleteDeliveryOrders: 0,
  });
});

test("marks missing and incomplete dates without treating them as on-time deliveries", () => {
  const metrics = supplierDeliveryMetrics(
    [
      { id: 1, supplierId: 4, supplierName: "East", status: "ordered", expectedAt: "2025-01-01" },
      { id: 2, supplierId: 4, supplierName: "East", status: "received", expectedAt: null },
      { id: 3, supplierId: 4, supplierName: "East", status: "received", expectedAt: null },
    ],
    [
      { id: 10, purchaseOrderId: 1, status: "in_transit", expectedAt: null, receivedAt: null },
      { id: 11, purchaseOrderId: 2, status: "received", expectedAt: null, receivedAt: "2025-01-10" },
    ],
    [],
    "2025-02-01",
  );

  assert.deepEqual(metrics.get(4), {
    onTimeDeliveries: 0,
    lateDeliveries: 0,
    measuredDeliveries: 0,
    averageDeliveryVarianceDays: null,
    overdueOpenOrders: 1,
    missingExpectedDateOrders: 2,
    missingActualDateOrders: 1,
    incompleteDeliveryOrders: 1,
  });
});

test("ignores cancelled orders and shipments and keeps suppliers without date pairs visible", () => {
  const metrics = supplierDeliveryMetrics(
    [
      { id: 1, supplierId: 9, supplierName: "West", status: "cancelled", expectedAt: null },
      { id: 2, supplierId: 9, supplierName: "West", status: "received", expectedAt: "2025-03-01" },
    ],
    [
      { id: 10, purchaseOrderId: 1, status: "cancelled", expectedAt: "2025-02-01", receivedAt: null },
    ],
    [],
    "2025-04-01",
  );

  assert.deepEqual(metrics.get(9), {
    onTimeDeliveries: 0,
    lateDeliveries: 0,
    measuredDeliveries: 0,
    averageDeliveryVarianceDays: null,
    overdueOpenOrders: 0,
    missingExpectedDateOrders: 0,
    missingActualDateOrders: 1,
    incompleteDeliveryOrders: 0,
  });
});
