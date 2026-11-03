import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sum } from "drizzle-orm";
import type { Express, RequestHandler } from "express";
import {
  customerInputSchema, publicShopOrderInputSchema, salesOrderInputSchema,
} from "./product-validation";
import {
  customers, inventoryMovements, inventoryReservations, products, salesOrderLines, salesOrders,
} from "../shared/schema";
import { db } from "./db";
import { accountBalance, formatCents, postJournal } from "./accounting-posting";

const bad = (res: import("express").Response, message: string) => res.status(400).json({ error: message });
const idOf = (value: unknown) => { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : null; };
function cents(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
function money(value: bigint) { return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`; }
async function stockBalance(tx: any, productId: number) {
  const [m] = await tx.select({ value: sum(inventoryMovements.quantityDelta) }).from(inventoryMovements).where(eq(inventoryMovements.productId, productId));
  const [r] = await tx.select({ value: sum(inventoryReservations.quantity) }).from(inventoryReservations)
    .where(and(eq(inventoryReservations.productId, productId), eq(inventoryReservations.status, "active")));
  return { onHand: Number(m?.value ?? 0), reserved: Number(r?.value ?? 0) };
}

export function registerSalesRoutes(app: Express, owner: RequestHandler) {
  app.get("/api/shop/products", async (_req, res) => {
    const rows = await db.select({
      id: products.id,
      name: products.name,
      description: products.description,
      unit: products.unit,
      sellingPriceZmw: products.sellingPriceZmw,
    }).from(products).where(and(eq(products.status, "active"))).orderBy(asc(products.name));
    const catalog = [];
    for (const product of rows) {
      if (product.sellingPriceZmw == null) continue;
      const balance = await stockBalance(db, product.id);
      const available = Math.max(0, balance.onHand - balance.reserved);
      if (available > 0) catalog.push(product);
    }
    res.json({ products: catalog });
  });

  app.post("/api/shop/orders", async (req, res) => {
    const parsed = publicShopOrderInputSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check your order details.");
    const result = await db.transaction(async (tx) => {
      const ids = parsed.data.lines.map((line) => line.productId);
      const selected = await tx.select({
        id: products.id, name: products.name, status: products.status, sellingPriceZmw: products.sellingPriceZmw,
      }).from(products).where(inArray(products.id, ids)).orderBy(asc(products.id)).for("update");
      if (selected.length !== ids.length || selected.some((product) => product.status !== "active" || product.sellingPriceZmw == null)) {
        return { error: "One or more selected products are no longer available." };
      }
      for (const line of parsed.data.lines) {
        const balance = await stockBalance(tx, line.productId);
        if (balance.onHand - balance.reserved < line.quantity) {
          const product = selected.find((item) => item.id === line.productId);
          return { error: `${product?.name ?? "A selected product"} no longer has enough available stock. Please update your order.` };
        }
      }
      const [customer] = await tx.insert(customers).values({
        name: parsed.data.name,
        phone: parsed.data.phone,
        email: parsed.data.email,
        address: parsed.data.address || null,
        status: "active",
      }).returning();
      const orderNumber = `WEB-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
      const [order] = await tx.insert(salesOrders).values({
        orderNumber,
        customerId: customer.id,
        deliveryAddress: parsed.data.address || null,
        notes: [ "Public shop order request", parsed.data.notes ].filter(Boolean).join(" — "),
        status: "draft",
      }).returning();
      const byId = new Map(selected.map((product) => [product.id, product]));
      await tx.insert(salesOrderLines).values(parsed.data.lines.map((line) => ({
        salesOrderId: order.id,
        productId: line.productId,
        quantity: line.quantity,
        unitPriceZmw: byId.get(line.productId)!.sellingPriceZmw!,
      })));
      return { orderNumber };
    });
    if ("error" in result) return res.status(409).json({ error: result.error });
    res.status(201).json({ orderNumber: result.orderNumber });
  });

  app.get("/api/customers", owner, async (_req, res) => {
    res.json({ customers: await db.select().from(customers).orderBy(asc(customers.name)) });
  });
  app.post("/api/customers", owner, async (req, res) => {
    const parsed = customerInputSchema.safeParse({ ...req.body, status: req.body?.status ?? "active" });
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the customer details.");
    const [customer] = await db.insert(customers).values(parsed.data).returning();
    res.status(201).json({ customer });
  });
  app.patch("/api/customers/:id", owner, async (req, res) => {
    const id = idOf(req.params.id); if (!id) return bad(res, "Invalid customer.");
    const parsed = customerInputSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the customer details.");
    const [customer] = await db.update(customers).set({ ...parsed.data, updatedAt: new Date() }).where(eq(customers.id, id)).returning();
    if (!customer) return res.status(404).json({ error: "Customer not found." });
    res.json({ customer });
  });

  app.get("/api/sales-orders", owner, async (_req, res) => {
    const [orders, lines] = await Promise.all([
      db.select({ order: salesOrders, customerName: customers.name }).from(salesOrders)
        .innerJoin(customers, eq(salesOrders.customerId, customers.id)).orderBy(desc(salesOrders.createdAt)),
      db.select({ line: salesOrderLines, productName: products.name, sku: products.sku })
        .from(salesOrderLines).innerJoin(products, eq(salesOrderLines.productId, products.id)),
    ]);
    res.json({ orders: orders.map(({ order, customerName }) => {
      const items = lines.filter(({ line }) => line.salesOrderId === order.id)
        .map(({ line, productName, sku }) => ({ ...line, productName, sku, lineTotalZmw: money(cents(line.unitPriceZmw) * BigInt(line.quantity)) }));
      return { ...order, customerName, lines: items, totalZmw: money(items.reduce((total, line) => total + cents(line.unitPriceZmw) * BigInt(line.quantity), 0n)) };
    }) });
  });
  app.post("/api/sales-orders", owner, async (req, res) => {
    const parsed = salesOrderInputSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the order details.");
    const [customer] = await db.select().from(customers).where(eq(customers.id, parsed.data.customerId)).limit(1);
    if (!customer || customer.status !== "active") return bad(res, "Choose an active customer.");
    const ids = parsed.data.lines.map((line) => line.productId);
    const selected = await db.select({ id: products.id, status: products.status }).from(products).where(inArray(products.id, ids));
    if (selected.length !== ids.length || selected.some((product) => product.status !== "active")) return bad(res, "Choose active products only.");
    const order = await db.transaction(async (tx) => {
      const [created] = await tx.insert(salesOrders).values({
        orderNumber: `SO-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`,
        customerId: parsed.data.customerId, deliveryAddress: parsed.data.deliveryAddress, notes: parsed.data.notes, status: "draft",
      }).returning();
      await tx.insert(salesOrderLines).values(parsed.data.lines.map((line) => ({ ...line, salesOrderId: created.id })));
      return created;
    });
    res.status(201).json({ order });
  });
  app.post("/api/sales-orders/:id/confirm", owner, async (req, res) => {
    const id = idOf(req.params.id); if (!id) return bad(res, "Invalid sales order.");
    const result = await db.transaction(async (tx) => {
      const [order] = await tx.select().from(salesOrders).where(eq(salesOrders.id, id)).for("update").limit(1);
      if (!order) return { error: "Sales order not found.", status: 404 };
      if (order.status !== "draft") return { error: "Only draft orders can be confirmed.", status: 409 };
      const [customer] = await tx.select({ status: customers.status }).from(customers).where(eq(customers.id, order.customerId)).limit(1);
      if (!customer || customer.status !== "active") return { error: "The customer is inactive and this order cannot be confirmed.", status: 409 };
      const lines = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, id)).orderBy(asc(salesOrderLines.productId));
      for (const line of lines) {
        const [product] = await tx.select({ id: products.id, status: products.status }).from(products).where(eq(products.id, line.productId)).for("update");
        if (!product || product.status !== "active") return { error: `Product ${line.productId} is no longer active.`, status: 409 };
        const balance = await stockBalance(tx, line.productId);
        const available = balance.onHand - balance.reserved;
        if (available < line.quantity) return { error: `${available} units available for product ${line.productId}; ${line.quantity} requested.`, status: 409 };
      }
      await tx.insert(inventoryReservations).values(lines.map((line) => ({
        productId: line.productId, salesOrderId: id, quantity: line.quantity, reference: order.orderNumber,
        reason: `Sales order ${order.orderNumber}`, status: "active" as const,
      })));
      const [saved] = await tx.update(salesOrders).set({ status: "confirmed", confirmedAt: new Date(), updatedAt: new Date() }).where(eq(salesOrders.id, id)).returning();
      return { order: saved };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.json({ order: result.order });
  });
  app.post("/api/sales-orders/:id/fulfill", owner, async (req, res) => {
    const id = idOf(req.params.id); if (!id) return bad(res, "Invalid sales order.");
    const result = await db.transaction(async (tx) => {
      const [order] = await tx.select().from(salesOrders).where(eq(salesOrders.id, id)).for("update").limit(1);
      if (!order) return { error: "Sales order not found.", status: 404 };
      if (order.status !== "confirmed") return { error: "Only confirmed orders can be fulfilled.", status: 409 };
      const holds = await tx.select().from(inventoryReservations).where(and(eq(inventoryReservations.salesOrderId, id), eq(inventoryReservations.status, "active"))).orderBy(asc(inventoryReservations.productId));
      if (!holds.length) return { error: "No active stock reservations were found.", status: 409 };
      for (const hold of holds) await tx.select({ id: products.id }).from(products).where(eq(products.id, hold.productId)).for("update");
      const orderLines = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, id));
      const revenue = orderLines.reduce((total, line) => total + cents(line.unitPriceZmw) * BigInt(line.quantity), 0n);
      if (revenue > 0n) {
        await postJournal(tx, {
          sourceKey: `sales-order-${id}-revenue`, sourceType: "sales_order", sourceId: id,
          memo: `Sales order ${order.orderNumber}`, entryDate: order.orderDate,
          lines: [
            { accountKey: "accounts_receivable", debitZmw: formatCents(revenue), description: "Unpaid customer balance" },
            { accountKey: "sales_revenue", creditZmw: formatCents(revenue), description: "Sales" },
          ],
        });
      }
      const costLines = [];
      for (const line of orderLines) {
        const [movementTotal] = await tx.select({ value: sum(inventoryMovements.quantityDelta) })
          .from(inventoryMovements).where(eq(inventoryMovements.productId, line.productId));
        const onHand = Number(movementTotal?.value ?? 0);
        const inventoryValue = await accountBalance(tx, "inventory", line.productId);
        if (onHand <= 0 || inventoryValue <= 0n) continue;
        const cost = (inventoryValue * BigInt(line.quantity) + BigInt(onHand / 2)) / BigInt(onHand);
        if (cost <= 0n) continue;
        costLines.push(
          { accountKey: "cost_of_goods_sold", productId: line.productId, debitZmw: formatCents(cost), description: "Weighted-average cost of sale" },
          { accountKey: "inventory", productId: line.productId, creditZmw: formatCents(cost), description: "Inventory issued" },
        );
      }
      if (costLines.length) {
        await postJournal(tx, {
          sourceKey: `sales-order-${id}-cogs`, sourceType: "sales_order_cogs", sourceId: id,
          memo: `Cost of sales for ${order.orderNumber}`, entryDate: order.orderDate, lines: costLines,
        });
      }
      for (const hold of holds) {
        const [movement] = await tx.insert(inventoryMovements).values({
          productId: hold.productId, kind: "reservation_fulfillment", quantityDelta: -hold.quantity,
          reason: `Fulfilled sales order ${order.orderNumber}`, reference: order.orderNumber,
          sourceKey: `sales-order-${id}-product-${hold.productId}`, reservationId: hold.id,
        }).returning();
        await tx.update(inventoryReservations).set({ status: "fulfilled", updatedAt: new Date() }).where(eq(inventoryReservations.id, hold.id));
      }
      const [saved] = await tx.update(salesOrders).set({ status: "fulfilled", fulfilledAt: new Date(), updatedAt: new Date() }).where(eq(salesOrders.id, id)).returning();
      return { order: saved };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.json({ order: result.order });
  });
  app.post("/api/sales-orders/:id/cancel", owner, async (req, res) => {
    const id = idOf(req.params.id); if (!id) return bad(res, "Invalid sales order.");
    const result = await db.transaction(async (tx) => {
      const [order] = await tx.select().from(salesOrders).where(eq(salesOrders.id, id)).for("update").limit(1);
      if (!order) return { error: "Sales order not found.", status: 404 };
      if (order.status === "fulfilled" || order.status === "cancelled") return { error: "This order can no longer be cancelled.", status: 409 };
      await tx.update(inventoryReservations).set({ status: "released", updatedAt: new Date() })
        .where(and(eq(inventoryReservations.salesOrderId, id), eq(inventoryReservations.status, "active")));
      const [saved] = await tx.update(salesOrders).set({ status: "cancelled", updatedAt: new Date() }).where(eq(salesOrders.id, id)).returning();
      return { order: saved };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.json({ order: result.order });
  });
}
