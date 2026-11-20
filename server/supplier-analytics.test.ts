import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test from "node:test";
import { inArray } from "drizzle-orm";
import {
  businessPayments, importExpenses, products, purchaseOrderLines, purchaseOrders,
  shipmentPurchaseOrders, shipments, suppliers,
} from "../shared/schema";
import { supplierDeliveryMetrics, supplierMonthlySpend, supplierShipmentDetails } from "./supplier-analytics";
import { supplierReportCsv, supplierReportForSupplier } from "../shared/supplier-report-csv";

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
       suppliers: [{
         supplierId: 7, supplierName: 'North "Trading"', orderedGoodsZmw: "240.00",
         importCostsZmw: "30.00", paymentsZmw: "120.00",
       }],
    }],
    totals: {
      orderedGoodsZmw: "240.00", importCostsZmw: "35.00", unallocatedImportCostsZmw: "5.00", paymentsZmw: "120.00",
      orders: 2, onTimeOrders: 1, lateOrders: 1, overdueOpenOrders: 0, missingExpectedDateOrders: 0,
      missingActualDateOrders: 0, incompleteDeliveryOrders: 0, measuredDeliveryOrders: 2,
    },
    suppliers: [{
      supplierId: 7, name: 'North "Trading"', orders: 2, orderedGoodsZmw: "240.00", importCostsZmw: "30.00", paymentsZmw: "120.00",
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
    shipments: [{
      supplierId: 9, supplierName: "@HIDDEN", orderNumber: "=PO-1", shipmentId: 2,
      shipmentReference: "+SUM(1,1)", status: "received", expectedAt: null, receivedAt: null,
    }],
    totals: {
      orderedGoodsZmw: "0.00", importCostsZmw: "0.00", unallocatedImportCostsZmw: "0.00", paymentsZmw: "0.00",
      orders: 0, onTimeOrders: 0, lateOrders: 0, overdueOpenOrders: 0, missingExpectedDateOrders: 0,
      missingActualDateOrders: 0, incompleteDeliveryOrders: 0, measuredDeliveryOrders: 0,
    },
    suppliers: [{
      supplierId: 9, name: "=HYPERLINK(\"https://example.invalid\")", orders: 0, orderedGoodsZmw: "0.00", importCostsZmw: "0.00",
      paymentsZmw: "0.00", measuredDeliveryOrders: 0, onTimeOrders: 0, lateOrders: 0, missingExpectedDateOrders: 0,
      missingActualDateOrders: 0, incompleteDeliveryOrders: 0, overdueOpenOrders: 0, averageDeliveryVarianceDays: null,
    }],
  });

  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.invalid""\)"/);
  assert.match(csv, /"'@HIDDEN","'=PO-1","2","'\+SUM\(1,1\)"/);
});

test("single-supplier reports keep only that supplier's values and preserve unallocated costs", () => {
  const report = {
    period: { from: "2025-01-01", to: "2025-01-31" },
    monthlySpend: [{
      month: "2025-01", orderedGoodsZmw: "300.00", importCostsZmw: "90.00", paymentsZmw: "50.00",
      suppliers: [
        { supplierId: 7, supplierName: "North", orderedGoodsZmw: "100.00", importCostsZmw: "30.00", paymentsZmw: "20.00" },
        { supplierId: 8, supplierName: "East", orderedGoodsZmw: "200.00", importCostsZmw: "60.00", paymentsZmw: "30.00" },
      ],
    }],
    shipments: [
      { supplierId: 7, supplierName: "North", orderNumber: "PO-N", shipmentId: 1, shipmentReference: null, status: "received", expectedAt: null, receivedAt: null },
      { supplierId: 8, supplierName: "East", orderNumber: "PO-E", shipmentId: 2, shipmentReference: null, status: "received", expectedAt: null, receivedAt: null },
    ],
    totals: {
      orderedGoodsZmw: "300.00", importCostsZmw: "105.00", unallocatedImportCostsZmw: "15.00", paymentsZmw: "50.00",
      orders: 3, onTimeOrders: 2, lateOrders: 1, overdueOpenOrders: 0, missingExpectedDateOrders: 0,
      missingActualDateOrders: 0, incompleteDeliveryOrders: 0, measuredDeliveryOrders: 3,
    },
    suppliers: [
      {
        supplierId: 7, name: "North", orders: 1, orderedGoodsZmw: "100.00", importCostsZmw: "30.00", paymentsZmw: "20.00",
        measuredDeliveryOrders: 1, onTimeOrders: 1, lateOrders: 0, missingExpectedDateOrders: 0,
        missingActualDateOrders: 0, incompleteDeliveryOrders: 0, overdueOpenOrders: 0, averageDeliveryVarianceDays: "0.0",
      },
      {
        supplierId: 8, name: "East", orders: 2, orderedGoodsZmw: "200.00", importCostsZmw: "60.00", paymentsZmw: "30.00",
        measuredDeliveryOrders: 2, onTimeOrders: 1, lateOrders: 1, missingExpectedDateOrders: 0,
        missingActualDateOrders: 0, incompleteDeliveryOrders: 0, overdueOpenOrders: 0, averageDeliveryVarianceDays: "1.0",
      },
    ],
  };
  const filtered = supplierReportForSupplier(report, 7);
  assert.deepEqual(filtered.suppliers.map((supplier) => supplier.name), ["North"]);
  assert.deepEqual(filtered.shipments.map((shipment) => shipment.orderNumber), ["PO-N"]);
  assert.deepEqual(filtered.totals, {
    ...report.totals,
    orderedGoodsZmw: "100.00", importCostsZmw: "30.00", paymentsZmw: "20.00",
    orders: 1, onTimeOrders: 1, lateOrders: 0, measuredDeliveryOrders: 1,
  });
  assert.deepEqual(filtered.monthlySpend[0]?.suppliers, [report.monthlySpend[0]!.suppliers[0]]);
  assert.equal(filtered.monthlySpend[0]?.orderedGoodsZmw, "100.00");
  assert.equal(filtered.monthlySpend[0]?.paymentsZmw, "20.00");
  const csv = supplierReportCsv(filtered);
  assert.match(csv, /"15\.00"|"15.00"/, "unallocated costs remain visible in the single-supplier export");
  assert.doesNotMatch(csv, /"PO-E"|"East"/);
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
      { supplierId: 7, supplierName: "North", paymentDate: "2025-03-01", amountZmw: "60.00" },
      { supplierId: 7, supplierName: "North", paymentDate: "2025-01-15", amountZmw: "40.00" },
    ],
  });

  assert.deepEqual(monthly, [
    {
      month: "2025-01", orderedGoodsZmw: "100.00", importCostsZmw: "0.00", paymentsZmw: "40.00",
       suppliers: [{ supplierId: 7, supplierName: "North", orderedGoodsZmw: "100.00", importCostsZmw: "0.00", paymentsZmw: "40.00" }],
    },
    {
      month: "2025-02", orderedGoodsZmw: "50.00", importCostsZmw: "30.00", paymentsZmw: "0.00",
      suppliers: [
         { supplierId: 8, supplierName: "East", orderedGoodsZmw: "50.00", importCostsZmw: "0.00", paymentsZmw: "0.00" },
         { supplierId: 7, supplierName: "North", orderedGoodsZmw: "0.00", importCostsZmw: "30.00", paymentsZmw: "0.00" },
      ],
    },
    {
      month: "2025-03", orderedGoodsZmw: "0.00", importCostsZmw: "20.00", paymentsZmw: "60.00",
       suppliers: [{ supplierId: 7, supplierName: "North", orderedGoodsZmw: "0.00", importCostsZmw: "20.00", paymentsZmw: "60.00" }],
    },
  ]);
});

test("monthly supplier spend includes both date boundaries and excludes adjacent dates", () => {
  const monthly = supplierMonthlySpend({
    fromDate: "2025-02-10",
    toDate: "2025-02-20",
    purchaseLines: [
      { supplierId: 7, supplierName: "North", orderedAt: "2025-02-09", status: "received", totalZmw: "10.00" },
      { supplierId: 7, supplierName: "North", orderedAt: "2025-02-10", status: "received", totalZmw: "20.00" },
      { supplierId: 7, supplierName: "North", orderedAt: "2025-02-20", status: "received", totalZmw: "30.00" },
      { supplierId: 7, supplierName: "North", orderedAt: "2025-02-21", status: "received", totalZmw: "40.00" },
    ],
    expenses: [
      { incurredAt: "2025-02-09", amountZmw: "1.00", allocations: [] },
      { incurredAt: "2025-02-10", amountZmw: "2.00", allocations: [] },
      { incurredAt: "2025-02-20", amountZmw: "3.00", allocations: [] },
      { incurredAt: "2025-02-21", amountZmw: "4.00", allocations: [] },
    ],
    payments: [
      { supplierId: 7, supplierName: "North", paymentDate: "2025-02-09", amountZmw: "1.00" },
      { supplierId: 7, supplierName: "North", paymentDate: "2025-02-10", amountZmw: "2.00" },
      { supplierId: 7, supplierName: "North", paymentDate: "2025-02-20", amountZmw: "3.00" },
      { supplierId: 7, supplierName: "North", paymentDate: "2025-02-21", amountZmw: "4.00" },
    ],
  });

  assert.deepEqual(monthly, [{
    month: "2025-02",
    orderedGoodsZmw: "50.00",
    importCostsZmw: "5.00",
    paymentsZmw: "5.00",
     suppliers: [{ supplierId: 7, supplierName: "North", orderedGoodsZmw: "50.00", importCostsZmw: "0.00", paymentsZmw: "5.00" }],
  }]);
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
     payments: [{ supplierId: 7, supplierName: "North", paymentDate: "2025-02-21", amountZmw: "20.00" }],
  });

  assert.deepEqual(monthly, [
    {
      month: "2025-02", orderedGoodsZmw: "0.00", importCostsZmw: "75.25", paymentsZmw: "20.00",
      suppliers: [
         { supplierId: 8, supplierName: "East", orderedGoodsZmw: "0.00", importCostsZmw: "37.62", paymentsZmw: "0.00" },
         { supplierId: 7, supplierName: "North", orderedGoodsZmw: "0.00", importCostsZmw: "37.63", paymentsZmw: "20.00" },
      ],
    },
  ]);
});

test("supplier analytics includes date boundaries, excludes adjacent dates, and reconciles totals", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [{ db, pool }, { registerBusinessReportRoutes }] = await Promise.all([
    import("./db"),
    import("./business-report-routes"),
  ]);
  const suffix = randomUUID();
  const app = express();
  const owner: RequestHandler = (_req, _res, next) => next();
  registerBusinessReportRoutes(app, owner);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let supplierIds: number[] = [];
  let productId: number | undefined;
  let purchaseOrderIds: number[] = [];
  let shipmentId: number | undefined;
  let outsideShipmentId: number | undefined;
  let expenseIds: number[] = [];
  let paymentIds: number[] = [];

  try {
    const createdSuppliers = await db.insert(suppliers).values([
      { name: `Monthly reconciliation North ${suffix}` },
      { name: `Monthly reconciliation East ${suffix}` },
    ]).returning();
    supplierIds = createdSuppliers.map(({ id }) => id);
    const [north, east] = createdSuppliers;
    assert.ok(north && east);

    const [product] = await db.insert(products).values({
      sku: `MRE-${suffix}`,
      name: `Monthly reconciliation product ${suffix}`,
      status: "active",
    }).returning();
    productId = product.id;

    const createdOrders = await db.insert(purchaseOrders).values([
      {
        orderNumber: `MRE-N-${suffix.slice(0, 12)}`, supplierId: north.id,
        status: "received", currency: "USD", exchangeRateToZmw: "2",
        orderedAt: "2097-01-01",
      },
      {
        orderNumber: `MRE-E-${suffix.slice(0, 12)}`, supplierId: east.id,
        status: "received", currency: "GBP", exchangeRateToZmw: "4",
        orderedAt: "2097-03-31",
      },
    ]).returning();
    purchaseOrderIds = createdOrders.map(({ id }) => id);
    const [northOrder, eastOrder] = createdOrders;
    assert.ok(northOrder && eastOrder);

    const outsideOrders = await db.insert(purchaseOrders).values([
      {
        orderNumber: `MRE-B-${suffix.slice(0, 12)}`, supplierId: north.id,
        status: "received", currency: "USD", exchangeRateToZmw: "2",
        orderedAt: "2096-12-31",
      },
      {
        orderNumber: `MRE-A-${suffix.slice(0, 12)}`, supplierId: east.id,
        status: "received", currency: "GBP", exchangeRateToZmw: "4",
        orderedAt: "2097-04-01",
      },
    ]).returning();
    purchaseOrderIds.push(...outsideOrders.map(({ id }) => id));

    const lines = await db.insert(purchaseOrderLines).values([
      { purchaseOrderId: northOrder.id, productId, quantityOrdered: 2, unitPrice: "100.00" },
      { purchaseOrderId: eastOrder.id, productId, quantityOrdered: 1, unitPrice: "50.00" },
      ...outsideOrders.map((order) => ({
        purchaseOrderId: order.id, productId: product.id, quantityOrdered: 1, unitPrice: "500.00",
      })),
    ]).returning();

    const [shipment] = await db.insert(shipments).values({
      purchaseOrderId: northOrder.id,
      shipmentReference: `MRE-S-${suffix.slice(0, 12)}`,
      status: "received",
      receivedAt: "2097-02-20",
    }).returning();
    shipmentId = shipment.id;
    const [outsideShipment] = await db.insert(shipments).values({
      purchaseOrderId: outsideOrders[0]!.id,
      shipmentReference: `MRE-OUT-S-${suffix.slice(0, 10)}`,
      status: "received",
      receivedAt: "2097-02-20",
    }).returning();
    outsideShipmentId = outsideShipment.id;
    await db.insert(shipmentPurchaseOrders).values({
      shipmentId,
      purchaseOrderId: eastOrder.id,
    });

    const createdExpenses = await db.insert(importExpenses).values([
      {
        shipmentId, category: "freight", description: "Shared shipment cost",
        amount: "30.00", currency: "USD", exchangeRateToZmw: "2",
        basis: "value", incurredAt: "2097-01-01",
      },
      {
        purchaseOrderId: northOrder.id, category: "handling", description: "Order cost",
        amount: "10.00", currency: "USD", exchangeRateToZmw: "2",
        basis: "value", incurredAt: "2097-03-31",
      },
      {
        purchaseOrderId: northOrder.id, category: "handling", description: "Before range cost",
        amount: "100.00", currency: "USD", exchangeRateToZmw: "2",
        basis: "value", incurredAt: "2096-12-31",
      },
      {
        purchaseOrderId: northOrder.id, category: "handling", description: "After range cost",
        amount: "200.00", currency: "USD", exchangeRateToZmw: "2",
        basis: "value", incurredAt: "2097-04-01",
      },
    ]).returning();
    expenseIds = createdExpenses.map(({ id }) => id);

    const createdPayments = await db.insert(businessPayments).values([
      {
        paymentNumber: `MRE-P1-${suffix.slice(0, 10)}`,
        direction: "supplier_payment", purchaseOrderId: northOrder.id,
        amountZmw: "35.00", paymentDate: "2096-12-31", method: "bank_transfer",
      },
      {
        paymentNumber: `MRE-P2-${suffix.slice(0, 10)}`,
        direction: "supplier_payment", purchaseOrderId: eastOrder.id,
        amountZmw: "15.00", paymentDate: "2097-03-31", method: "bank_transfer",
      },
      {
        paymentNumber: `MRE-P3-${suffix.slice(0, 10)}`,
        direction: "supplier_payment", purchaseOrderId: outsideOrders[0]!.id,
        amountZmw: "70.00", paymentDate: "2097-02-20", method: "bank_transfer",
      },
      {
        paymentNumber: `MRE-P4-${suffix.slice(0, 10)}`,
        direction: "supplier_payment", purchaseOrderId: outsideOrders[1]!.id,
        amountZmw: "80.00", paymentDate: "2096-12-30", method: "bank_transfer",
      },
    ]).returning();
    paymentIds = createdPayments.map(({ id }) => id);
    assert.equal(lines.length, 4);

    const response = await fetch(
      `${baseUrl}/api/supplier-analytics?from=2097-01-01&to=2097-03-31`,
    );
    const payload = await response.json() as {
      period: { from: string | null; to: string | null };
      totals: { orders: number; orderedGoodsZmw: string; importCostsZmw: string; paymentsZmw: string };
      monthlySpend: {
        month: string; orderedGoodsZmw: string; importCostsZmw: string; paymentsZmw: string;
        suppliers: { supplierId: number; supplierName: string; orderedGoodsZmw: string; importCostsZmw: string; paymentsZmw: string }[];
      }[];
      suppliers: {
        supplierId: number; name: string; orderedGoodsZmw: string; importCostsZmw: string; paymentsZmw: string;
      }[];
      shipments: { shipmentId: number; supplierId: number; orderNumber: string }[];
    };
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.deepEqual(payload.period, { from: "2097-01-01", to: "2097-03-31" });

    const cents = (value: string) => {
      const [whole, fraction = ""] = value.split(".");
      return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    };
    const sumMonthly = (key: "orderedGoodsZmw" | "importCostsZmw" | "paymentsZmw") =>
      payload.monthlySpend.reduce((sum, month) => sum + cents(month[key]), 0n);
    assert.equal(payload.totals.orderedGoodsZmw, "600.00");
    assert.equal(payload.totals.importCostsZmw, "80.00");
    assert.equal(payload.totals.paymentsZmw, "85.00");
    assert.equal(payload.totals.orders, 2);
    assert.deepEqual(
      payload.shipments.map((row) => [row.shipmentId, row.supplierId, row.orderNumber]),
      [
        [shipment.id, east.id, eastOrder.orderNumber],
        [shipment.id, north.id, northOrder.orderNumber],
      ],
      "shipment details should include each linked in-range order once and exclude the out-of-range order",
    );
    assert.equal(sumMonthly("orderedGoodsZmw"), cents(payload.totals.orderedGoodsZmw));
    assert.equal(sumMonthly("importCostsZmw"), cents(payload.totals.importCostsZmw));
    assert.equal(sumMonthly("paymentsZmw"), cents(payload.totals.paymentsZmw));

    const january = payload.monthlySpend.find(({ month }) => month === "2097-01");
    assert.ok(january);
    assert.equal(january.orderedGoodsZmw, "400.00");
    assert.equal(january.importCostsZmw, "60.00");
    assert.equal(january.paymentsZmw, "0.00");
    assert.equal(cents(january.importCostsZmw), 6_000n, "the shared shipment expense must be counted once");
    const march = payload.monthlySpend.find(({ month }) => month === "2097-03");
    assert.ok(march);
    assert.equal(march.orderedGoodsZmw, "200.00");
    assert.equal(march.importCostsZmw, "20.00");
    assert.equal(march.paymentsZmw, "15.00");
    const february = payload.monthlySpend.find(({ month }) => month === "2097-02");
    assert.ok(february);
    assert.equal(february.paymentsZmw, "70.00", "payments follow their recorded date even when the order is outside the period");

    for (const supplier of payload.suppliers) {
      const monthlyRows = payload.monthlySpend.flatMap((month) =>
        month.suppliers.filter((row) => row.supplierId === supplier.supplierId),
      );
      assert.equal(
        monthlyRows.reduce((sum, row) => sum + cents(row.orderedGoodsZmw), 0n),
        cents(supplier.orderedGoodsZmw),
        `${supplier.name} monthly goods should match its report row`,
      );
      assert.equal(
        monthlyRows.reduce((sum, row) => sum + cents(row.importCostsZmw), 0n),
        cents(supplier.importCostsZmw),
        `${supplier.name} monthly import costs should match its report row`,
      );
      assert.equal(
        monthlyRows.reduce((sum, row) => sum + cents(row.paymentsZmw), 0n),
        cents(supplier.paymentsZmw),
        `${supplier.name} monthly payments should match its report row`,
      );
    }

    for (const [query, expectedPeriod] of [
      ["?from=2097-03-01", { from: "2097-03-01", to: null }],
      ["?to=2097-01-31", { from: null, to: "2097-01-31" }],
    ] as const) {
      const openRangeResponse = await fetch(`${baseUrl}/api/supplier-analytics${query}`);
      const openRange = await openRangeResponse.json() as {
        period: { from: string | null; to: string | null };
        totals: { orderedGoodsZmw: string; importCostsZmw: string; paymentsZmw: string };
        monthlySpend: { orderedGoodsZmw: string; importCostsZmw: string; paymentsZmw: string }[];
      };
      assert.equal(openRangeResponse.status, 200, JSON.stringify(openRange));
      assert.deepEqual(openRange.period, expectedPeriod);
      for (const key of ["orderedGoodsZmw", "importCostsZmw", "paymentsZmw"] as const) {
        assert.equal(
          openRange.monthlySpend.reduce((sum, month) => sum + cents(month[key]), 0n),
          cents(openRange.totals[key]),
          `open-ended date range should reconcile monthly ${key}`,
        );
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    try {
      if (paymentIds.length) await db.delete(businessPayments).where(inArray(businessPayments.id, paymentIds));
      if (expenseIds.length) await db.delete(importExpenses).where(inArray(importExpenses.id, expenseIds));
      if (shipmentId !== undefined) {
        await db.delete(shipmentPurchaseOrders).where(inArray(shipmentPurchaseOrders.shipmentId, [shipmentId]));
        await db.delete(shipments).where(inArray(shipments.id, [shipmentId]));
      }
      if (outsideShipmentId !== undefined) {
        await db.delete(shipments).where(inArray(shipments.id, [outsideShipmentId]));
      }
      if (purchaseOrderIds.length) {
        await db.delete(purchaseOrderLines).where(inArray(purchaseOrderLines.purchaseOrderId, purchaseOrderIds));
        await db.delete(purchaseOrders).where(inArray(purchaseOrders.id, purchaseOrderIds));
      }
      if (productId !== undefined) await db.delete(products).where(inArray(products.id, [productId]));
      if (supplierIds.length) await db.delete(suppliers).where(inArray(suppliers.id, supplierIds));
    } finally {
      await pool.end();
    }
  }
});
