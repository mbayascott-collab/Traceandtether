import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Express, RequestHandler } from "express";
import {
  accountingAccounts, businessPayments, customers, importExpenses, inventoryMovements, inventoryReservations, journalEntries, journalLines,
  products, purchaseOrderLines, purchaseOrders, salesDeliveryLines, salesDeliveries, salesOrderLines, salesOrders,
  shipmentLines, shipmentPurchaseOrders, shipments, suppliers,
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
        accountBalance(db, "inventory"),
        Promise.all(["cash_bank", "cash_on_hand", "bank_account", "mobile_money", "other_funds"]
          .map((key) => accountBalance(db, key))).then((balances) => balances.reduce((total, value) => total + value, 0n)),
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
      db.select({
        id: salesOrders.id, status: salesOrders.status, orderDate: salesOrders.orderDate,
        customerId: salesOrders.customerId, customerName: customers.name,
      }).from(salesOrders).innerJoin(customers, eq(salesOrders.customerId, customers.id)),
      db.select().from(salesOrderLines),
      db.select({
        orderId: salesDeliveries.salesOrderId, deliveryDate: salesDeliveries.deliveryDate,
        customerId: salesOrders.customerId, customerName: customers.name,
        productId: salesOrderLines.productId, quantity: salesDeliveryLines.quantity, price: salesOrderLines.unitPriceZmw,
      }).from(salesDeliveryLines)
        .innerJoin(salesDeliveries, eq(salesDeliveryLines.deliveryId, salesDeliveries.id))
        .innerJoin(salesOrderLines, eq(salesDeliveryLines.salesOrderLineId, salesOrderLines.id))
        .innerJoin(salesOrders, eq(salesOrders.id, salesDeliveries.salesOrderId))
        .innerJoin(customers, eq(salesOrders.customerId, customers.id)),
      db.select({ productId: journalLines.productId, debitZmw: journalLines.debitZmw, entryDate: journalEntries.entryDate })
        .from(journalLines).innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
        .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
        .where(eq(accountingAccounts.systemKey, "cost_of_goods_sold")),
    ]);
    const ordersWithDeliveries = new Set(deliveryRows.map((row) => row.orderId));
    const revenue = new Map<number, bigint>(), units = new Map<number, number>();
    const monthlySales = new Map<string, bigint>();
    const customerActivity = new Map<number, { name: string; revenue: bigint; orderIds: Set<number> }>();
    const periodOrderIds = new Set<number>();
    const recordCustomerSale = (orderId: number, customerId: number, customerName: string, date: string, amount: bigint) => {
      const month = date.slice(0, 7);
      monthlySales.set(month, (monthlySales.get(month) ?? 0n) + amount);
      periodOrderIds.add(orderId);
      const customer = customerActivity.get(customerId) ?? { name: customerName, revenue: 0n, orderIds: new Set<number>() };
      customer.revenue += amount;
      customer.orderIds.add(orderId);
      customerActivity.set(customerId, customer);
    };
    for (const row of deliveryRows) {
      if ((fromDate && row.deliveryDate < fromDate) || (toDate && row.deliveryDate > toDate)) continue;
      const amount = cents(row.price) * BigInt(row.quantity);
      revenue.set(row.productId, (revenue.get(row.productId) ?? 0n) + amount);
      units.set(row.productId, (units.get(row.productId) ?? 0) + row.quantity);
      recordCustomerSale(row.orderId, row.customerId, row.customerName, row.deliveryDate, amount);
    }
    for (const line of lines) {
      const order = orders.find((item) => item.id === line.salesOrderId);
      if (!order || order.status !== "fulfilled" || ordersWithDeliveries.has(order.id) || (fromDate && order.orderDate < fromDate) || (toDate && order.orderDate > toDate)) continue;
      const amount = cents(line.unitPriceZmw) * BigInt(line.quantity);
      revenue.set(line.productId, (revenue.get(line.productId) ?? 0n) + amount);
      units.set(line.productId, (units.get(line.productId) ?? 0) + line.quantity);
      recordCustomerSale(order.id, order.customerId, order.customerName, order.orderDate, amount);
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
    const customersWithSales = [...customerActivity.entries()].map(([customerId, activity]) => ({
      customerId, name: activity.name, salesZmw: from(activity.revenue), orders: activity.orderIds.size,
    })).sort((a, b) => {
      const left = cents(a.salesZmw), right = cents(b.salesZmw);
      return left === right ? 0 : left > right ? -1 : 1;
    });
    const firstMonth = fromDate ? fromDate.slice(0, 7) : [...monthlySales.keys()].sort()[0];
    const lastMonth = toDate ? toDate.slice(0, 7) : [...monthlySales.keys()].sort().at(-1);
    const salesByMonth: { month: string; salesZmw: string }[] = [];
    if (firstMonth && lastMonth) {
      const cursor = new Date(`${firstMonth}-01T00:00:00Z`);
      const end = new Date(`${lastMonth}-01T00:00:00Z`);
      while (cursor <= end) {
        const month = cursor.toISOString().slice(0, 7);
        salesByMonth.push({ month, salesZmw: from(monthlySales.get(month) ?? 0n) });
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      }
    }
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
      salesByMonth,
      customerSummary: {
        customersWithSales: customersWithSales.length,
        repeatCustomers: customersWithSales.filter((customer) => customer.orders > 1).length,
        fulfilledOrders: periodOrderIds.size,
        unitsDelivered: [...units.values()].reduce((sum, quantity) => sum + quantity, 0),
      },
      topCustomers: customersWithSales.slice(0, 10),
    });
  });

  app.get("/api/supplier-analytics", owner, async (req, res) => {
    const fromDate = typeof req.query.from === "string" ? req.query.from : "";
    const toDate = typeof req.query.to === "string" ? req.query.to : "";
    if ((fromDate && !validDate(fromDate)) || (toDate && !validDate(toDate)) || (fromDate && toDate && fromDate > toDate)) {
      return res.status(400).json({ error: "Choose a valid supplier report date range." });
    }
    const dateConditions = [
      ...(fromDate ? [gte(purchaseOrders.orderedAt, fromDate)] : []),
      ...(toDate ? [lte(purchaseOrders.orderedAt, toDate)] : []),
    ];
    const orderConditions = and(...dateConditions);
    const paymentConditions = [
      ...(fromDate ? [gte(businessPayments.paymentDate, fromDate)] : []),
      ...(toDate ? [lte(businessPayments.paymentDate, toDate)] : []),
    ];
    const expenseConditions = [
      ...(fromDate ? [gte(importExpenses.incurredAt, fromDate)] : []),
      ...(toDate ? [lte(importExpenses.incurredAt, toDate)] : []),
    ];
    const [orders, purchaseLines, expenses, payments, shipmentRows, shipmentLinks] = await Promise.all([
      db.select({
        id: purchaseOrders.id, supplierId: purchaseOrders.supplierId, supplierName: suppliers.name,
        status: purchaseOrders.status, expectedAt: purchaseOrders.expectedAt,
      }).from(purchaseOrders).innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
        .where(orderConditions),
      db.select({
        supplierId: purchaseOrders.supplierId, supplierName: suppliers.name, orderId: purchaseOrders.id,
        status: purchaseOrders.status,
        totalZmw: sql<string>`round(${purchaseOrderLines.unitPrice}::numeric * ${purchaseOrderLines.quantityOrdered} * ${purchaseOrders.exchangeRateToZmw}::numeric, 2)::text`,
      }).from(purchaseOrderLines).innerJoin(purchaseOrders, eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id))
        .innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id)).where(orderConditions),
      db.select({
        supplierId: purchaseOrders.supplierId, supplierName: suppliers.name,
        amountZmw: sql<string>`round(${importExpenses.amount}::numeric * ${importExpenses.exchangeRateToZmw}::numeric, 2)::text`,
      }).from(importExpenses).innerJoin(purchaseOrders, eq(importExpenses.purchaseOrderId, purchaseOrders.id))
        .innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
        .where(and(...expenseConditions)),
      db.select({
        supplierId: purchaseOrders.supplierId, supplierName: suppliers.name, amountZmw: businessPayments.amountZmw,
      }).from(businessPayments).innerJoin(purchaseOrders, eq(businessPayments.purchaseOrderId, purchaseOrders.id))
        .innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
        .where(and(eq(businessPayments.direction, "supplier_payment"), ...paymentConditions)),
      db.select({
        id: shipments.id, purchaseOrderId: shipments.purchaseOrderId, status: shipments.status, receivedAt: shipments.receivedAt,
      }).from(shipments),
      db.select({ shipmentId: shipmentPurchaseOrders.shipmentId, purchaseOrderId: shipmentPurchaseOrders.purchaseOrderId })
        .from(shipmentPurchaseOrders),
    ]);
    type SupplierMetric = {
      supplierId: number; name: string; orderedGoods: bigint; importCosts: bigint; payments: bigint;
      orders: Set<number>; onTime: number; late: number; overdueOpen: number; missingExpected: number;
    };
    const bySupplier = new Map<number, SupplierMetric>();
    const getSupplier = (supplierId: number, name: string) => {
      let supplier = bySupplier.get(supplierId);
      if (!supplier) {
        supplier = { supplierId, name, orderedGoods: 0n, importCosts: 0n, payments: 0n, orders: new Set(), onTime: 0, late: 0, overdueOpen: 0, missingExpected: 0 };
        bySupplier.set(supplierId, supplier);
      }
      return supplier;
    };
    const linkedShipmentIds = new Map<number, number[]>();
    for (const link of shipmentLinks) linkedShipmentIds.set(link.purchaseOrderId, [...(linkedShipmentIds.get(link.purchaseOrderId) ?? []), link.shipmentId]);
    const shipmentsById = new Map(shipmentRows.map((shipment) => [shipment.id, shipment]));
    const shipmentsByPrimaryOrder = new Map<number, typeof shipmentRows>();
    for (const shipment of shipmentRows) {
      if (shipment.status !== "received" || !shipment.receivedAt) continue;
      shipmentsByPrimaryOrder.set(shipment.purchaseOrderId, [...(shipmentsByPrimaryOrder.get(shipment.purchaseOrderId) ?? []), shipment]);
    }
    for (const order of orders) {
      const supplier = getSupplier(order.supplierId, order.supplierName);
      supplier.orders.add(order.id);
      if (order.status === "cancelled") continue;
      if (!order.expectedAt) supplier.missingExpected += 1;
      else if (order.status === "received") {
        const linked = linkedShipmentIds.get(order.id) ?? [];
        const related = linked.length
          ? linked.flatMap((shipmentId) => {
            const shipment = shipmentsById.get(shipmentId);
            return shipment?.receivedAt && shipment.status === "received" ? [shipment] : [];
          })
          : shipmentsByPrimaryOrder.get(order.id) ?? [];
        const actualDates = related.map((shipment) => shipment.receivedAt!);
        const completedAt = actualDates.sort().at(-1);
        if (completedAt) {
          if (completedAt <= order.expectedAt) supplier.onTime += 1;
          else supplier.late += 1;
        }
      } else if (order.expectedAt < new Date().toISOString().slice(0, 10)) supplier.overdueOpen += 1;
    }
    for (const line of purchaseLines) {
      if (line.status !== "cancelled") getSupplier(line.supplierId, line.supplierName).orderedGoods += cents(line.totalZmw);
    }
    for (const expense of expenses) getSupplier(expense.supplierId, expense.supplierName).importCosts += cents(expense.amountZmw);
    for (const payment of payments) getSupplier(payment.supplierId, payment.supplierName).payments += cents(payment.amountZmw);
    const rows = [...bySupplier.values()].map((supplier) => ({
      supplierId: supplier.supplierId, name: supplier.name, orders: supplier.orders.size,
      orderedGoodsZmw: from(supplier.orderedGoods), importCostsZmw: from(supplier.importCosts),
      paymentsZmw: from(supplier.payments), onTimeOrders: supplier.onTime, lateOrders: supplier.late,
      overdueOpenOrders: supplier.overdueOpen, missingExpectedDateOrders: supplier.missingExpected,
      onTimeRatePercent: supplier.onTime + supplier.late > 0
        ? ((supplier.onTime / (supplier.onTime + supplier.late)) * 100).toFixed(1) : null,
    })).sort((a, b) => Number(b.orderedGoodsZmw) - Number(a.orderedGoodsZmw));
    res.json({
      period: { from: fromDate || null, to: toDate || null },
      totals: {
        suppliers: rows.length, orderedGoodsZmw: from(rows.reduce((sum, row) => sum + cents(row.orderedGoodsZmw), 0n)),
        importCostsZmw: from(rows.reduce((sum, row) => sum + cents(row.importCostsZmw), 0n)),
        paymentsZmw: from(rows.reduce((sum, row) => sum + cents(row.paymentsZmw), 0n)),
        onTimeOrders: rows.reduce((sum, row) => sum + row.onTimeOrders, 0),
        lateOrders: rows.reduce((sum, row) => sum + row.lateOrders, 0),
        overdueOpenOrders: rows.reduce((sum, row) => sum + row.overdueOpenOrders, 0),
      },
      suppliers: rows,
    });
  });
}
