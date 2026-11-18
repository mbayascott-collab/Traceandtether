import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sum } from "drizzle-orm";
import type { Express, RequestHandler } from "express";
import {
  customerInputSchema, customerQuoteInputSchema, publicShopOrderInputSchema, salesDeliveryInputSchema, salesOrderInputSchema,
} from "./product-validation";
import {
  customerQuoteLines, customerQuotes, customers, inventoryMovements, inventoryReservations, marketingAttributions, marketingCampaigns, products, salesDeliveryLines, salesDeliveries, salesOrderLines, salesOrders,
} from "../shared/schema";
import { db } from "./db";
import { accountBalance, formatCents, postJournal } from "./accounting-posting";
import { publicShopProtection } from "./public-shop-protection";

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

async function recordDelivery(tx: any, orderId: number, input: { deliveryDate: string; lines: { salesOrderLineId: number; quantity: number }[] }) {
  const [order] = await tx.select().from(salesOrders).where(eq(salesOrders.id, orderId)).for("update").limit(1);
  if (!order) return { error: "Sales order not found.", status: 404 };
  if (order.status !== "confirmed" && order.status !== "partially_fulfilled") {
    return { error: "Only confirmed or partly delivered orders can receive another delivery.", status: 409 };
  }
  const orderLines = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, orderId)).orderBy(asc(salesOrderLines.productId));
  const deliveredRows = await tx.select({
    lineId: salesDeliveryLines.salesOrderLineId, quantity: sum(salesDeliveryLines.quantity),
  }).from(salesDeliveryLines)
    .innerJoin(salesDeliveries, eq(salesDeliveryLines.deliveryId, salesDeliveries.id))
    .where(eq(salesDeliveries.salesOrderId, orderId)).groupBy(salesDeliveryLines.salesOrderLineId);
  const delivered = new Map<number, number>();
  for (const row of deliveredRows) delivered.set(row.lineId, Number(row.quantity ?? 0));
  const requested = new Map<number, number>();
  for (const line of input.lines) requested.set(line.salesOrderLineId, line.quantity);
  for (const [lineId, quantity] of requested) {
    const line = orderLines.find((item: typeof salesOrderLines.$inferSelect) => item.id === lineId);
    if (!line) return { error: "A delivery line does not belong to this sales order.", status: 400 };
    const remaining = line.quantity - (delivered.get(lineId) ?? 0);
    if (quantity > remaining) return { error: `Only ${remaining} more units can be delivered for product ${line.productId}.`, status: 409 };
  }
  const holdsByProduct = new Map<number, typeof inventoryReservations.$inferSelect>();
  for (const lineInput of input.lines) {
    const line = orderLines.find((item: typeof salesOrderLines.$inferSelect) => item.id === lineInput.salesOrderLineId)!;
    const [hold] = await tx.select().from(inventoryReservations)
      .where(and(eq(inventoryReservations.salesOrderId, orderId), eq(inventoryReservations.productId, line.productId), eq(inventoryReservations.status, "active")))
      .for("update").limit(1);
    if (!hold || hold.quantity < lineInput.quantity) {
      return { error: `The reserved stock for product ${line.productId} is not enough for this delivery.`, status: 409 };
    }
    holdsByProduct.set(line.productId, hold);
  }
  const [delivery] = await tx.insert(salesDeliveries).values({
    deliveryNumber: `DN-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    salesOrderId: orderId, deliveryDate: input.deliveryDate,
  }).returning();
  await tx.insert(salesDeliveryLines).values(input.lines.map((line) => ({
    deliveryId: delivery.id, salesOrderLineId: line.salesOrderLineId, quantity: line.quantity,
  })));

  let revenue = 0n;
  const cogsLines = [];
  for (const lineInput of input.lines) {
    const line = orderLines.find((item: typeof salesOrderLines.$inferSelect) => item.id === lineInput.salesOrderLineId)!;
    const hold = holdsByProduct.get(line.productId)!;
    const remainingReservation = hold.quantity - lineInput.quantity;
    await tx.update(inventoryReservations).set({
      quantity: remainingReservation > 0 ? remainingReservation : hold.quantity,
      status: remainingReservation > 0 ? "active" : "fulfilled",
      updatedAt: new Date(),
    }).where(eq(inventoryReservations.id, hold.id));
    const [movementTotal] = await tx.select({ value: sum(inventoryMovements.quantityDelta) })
      .from(inventoryMovements).where(eq(inventoryMovements.productId, line.productId));
    const onHand = Number(movementTotal?.value ?? 0);
    const stockValue = await accountBalance(tx, "inventory", line.productId);
    if (onHand > 0 && stockValue > 0n) {
      const cost = (stockValue * BigInt(lineInput.quantity) + BigInt(onHand / 2)) / BigInt(onHand);
      if (cost > 0n) cogsLines.push(
        { accountKey: "cost_of_goods_sold", productId: line.productId, debitZmw: formatCents(cost), description: "Weighted-average cost of delivered goods" },
        { accountKey: "inventory", productId: line.productId, creditZmw: formatCents(cost), description: "Inventory delivered" },
      );
    }
    await tx.insert(inventoryMovements).values({
      productId: line.productId, kind: "reservation_fulfillment", quantityDelta: -lineInput.quantity,
      reason: `Delivered on ${delivery.deliveryNumber}`, reference: delivery.deliveryNumber,
      sourceKey: `sales-delivery-${delivery.id}-product-${line.productId}`, reservationId: hold.id,
    });
    revenue += cents(line.unitPriceZmw) * BigInt(lineInput.quantity);
  }
  if (revenue > 0n) await postJournal(tx, {
    sourceKey: `sales-delivery-${delivery.id}-revenue`, sourceType: "sales_delivery", sourceId: delivery.id,
    memo: `Delivery ${delivery.deliveryNumber} for ${order.orderNumber}`, entryDate: input.deliveryDate,
    lines: [
      { accountKey: "accounts_receivable", debitZmw: formatCents(revenue), description: "Customer balance for delivered goods" },
      { accountKey: "sales_revenue", creditZmw: formatCents(revenue), description: "Sales delivered" },
    ],
  });
  if (cogsLines.length) await postJournal(tx, {
    sourceKey: `sales-delivery-${delivery.id}-cogs`, sourceType: "sales_delivery_cogs", sourceId: delivery.id,
    memo: `Cost of delivery ${delivery.deliveryNumber}`, entryDate: input.deliveryDate, lines: cogsLines,
  });

  const deliveredAfter = new Map(delivered);
  for (const [lineId, quantity] of requested) deliveredAfter.set(lineId, (deliveredAfter.get(lineId) ?? 0) + quantity);
  const complete = orderLines.every((line: typeof salesOrderLines.$inferSelect) => (deliveredAfter.get(line.id) ?? 0) === line.quantity);
  const [saved] = await tx.update(salesOrders).set({
    status: complete ? "fulfilled" : "partially_fulfilled",
    fulfilledAt: complete ? new Date() : null,
    updatedAt: new Date(),
  }).where(eq(salesOrders.id, orderId)).returning();
  return { delivery, order: saved };
}

export function registerSalesRoutes(app: Express, owner: RequestHandler) {
  app.get("/api/shop/products", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
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
    res.json({ products: catalog, challenge: publicShopProtection.issueChallenge(_req.ip || _req.socket.remoteAddress || "") });
  });

  app.post("/api/shop/orders", async (req, res) => {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const check = publicShopProtection.checkSubmission(
      req.ip || req.socket.remoteAddress || "",
      body.challenge,
      body.website,
    );
    if (!check.ok) {
      if (check.reason === "rate_limited") {
        res.setHeader("Retry-After", String(check.retryAfterSeconds));
        return res.status(429).json({ error: "Too many order requests. Please try again later." });
      }
      return bad(res, "Please refresh the shop and try again.");
    }
    const { challenge: _challenge, website: _website, ...orderBody } = body;
    const parsed = publicShopOrderInputSchema.safeParse(orderBody);
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
    const [orders, lines, attributions, deliveryRows] = await Promise.all([
      db.select({ order: salesOrders, customerName: customers.name }).from(salesOrders)
        .innerJoin(customers, eq(salesOrders.customerId, customers.id)).orderBy(desc(salesOrders.createdAt)),
      db.select({ line: salesOrderLines, productName: products.name, sku: products.sku })
        .from(salesOrderLines).innerJoin(products, eq(salesOrderLines.productId, products.id)),
      db.select({ salesOrderId: marketingAttributions.salesOrderId, campaignId: marketingAttributions.campaignId, campaignName: marketingCampaigns.name })
        .from(marketingAttributions).innerJoin(marketingCampaigns, eq(marketingAttributions.campaignId, marketingCampaigns.id)),
      db.select({
        delivery: salesDeliveries, deliveryLine: salesDeliveryLines,
        orderLine: salesOrderLines, productName: products.name, sku: products.sku,
      }).from(salesDeliveries)
        .innerJoin(salesDeliveryLines, eq(salesDeliveryLines.deliveryId, salesDeliveries.id))
        .innerJoin(salesOrderLines, eq(salesOrderLines.id, salesDeliveryLines.salesOrderLineId))
        .innerJoin(products, eq(products.id, salesOrderLines.productId))
        .orderBy(desc(salesDeliveries.deliveryDate)),
    ]);
    const attributionByOrder = new Map(attributions.map((item) => [item.salesOrderId, item]));
    res.json({ orders: orders.map(({ order, customerName }) => {
      const orderDeliveries = deliveryRows.filter(({ delivery }) => delivery.salesOrderId === order.id);
      const deliveredByLine = new Map<number, number>();
      for (const row of orderDeliveries) {
        deliveredByLine.set(row.orderLine.id, (deliveredByLine.get(row.orderLine.id) ?? 0) + row.deliveryLine.quantity);
      }
      const items = lines.filter(({ line }) => line.salesOrderId === order.id)
        .map(({ line, productName, sku }) => {
          const deliveredQuantity = deliveredByLine.get(line.id) ?? (order.status === "fulfilled" ? line.quantity : 0);
          return {
            ...line, productName, sku, deliveredQuantity,
            remainingQuantity: Math.max(0, line.quantity - deliveredQuantity),
            lineTotalZmw: money(cents(line.unitPriceZmw) * BigInt(line.quantity)),
          };
        });
      const attribution = attributionByOrder.get(order.id);
      const deliveriesById = new Map<number, { id: number; deliveryNumber: string; deliveryDate: string; lines: { salesOrderLineId: number; productName: string; sku: string; quantity: number }[] }>();
      for (const row of orderDeliveries) {
        const delivery = deliveriesById.get(row.delivery.id) ?? {
          id: row.delivery.id, deliveryNumber: row.delivery.deliveryNumber, deliveryDate: row.delivery.deliveryDate, lines: [],
        };
        delivery.lines.push({
          salesOrderLineId: row.orderLine.id, productName: row.productName, sku: row.sku, quantity: row.deliveryLine.quantity,
        });
        deliveriesById.set(row.delivery.id, delivery);
      }
      return {
        ...order, customerName, campaignId: attribution?.campaignId ?? null, campaignName: attribution?.campaignName ?? null,
        lines: items, deliveries: Array.from(deliveriesById.values()),
        deliveredZmw: money(items.reduce((total, line) => total + cents(line.unitPriceZmw) * BigInt(line.deliveredQuantity), 0n)),
        totalZmw: money(items.reduce((total, line) => total + cents(line.unitPriceZmw) * BigInt(line.quantity), 0n)),
      };
    }) });
  });
  app.get("/api/customer-quotes", owner, async (_req, res) => {
    const [quotes, lines] = await Promise.all([
      db.select({ quote: customerQuotes, customerName: customers.name, salesOrderNumber: salesOrders.orderNumber })
        .from(customerQuotes).innerJoin(customers, eq(customerQuotes.customerId, customers.id))
        .leftJoin(salesOrders, eq(customerQuotes.salesOrderId, salesOrders.id)).orderBy(desc(customerQuotes.createdAt)),
      db.select({ line: customerQuoteLines, productName: products.name, sku: products.sku })
        .from(customerQuoteLines).innerJoin(products, eq(customerQuoteLines.productId, products.id)),
    ]);
    res.json({ quotes: quotes.map(({ quote, customerName, salesOrderNumber }) => {
      const quoteLines = lines.filter(({ line }) => line.customerQuoteId === quote.id).map(({ line, productName, sku }) => ({
        id: line.id, productId: line.productId, productName, sku, quantity: line.quantity,
        unitPriceZmw: line.unitPriceZmw, lineTotalZmw: money(cents(line.unitPriceZmw) * BigInt(line.quantity)),
      }));
      return { ...quote, customerName, salesOrderNumber, lines: quoteLines, totalZmw: money(quoteLines.reduce((sum, line) => sum + cents(line.unitPriceZmw) * BigInt(line.quantity), 0n)) };
    }) });
  });
  app.post("/api/customer-quotes", owner, async (req, res) => {
    const parsed = customerQuoteInputSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the quote details.");
    const [customer] = await db.select({ status: customers.status }).from(customers).where(eq(customers.id, parsed.data.customerId)).limit(1);
    if (!customer || customer.status !== "active") return bad(res, "Choose an active customer.");
    const ids = parsed.data.lines.map((line) => line.productId);
    const active = await db.select({ id: products.id, status: products.status }).from(products).where(inArray(products.id, ids));
    if (active.length !== ids.length || active.some((product) => product.status !== "active")) return bad(res, "Choose active products only.");
    const { lines, ...input } = parsed.data;
    const quote = await db.transaction(async (tx) => {
      const [created] = await tx.insert(customerQuotes).values({
        ...input, quoteNumber: `CQ-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`,
      }).returning();
      await tx.insert(customerQuoteLines).values(lines.map((line) => ({ ...line, customerQuoteId: created.id })));
      return created;
    });
    res.status(201).json({ quote });
  });
  app.patch("/api/customer-quotes/:id", owner, async (req, res) => {
    const id = idOf(req.params.id);
    if (!id) return bad(res, "Invalid quote.");
    const parsed = customerQuoteInputSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the quote details.");
    const result = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(customerQuotes).where(eq(customerQuotes.id, id)).for("update").limit(1);
      if (!current) return { error: "Customer quote not found.", status: 404 };
      if (current.status !== "draft" && current.status !== "sent") return { error: "Only draft or sent quotes can be edited.", status: 409 };
      const [customer] = await tx.select({ status: customers.status }).from(customers).where(eq(customers.id, parsed.data.customerId)).limit(1);
      if (!customer || customer.status !== "active") return { error: "Choose an active customer.", status: 400 };
      const ids = parsed.data.lines.map((line) => line.productId);
      const active = await tx.select({ id: products.id, status: products.status }).from(products).where(inArray(products.id, ids));
      if (active.length !== ids.length || active.some((product) => product.status !== "active")) return { error: "Choose active products only.", status: 400 };
      const { lines, ...input } = parsed.data;
      await tx.delete(customerQuoteLines).where(eq(customerQuoteLines.customerQuoteId, id));
      await tx.insert(customerQuoteLines).values(lines.map((line) => ({ ...line, customerQuoteId: id })));
      const [quote] = await tx.update(customerQuotes).set({ ...input, updatedAt: new Date() }).where(eq(customerQuotes.id, id)).returning();
      return { quote };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.json(result);
  });
  app.delete("/api/customer-quotes/:id", owner, async (req, res) => {
    const id = idOf(req.params.id);
    if (!id) return bad(res, "Invalid quote.");
    const result = await db.transaction(async (tx) => {
      const [quote] = await tx.select().from(customerQuotes).where(eq(customerQuotes.id, id)).for("update").limit(1);
      if (!quote) return { error: "Customer quote not found.", status: 404 };
      if (quote.status === "converted" || quote.salesOrderId) {
        return { error: "Delete the linked draft sales order before deleting this quote.", status: 409 };
      }
      await tx.delete(customerQuoteLines).where(eq(customerQuoteLines.customerQuoteId, id));
      await tx.delete(customerQuotes).where(eq(customerQuotes.id, id));
      return { ok: true };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.json(result);
  });
  app.post("/api/customer-quotes/:id/convert", owner, async (req, res) => {
    const id = idOf(req.params.id);
    if (!id) return bad(res, "Invalid quote.");
    const result = await db.transaction(async (tx) => {
      const [quote] = await tx.select().from(customerQuotes).where(eq(customerQuotes.id, id)).for("update").limit(1);
      if (!quote) return { error: "Customer quote not found.", status: 404 };
      if (quote.status !== "accepted" || quote.salesOrderId) return { error: "Mark this quote as accepted before converting it.", status: 409 };
      if (quote.validUntil && quote.validUntil < new Date().toISOString().slice(0, 10)) return { error: "This quote has expired and cannot be converted.", status: 409 };
      const quoteLines = await tx.select().from(customerQuoteLines).where(eq(customerQuoteLines.customerQuoteId, id)).orderBy(asc(customerQuoteLines.productId));
      const activeProducts = await tx.select({ id: products.id, status: products.status }).from(products)
        .where(inArray(products.id, quoteLines.map((line) => line.productId))).orderBy(asc(products.id)).for("update");
      if (activeProducts.length !== quoteLines.length || activeProducts.some((product) => product.status !== "active")) return { error: "A quoted product is no longer active.", status: 409 };
      const [customer] = await tx.select({ status: customers.status }).from(customers).where(eq(customers.id, quote.customerId)).limit(1);
      if (!customer || customer.status !== "active") return { error: "The customer is inactive; reactivate them before converting.", status: 409 };
      const [order] = await tx.insert(salesOrders).values({
        orderNumber: `SO-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`,
        customerId: quote.customerId, deliveryAddress: quote.deliveryAddress,
        notes: `Created from ${quote.quoteNumber}${quote.notes ? ` — ${quote.notes}` : ""}`, status: "draft",
      }).returning();
      await tx.insert(salesOrderLines).values(quoteLines.map((line) => ({
        salesOrderId: order.id, productId: line.productId, quantity: line.quantity, unitPriceZmw: line.unitPriceZmw,
      })));
      const [savedQuote] = await tx.update(customerQuotes).set({ status: "converted", salesOrderId: order.id, updatedAt: new Date() }).where(eq(customerQuotes.id, id)).returning();
      return { quote: savedQuote, order };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.json(result);
  });
  app.patch("/api/sales-orders/:id/attribution", owner, async (req, res) => {
    const id = idOf(req.params.id);
    if (!id) return bad(res, "Invalid sales order.");
    const campaignId = req.body?.campaignId;
    if (campaignId !== null && (!Number.isSafeInteger(campaignId) || campaignId <= 0)) return bad(res, "Choose a valid campaign.");
    const [order] = await db.select({ id: salesOrders.id }).from(salesOrders).where(eq(salesOrders.id, id)).limit(1);
    if (!order) return res.status(404).json({ error: "Sales order not found." });
    if (campaignId === null) {
      await db.delete(marketingAttributions).where(eq(marketingAttributions.salesOrderId, id));
      return res.json({ campaignId: null });
    }
    const [campaign] = await db.select({ id: marketingCampaigns.id }).from(marketingCampaigns).where(eq(marketingCampaigns.id, campaignId)).limit(1);
    if (!campaign) return bad(res, "Choose an existing campaign.");
    await db.insert(marketingAttributions).values({ salesOrderId: id, campaignId })
      .onConflictDoUpdate({ target: marketingAttributions.salesOrderId, set: { campaignId, attributedAt: new Date() } });
    res.json({ campaignId });
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
  app.delete("/api/sales-orders/:id", owner, async (req, res) => {
    const id = idOf(req.params.id);
    if (!id) return bad(res, "Invalid sales order.");
    const result = await db.transaction(async (tx) => {
      const [order] = await tx.select().from(salesOrders).where(eq(salesOrders.id, id)).for("update").limit(1);
      if (!order) return { error: "Sales order not found.", status: 404 };
      const wasNeverConfirmed = order.confirmedAt === null;
      if (order.status !== "draft" && !(order.status === "cancelled" && wasNeverConfirmed)) {
        return { error: "Only draft orders or orders cancelled before confirmation can be deleted.", status: 409 };
      }
      if (!wasNeverConfirmed) return { error: "This order has confirmation history and cannot be deleted.", status: 409 };
      const [reservation] = await tx.select({ id: inventoryReservations.id })
        .from(inventoryReservations).where(eq(inventoryReservations.salesOrderId, id)).limit(1);
      if (reservation) return { error: "This order has stock reservation history and cannot be deleted. Cancel it instead.", status: 409 };

      await tx.update(customerQuotes)
        .set({ status: "accepted", salesOrderId: null, updatedAt: new Date() })
        .where(eq(customerQuotes.salesOrderId, id));
      await tx.delete(salesOrderLines).where(eq(salesOrderLines.salesOrderId, id));
      await tx.delete(salesOrders).where(eq(salesOrders.id, id));
      return { ok: true };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.json(result);
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
  app.post("/api/sales-orders/:id/deliveries", owner, async (req, res) => {
    const id = idOf(req.params.id); if (!id) return bad(res, "Invalid sales order.");
    const parsed = salesDeliveryInputSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the delivery details.");
    const result = await db.transaction((tx) => recordDelivery(tx, id, parsed.data));
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.status(201).json(result);
  });
  app.post("/api/sales-orders/:id/fulfill", owner, async (req, res) => {
    const id = idOf(req.params.id); if (!id) return bad(res, "Invalid sales order.");
    const result = await db.transaction(async (tx) => {
      const [order] = await tx.select().from(salesOrders).where(eq(salesOrders.id, id)).for("update").limit(1);
      if (!order) return { error: "Sales order not found.", status: 404 };
      if (order.status !== "confirmed" && order.status !== "partially_fulfilled") return { error: "Only open confirmed orders can be fulfilled.", status: 409 };
      const orderLines = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, id));
      const deliveredRows = await tx.select({
        lineId: salesDeliveryLines.salesOrderLineId, quantity: sum(salesDeliveryLines.quantity),
      }).from(salesDeliveryLines)
        .innerJoin(salesDeliveries, eq(salesDeliveryLines.deliveryId, salesDeliveries.id))
        .where(eq(salesDeliveries.salesOrderId, id)).groupBy(salesDeliveryLines.salesOrderLineId);
      const delivered = new Map<number, number>(deliveredRows.map((row) => [row.lineId, Number(row.quantity ?? 0)]));
      const remainingLines = orderLines.map((line) => ({
        salesOrderLineId: line.id, quantity: line.quantity - (delivered.get(line.id) ?? 0),
      })).filter((line) => line.quantity > 0);
      if (!remainingLines.length) return { error: "This order has no remaining items to deliver.", status: 409 };
      return recordDelivery(tx, id, { deliveryDate: new Date().toISOString().slice(0, 10), lines: remainingLines });
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.json(result);
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
