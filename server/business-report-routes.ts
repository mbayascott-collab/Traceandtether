import { desc, eq } from "drizzle-orm";
import type { Express, RequestHandler } from "express";
import {
  accountingAccounts, customers, inventoryMovements, inventoryReservations, journalEntries, journalLines,
  products, salesOrderLines, salesOrders,
} from "../shared/schema";
import { calculateProductProfitability, toMinorUnits } from "../shared/money";
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
    const [allProducts, allCustomers, orders, movements, reservations, lines, inventoryValue] = await Promise.all([
      db.select().from(products).orderBy(desc(products.updatedAt)),
      db.select({ id: customers.id }).from(customers),
      db.select({ order: salesOrders, customerName: customers.name }).from(salesOrders)
        .innerJoin(customers, eq(salesOrders.customerId, customers.id)).orderBy(desc(salesOrders.createdAt)),
      db.select({ productId: inventoryMovements.productId, quantityDelta: inventoryMovements.quantityDelta }).from(inventoryMovements),
      db.select({ productId: inventoryReservations.productId, quantity: inventoryReservations.quantity })
        .from(inventoryReservations).where(eq(inventoryReservations.status, "active")),
      db.select({ orderId: salesOrderLines.salesOrderId, quantity: salesOrderLines.quantity, price: salesOrderLines.unitPriceZmw }).from(salesOrderLines),
      accountBalance(db, "inventory"),
    ]);
    const onHand = new Map<number, number>(), reserved = new Map<number, number>();
    for (const row of movements) onHand.set(row.productId, (onHand.get(row.productId) ?? 0) + row.quantityDelta);
    for (const row of reservations) reserved.set(row.productId, (reserved.get(row.productId) ?? 0) + row.quantity);
    const fulfilledIds = new Set(orders.filter(({ order }) => order.status === "fulfilled" && order.orderDate >= monthStart).map(({ order }) => order.id));
    const monthSales = lines.reduce((total, line) => fulfilledIds.has(line.orderId) ? total + cents(line.price) * BigInt(line.quantity) : total, 0n);
    const lowStock = allProducts.filter((product) => product.status === "active" && product.reorderThreshold > 0)
      .map((product) => ({ id: product.id, name: product.name, sku: product.sku, available: Math.max(0, (onHand.get(product.id) ?? 0) - (reserved.get(product.id) ?? 0)), threshold: product.reorderThreshold }))
      .filter((product) => product.available <= product.threshold)
      .sort((a, b) => a.available - b.available).slice(0, 8);
    const recentOrders = orders.slice(0, 6).map(({ order, customerName }) => ({
      id: order.id, orderNumber: order.orderNumber, customerName, status: order.status, orderDate: order.orderDate,
    }));
    res.json({
      metrics: {
        products: allProducts.length, activeProducts: allProducts.filter((p) => p.status === "active").length,
        customers: allCustomers.length, openOrders: orders.filter(({ order }) => order.status === "draft" || order.status === "confirmed").length,
        monthSalesZmw: from(monthSales), inStockProducts: allProducts.filter((p) => (onHand.get(p.id) ?? 0) - (reserved.get(p.id) ?? 0) > 0).length,
        inventoryValueZmw: from(inventoryValue),
      },
      lowStock, recentOrders, monthStart,
    });
  });

  app.get("/api/profitability", owner, async (req, res) => {
    const fromDate = typeof req.query.from === "string" ? req.query.from : "";
    const toDate = typeof req.query.to === "string" ? req.query.to : "";
    if ((fromDate && !validDate(fromDate)) || (toDate && !validDate(toDate)) || (fromDate && toDate && fromDate > toDate)) {
      return res.status(400).json({ error: "Choose a valid date range." });
    }
    const [allProducts, orders, lines, costLines] = await Promise.all([
      db.select({ id: products.id, name: products.name, sku: products.sku, unit: products.unit, estimatedLandedCostZmw: products.estimatedLandedCostZmw })
        .from(products).orderBy(products.name),
      db.select({ id: salesOrders.id, orderDate: salesOrders.orderDate }).from(salesOrders).where(eq(salesOrders.status, "fulfilled")),
      db.select().from(salesOrderLines),
      db.select({ productId: journalLines.productId, debitZmw: journalLines.debitZmw, entryDate: journalEntries.entryDate })
        .from(journalLines).innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
        .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
        .where(eq(accountingAccounts.systemKey, "cost_of_goods_sold")),
    ]);
    const orderById = new Map(orders.map((order) => [order.id, order]));
    const revenue = new Map<number, bigint>(), units = new Map<number, number>();
    for (const line of lines) {
      const order = orderById.get(line.salesOrderId);
      if (!order || (fromDate && order.orderDate < fromDate) || (toDate && order.orderDate > toDate)) continue;
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
