import { and, asc, eq, inArray, ne, sum } from "drizzle-orm";
import type { Express, RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { allocateLandedCosts } from "../shared/landed-cost";
import {
  importExpenses, products, purchaseOrderLines, purchaseOrders, shipmentLines, shipments, suppliers,
} from "../shared/schema";
import {
  importExpenseInputSchema, purchaseOrderInputSchema, purchaseOrderUpdateSchema,
  shipmentInputSchema, shipmentReceiptSchema,
} from "./product-validation";
import { db } from "./db";

const invalid = (res: import("express").Response, message: string) => res.status(400).json({ error: message });
const apiError = (error: unknown) => typeof error === "object" && error !== null ? String((error as { code?: unknown }).code ?? "") : "";

export function registerProcurementRoutes(app: Express, owner: RequestHandler) {
  app.get("/api/purchase-orders", owner, async (_req, res) => {
    const [orders, lines] = await Promise.all([
      db.select({ order: purchaseOrders, supplierName: suppliers.name }).from(purchaseOrders)
        .innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id)).orderBy(asc(purchaseOrders.createdAt)),
      db.select({ line: purchaseOrderLines, productName: products.name, sku: products.sku })
        .from(purchaseOrderLines).innerJoin(products, eq(purchaseOrderLines.productId, products.id)),
    ]);
    res.json({ orders: orders.map(({ order, supplierName }) => ({
      ...order, supplierName,
      lines: lines.filter(({ line }) => line.purchaseOrderId === order.id)
        .map(({ line, productName, sku }) => ({ ...line, productName, sku })),
    })) });
  });

  app.post("/api/purchase-orders", owner, async (req, res) => {
    const parsed = purchaseOrderInputSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error.issues[0]?.message ?? "Check the order details.");
    const { lines, ...input } = parsed.data;
    const [supplier] = await db.select({ status: suppliers.status }).from(suppliers)
      .where(eq(suppliers.id, input.supplierId)).limit(1);
    if (!supplier || supplier.status !== "active") return invalid(res, "Choose an active supplier.");
    const productIds = lines.map((line) => line.productId);
    const existingProducts = await db.select({ id: products.id }).from(products).where(inArray(products.id, productIds));
    if (existingProducts.length !== productIds.length) return invalid(res, "One or more products could not be found.");
    try {
      const order = await db.transaction(async (tx) => {
        const [created] = await tx.insert(purchaseOrders).values({
          ...input,
          orderNumber: `PO-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`,
          status: "ordered",
        }).returning();
        await tx.insert(purchaseOrderLines).values(lines.map((line) => ({
          ...line, purchaseOrderId: created.id,
        })));
        return created;
      });
      res.status(201).json({ order });
    } catch (error) {
      if (apiError(error) === "23505") return res.status(409).json({ error: "The order number or product line is duplicated." });
      throw error;
    }
  });

  app.patch("/api/purchase-orders/:id", owner, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return invalid(res, "Invalid purchase order.");
    const parsed = purchaseOrderUpdateSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error.issues[0]?.message ?? "Check the order details.");
    const [current] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).limit(1);
    if (!current) return res.status(404).json({ error: "Purchase order not found." });
    if (current.status === "received" || current.status === "partially_received") return invalid(res, "Received orders cannot be cancelled or reopened.");
    if (current.status === "cancelled" && parsed.data.status !== "cancelled") return invalid(res, "Cancelled orders cannot be reopened.");
    if (parsed.data.status === "cancelled" && current.status !== "cancelled") {
      const [openShipment] = await db.select({ id: shipments.id }).from(shipments)
        .where(and(eq(shipments.purchaseOrderId, id), ne(shipments.status, "cancelled"))).limit(1);
      if (openShipment) return invalid(res, "Cancel or complete the shipment before cancelling this order.");
    }
    const [order] = await db.update(purchaseOrders).set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(purchaseOrders.id, id)).returning();
    res.json({ order });
  });

  app.get("/api/shipments", owner, async (_req, res) => {
    const headers = await db.select({ shipment: shipments, orderNumber: purchaseOrders.orderNumber, supplierName: suppliers.name })
      .from(shipments).innerJoin(purchaseOrders, eq(shipments.purchaseOrderId, purchaseOrders.id))
      .innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id)).orderBy(asc(shipments.createdAt));
    const rows = await db.select({ line: shipmentLines, productName: products.name, sku: products.sku, orderLine: purchaseOrderLines })
      .from(shipmentLines).innerJoin(purchaseOrderLines, eq(shipmentLines.purchaseOrderLineId, purchaseOrderLines.id))
      .innerJoin(products, eq(purchaseOrderLines.productId, products.id));
    res.json({ shipments: headers.map(({ shipment, orderNumber, supplierName }) => ({
      ...shipment, orderNumber, supplierName,
      lines: rows.filter(({ line }) => line.shipmentId === shipment.id)
        .map(({ line, productName, sku, orderLine }) => ({ ...line, productName, sku, quantityOrdered: orderLine.quantityOrdered })),
    })) });
  });

  app.post("/api/shipments", owner, async (req, res) => {
    const parsed = shipmentInputSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error.issues[0]?.message ?? "Check shipment details.");
    const { lines, ...input } = parsed.data;
    const [order] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.purchaseOrderId)).limit(1);
    if (!order || order.status === "cancelled" || order.status === "received") return invalid(res, "Choose an open purchase order.");
    const lineIds = lines.map((line) => line.purchaseOrderLineId);
    const orderLines = await db.select().from(purchaseOrderLines)
      .where(and(eq(purchaseOrderLines.purchaseOrderId, order.id), inArray(purchaseOrderLines.id, lineIds)));
    if (orderLines.length !== lines.length) return invalid(res, "Every shipment line must belong to the selected purchase order.");
    const shippedRows = await db.select({ lineId: shipmentLines.purchaseOrderLineId, quantity: sum(shipmentLines.quantityShipped) })
      .from(shipmentLines).innerJoin(shipments, eq(shipmentLines.shipmentId, shipments.id))
      .where(and(eq(shipments.purchaseOrderId, order.id), ne(shipments.status, "cancelled"))).groupBy(shipmentLines.purchaseOrderLineId);
    const shipped = new Map(shippedRows.map((row) => [row.lineId, Number(row.quantity ?? 0)]));
    for (const item of lines) {
      const ordered = orderLines.find((line) => line.id === item.purchaseOrderLineId)?.quantityOrdered ?? 0;
      if ((shipped.get(item.purchaseOrderLineId) ?? 0) + item.quantityShipped > ordered) return invalid(res, "Shipment quantity exceeds the quantity ordered.");
    }
    const shipment = await db.transaction(async (tx) => {
      const [created] = await tx.insert(shipments).values(input).returning();
      await tx.insert(shipmentLines).values(lines.map((line) => ({ ...line, shipmentId: created.id, quantityReceived: 0 })));
      return created;
    });
    res.status(201).json({ shipment });
  });

  app.patch("/api/shipments/:id/receive", owner, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return invalid(res, "Invalid shipment.");
    const parsed = shipmentReceiptSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error.issues[0]?.message ?? "Check received quantities.");
    const [shipment] = await db.select().from(shipments).where(eq(shipments.id, id)).limit(1);
    if (!shipment || shipment.status === "cancelled") return res.status(404).json({ error: "Open shipment not found." });
    const currentLines = await db.select().from(shipmentLines).where(eq(shipmentLines.shipmentId, id));
    if (currentLines.length !== parsed.data.lines.length || parsed.data.lines.some((item) => !currentLines.some((line) => line.id === item.shipmentLineId))) {
      return invalid(res, "Include a received quantity for every line in this shipment.");
    }
    const orderLines = await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, shipment.purchaseOrderId));
    const receipts = await db.select({ shipmentId: shipmentLines.shipmentId, lineId: shipmentLines.purchaseOrderLineId, quantity: shipmentLines.quantityReceived })
      .from(shipmentLines).innerJoin(shipments, eq(shipmentLines.shipmentId, shipments.id))
      .where(and(eq(shipments.purchaseOrderId, shipment.purchaseOrderId), ne(shipments.status, "cancelled")));
    const next = new Map(parsed.data.lines.map((line) => [line.shipmentLineId, line.quantityReceived]));
    for (const line of currentLines) {
      const value = next.get(line.id)!;
      if (value > line.quantityShipped) return invalid(res, "Received quantity cannot exceed the quantity shipped.");
      const otherReceived = receipts.filter((row) => row.lineId === line.purchaseOrderLineId && row.shipmentId !== id)
        .reduce((sumValue, row) => sumValue + row.quantity, 0);
      const ordered = orderLines.find((row) => row.id === line.purchaseOrderLineId)?.quantityOrdered ?? 0;
      const sameShipmentOtherLines = currentLines.filter((row) => row.id !== line.id && row.purchaseOrderLineId === line.purchaseOrderLineId)
        .reduce((sumValue, row) => sumValue + (next.get(row.id) ?? row.quantityReceived), 0);
      if (otherReceived + sameShipmentOtherLines + value > ordered) return invalid(res, "Total received quantity cannot exceed the quantity ordered.");
    }
    const updated = await db.transaction(async (tx) => {
      for (const line of currentLines) {
        await tx.update(shipmentLines).set({ quantityReceived: next.get(line.id)! }).where(eq(shipmentLines.id, line.id));
      }
      const receivedForShipment = parsed.data.lines.reduce((sumValue, line) => sumValue + line.quantityReceived, 0);
      const shippedForShipment = currentLines.reduce((sumValue, line) => sumValue + line.quantityShipped, 0);
      const status = receivedForShipment === shippedForShipment ? "received" : receivedForShipment > 0 ? "partially_received" : "in_transit";
      const [saved] = await tx.update(shipments).set({
        status, receivedAt: status === "received" ? new Date().toISOString().slice(0, 10) : null, updatedAt: new Date(),
      }).where(eq(shipments.id, id)).returning();
      const allRows = await tx.select({ lineId: shipmentLines.purchaseOrderLineId, shipmentId: shipmentLines.shipmentId, quantity: shipmentLines.quantityReceived })
        .from(shipmentLines).innerJoin(shipments, eq(shipmentLines.shipmentId, shipments.id))
        .where(and(eq(shipments.purchaseOrderId, shipment.purchaseOrderId), ne(shipments.status, "cancelled")));
      const totalReceived = allRows.reduce((sumValue, row) => sumValue + row.quantity, 0);
      const totalOrdered = orderLines.reduce((sumValue, line) => sumValue + line.quantityOrdered, 0);
      const orderStatus = totalReceived === totalOrdered ? "received" : totalReceived > 0 ? "partially_received" : "ordered";
      await tx.update(purchaseOrders).set({ status: orderStatus, updatedAt: new Date() }).where(eq(purchaseOrders.id, shipment.purchaseOrderId));
      return saved;
    });
    res.json({ shipment: updated });
  });

  app.get("/api/import-expenses", owner, async (req, res) => {
    const purchaseOrderId = req.query.purchaseOrderId ? Number(req.query.purchaseOrderId) : undefined;
    if (purchaseOrderId !== undefined && (!Number.isSafeInteger(purchaseOrderId) || purchaseOrderId <= 0)) return invalid(res, "Invalid purchase order filter.");
    const rows = await db.select().from(importExpenses)
      .where(purchaseOrderId ? eq(importExpenses.purchaseOrderId, purchaseOrderId) : undefined)
      .orderBy(asc(importExpenses.incurredAt));
    res.json({ expenses: rows });
  });

  app.post("/api/import-expenses", owner, async (req, res) => {
    const parsed = importExpenseInputSchema.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error.issues[0]?.message ?? "Check expense details.");
    const [order] = await db.select({ status: purchaseOrders.status }).from(purchaseOrders)
      .where(eq(purchaseOrders.id, parsed.data.purchaseOrderId)).limit(1);
    if (!order || order.status === "cancelled") return invalid(res, "Choose an open purchase order.");
    const [expense] = await db.insert(importExpenses).values({
      ...parsed.data, incurredAt: parsed.data.incurredAt ?? new Date().toISOString().slice(0, 10),
    }).returning();
    res.status(201).json({ expense });
  });

  app.get("/api/landed-costs", owner, async (req, res) => {
    const requestedId = req.query.purchaseOrderId ? Number(req.query.purchaseOrderId) : undefined;
    if (requestedId !== undefined && (!Number.isSafeInteger(requestedId) || requestedId <= 0)) return invalid(res, "Invalid purchase order filter.");
    const orders = await db.select({ order: purchaseOrders, supplierName: suppliers.name }).from(purchaseOrders)
      .innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
      .where(requestedId ? eq(purchaseOrders.id, requestedId) : undefined).orderBy(asc(purchaseOrders.createdAt));
    const lines = await db.select({ line: purchaseOrderLines, productName: products.name, sku: products.sku })
      .from(purchaseOrderLines).innerJoin(products, eq(purchaseOrderLines.productId, products.id));
    const expenses = await db.select().from(importExpenses);
    res.json({ orders: orders.map(({ order, supplierName }) => {
      const orderLines = lines.filter(({ line }) => line.purchaseOrderId === order.id);
      const allocated = allocateLandedCosts(
        orderLines.map(({ line }) => ({ lineId: line.id, quantityOrdered: line.quantityOrdered, unitPrice: line.unitPrice })),
        expenses.filter((expense) => expense.purchaseOrderId === order.id)
          .map((expense) => ({ expenseId: expense.id, amount: expense.amount, exchangeRateToZmw: expense.exchangeRateToZmw, basis: expense.basis })),
        order.exchangeRateToZmw,
      );
      return { ...order, supplierName, lines: orderLines.map(({ line, productName, sku }) => ({
        ...line, productName, sku, ...allocated.lines.find((result) => result.lineId === line.id),
      })), allocations: allocated.allocations };
    }) });
  });
}
