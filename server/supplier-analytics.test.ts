import assert from "node:assert/strict";
import test from "node:test";
import { supplierDeliveryMetrics } from "./supplier-analytics";
import { supplierReportCsv } from "../shared/supplier-report-csv";

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

test("supplier CSV keeps the selected range, supplier delivery values, and unallocated costs separate", () => {
  const csv = supplierReportCsv({
    period: { from: "2025-01-01", to: "2025-01-31" },
    totals: {
      orderedGoodsZmw: "240.00", importCostsZmw: "35.00", unallocatedImportCostsZmw: "5.00", paymentsZmw: "120.00",
      orders: 2, onTimeOrders: 1, lateOrders: 1, overdueOpenOrders: 0, missingExpectedDateOrders: 0,
      missingActualDateOrders: 0, incompleteDeliveryOrders: 0, measuredDeliveryOrders: 2,
    },
    suppliers: [{
      name: 'North "Trading"', orders: 2, orderedGoodsZmw: "240.00", importCostsZmw: "30.00", paymentsZmw: "120.00",
      measuredDeliveryOrders: 2, onTimeOrders: 1, lateOrders: 1, missingExpectedDateOrders: 0,
      missingActualDateOrders: 0, incompleteDeliveryOrders: 0, overdueOpenOrders: 0, averageDeliveryVarianceDays: "1.5",
    }],
  });

  assert.match(csv, /"From","2025-01-01"/);
  assert.match(csv, /"To","2025-01-31"/);
  assert.match(csv, /"North ""Trading""","2","240\.00","30\.00","120\.00","2","1","1"/);
  assert.match(csv, /"'\+1\.5 days · late"/);
  assert.match(csv, /"Unallocated import costs \(not assigned to a supplier\)","5\.00","ZMW"/);
  assert.match(csv, /"Total","2","240\.00","35\.00","120\.00"/);
});

test("supplier CSV protects formula-like supplier names", () => {
  const csv = supplierReportCsv({
    period: { from: null, to: null },
    totals: {
      orderedGoodsZmw: "0.00", importCostsZmw: "0.00", unallocatedImportCostsZmw: "0.00", paymentsZmw: "0.00",
      orders: 0, onTimeOrders: 0, lateOrders: 0, overdueOpenOrders: 0, missingExpectedDateOrders: 0,
      missingActualDateOrders: 0, incompleteDeliveryOrders: 0, measuredDeliveryOrders: 0,
    },
    suppliers: [{
      name: "=HYPERLINK(\"https://example.invalid\")", orders: 0, orderedGoodsZmw: "0.00", importCostsZmw: "0.00",
      paymentsZmw: "0.00", measuredDeliveryOrders: 0, onTimeOrders: 0, lateOrders: 0, missingExpectedDateOrders: 0,
      missingActualDateOrders: 0, incompleteDeliveryOrders: 0, overdueOpenOrders: 0, averageDeliveryVarianceDays: null,
    }],
  });

  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.invalid""\)"/);
});
