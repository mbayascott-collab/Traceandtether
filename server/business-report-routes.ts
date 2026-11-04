import { desc, eq } from "drizzle-orm";
import type { Express, RequestHandler } from "express";
import {
  accountingAccounts, customers, inventoryMovements, inventoryReservations, journalEntries, journalLines,
  products, purchaseOrderLines, purchaseOrders, salesDeliveryLines, salesDeliveries, salesOrderLines, salesOrders, shipmentLines,
} from "../shared/schema";
import { calculateProductProfitability, toMinorUnits } from "../shared/money";
import { forecastCashWithin30Days, suggestedReorderQuantity } from "../shared/business-planning";
import { accountBalance, formatCents } from "./accounting-posting";
import { db } from "./db";

const cents = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
};
const from = (value: bigint) => formatCents(value);
const validDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export function registerBusinessReportRoutes(app: Express, owner: RequestHandler) {
  app.get("/api/business-dashboard", owner, async (_req, res) => {
    const monthStart = `${new Date().toISOString().slice(0, 8)}01`;
    const salesWindowStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [allProducts, allCustomers, orders, movements, reservations, lines, deliveryRows, purchaseHeaders, purchaseLines, postedShipLines, accountBalances] = await Promise.all([
      db.select().from(products).orderBy(desc(products.updatedAt)),
      db.select({ id: customers.id }).from(customers),
      db.select({ order: salesOrders, customerName: customers.name }).from(salesOrders)
        .innerJoin(customers, eq(salesOrders.customerId, customers.id)).orderBy(desc(salesOrders.createdAt)),
      db.select({ productId: inventoryMovements.productId, quantityDelta: inventoryMovements.quantityDelta }).from(inventoryMovements),
      db.select({ productId: inventoryReservations.productId, quantity: inventoryReservations.quantity })
        .from(inventoryReservations).where(eq(inventoryReservations.status, "active")),
      db.select({ orderId: salesOrderLines.salesOrderId, productId: salesOrderLines.productId, quantity: salesOrderLines.quantity, price: salesOrderLines.unitPriceZmw }).from(salesOrderLines),
      db.select({
        orderId: salesDeliveries.salesOrderId, deliveryDate: salesDeliveries.deliveryDate,
        productId: salesOrderLines.productId, quantity: salesDeliveryLines.quantity, price: salesOrderLines.unitPriceZmw,
      }).from(salesDeliveryLines)
        .innerJoin(salesDeliveries, eq(salesDeliveryLines.deliveryId, salesDeliveries.id))
        .innerJoin(salesOrderLines, eq(salesDeliveryLines.salesOrderLineId, salesOrderLines.id)),
      db.select({ id: purchaseOrders.id, status: purchaseOrders.status }).from(purchaseOrders),
      db.select().from(purchaseOrderLines),
      db.select({ purchaseOrderLineId: shipmentLines.purchaseOrderLineId, quantityStocked: shipmentLines.quantityStocked }).from(shipmentLines),
      Promise.all([
        accountBalance(db, "inventory"), accountBalance(db, "cash_bank"),
        accountBalance(db, "accounts_receivable"), accountBalance(db, "accounts_payable"),
      ]),
    ]);
    const [inventoryValue, cashBalance, receivablesRaw, payablesRaw] = accountBalances;
    const onHand = new Map<number, number>(), reserved = new Map<number, number>();
    for (const row of movements) onHand.set(row.productId, (onHand.get(row.productId) ?? 0) + row.quantityDelta);
    for (const row of reservations) reserved.set(row.productId, (reserved.get(row.productId) ?? 0) + row.quantity);
    const ordersWithDeliveries = new Set(deliveryRows.map((row) => row.orderId));
    const monthSales = deliveryRows.reduce((total, row) => row.deliveryDate >= monthStart ? total + cents(row.price) * BigInt(row.quantity) : total, 0n)
      + lines.reduce((total, line) => {
        const order = orders.find(({ order: row }) => row.id === line.orderId)?.order;
        return order?.status === "fulfilled" && !ordersWithDeliveries.has(line.orderId) && order.orderDate >= monthStart
          ? total + cents(line.price) * BigInt(line.quantity) : total;
      }, 0n);
    const demand = new Map<number, number>();
    for (const row of deliveryRows) if (row.deliveryDate >= salesWindowStart) demand.set(row.productId, (demand.get(row.productId) ?? 0) + row.quantity);
    const recentFulfilledIds = new Set(orders.filter(({ order }) => order.status === "fulfilled" && !ordersWithDeliveries.has(order.id) && order.orderDate >= salesWindowStart).map(({ order }) => order.id));
    for (const line of lines) if (recentFulfilledIds.has(line.orderId)) demand.set(line.productId, (demand.get(line.productId) ?? 0) + line.quantity);
    const purchaseStatus = new Map(purchaseHeaders.map((order) => [order.id, order.status]));
    const stockedByLine = new Map<number, number>();
    for (const line of postedShipLines) stockedByLine.set(line.purchaseOrderLineId, (stockedByLine.get(line.purchaseOrderLineId) ?? 0) + line.quantityStocked);
    const incoming = new Map<number, number>();
    for (const line of purchaseLines) {
      if (purchaseStatus.get(line.purchaseOrderId) === "cancelled") continue;
      incoming.set(line.productId, (incoming.get(line.productId) ?? 0) + Math.max(0, line.quantityOrdered - (stockedByLine.get(line.id) ?? 0)));
    }
    const replenishment = allProducts.filter((product) => product.status === "active" && product.reorderThreshold > 0)
      .map((product) => {
        const available = Math.max(0, (onHand.get(product.id) ?? 0) - (reserved.get(product.id) ?? 0));
        const incomingQty = incoming.get(product.id) ?? 0;
        return {
          id: product.id, name: product.name, sku: product.sku, supplierName: product.supplierName,
          available, incoming: incomingQty, salesLast90Days: demand.get(product.id) ?? 0,
          reorderLevel: product.reorderThreshold,
          suggestedQuantity: suggestedReorderQuantity(onHand.get(product.id) ?? 0, reserved.get(product.id) ?? 0, incomingQty, product.reorderThreshold),
        };
      }).filter((product) => product.suggestedQuantity > 0)
      .sort((a, b) => a.suggestedQuantity - b.suggestedQuantity).slice(0, 12);
    const recentOrders = orders.slice(0, 6).map(({ order, customerName }) => ({
      id: order.id, orderNumber: order.orderNumber, customerName, status: order.status, orderDate: order.orderDate,
    }));
    const forecast = forecastCashWithin30Days(cashBalance, receivablesRaw, payablesRaw);
    res.json({
      metrics: {
        products: allProducts.length, activeProducts: allProducts.filter((p) => p.status === "active").length,
        customers: allCustomers.length, openOrders: orders.filter(({ order }) => order.status === "draft" || order.status === "confirmed" || order.status === "partially_fulfilled").length,
        monthSalesZmw: from(monthSales), inStockProducts: allProducts.filter((p) => (onHand.get(p.id) ?? 0) - (reserved.get(p.id) ?? 0) > 0).length,
        inventoryValueZmw: from(inventoryValue),
      },
      cashForecast: {
        recordedCashZmw: from(forecast.recordedCash), expectedReceiptsZmw: from(forecast.expectedReceipts),
        expectedPaymentsZmw: from(forecast.expectedPayments), estimatedClosingZmw: from(forecast.estimatedClosing),
        assumption: "Current unpaid balances are collected or paid within 30 days; no new sales or costs are assumed.",
      },
      replenishment, recentOrders, monthStart, salesWindowStart,
    });
  });

  app.get("/api/profitability", owner, async (req, res) => {
    const fromDate = typeof req.query.from === "string" ? req.query.from : "";
    const toDate = typeof req.query.to === "string" ? req.query.to : "";
    if ((fromDate && !validDate(fromDate)) || (toDate && !validDate(toDate)) || (fromDate && toDate && fromDate > toDate)) {
      return res.status(400).json({ error: "Choose a valid date range." });
    }
    const [allProducts, orders, lines, deliveryRows, costLines] = await Promise.all([
      db.select({ id: products.id, name: products.name, sku: products.sku, unit: products.unit, estimatedLandedCostZmw: products.estimatedLandedCostZmw })
        .from(products).orderBy(products.name),
      db.select({ id: salesOrders.id, status: salesOrders.status, orderDate: salesOrders.orderDate }).from(salesOrders),
      db.select().from(salesOrderLines),
      db.select({
        orderId: salesDeliveries.salesOrderId, deliveryDate: salesDeliveries.deliveryDate,
        productId: salesOrderLines.productId, quantity: salesDeliveryLines.quantity, price: salesOrderLines.unitPriceZmw,
      }).from(salesDeliveryLines)
        .innerJoin(salesDeliveries, eq(salesDeliveryLines.deliveryId, salesDeliveries.id))
        .innerJoin(salesOrderLines, eq(salesDeliveryLines.salesOrderLineId, salesOrderLines.id)),
      db.select({ productId: journalLines.productId, debitZmw: journalLines.debitZmw, entryDate: journalEntries.entryDate })
        .from(journalLines).innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
        .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
        .where(eq(accountingAccounts.systemKey, "cost_of_goods_sold")),
    ]);
    const ordersWithDeliveries = new Set(deliveryRows.map((row) => row.orderId));
    const revenue = new Map<number, bigint>(), units = new Map<number, number>();
    for (const row of deliveryRows) {
      if ((fromDate && row.deliveryDate < fromDate) || (toDate && row.deliveryDate > toDate)) continue;
      revenue.set(row.productId, (revenue.get(row.productId) ?? 0n) + cents(row.price) * BigInt(row.quantity));
      units.set(row.productId, (units.get(row.productId) ?? 0) + row.quantity);
    }
    for (const line of lines) {
      const order = orders.find((item) => item.id === line.salesOrderId);
      if (!order || order.status !== "fulfilled" || ordersWithDeliveries.has(order.id) || (fromDate && order.orderDate < fromDate) || (toDate && order.orderDate > toDate)) continue;
      revenue.set(line.productId, (revenue.get(line.productId) ?? 0n) + cents(line.unitPriceZmw) * BigInt(line.quantity));
      units.set(line.productId, (units.get(line.productId) ?? 0) + line.quantity);
    }
    const costs = new Map<number, bigint>();
    for (const line of costLines) {
      if (line.productId == null || (fromDate && line.entryDate < fromDate) || (toDate && line.entryDate > toDate)) continue;
      costs.set(line.productId, (costs.get(line.productId) ?? 0n) + cents(line.debitZmw));
    }
    let totalRevenue = 0n, totalRecordedCost = 0n, totalEstimatedProfit = 0n;
    let missingCostProducts = 0, missingEstimateProducts = 0;
    const rows = allProducts.map((product) => {
      const productRevenue = revenue.get(product.id) ?? 0n;
      const productCost = costs.get(product.id);
      const quantity = units.get(product.id) ?? 0;
      const actual = productCost == null ? null : calculateProductProfitability(from(productRevenue), from(productCost));
      const unitEstimate = toMinorUnits(product.estimatedLandedCostZmw);
      const estimatedProfit = quantity > 0 && unitEstimate != null ? productRevenue - unitEstimate * BigInt(quantity) : null;
      totalRevenue += productRevenue;
      if (productCost != null) totalRecordedCost += productCost;
      if (estimatedProfit != null) totalEstimatedProfit += estimatedProfit;
      if (quantity > 0 && productCost == null) missingCostProducts += 1;
      if (quantity > 0 && unitEstimate == null) missingEstimateProducts += 1;
      return {
        productId: product.id, name: product.name, sku: product.sku, unit: product.unit, unitsSold: quantity,
        salesZmw: quantity ? from(productRevenue) : null,
        recordedCostZmw: productCost == null ? null : from(productCost),
        recordedGrossProfitZmw: actual?.estimatedGrossProfitZmw ?? null,
        recordedGrossMarginPercent: actual?.estimatedGrossMarginPercent ?? null,
        estimatedGrossProfitZmw: estimatedProfit == null ? null : from(estimatedProfit),
        costStatus: quantity === 0 ? "no_sales" : productCost == null ? "missing" : "recorded",
      };
    });
    const totalsAreComplete = missingCostProducts === 0;
    const totalActualProfit = totalsAreComplete ? totalRevenue - totalRecordedCost : null;
    res.json({
      period: { from: fromDate || null, to: toDate || null },
      totals: {
        salesZmw: from(totalRevenue), recordedCostZmw: from(totalRecordedCost),
        recordedGrossProfitZmw: totalActualProfit == null ? null : from(totalActualProfit),
        recordedGrossMarginPercent: totalActualProfit != null && totalRevenue > 0n ? calculateProductProfitability(from(totalRevenue), from(totalRecordedCost)).estimatedGrossMarginPercent : null,
        estimatedGrossProfitZmw: missingEstimateProducts === 0 ? from(totalEstimatedProfit) : null,
        productsMissingRecordedCost: missingCostProducts, productsMissingEstimatedCost: missingEstimateProducts,
      },
      products: rows,
    });
  });
}
