import assert from "node:assert/strict";
import test from "node:test";
import { calculateDashboardSales, calculateSalesActivity } from "./sales-analytics";

test("dashboard sales and demand exclude cancelled deliveries but include undelivered fulfillments", () => {
  const activity = calculateDashboardSales({
    monthStart: "2025-02-01",
    salesWindowStart: "2024-11-01",
    orders: [
      { id: 1, status: "partially_fulfilled", orderDate: "2025-02-01" },
      { id: 2, status: "cancelled", orderDate: "2025-02-10" },
      { id: 3, status: "fulfilled", orderDate: "2025-02-15" },
    ],
    lines: [
      { orderId: 1, productId: 100, quantity: 10, price: "10.00" },
      { orderId: 2, productId: 200, quantity: 7, price: "100.00" },
      { orderId: 3, productId: 300, quantity: 2, price: "25.00" },
    ],
    deliveries: [
      { orderId: 1, deliveryDate: "2025-02-05", productId: 100, quantity: 3, price: "10.00", orderStatus: "partially_fulfilled" },
      { orderId: 2, deliveryDate: "2025-02-12", productId: 200, quantity: 7, price: "100.00", orderStatus: "cancelled" },
    ],
  });

  assert.equal(activity.monthSales, 8_000n);
  assert.deepEqual([...activity.demand.entries()].sort(([a], [b]) => a - b), [
    [100, 3],
    [300, 2],
  ]);
});

test("dashboard counts multiple deliveries for a fulfilled order without adding its full order lines", () => {
  const activity = calculateDashboardSales({
    monthStart: "2025-02-01",
    salesWindowStart: "2024-11-01",
    orders: [{ id: 1, status: "fulfilled", orderDate: "2025-02-10" }],
    lines: [{ orderId: 1, productId: 100, quantity: 8, price: "10.00" }],
    deliveries: [
      { orderId: 1, deliveryDate: "2025-02-12", productId: 100, quantity: 3, price: "10.00", orderStatus: "fulfilled" },
      { orderId: 1, deliveryDate: "2025-02-14", productId: 100, quantity: 5, price: "10.00", orderStatus: "fulfilled" },
    ],
  });

  assert.equal(activity.monthSales, 8_000n);
  assert.deepEqual([...activity.demand.entries()], [[100, 8]]);
});

test("dashboard sales and demand exclude undelivered fulfillments older than both windows", () => {
  const activity = calculateDashboardSales({
    monthStart: "2025-02-01",
    salesWindowStart: "2024-11-01",
    orders: [{ id: 1, status: "fulfilled", orderDate: "2024-10-31" }],
    lines: [{ orderId: 1, productId: 100, quantity: 99, price: "9999.99" }],
    deliveries: [],
  });

  assert.equal(activity.monthSales, 0n);
  assert.deepEqual([...activity.demand.entries()], []);
});

test("counts partial deliveries and undelivered fulfillments once within inclusive period bounds", () => {
  const report = calculateSalesActivity({
    fromDate: "2025-01-31",
    toDate: "2025-02-28",
    orders: [
      { id: 1, status: "partially_fulfilled", orderDate: "2025-01-30", customerId: 10, customerName: "Amina" },
      { id: 2, status: "fulfilled", orderDate: "2025-02-28", customerId: 20, customerName: "Banda" },
      { id: 3, status: "fulfilled", orderDate: "2025-02-10", customerId: 10, customerName: "Amina" },
      { id: 4, status: "confirmed", orderDate: "2025-02-15", customerId: 30, customerName: "Chola" },
      { id: 5, status: "cancelled", orderDate: "2025-02-20", customerId: 40, customerName: "Daka" },
      { id: 6, status: "partially_fulfilled", orderDate: "2025-01-31", customerId: 50, customerName: "Eunice" },
      { id: 7, status: "fulfilled", orderDate: "2025-01-30", customerId: 60, customerName: "Fumbani" },
    ],
    lines: [
      { salesOrderId: 1, productId: 100, quantity: 10, unitPriceZmw: "50.00" },
      { salesOrderId: 2, productId: 200, quantity: 2, unitPriceZmw: "100.00" },
      { salesOrderId: 3, productId: 100, quantity: 1, unitPriceZmw: "70.00" },
      { salesOrderId: 4, productId: 300, quantity: 4, unitPriceZmw: "25.00" },
      { salesOrderId: 5, productId: 300, quantity: 1, unitPriceZmw: "500.00" },
      { salesOrderId: 6, productId: 300, quantity: 1, unitPriceZmw: "30.00" },
      { salesOrderId: 7, productId: 300, quantity: 1, unitPriceZmw: "40.00" },
    ],
    deliveries: [
      { orderId: 1, deliveryDate: "2025-01-31", customerId: 10, customerName: "Amina", productId: 100, quantity: 2, price: "50.00", orderStatus: "partially_fulfilled" },
      { orderId: 1, deliveryDate: "2025-02-01", customerId: 10, customerName: "Amina", productId: 100, quantity: 3, price: "50.00", orderStatus: "partially_fulfilled" },
      { orderId: 3, deliveryDate: "2025-02-10", customerId: 10, customerName: "Amina", productId: 100, quantity: 1, price: "70.00", orderStatus: "fulfilled" },
      { orderId: 5, deliveryDate: "2025-02-20", customerId: 40, customerName: "Daka", productId: 300, quantity: 1, price: "500.00", orderStatus: "cancelled" },
      { orderId: 6, deliveryDate: "2025-01-30", customerId: 50, customerName: "Eunice", productId: 300, quantity: 1, price: "30.00", orderStatus: "partially_fulfilled" },
      { orderId: 6, deliveryDate: "2025-03-01", customerId: 50, customerName: "Eunice", productId: 300, quantity: 1, price: "30.00", orderStatus: "partially_fulfilled" },
    ],
  });

  assert.deepEqual(report.salesByMonth, [
    { month: "2025-01", revenue: 10_000n },
    { month: "2025-02", revenue: 42_000n },
  ]);
  assert.deepEqual(report.products, [
    { productId: 100, revenue: 32_000n, units: 6 },
    { productId: 200, revenue: 20_000n, units: 2 },
  ]);
  assert.deepEqual(report.customers, [
    { customerId: 10, name: "Amina", revenue: 32_000n, orders: 2 },
    { customerId: 20, name: "Banda", revenue: 20_000n, orders: 1 },
  ]);
  assert.equal(report.totalRevenue, 52_000n);
  assert.deepEqual(report.summary, {
    customersWithSales: 2,
    repeatCustomers: 1,
    fulfilledOrders: 3,
    unitsDelivered: 8,
  });
});

test("returns zero-sales months across a selected range with no sales", () => {
  const report = calculateSalesActivity({
    fromDate: "2025-04-01",
    toDate: "2025-06-30",
    orders: [],
    lines: [],
    deliveries: [],
  });

  assert.deepEqual(report.salesByMonth, [
    { month: "2025-04", revenue: 0n },
    { month: "2025-05", revenue: 0n },
    { month: "2025-06", revenue: 0n },
  ]);
  assert.equal(report.totalRevenue, 0n);
  assert.equal(report.summary.fulfilledOrders, 0);
});
