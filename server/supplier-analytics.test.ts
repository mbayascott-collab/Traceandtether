import assert from "node:assert/strict";
import test from "node:test";
import { supplierDeliveryMetrics, supplierMonthlySpend, supplierShipmentDetails } from "./supplier-analytics";
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

test("shipment details stay within selected orders and leave missing shipment dates blank", () => {
  const details = supplierShipmentDetails(
    [
      { id: 1, supplierId: 7, supplierName: "North", orderNumber: "PO-1", status: "received", expectedAt: "2025-01-10" },
      { id: 2, supplierId: 8, supplierName: "East", orderNumber: "PO-2", status: "ordered", expectedAt: null },
      { id: 3, supplierId: 9, supplierName: "West", orderNumber: "PO-3", status: "cancelled", expectedAt: null },
    ],
    [
      { id: 11, purchaseOrderId: 1, shipmentReference: "SHIP-1", status: "received", expectedAt: null, receivedAt: "2025-01-12" },
      { id: 12, purchaseOrderId: 2, shipmentReference: null, status: "in_transit", expectedAt: null, receivedAt: null },
      { id: 13, purchaseOrderId: 3, shipmentReference: "SHIP-CANCELLED", status: "cancelled", expectedAt: "2025-01-01", receivedAt: null },
      { id: 14, purchaseOrderId: 4, shipmentReference: null, status: "received", expectedAt: null, receivedAt: null },
    ],
    [{ shipmentId: 11, purchaseOrderId: 2 }],
  );

  assert.deepEqual(details, [
    {
      supplierId: 8, supplierName: "East", orderNumber: "PO-2", shipmentId: 11, shipmentReference: "SHIP-1",
      status: "received", expectedAt: null, receivedAt: "2025-01-12",
    },
    {
      supplierId: 8, supplierName: "East", orderNumber: "PO-2", shipmentId: 12, shipmentReference: null,
      status: "in_transit", expectedAt: null, receivedAt: null,
    },
    {
      supplierId: 7, supplierName: "North", orderNumber: "PO-1", shipmentId: 11, shipmentReference: "SHIP-1",
      status: "received", expectedAt: null, receivedAt: "2025-01-12",
    },
  ]);
});

test("supplier CSV keeps the selected range, supplier delivery values, and unallocated costs separate", () => {
  const csv = supplierReportCsv({
    period: { from: "2025-01-01", to: "2025-01-31" },
    shipments: [{
      supplierId: 7, supplierName: "North", orderNumber: "PO-1", shipmentId: 11,
      shipmentReference: "SHIP-1", status: "received", expectedAt: null, receivedAt: "2025-01-12",
    }],
    monthlySpend: [{
      month: "2025-01", orderedGoodsZmw: "240.00", importCostsZmw: "35.00", paymentsZmw: "120.00",
      suppliers: [{ supplierId: 7, supplierName: 'North "Trading"', orderedGoodsZmw: "240.00", importCostsZmw: "30.00" }],
    }],
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
  assert.match(csv, /"Goods ordered use purchase-order dates; import costs use expense dates; supplier payments use payment dates and are separate from costs\."/);
  assert.match(csv, /"2025-01","240\.00","35\.00","120\.00"/);
  assert.match(csv, /"Monthly costs by supplier"/);
  assert.match(csv, /"2025-01","North ""Trading""","240\.00","30\.00"/);
  assert.match(csv, /"Supplier-allocated total","240\.00","30\.00"/);
  assert.match(csv, /"Supplier shipment receipt dates"/);
  assert.match(csv, /"Dates below are recorded on the shipment; blank dates are not inferred from purchase orders\."/);
  assert.match(csv, /"North","PO-1","11","SHIP-1","received","","2025-01-12"/);
});

test("supplier CSV protects formula-like supplier names", () => {
  const csv = supplierReportCsv({
    period: { from: null, to: null },
    monthlySpend: [],
    shipments: [],
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

test("monthly supplier spend uses order, expense, and payment dates independently", () => {
  const monthly = supplierMonthlySpend({
    fromDate: "2025-01-01",
    toDate: "2025-03-31",
    purchaseLines: [
      { supplierId: 7, supplierName: "North", orderedAt: "2025-01-28", status: "ordered", totalZmw: "100.00" },
      { supplierId: 8, supplierName: "East", orderedAt: "2025-02-03", status: "received", totalZmw: "50.00" },
      { supplierId: 8, supplierName: "East", orderedAt: "2025-02-10", status: "cancelled", totalZmw: "900.00" },
      { supplierId: 7, supplierName: "North", orderedAt: "2024-12-31", status: "received", totalZmw: "700.00" },
    ],
    expenses: [
      { incurredAt: "2025-02-05", amountZmw: "30.00", allocations: [{ supplierId: 7, supplierName: "North", amountZmw: "30.00" }] },
      { incurredAt: "2025-03-12", amountZmw: "20.00", allocations: [{ supplierId: 7, supplierName: "North", amountZmw: "20.00" }] },
      { incurredAt: "2024-12-31", amountZmw: "800.00", allocations: [] },
    ],
    payments: [
      { paymentDate: "2025-03-01", amountZmw: "60.00" },
      { paymentDate: "2025-01-15", amountZmw: "40.00" },
    ],
  });

  assert.deepEqual(monthly, [
    {
      month: "2025-01", orderedGoodsZmw: "100.00", importCostsZmw: "0.00", paymentsZmw: "40.00",
      suppliers: [{ supplierId: 7, supplierName: "North", orderedGoodsZmw: "100.00", importCostsZmw: "0.00" }],
    },
    {
      month: "2025-02", orderedGoodsZmw: "50.00", importCostsZmw: "30.00", paymentsZmw: "0.00",
      suppliers: [
        { supplierId: 8, supplierName: "East", orderedGoodsZmw: "50.00", importCostsZmw: "0.00" },
        { supplierId: 7, supplierName: "North", orderedGoodsZmw: "0.00", importCostsZmw: "30.00" },
      ],
    },
    {
      month: "2025-03", orderedGoodsZmw: "0.00", importCostsZmw: "20.00", paymentsZmw: "60.00",
      suppliers: [{ supplierId: 7, supplierName: "North", orderedGoodsZmw: "0.00", importCostsZmw: "20.00" }],
    },
  ]);
});

test("monthly supplier spend counts shared shipment expenses once in the incurred month", () => {
  const monthly = supplierMonthlySpend({
    fromDate: "2025-02-01",
    toDate: "2025-02-28",
    purchaseLines: [
      { supplierId: 7, supplierName: "North", orderedAt: "2025-01-15", status: "received", totalZmw: "100.00" },
      { supplierId: 8, supplierName: "East", orderedAt: "2025-01-15", status: "received", totalZmw: "100.00" },
    ],
    expenses: [{
      incurredAt: "2025-02-20", amountZmw: "75.25",
      allocations: [
        { supplierId: 7, supplierName: "North", amountZmw: "37.63" },
        { supplierId: 8, supplierName: "East", amountZmw: "37.62" },
      ],
    }],
    payments: [{ paymentDate: "2025-02-21", amountZmw: "20.00" }],
  });

  assert.deepEqual(monthly, [
    {
      month: "2025-02", orderedGoodsZmw: "0.00", importCostsZmw: "75.25", paymentsZmw: "20.00",
      suppliers: [
        { supplierId: 8, supplierName: "East", orderedGoodsZmw: "0.00", importCostsZmw: "37.62" },
        { supplierId: 7, supplierName: "North", orderedGoodsZmw: "0.00", importCostsZmw: "37.63" },
      ],
    },
  ]);
});
