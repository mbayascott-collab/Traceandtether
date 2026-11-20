import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql, sum } from "drizzle-orm";
import type { Express, RequestHandler } from "express";
import { z } from "zod";
import {
  customerInputSchema, customerQuoteInputSchema, publicShopOrderInputSchema, salesDeliveryInputSchema, salesOrderConfirmationInputSchema, salesOrderInputSchema,
} from "./product-validation";
import { isCustomerQuoteExpired, requiresCustomerQuoteExpiryConfirmation } from "../shared/customer-quote-expiry";
import {
  accountingAccounts, customerQuoteEmailEvents, customerQuoteLines, customerQuotes, customers, inventoryLocations, inventoryMovements, inventoryReservations, journalEntries, journalLines, marketingAttributions, marketingCampaigns, products, publicShopOrderAttemptCounts, publicShopOrderAttemptDailyCounts, salesDeliveryLines, salesDeliveries, salesDeliveryReceiptProofs, salesDeliveryReceipts, salesOrderLines, salesOrders,
} from "../shared/schema";
import { db } from "./db";
import { accountBalance, cents as accountingCents, formatCents, postJournal } from "./accounting-posting";
import {
  PUBLIC_SHOP_RETRY_MESSAGE, PublicShopProtectionUnavailableError, publicShopProtection,
} from "./public-shop-protection";
import {
  completePublicShopAttemptDays, findPublicShopBlockedSpikes, isPublicShopAttemptDateRange, publicShopAttemptSummary, recordPublicShopAttempt,
} from "./public-shop-analytics";
import { recordBusinessAudit, type AuditActor } from "./audit";
import { matchesDeliveryRequest } from "./sales-delivery-idempotency";
import { inspectDeliveryProof } from "./delivery-proof";
import { allocateReservationConsumption, chooseSalesStockAllocations } from "./sales-stock-allocation";
import { requireBusinessOwner } from "./access-control";
import { sendCustomerQuoteEmail } from "./customer-quote-email";
import { sendSalesDeliveryInvoiceEmail } from "./sales-delivery-invoice-email";
import {
  customerQuoteDeliveryEventSchema, hasValidDeliveryWebhookToken,
  isValidCustomerQuoteDeliveryEventTime, shouldApplyCustomerQuoteDeliveryEvent,
} from "./customer-quote-delivery-events";

const bad = (res: import("express").Response, message: string) => res.status(400).json({ error: message });
const idOf = (value: unknown) => { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : null; };
function cents(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
function money(value: bigint) { return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`; }
function roundedDivide(numerator: bigint, denominator: bigint) {
  return (numerator + denominator / 2n) / denominator;
}
const returnInputSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(80),
  locationId: z.number().int().positive(),
  quantity: z.number().int().positive().max(1_000_000),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Enter a valid return date."),
  reason: z.string().trim().min(3).max(500),
}).strict();
async function stockBalance(tx: any, productId: number, locationId?: number) {
  const [location] = locationId ? [{ id: locationId }] : await tx.select({ id: inventoryLocations.id }).from(inventoryLocations).where(eq(inventoryLocations.name, "Main")).limit(1);
  const conditions = location ? and(eq(inventoryMovements.productId, productId), eq(inventoryMovements.locationId, location.id)) : eq(inventoryMovements.productId, productId);
  const reservationConditions = location
    ? and(eq(inventoryReservations.productId, productId), eq(inventoryReservations.status, "active"), eq(inventoryReservations.locationId, location.id))
    : and(eq(inventoryReservations.productId, productId), eq(inventoryReservations.status, "active"));
  const [m] = await tx.select({ value: sum(inventoryMovements.quantityDelta) }).from(inventoryMovements).where(conditions);
  const [r] = await tx.select({ value: sum(inventoryReservations.quantity) }).from(inventoryReservations)
    .where(reservationConditions);
  return { onHand: Number(m?.value ?? 0), reserved: Number(r?.value ?? 0), locationId: location?.id ?? null };
}

async function deliveryRequestResult(tx: any, existing: typeof salesDeliveries.$inferSelect, orderId: number,
  input: { deliveryDate: string; lines: { salesOrderLineId: number; quantity: number; locationAllocations?: { locationId: number; quantity: number }[] }[] }) {
  const savedDeliveryLines = await tx.select({
    id: salesDeliveryLines.id,
    salesOrderLineId: salesDeliveryLines.salesOrderLineId, quantity: salesDeliveryLines.quantity,
  }).from(salesDeliveryLines).where(eq(salesDeliveryLines.deliveryId, existing.id)).orderBy(asc(salesDeliveryLines.salesOrderLineId));
  const savedFulfillment = savedDeliveryLines.length
    ? await tx.select({
      salesDeliveryLineId: inventoryMovements.salesDeliveryLineId,
      locationId: inventoryMovements.locationId,
      quantity: inventoryMovements.quantityDelta,
    }).from(inventoryMovements).where(and(
      eq(inventoryMovements.kind, "reservation_fulfillment"),
      inArray(inventoryMovements.salesDeliveryLineId, savedDeliveryLines.map((line: { id: number }) => line.id)),
    ))
    : [];
  const allocationsByDeliveryLine = new Map<number, { locationId: number; quantity: number }[]>();
  for (const movement of savedFulfillment) {
    if (movement.salesDeliveryLineId === null || movement.locationId === null) continue;
    const allocations = allocationsByDeliveryLine.get(movement.salesDeliveryLineId) ?? [];
    const existingLocation = allocations.find((allocation) => allocation.locationId === movement.locationId);
    if (existingLocation) existingLocation.quantity -= movement.quantity;
    else allocations.push({ locationId: movement.locationId, quantity: -movement.quantity });
    allocationsByDeliveryLine.set(movement.salesDeliveryLineId, allocations);
  }
  const savedLines = savedDeliveryLines.map((line: { id: number; salesOrderLineId: number; quantity: number }) => ({
    salesOrderLineId: line.salesOrderLineId,
    quantity: line.quantity,
    locationAllocations: allocationsByDeliveryLine.get(line.id) ?? [],
  }));
  if (!matchesDeliveryRequest({
    salesOrderId: existing.salesOrderId, deliveryDate: existing.deliveryDate, lines: savedLines,
  }, {
    salesOrderId: orderId, deliveryDate: input.deliveryDate, lines: input.lines,
  })) {
    return { error: "This delivery request key was already used for different details.", status: 409 };
  }
  const [order] = await tx.select().from(salesOrders).where(eq(salesOrders.id, orderId)).limit(1);
  if (!order) return { error: "Sales order not found.", status: 404 };
  return { delivery: existing, order };
}

async function recordDelivery(tx: any, orderId: number,
  input: { idempotencyKey: string; deliveryDate: string; lines: { salesOrderLineId: number; quantity: number; locationAllocations?: { locationId: number; quantity: number }[] }[] }, actor: AuditActor) {
  const [order] = await tx.select().from(salesOrders).where(eq(salesOrders.id, orderId)).for("update").limit(1);
  if (!order) return { error: "Sales order not found.", status: 404 };
  const [existingDelivery] = await tx.select().from(salesDeliveries)
    .where(eq(salesDeliveries.idempotencyKey, input.idempotencyKey)).limit(1);
  if (existingDelivery) return deliveryRequestResult(tx, existingDelivery, orderId, input);
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
  const holdsByLine = new Map<number, {
    holds: typeof inventoryReservations.$inferSelect[];
    consumption: { reservationId: number; locationId: number | null; quantity: number }[];
  }>();
  for (const lineInput of input.lines) {
    const line = orderLines.find((item: typeof salesOrderLines.$inferSelect) => item.id === lineInput.salesOrderLineId)!;
    const holds = await tx.select().from(inventoryReservations)
      .where(and(eq(inventoryReservations.salesOrderId, orderId), eq(inventoryReservations.productId, line.productId), eq(inventoryReservations.status, "active")))
      .orderBy(asc(inventoryReservations.id)).for("update");
    const locationAllocations = lineInput.locationAllocations ?? [];
    const consumption = allocateReservationConsumption(holds, lineInput.quantity, locationAllocations);
    if (!consumption) {
      return {
        error: locationAllocations.length
          ? `The selected location quantities for product ${line.productId} must match the delivery quantity and stay within this order's remaining reservations.`
          : `The reserved stock for product ${line.productId} is not enough for this delivery.`,
        status: 409,
      };
    }
    holdsByLine.set(lineInput.salesOrderLineId, { holds, consumption });
  }
  const [delivery] = await tx.insert(salesDeliveries).values({
    deliveryNumber: `DN-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    idempotencyKey: input.idempotencyKey,
    salesOrderId: orderId, deliveryDate: input.deliveryDate,
  }).onConflictDoNothing({ target: salesDeliveries.idempotencyKey }).returning();
  if (!delivery) {
    const [concurrentDelivery] = await tx.select().from(salesDeliveries)
      .where(eq(salesDeliveries.idempotencyKey, input.idempotencyKey)).limit(1);
    if (!concurrentDelivery) throw new Error("The delivery request could not be recorded.");
    return deliveryRequestResult(tx, concurrentDelivery, orderId, input);
  }
  const deliveryLines = await tx.insert(salesDeliveryLines).values(input.lines.map((line) => ({
    deliveryId: delivery.id, salesOrderLineId: line.salesOrderLineId, quantity: line.quantity,
  }))).returning({ id: salesDeliveryLines.id, salesOrderLineId: salesDeliveryLines.salesOrderLineId });
  const deliveryLineIdByOrderLine = new Map(deliveryLines.map((line: { id: number; salesOrderLineId: number }) => [
    line.salesOrderLineId, line.id,
  ]));

  let revenue = 0n;
  const cogsLines = [];
  for (const lineInput of input.lines) {
    const line = orderLines.find((item: typeof salesOrderLines.$inferSelect) => item.id === lineInput.salesOrderLineId)!;
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
    const allocation = holdsByLine.get(lineInput.salesOrderLineId)!;
    const deliveryLineId = deliveryLineIdByOrderLine.get(lineInput.salesOrderLineId)!;
    const holdsById = new Map(allocation.holds.map((hold) => [hold.id, hold]));
    for (const consumed of allocation.consumption) {
      const hold = holdsById.get(consumed.reservationId)!;
      const remainingReservation = hold.quantity - consumed.quantity;
      await tx.update(inventoryReservations).set({
        quantity: remainingReservation > 0 ? remainingReservation : hold.quantity,
        status: remainingReservation > 0 ? "active" : "fulfilled",
        updatedAt: new Date(),
      }).where(eq(inventoryReservations.id, hold.id));
      await recordBusinessAudit(tx, {
        entityType: "inventory_reservation", entityId: hold.id,
        recordLabel: `Reservation #${hold.id} · product #${line.productId}`,
        actor, action: "updated", changedFields: ["quantity", "status"],
      });
      const [movement] = await tx.insert(inventoryMovements).values({
        productId: line.productId, locationId: hold.locationId, kind: "reservation_fulfillment", quantityDelta: -consumed.quantity,
        reason: `Delivered on ${delivery.deliveryNumber}`, reference: delivery.deliveryNumber,
        sourceKey: `sales-delivery-${delivery.id}-line-${deliveryLineId}-reservation-${hold.id}`,
        reservationId: hold.id, salesDeliveryLineId: deliveryLineId,
      }).returning();
      await recordBusinessAudit(tx, {
        entityType: "inventory_movement", entityId: movement.id,
        recordLabel: `Delivery ${delivery.deliveryNumber} · product #${line.productId}`,
        actor, action: "created",
        changedFields: ["productId", "locationId", "kind", "quantityDelta", "reason", "reference", "reservationId", "salesDeliveryLineId"],
      });
    }
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
  await recordBusinessAudit(tx, {
    entityType: "sales_delivery", entityId: delivery.id, recordLabel: delivery.deliveryNumber,
    actor, action: "created", changedFields: ["deliveryDate", "lines"],
  });
  await recordBusinessAudit(tx, {
    entityType: "sales_order", entityId: saved.id, recordLabel: saved.orderNumber,
    actor, action: "updated", changedFields: ["status"],
  });
  return { delivery, order: saved };
}

export function registerSalesRoutes(
  app: Express,
  owner: RequestHandler,
  dependencies: {
    sendCustomerQuoteEmail?: typeof sendCustomerQuoteEmail;
    sendSalesDeliveryInvoiceEmail?: typeof sendSalesDeliveryInvoiceEmail;
  } = {},
) {
  const sendQuoteEmail = dependencies.sendCustomerQuoteEmail ?? sendCustomerQuoteEmail;
  const sendDeliveryInvoiceEmail = dependencies.sendSalesDeliveryInvoiceEmail ?? sendSalesDeliveryInvoiceEmail;
  const publicShopAnalyticsOwner = requireBusinessOwner(
    "Only the business owner can view public shop request activity.",
  );
  app.post("/api/webhooks/customer-quote-email", async (req, res) => {
    if (!hasValidDeliveryWebhookToken(req.get("authorization"), process.env.CUSTOMER_QUOTE_EMAIL_WEBHOOK_SECRET)) {
      return res.status(process.env.CUSTOMER_QUOTE_EMAIL_WEBHOOK_SECRET ? 401 : 503)
        .json({ error: process.env.CUSTOMER_QUOTE_EMAIL_WEBHOOK_SECRET ? "Invalid webhook authorization." : "Email delivery updates are not configured." });
    }
    const parsed = customerQuoteDeliveryEventSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Invalid email delivery event.");
    const event = parsed.data;
    const eventAt = new Date(event.occurredAt);
    if (!isValidCustomerQuoteDeliveryEventTime(event)) return bad(res, "The email delivery event time is invalid or too far in the future.");

    const result = await db.transaction(async (tx) => {
      const [quote] = await tx.select().from(customerQuotes)
        .where(eq(customerQuotes.emailProviderMessageId, event.messageId)).for("update").limit(1);
      if (!quote) return { error: "No current quote email matches this message reference.", status: 404 };

      const [received] = await tx.insert(customerQuoteEmailEvents).values({
        provider: event.provider,
        providerEventId: event.eventId,
        customerQuoteId: quote.id,
        providerMessageId: event.messageId,
        outcome: event.status,
        occurredAt: eventAt,
      }).onConflictDoNothing().returning({ id: customerQuoteEmailEvents.id });
      if (!received) return { duplicate: true };

      if (!shouldApplyCustomerQuoteDeliveryEvent({
        currentMessageId: quote.emailProviderMessageId,
        lastEventAt: quote.emailDeliveryEventAt,
        event,
      })) return { stale: true };

      const emailSendError = event.status === "delivered"
        ? null
        : event.error || (event.status === "bounced" ? "The recipient's email address bounced." : "Email delivery failed.");
      const [updated] = await tx.update(customerQuotes).set({
        emailSendStatus: event.status,
        emailDeliveryEventAt: eventAt,
        emailSendError,
        updatedAt: new Date(),
      }).where(eq(customerQuotes.id, quote.id)).returning();
      if (!updated) throw new Error("The quote delivery result could not be saved.");
      await recordBusinessAudit(tx, {
        entityType: "customer_quote", entityId: updated.id, recordLabel: updated.quoteNumber,
        actor: { clerkUserId: null, email: "Email delivery provider" }, action: "updated",
        changedFields: ["emailSendStatus", "emailDeliveryEventAt", "emailSendError"],
      });
      return { applied: true };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.json(result);
  });
  app.get("/api/shop/products", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    let challenge: string;
    try {
      challenge = await publicShopProtection.issueChallenge(_req.ip || _req.socket.remoteAddress || "");
    } catch (error) {
      if (error instanceof PublicShopProtectionUnavailableError) {
        return res.status(503).json({ error: PUBLIC_SHOP_RETRY_MESSAGE });
      }
      throw error;
    }
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
    res.json({ products: catalog, challenge });
  });

  app.post("/api/shop/orders", async (req, res) => {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    let check;
    try {
      check = await publicShopProtection.checkSubmission(
        req.ip || req.socket.remoteAddress || "",
        body.challenge,
        body.website,
      );
    } catch (error) {
      if (error instanceof PublicShopProtectionUnavailableError) {
        return res.status(503).json({ error: PUBLIC_SHOP_RETRY_MESSAGE });
      }
      throw error;
    }
    if (!check.ok) {
      await recordPublicShopAttempt(db, check.reason);
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
      const [sourceCampaign] = parsed.data.trackingCode
        ? await tx.select({ id: marketingCampaigns.id }).from(marketingCampaigns)
          .where(and(
            eq(marketingCampaigns.trackingCode, parsed.data.trackingCode),
            eq(marketingCampaigns.status, "active"),
            sql`(${marketingCampaigns.startsOn} is null or ${marketingCampaigns.startsOn} <= CURRENT_DATE)`,
          )).limit(1).for("share")
        : [];
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
      const publicActor: AuditActor = { clerkUserId: null, email: "Public shop" };
      await recordBusinessAudit(tx, {
        entityType: "customer", entityId: customer.id, recordLabel: customer.name,
        actor: publicActor, action: "created", changedFields: ["name", "phone", "email", "address", "status"],
      });
      const orderNumber = `WEB-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
      const [order] = await tx.insert(salesOrders).values({
        orderNumber,
        customerId: customer.id,
        deliveryAddress: parsed.data.address || null,
        notes: [ "Public shop order request", parsed.data.notes ].filter(Boolean).join(" — "),
        status: "draft",
      }).returning();
      await recordBusinessAudit(tx, {
        entityType: "sales_order", entityId: order.id, recordLabel: order.orderNumber,
        actor: publicActor, action: "created", changedFields: ["customerId", "deliveryAddress", "notes", "status", "lines"],
      });
      const byId = new Map(selected.map((product) => [product.id, product]));
      await tx.insert(salesOrderLines).values(parsed.data.lines.map((line) => ({
        salesOrderId: order.id,
        productId: line.productId,
        quantity: line.quantity,
        unitPriceZmw: byId.get(line.productId)!.sellingPriceZmw!,
      })));
      if (sourceCampaign) {
        await tx.insert(marketingAttributions).values({
          salesOrderId: order.id, campaignId: sourceCampaign.id, source: "campaign_link",
        });
      }
      await recordPublicShopAttempt(tx, "accepted");
      return { orderNumber };
    });
    if ("error" in result) return res.status(409).json({ error: result.error });
    res.status(201).json({ orderNumber: result.orderNumber });
  });

  app.get("/api/shop/order-attempt-summary", owner, publicShopAnalyticsOwner, async (_req, res) => {
    const [counts] = await db.select({
      acceptedCount: publicShopOrderAttemptCounts.acceptedCount,
      blockedCount: publicShopOrderAttemptCounts.blockedCount,
      rateLimitedCount: publicShopOrderAttemptCounts.rateLimitedCount,
      botCheckCount: publicShopOrderAttemptCounts.botCheckCount,
    }).from(publicShopOrderAttemptCounts).limit(1);
    res.json({ summary: publicShopAttemptSummary(counts) });
  });

  app.get("/api/shop/order-attempt-days", owner, publicShopAnalyticsOwner, async (req, res) => {
    const { from, to } = req.query;
    if (typeof from !== "string" || typeof to !== "string" || !isPublicShopAttemptDateRange(from, to)) {
      return res.status(400).json({ error: "Choose a valid date range with the start date on or before the end date." });
    }
    const rows = await db.select({
      day: publicShopOrderAttemptDailyCounts.day,
      accepted: publicShopOrderAttemptDailyCounts.acceptedCount,
      blocked: publicShopOrderAttemptDailyCounts.blockedCount,
      rateLimited: publicShopOrderAttemptDailyCounts.rateLimitedCount,
      botCheck: publicShopOrderAttemptDailyCounts.botCheckCount,
    }).from(publicShopOrderAttemptDailyCounts)
      .where(and(gte(publicShopOrderAttemptDailyCounts.day, from), lte(publicShopOrderAttemptDailyCounts.day, to)))
      .orderBy(asc(publicShopOrderAttemptDailyCounts.day));
    const days = completePublicShopAttemptDays(from, to, rows);
    res.json({ days, blockedSpikes: findPublicShopBlockedSpikes(days) });
  });

  app.get("/api/shop/order-attempt-export", owner, publicShopAnalyticsOwner, async (req, res) => {
    const { from, to } = req.query;
    if (typeof from !== "string" || typeof to !== "string" || !isPublicShopAttemptDateRange(from, to)) {
      return res.status(400).json({ error: "Choose a valid date range with the start date on or before the end date." });
    }
    const rows = await db.select({
      day: publicShopOrderAttemptDailyCounts.day,
      accepted: publicShopOrderAttemptDailyCounts.acceptedCount,
      blocked: publicShopOrderAttemptDailyCounts.blockedCount,
      rateLimited: publicShopOrderAttemptDailyCounts.rateLimitedCount,
      botCheck: publicShopOrderAttemptDailyCounts.botCheckCount,
    }).from(publicShopOrderAttemptDailyCounts)
      .where(and(gte(publicShopOrderAttemptDailyCounts.day, from), lte(publicShopOrderAttemptDailyCounts.day, to)))
      .orderBy(asc(publicShopOrderAttemptDailyCounts.day));
    const days = completePublicShopAttemptDays(from, to, rows);
    const csvRows = [
      ["Date (UTC)", "Accepted", "Blocked", "Rate-limited", "Challenge or honeypot failed"],
      ...days.map(({ day, accepted, blocked, rateLimited, botCheck }) => [day, accepted, blocked, rateLimited, botCheck]),
    ];
    const csv = csvRows
      .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))
      .join("\r\n");
    res.type("text/csv").attachment(`public-shop-daily-totals-${from}-to-${to}.csv`).send(csv);
  });

  app.get("/api/customers", owner, async (_req, res) => {
    res.json({ customers: await db.select().from(customers).orderBy(asc(customers.name)) });
  });
  app.post("/api/customers", owner, async (req, res) => {
    const parsed = customerInputSchema.safeParse({ ...req.body, status: req.body?.status ?? "active" });
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the customer details.");
    const [customer] = await db.transaction(async (tx) => {
      const [created] = await tx.insert(customers).values(parsed.data).returning();
      await recordBusinessAudit(tx, {
        entityType: "customer", entityId: created.id, recordLabel: created.name,
        actor: res.locals.actor, action: "created", changedFields: Object.keys(parsed.data),
      });
      return [created];
    });
    res.status(201).json({ customer });
  });
  app.patch("/api/customers/:id", owner, async (req, res) => {
    const id = idOf(req.params.id); if (!id) return bad(res, "Invalid customer.");
    const parsed = customerInputSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the customer details.");
    const [customer] = await db.transaction(async (tx) => {
      const [updated] = await tx.update(customers).set({ ...parsed.data, updatedAt: new Date() }).where(eq(customers.id, id)).returning();
      if (updated) await recordBusinessAudit(tx, {
        entityType: "customer", entityId: updated.id, recordLabel: updated.name,
        actor: res.locals.actor, action: "updated", changedFields: Object.keys(parsed.data),
      });
      return [updated];
    });
    if (!customer) return res.status(404).json({ error: "Customer not found." });
    res.json({ customer });
  });

  app.get("/api/sales-orders", owner, async (_req, res) => {
    const [orders, lines, attributions, deliveryRows, receiptRows, receiptProofRows, locations, movementBalances, reservationBalances, orderReservations, fulfillmentRows, returnRows] = await Promise.all([
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
      db.select({
        deliveryId: salesDeliveryReceipts.deliveryId,
        receivedBy: salesDeliveryReceipts.receivedBy,
        receivedAt: salesDeliveryReceipts.receivedAt,
        proofFileName: salesDeliveryReceipts.proofFileName,
        proofMimeType: salesDeliveryReceipts.proofMimeType,
      }).from(salesDeliveryReceipts),
      db.select({
        id: salesDeliveryReceiptProofs.id,
        deliveryId: salesDeliveryReceiptProofs.deliveryId,
        fileName: salesDeliveryReceiptProofs.fileName,
        mimeType: salesDeliveryReceiptProofs.mimeType,
      }).from(salesDeliveryReceiptProofs),
      db.select({ id: inventoryLocations.id, name: inventoryLocations.name })
        .from(inventoryLocations).where(eq(inventoryLocations.active, true)).orderBy(asc(inventoryLocations.name)),
      db.select({
        productId: inventoryMovements.productId, locationId: inventoryMovements.locationId,
        quantity: sum(inventoryMovements.quantityDelta),
      }).from(inventoryMovements).groupBy(inventoryMovements.productId, inventoryMovements.locationId),
      db.select({
        productId: inventoryReservations.productId, locationId: inventoryReservations.locationId,
        quantity: sum(inventoryReservations.quantity),
      }).from(inventoryReservations).where(eq(inventoryReservations.status, "active"))
        .groupBy(inventoryReservations.productId, inventoryReservations.locationId),
      db.select({
        salesOrderId: inventoryReservations.salesOrderId, productId: inventoryReservations.productId,
        reservation: inventoryReservations, locationName: inventoryLocations.name,
      }).from(inventoryReservations)
        .leftJoin(inventoryLocations, eq(inventoryReservations.locationId, inventoryLocations.id))
        .where(isNotNull(inventoryReservations.salesOrderId))
        .orderBy(asc(inventoryReservations.id)),
      db.select({
        salesDeliveryLineId: salesDeliveryLines.id,
        locationId: inventoryMovements.locationId,
        locationName: inventoryLocations.name,
        quantityDelta: inventoryMovements.quantityDelta,
      }).from(inventoryMovements)
        .innerJoin(salesDeliveries, eq(inventoryMovements.reference, salesDeliveries.deliveryNumber))
        .innerJoin(salesDeliveryLines, eq(salesDeliveryLines.deliveryId, salesDeliveries.id))
        .innerJoin(salesOrderLines, and(
          eq(salesOrderLines.id, salesDeliveryLines.salesOrderLineId),
          eq(salesOrderLines.productId, inventoryMovements.productId),
        ))
        .innerJoin(inventoryReservations, eq(inventoryReservations.id, inventoryMovements.reservationId))
        .leftJoin(inventoryLocations, eq(inventoryMovements.locationId, inventoryLocations.id))
        .where(and(
          eq(inventoryMovements.kind, "reservation_fulfillment"),
          isNotNull(inventoryReservations.salesOrderId),
        )),
      db.select({
        salesDeliveryLineId: inventoryMovements.salesDeliveryLineId,
        quantity: inventoryMovements.quantityDelta,
        reason: inventoryMovements.reason,
        createdAt: inventoryMovements.createdAt,
        locationName: inventoryLocations.name,
      }).from(inventoryMovements)
        .innerJoin(salesDeliveryLines, eq(inventoryMovements.salesDeliveryLineId, salesDeliveryLines.id))
        .leftJoin(inventoryLocations, eq(inventoryMovements.locationId, inventoryLocations.id))
        .where(eq(inventoryMovements.kind, "stock_return"))
        .orderBy(desc(inventoryMovements.createdAt)),
    ]);
    const attributionByOrder = new Map(attributions.map((item) => [item.salesOrderId, item]));
    const receiptByDelivery = new Map(receiptRows.map((receipt) => [receipt.deliveryId, receipt]));
    const proofsByDelivery = new Map<number, { id: number | null; fileName: string; mimeType: string }[]>();
    for (const receipt of receiptRows) {
      if (receipt.proofFileName && receipt.proofMimeType) {
        proofsByDelivery.set(receipt.deliveryId, [{
          id: null, fileName: receipt.proofFileName, mimeType: receipt.proofMimeType,
        }]);
      }
    }
    for (const proof of receiptProofRows) {
      const proofs = proofsByDelivery.get(proof.deliveryId) ?? [];
      proofs.push({ id: proof.id, fileName: proof.fileName, mimeType: proof.mimeType });
      proofsByDelivery.set(proof.deliveryId, proofs);
    }
    const onHandByProductLocation = new Map(movementBalances.map((row) => [
      `${row.productId}:${row.locationId}`, Number(row.quantity ?? 0),
    ]));
    const reservedByProductLocation = new Map(reservationBalances.map((row) => [
      `${row.productId}:${row.locationId}`, Number(row.quantity ?? 0),
    ]));
    const orderReservationsByProduct = new Map<string, {
      id: number; locationId: number | null; locationName: string | null; quantity: number;
      status: "active" | "released" | "fulfilled";
    }[]>();
    for (const row of orderReservations) {
      if (row.salesOrderId === null) continue;
      const key = `${row.salesOrderId}:${row.productId}`;
      const reservations = orderReservationsByProduct.get(key) ?? [];
      reservations.push({
        id: row.reservation.id, locationId: row.reservation.locationId, locationName: row.locationName,
        quantity: row.reservation.quantity, status: row.reservation.status,
      });
      orderReservationsByProduct.set(key, reservations);
    }
    const stockByDeliveryLine = new Map<number, { locationId: number | null; locationName: string | null; quantity: number }[]>();
    for (const row of fulfillmentRows) {
      if (row.salesDeliveryLineId === null) continue;
      const locationsForLine = stockByDeliveryLine.get(row.salesDeliveryLineId) ?? [];
      const existing = locationsForLine.find((item) => item.locationId === row.locationId);
      if (existing) existing.quantity += -row.quantityDelta;
      else locationsForLine.push({
        locationId: row.locationId, locationName: row.locationName, quantity: -row.quantityDelta,
      });
      stockByDeliveryLine.set(row.salesDeliveryLineId, locationsForLine);
    }
    const returnsByDeliveryLine = new Map<number, typeof returnRows>();
    for (const row of returnRows) {
      if (row.salesDeliveryLineId === null) continue;
      const lineReturns = returnsByDeliveryLine.get(row.salesDeliveryLineId) ?? [];
      lineReturns.push(row);
      returnsByDeliveryLine.set(row.salesDeliveryLineId, lineReturns);
    }
    res.json({ orders: orders.map(({ order, customerName }) => {
      const orderDeliveries = deliveryRows.filter(({ delivery }) => delivery.salesOrderId === order.id);
      const deliveredByLine = new Map<number, number>();
      for (const row of orderDeliveries) {
        deliveredByLine.set(row.orderLine.id, (deliveredByLine.get(row.orderLine.id) ?? 0) + row.deliveryLine.quantity);
      }
      const items = lines.filter(({ line }) => line.salesOrderId === order.id)
        .map(({ line, productName, sku }) => {
          const deliveredQuantity = deliveredByLine.get(line.id) ?? (order.status === "fulfilled" ? line.quantity : 0);
          const stockReservations = orderReservationsByProduct.get(`${order.id}:${line.productId}`) ?? [];
          return {
            ...line, productName, sku, deliveredQuantity,
            remainingQuantity: Math.max(0, line.quantity - deliveredQuantity),
            lineTotalZmw: money(cents(line.unitPriceZmw) * BigInt(line.quantity)),
            stockLocationId: stockReservations.length === 1 ? stockReservations[0].locationId : null,
            stockLocationName: stockReservations.length
              ? stockReservations.map((reservation) => `${reservation.locationName ?? "Stock"} (${reservation.quantity})`).join(", ")
              : null,
            stockReservations,
            stockLocations: locations.map((location) => ({
              ...location,
              available: Math.max(0,
                (onHandByProductLocation.get(`${line.productId}:${location.id}`) ?? 0)
                - (reservedByProductLocation.get(`${line.productId}:${location.id}`) ?? 0)),
            })),
          };
        });
      const attribution = attributionByOrder.get(order.id);
      const deliveriesById = new Map<number, {
        id: number; deliveryNumber: string; deliveryDate: string;
        receipt: { receivedBy: string; receivedAt: Date; proofFileName: string | null; proofMimeType: string | null; proofs: { id: number | null; fileName: string; mimeType: string }[] } | null;
        lines: { salesDeliveryLineId: number; salesOrderLineId: number; productName: string; sku: string; quantity: number; returnedQuantity: number; returns: { quantity: number; reason: string; createdAt: Date; locationName: string | null }[]; stockLocations: { locationId: number | null; locationName: string | null; quantity: number }[]; unitPriceZmw: string; lineTotalZmw: string }[];
        totalZmw: string;
      }>();
      for (const row of orderDeliveries) {
        const receipt = receiptByDelivery.get(row.delivery.id);
        const delivery = deliveriesById.get(row.delivery.id) ?? {
          id: row.delivery.id, deliveryNumber: row.delivery.deliveryNumber, deliveryDate: row.delivery.deliveryDate,
          receipt: receipt ? {
            receivedBy: receipt.receivedBy, receivedAt: receipt.receivedAt,
            proofFileName: receipt.proofFileName, proofMimeType: receipt.proofMimeType,
            proofs: proofsByDelivery.get(row.delivery.id) ?? [],
          } : null,
          lines: [], totalZmw: "0.00",
        };
        const lineTotal = cents(row.orderLine.unitPriceZmw) * BigInt(row.deliveryLine.quantity);
        delivery.lines.push({
          salesDeliveryLineId: row.deliveryLine.id,
          salesOrderLineId: row.orderLine.id, productName: row.productName, sku: row.sku,
          quantity: row.deliveryLine.quantity,
          returnedQuantity: (returnsByDeliveryLine.get(row.deliveryLine.id) ?? [])
            .reduce((quantity, returned) => quantity + returned.quantity, 0),
          returns: (returnsByDeliveryLine.get(row.deliveryLine.id) ?? []).map((returned) => ({
            quantity: returned.quantity, reason: returned.reason, createdAt: returned.createdAt,
            locationName: returned.locationName,
          })),
          stockLocations: stockByDeliveryLine.get(row.deliveryLine.id) ?? [],
          unitPriceZmw: row.orderLine.unitPriceZmw,
          lineTotalZmw: money(lineTotal),
        });
        delivery.totalZmw = money(cents(delivery.totalZmw) + lineTotal);
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
  app.post("/api/sales-deliveries/:id/send-invoice", owner, async (req, res) => {
    const deliveryId = idOf(req.params.id);
    if (!deliveryId) return bad(res, "Invalid delivery invoice.");
    const [delivery] = await db.select({
      id: salesDeliveries.id,
      deliveryNumber: salesDeliveries.deliveryNumber,
      deliveryDate: salesDeliveries.deliveryDate,
      orderNumber: salesOrders.orderNumber,
      customerName: customers.name,
      customerEmail: customers.email,
    }).from(salesDeliveries)
      .innerJoin(salesOrders, eq(salesOrders.id, salesDeliveries.salesOrderId))
      .innerJoin(customers, eq(customers.id, salesOrders.customerId))
      .where(eq(salesDeliveries.id, deliveryId)).limit(1);
    if (!delivery) return res.status(404).json({ error: "Delivery note not found." });
    if (!delivery.customerEmail) {
      return bad(res, "Add a saved email address to this customer before sending the invoice.");
    }
    if (!z.string().email().safeParse(delivery.customerEmail).success) {
      return bad(res, "The customer's saved email address is invalid. Update it before sending the invoice.");
    }
    const lines = await db.select({
      productName: products.name,
      sku: products.sku,
      quantity: salesDeliveryLines.quantity,
      unitPriceZmw: salesOrderLines.unitPriceZmw,
    }).from(salesDeliveryLines)
      .innerJoin(salesOrderLines, eq(salesOrderLines.id, salesDeliveryLines.salesOrderLineId))
      .innerJoin(products, eq(products.id, salesOrderLines.productId))
      .where(eq(salesDeliveryLines.deliveryId, delivery.id))
      .orderBy(asc(products.name), asc(salesDeliveryLines.id));
    if (!lines.length) return res.status(409).json({ error: "This delivery has no items to invoice." });
    const invoiceNumber = `INV-${delivery.deliveryNumber.replace(/^DN-/, "")}`;
    const invoiceLines = lines.map((line) => ({
      ...line,
      lineTotalZmw: money(cents(line.unitPriceZmw) * BigInt(line.quantity)),
    }));
    const totalZmw = money(invoiceLines.reduce(
      (total, line) => total + cents(line.unitPriceZmw) * BigInt(line.quantity), 0n,
    ));
    const outcome = await sendDeliveryInvoiceEmail({
      invoiceNumber,
      deliveryNumber: delivery.deliveryNumber,
      deliveryDate: delivery.deliveryDate,
      orderNumber: delivery.orderNumber,
      customerName: delivery.customerName,
      customerEmail: delivery.customerEmail,
      totalZmw,
      lines: invoiceLines,
    });
    if (!outcome.ok) return res.status(502).json({ error: outcome.error });
    res.json({ message: `Invoice sent to ${delivery.customerEmail}.` });
  });
  app.post("/api/sales-delivery-lines/:id/returns", owner, async (req, res) => {
    const deliveryLineId = idOf(req.params.id);
    if (!deliveryLineId) return bad(res, "Invalid delivered item.");
    const parsed = returnInputSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the return details.");
    const input = parsed.data;
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(0, hashtext(${"sales-return:" + input.idempotencyKey}))`);
      const [deliveryLine] = await tx.select({
        id: salesDeliveryLines.id, deliveryId: salesDeliveries.id,
        deliveryNumber: salesDeliveries.deliveryNumber, deliveryDate: salesDeliveries.deliveryDate,
        orderId: salesOrders.id, orderNumber: salesOrders.orderNumber,
        salesOrderLineId: salesOrderLines.id, productId: salesOrderLines.productId,
        quantity: salesDeliveryLines.quantity, unitPriceZmw: salesOrderLines.unitPriceZmw,
      }).from(salesDeliveryLines)
        .innerJoin(salesDeliveries, eq(salesDeliveryLines.deliveryId, salesDeliveries.id))
        .innerJoin(salesOrders, eq(salesDeliveries.salesOrderId, salesOrders.id))
        .innerJoin(salesOrderLines, eq(salesDeliveryLines.salesOrderLineId, salesOrderLines.id))
        .where(eq(salesDeliveryLines.id, deliveryLineId)).limit(1);
      if (!deliveryLine) return { error: "Delivered item not found.", status: 404 };
      await tx.select({ id: salesOrders.id }).from(salesOrders)
        .where(eq(salesOrders.id, deliveryLine.orderId)).for("update").limit(1);
      const [product] = await tx.select({ id: products.id }).from(products)
        .where(eq(products.id, deliveryLine.productId)).for("update").limit(1);
      if (!product) return { error: "Product not found.", status: 404 };

      const sourceKey = `sales-return-${input.idempotencyKey}`;
      const [existing] = await tx.select().from(inventoryMovements)
        .where(eq(inventoryMovements.sourceKey, sourceKey)).limit(1);
      if (existing) {
        const [existingJournal] = await tx.select({ entryDate: journalEntries.entryDate })
          .from(journalEntries).where(eq(journalEntries.sourceKey, `sales-return-${existing.id}-revenue`)).limit(1);
        const sameRequest = existing.salesDeliveryLineId === deliveryLine.id
          && existing.locationId === input.locationId
          && existing.quantityDelta === input.quantity
          && existing.reason === input.reason
          && existingJournal?.entryDate === input.returnDate;
        if (!sameRequest) return { error: "This return save key was already used for different details.", status: 409 };
        return { movement: existing, duplicate: true };
      }

      const [location] = await tx.select({ id: inventoryLocations.id, name: inventoryLocations.name })
        .from(inventoryLocations).where(and(
          eq(inventoryLocations.id, input.locationId), eq(inventoryLocations.active, true),
        )).limit(1);
      if (!location) return { error: "Choose an active stock location.", status: 400 };
      const priorReturns = await tx.select({
        id: inventoryMovements.id, quantity: inventoryMovements.quantityDelta,
      }).from(inventoryMovements)
        .where(and(
          eq(inventoryMovements.salesDeliveryLineId, deliveryLine.id),
          eq(inventoryMovements.kind, "stock_return"),
        ));
      const priorQuantity = priorReturns.reduce((total, row) => total + row.quantity, 0);
      if (priorQuantity + input.quantity > deliveryLine.quantity) {
        return {
          error: `Only ${deliveryLine.quantity - priorQuantity} units from ${deliveryLine.deliveryNumber} remain available to return.`,
          status: 409,
        };
      }

      const [movement] = await tx.insert(inventoryMovements).values({
        productId: product.id, locationId: location.id, kind: "stock_return", quantityDelta: input.quantity,
        reason: input.reason, reference: deliveryLine.deliveryNumber, sourceKey,
        salesDeliveryLineId: deliveryLine.id,
      }).returning();
      await recordBusinessAudit(tx, {
        entityType: "inventory_movement", entityId: movement.id,
        recordLabel: `Return from ${deliveryLine.deliveryNumber} · product #${product.id}`,
        actor: res.locals.actor, action: "created",
        changedFields: ["productId", "locationId", "kind", "quantityDelta", "reason", "reference", "salesDeliveryLineId"],
      });

      const revenueReturn = accountingCents(deliveryLine.unitPriceZmw) * BigInt(input.quantity);
      await postJournal(tx, {
        sourceKey: `sales-return-${movement.id}-revenue`,
        sourceType: "sales_return", sourceId: movement.id,
        memo: `Return from ${deliveryLine.deliveryNumber} for ${deliveryLine.orderNumber}: ${input.reason}`,
        entryDate: input.returnDate,
        lines: [
          { accountKey: "sales_revenue", debitZmw: formatCents(revenueReturn), description: "Returned sales" },
          { accountKey: "accounts_receivable", creditZmw: formatCents(revenueReturn), description: "Customer balance reduced" },
        ],
      });

      const [originalCost] = await tx.select({ value: sum(journalLines.debitZmw) })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
        .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
        .where(and(
          eq(journalEntries.sourceType, "sales_delivery_cogs"),
          eq(journalEntries.sourceId, deliveryLine.deliveryId),
          eq(journalLines.productId, product.id),
          eq(accountingAccounts.systemKey, "cost_of_goods_sold"),
        ));
      const originalCostCents = accountingCents(String(originalCost?.value ?? "0.00"));
      const cumulativeQuantity = priorQuantity + input.quantity;
      const targetCostReversal = originalCostCents > 0n
        ? roundedDivide(originalCostCents * BigInt(cumulativeQuantity), BigInt(deliveryLine.quantity))
        : 0n;
      let priorCostReversed = 0n;
      if (priorReturns.length) {
        const [priorCost] = await tx.select({ value: sum(journalLines.creditZmw) })
          .from(journalLines)
          .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
          .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
          .where(and(
            eq(journalEntries.sourceType, "sales_return_cogs"),
            inArray(journalEntries.sourceId, priorReturns.map((row) => row.id)),
            eq(accountingAccounts.systemKey, "cost_of_goods_sold"),
          ));
        priorCostReversed = accountingCents(String(priorCost?.value ?? "0.00"));
      }
      const costReturn = targetCostReversal > priorCostReversed
        ? targetCostReversal - priorCostReversed : 0n;
      if (costReturn > 0n) await postJournal(tx, {
        sourceKey: `sales-return-${movement.id}-cogs`,
        sourceType: "sales_return_cogs", sourceId: movement.id,
        memo: `Cost reversal for return from ${deliveryLine.deliveryNumber}`,
        entryDate: input.returnDate,
        lines: [
          { accountKey: "inventory", productId: product.id, debitZmw: formatCents(costReturn), description: "Returned stock cost" },
          { accountKey: "cost_of_goods_sold", productId: product.id, creditZmw: formatCents(costReturn), description: "Cost of returned goods" },
        ],
      });
      return { movement, duplicate: false };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.status(result.duplicate ? 200 : 201).json(result);
  });
  app.get("/api/customer-quotes", owner, async (_req, res) => {
    const [quotes, lines] = await Promise.all([
      db.select({ quote: customerQuotes, customerName: customers.name, customerEmail: customers.email, salesOrderNumber: salesOrders.orderNumber })
        .from(customerQuotes).innerJoin(customers, eq(customerQuotes.customerId, customers.id))
        .leftJoin(salesOrders, eq(customerQuotes.salesOrderId, salesOrders.id)).orderBy(desc(customerQuotes.createdAt)),
      db.select({ line: customerQuoteLines, productName: products.name, sku: products.sku })
        .from(customerQuoteLines).innerJoin(products, eq(customerQuoteLines.productId, products.id)),
    ]);
    res.json({ quotes: quotes.map(({ quote, customerName, customerEmail, salesOrderNumber }) => {
      const quoteLines = lines.filter(({ line }) => line.customerQuoteId === quote.id).map(({ line, productName, sku }) => ({
        id: line.id, productId: line.productId, productName, sku, quantity: line.quantity,
        unitPriceZmw: line.unitPriceZmw, lineTotalZmw: money(cents(line.unitPriceZmw) * BigInt(line.quantity)),
      }));
      return { ...quote, customerName, customerEmail, salesOrderNumber, lines: quoteLines, totalZmw: money(quoteLines.reduce((sum, line) => sum + cents(line.unitPriceZmw) * BigInt(line.quantity), 0n)) };
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
      await recordBusinessAudit(tx, {
        entityType: "customer_quote", entityId: created.id, recordLabel: created.quoteNumber,
        actor: res.locals.actor, action: "created", changedFields: [...Object.keys(input), "lines"],
      });
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
      if (current.emailSendStatus === "sending") return { error: "Wait for the quote email to finish before editing it.", status: 409 };
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
      await recordBusinessAudit(tx, {
        entityType: "customer_quote", entityId: quote.id, recordLabel: quote.quoteNumber,
        actor: res.locals.actor, action: "updated", changedFields: [...Object.keys(input), "lines"],
      });
      return { quote };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.json(result);
  });
  app.post("/api/customer-quotes/:id/send", owner, async (req, res) => {
    const id = idOf(req.params.id);
    if (!id) return bad(res, "Invalid quote.");
    const claim = await db.transaction(async (tx) => {
      const [quote] = await tx.select().from(customerQuotes).where(eq(customerQuotes.id, id)).for("update").limit(1);
      if (!quote) return { error: "Customer quote not found.", status: 404 };
      if (quote.emailSendStatus === "sending") {
        const attemptedAt = quote.emailAttemptedAt?.getTime() ?? 0;
        const stale = !attemptedAt || Date.now() - attemptedAt > 5 * 60 * 1000;
        if (stale && req.body?.confirmAmbiguousRetry !== true) {
          return {
            error: "The previous send did not finish. Check Gmail Sent, then confirm before retrying.",
            status: 409,
          };
        }
        if (!stale) return { error: "This quote email is already being sent. Wait for it to finish before trying again.", status: 409 };
      }

      const [customer] = await tx.select({ name: customers.name, email: customers.email })
        .from(customers).where(eq(customers.id, quote.customerId)).limit(1);
      if (!customer?.email) return { error: "Add a saved email address to this customer before sending the quote.", status: 400 };
      if (!z.string().email().safeParse(customer.email).success) {
        return { error: "The customer's saved email address is invalid. Update it before sending the quote.", status: 400 };
      }

      const lines = await tx.select({
        productName: products.name, sku: products.sku, quantity: customerQuoteLines.quantity,
        unitPriceZmw: customerQuoteLines.unitPriceZmw,
      }).from(customerQuoteLines).innerJoin(products, eq(customerQuoteLines.productId, products.id))
        .where(eq(customerQuoteLines.customerQuoteId, quote.id)).orderBy(asc(products.name));
      if (lines.length === 0) return { error: "This quote has no items to send.", status: 409 };
      const lineContent = lines.map((line) => ({
        ...line,
        lineTotalZmw: money(cents(line.unitPriceZmw) * BigInt(line.quantity)),
      }));
      const totalZmw = money(lineContent.reduce(
        (total, line) => total + cents(line.unitPriceZmw) * BigInt(line.quantity), 0n,
      ));
      const attemptedAt = new Date();
      const [claimed] = await tx.update(customerQuotes).set({
        emailSendStatus: "sending", emailAttemptedAt: attemptedAt, emailSentAt: null,
        emailSendError: null, emailProviderMessageId: null, emailDeliveryEventAt: null, updatedAt: attemptedAt,
      }).where(eq(customerQuotes.id, quote.id)).returning();
      return {
        quote: claimed,
        content: {
          quoteNumber: quote.quoteNumber, emailAttemptedAt: attemptedAt.toISOString(),
          customerName: customer.name, customerEmail: customer.email,
          validUntil: quote.validUntil, deliveryAddress: quote.deliveryAddress, notes: quote.notes,
          totalZmw, lines: lineContent,
        },
      };
    });
    if ("error" in claim) return res.status(claim.status ?? 400).json({ error: claim.error });

    const outcome = await sendQuoteEmail(claim.content);
    const sentAt = outcome.ok ? new Date() : null;
    const saved = await db.transaction(async (tx) => {
      const [updated] = await tx.update(customerQuotes).set({
        emailSendStatus: outcome.ok ? "sent" : "failed",
        emailSentAt: sentAt,
        emailSendError: outcome.ok ? null : outcome.error,
        emailProviderMessageId: outcome.ok ? outcome.messageId : null,
        updatedAt: new Date(),
      }).where(and(
        eq(customerQuotes.id, id),
        eq(customerQuotes.emailSendStatus, "sending"),
        eq(customerQuotes.emailAttemptedAt, claim.quote.emailAttemptedAt!),
      )).returning();
      if (!updated) return null;
      await recordBusinessAudit(tx, {
        entityType: "customer_quote", entityId: updated.id, recordLabel: updated.quoteNumber,
        actor: res.locals.actor, action: "updated",
        changedFields: ["emailSendStatus", "emailAttemptedAt", "emailSentAt", "emailSendError"],
      });
      return updated;
    });
    if (!saved) {
      return res.status(409).json({ error: "A newer quote email attempt replaced this result." });
    }
    if (!outcome.ok) return res.status(502).json({ error: outcome.error, quote: saved });
    res.json({ quote: saved });
  });
  app.delete("/api/customer-quotes/:id", owner, async (req, res) => {
    const id = idOf(req.params.id);
    if (!id) return bad(res, "Invalid quote.");
    const result = await db.transaction(async (tx) => {
      const [quote] = await tx.select().from(customerQuotes).where(eq(customerQuotes.id, id)).for("update").limit(1);
      if (!quote) return { error: "Customer quote not found.", status: 404 };
      if (quote.emailSendStatus === "sending") return { error: "Wait for the quote email to finish before deleting it.", status: 409 };
      if (quote.status === "converted" || quote.salesOrderId) {
        return { error: "Delete the linked draft sales order before deleting this quote.", status: 409 };
      }
      await recordBusinessAudit(tx, {
        entityType: "customer_quote", entityId: quote.id, recordLabel: quote.quoteNumber,
        actor: res.locals.actor, action: "deleted",
      });
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
      const approvalTime = new Date();
      const expired = isCustomerQuoteExpired(quote.validUntil, approvalTime);
      if (requiresCustomerQuoteExpiryConfirmation(quote.validUntil, req.body?.confirmExpired, approvalTime)) {
        return { error: `This quote expired on ${quote.validUntil}. Review the expiry and confirm before converting it.`, status: 409 };
      }
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
      await recordBusinessAudit(tx, {
        entityType: "sales_order", entityId: order.id, recordLabel: order.orderNumber,
        actor: res.locals.actor, action: "created", changedFields: ["customerId", "deliveryAddress", "notes", "status", "lines"],
      });
      await tx.insert(salesOrderLines).values(quoteLines.map((line) => ({
        salesOrderId: order.id, productId: line.productId, quantity: line.quantity, unitPriceZmw: line.unitPriceZmw,
      })));
      const [savedQuote] = await tx.update(customerQuotes).set({ status: "converted", salesOrderId: order.id, updatedAt: new Date() }).where(eq(customerQuotes.id, id)).returning();
      await recordBusinessAudit(tx, {
        entityType: "customer_quote", entityId: savedQuote.id, recordLabel: savedQuote.quoteNumber,
        actor: res.locals.actor, action: "updated", changedFields: ["status", "salesOrderId"],
      });
      if (expired) {
        await recordBusinessAudit(tx, {
          entityType: "customer_quote", entityId: savedQuote.id, recordLabel: savedQuote.quoteNumber,
          actor: res.locals.actor, action: "approved",
          changedFields: ["Expired quote prices", `Quote expiry date: ${quote.validUntil}`],
        });
      }
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
      await db.transaction(async (tx) => {
        await tx.delete(marketingAttributions).where(eq(marketingAttributions.salesOrderId, id));
        await recordBusinessAudit(tx, {
          entityType: "sales_order", entityId: order.id, recordLabel: `Sales order #${id}`,
          actor: res.locals.actor, action: "updated", changedFields: ["campaignAttribution"],
        });
      });
      return res.json({ campaignId: null });
    }
    const [campaign] = await db.select({ id: marketingCampaigns.id }).from(marketingCampaigns).where(eq(marketingCampaigns.id, campaignId)).limit(1);
    if (!campaign) return bad(res, "Choose an existing campaign.");
    await db.transaction(async (tx) => {
      await tx.insert(marketingAttributions).values({ salesOrderId: id, campaignId, source: "manual" })
        .onConflictDoUpdate({ target: marketingAttributions.salesOrderId, set: { campaignId, attributedAt: new Date() } });
      await recordBusinessAudit(tx, {
        entityType: "sales_order", entityId: order.id, recordLabel: `Sales order #${id}`,
        actor: res.locals.actor, action: "updated", changedFields: ["campaignAttribution"],
      });
    });
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
      await recordBusinessAudit(tx, {
        entityType: "sales_order", entityId: created.id, recordLabel: created.orderNumber,
        actor: res.locals.actor, action: "created", changedFields: ["customerId", "deliveryAddress", "notes", "status", "lines"],
      });
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

      await recordBusinessAudit(tx, {
        entityType: "sales_order", entityId: order.id, recordLabel: order.orderNumber,
        actor: res.locals.actor, action: "deleted",
      });
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
    const confirmation = salesOrderConfirmationInputSchema.safeParse(req.body ?? {});
    if (!confirmation.success) return bad(res, confirmation.error.issues[0]?.message ?? "Check the stock location choices.");
    const result = await db.transaction(async (tx) => {
      const [order] = await tx.select().from(salesOrders).where(eq(salesOrders.id, id)).for("update").limit(1);
      if (!order) return { error: "Sales order not found.", status: 404 };
      if (order.status !== "draft") return { error: "Only draft orders can be confirmed.", status: 409 };
      const [customer] = await tx.select({ status: customers.status }).from(customers).where(eq(customers.id, order.customerId)).limit(1);
      if (!customer || customer.status !== "active") return { error: "The customer is inactive and this order cannot be confirmed.", status: 409 };
      const lines = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, id)).orderBy(asc(salesOrderLines.productId));
      const requestedLocations = new Map(confirmation.data.locations.map(({ productId, locationId }) => [productId, locationId]));
      if ([...requestedLocations.keys()].some((productId) => !lines.some((line) => line.productId === productId))) {
        return { error: "A stock location choice does not match this order.", status: 400 };
      }
      const activeLocations = await tx.select({ id: inventoryLocations.id, name: inventoryLocations.name })
        .from(inventoryLocations).where(eq(inventoryLocations.active, true)).orderBy(asc(inventoryLocations.name));
      const allocationsByProduct = new Map<number, { locationId: number; quantity: number }[]>();
      for (const line of lines) {
        const [product] = await tx.select({ id: products.id, status: products.status }).from(products).where(eq(products.id, line.productId)).for("update");
        if (!product || product.status !== "active") return { error: `Product ${line.productId} is no longer active.`, status: 409 };
        const stockLocations = await Promise.all(activeLocations.map(async (location) => {
          const balance = await stockBalance(tx, line.productId, location.id);
          return { ...location, available: balance.onHand - balance.reserved };
        }));
        const allocation = chooseSalesStockAllocations(
          stockLocations, line.quantity, requestedLocations.get(line.productId) ?? null,
        );
        if ("error" in allocation) {
          return { error: `Product ${line.productId}: ${allocation.error}`, status: 409 };
        }
        allocationsByProduct.set(line.productId, allocation.allocations.map(({ id, quantity }) => ({
          locationId: id, quantity,
        })));
      }
      const reservations = await tx.insert(inventoryReservations).values(lines.flatMap((line) =>
        (allocationsByProduct.get(line.productId) ?? []).map((allocation) => ({
          productId: line.productId, locationId: allocation.locationId, salesOrderId: id,
          quantity: allocation.quantity, reference: order.orderNumber,
          reason: `Sales order ${order.orderNumber}`, status: "active" as const,
        })),
      )).returning();
      for (const reservation of reservations) await recordBusinessAudit(tx, {
        entityType: "inventory_reservation", entityId: reservation.id,
        recordLabel: `Reservation #${reservation.id} · product #${reservation.productId}`,
        actor: res.locals.actor, action: "created",
        changedFields: ["productId", "locationId", "salesOrderId", "quantity", "reference", "reason", "status"],
      });
      const [saved] = await tx.update(salesOrders).set({ status: "confirmed", confirmedAt: new Date(), updatedAt: new Date() }).where(eq(salesOrders.id, id)).returning();
      await recordBusinessAudit(tx, {
        entityType: "sales_order", entityId: saved.id, recordLabel: saved.orderNumber,
        actor: res.locals.actor, action: "updated", changedFields: ["status", "confirmedAt"],
      });
      return { order: saved };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.json({ order: result.order });
  });
  app.post("/api/sales-orders/:id/deliveries", owner, async (req, res) => {
    const id = idOf(req.params.id); if (!id) return bad(res, "Invalid sales order.");
    const parsed = salesDeliveryInputSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the delivery details.");
    const result = await db.transaction((tx) => recordDelivery(tx, id, parsed.data, res.locals.actor));
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.status(201).json(result);
  });
  app.post("/api/sales-deliveries/:id/receipt-proof", owner, async (req, res) => {
    const deliveryId = idOf(req.params.id);
    if (!deliveryId) return bad(res, "Invalid delivery note.");

    const receivedBy = typeof req.query.receivedBy === "string" ? req.query.receivedBy.trim() : "";
    const receivedAtValue = typeof req.query.receivedAt === "string" ? req.query.receivedAt : "";
    const fileName = typeof req.query.fileName === "string" ? req.query.fileName : "";
    if (!receivedBy || receivedBy.length > 120 || /[\u0000-\u001f\u007f]/.test(receivedBy)) {
      return bad(res, "Enter the name of the person who received the delivery.");
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(receivedAtValue)) {
      return bad(res, "Enter a valid date and time the delivery was received.");
    }
    const receivedAt = new Date(receivedAtValue);
    if (
      !Number.isFinite(receivedAt.getTime())
      || (receivedAtValue.includes(".")
        ? receivedAt.toISOString() !== receivedAtValue
        : receivedAt.toISOString().replace(".000Z", "Z") !== receivedAtValue)
    ) return bad(res, "Enter a valid date and time the delivery was received.");
    if (fileName.length > 255) return bad(res, "The proof file name is too long.");

    const file = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const proof = file.length ? inspectDeliveryProof(file, fileName) : null;
    if (proof && "error" in proof) return bad(res, proof.error ?? "Invalid proof file.");

    const [delivery] = await db.select({
      id: salesDeliveries.id, deliveryNumber: salesDeliveries.deliveryNumber,
    }).from(salesDeliveries).where(eq(salesDeliveries.id, deliveryId)).limit(1);
    if (!delivery) return res.status(404).json({ error: "Delivery note not found." });

    const saved = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(salesDeliveryReceipts)
        .where(eq(salesDeliveryReceipts.deliveryId, deliveryId)).for("update").limit(1);
      const values = {
        deliveryId, receivedBy, receivedAt,
        proofFileName: proof && !("error" in proof) ? proof.fileName : existing?.proofFileName ?? null,
        proofMimeType: proof && !("error" in proof) ? proof.mimeType : existing?.proofMimeType ?? null,
        proofData: proof && !("error" in proof) ? file : existing?.proofData ?? null,
        updatedAt: new Date(),
      };
      const [receipt] = existing
        ? await tx.update(salesDeliveryReceipts).set(values).where(eq(salesDeliveryReceipts.id, existing.id)).returning()
        : await tx.insert(salesDeliveryReceipts).values(values).returning();
      await recordBusinessAudit(tx, {
        entityType: "sales_delivery_receipt", entityId: receipt.id,
        recordLabel: `${delivery.deliveryNumber} · received by ${receipt.receivedBy}`,
        actor: res.locals.actor, action: existing ? "updated" : "created",
        changedFields: ["receivedBy", "receivedAt", ...(proof && !("error" in proof) ? ["proof"] : [])],
      });
      return receipt;
    });
    res.json({
      receipt: {
        receivedBy: saved.receivedBy, receivedAt: saved.receivedAt,
        proofFileName: saved.proofFileName, proofMimeType: saved.proofMimeType,
        proofs: saved.proofFileName && saved.proofMimeType
          ? [{ id: null, fileName: saved.proofFileName, mimeType: saved.proofMimeType }]
          : [],
      },
    });
  });
  app.post("/api/sales-deliveries/:id/receipt-proofs", owner, async (req, res) => {
    const deliveryId = idOf(req.params.id);
    if (!deliveryId) return bad(res, "Invalid delivery note.");
    const idempotencyKey = req.get("Idempotency-Key") ?? "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      return bad(res, "A valid upload request key is required.");
    }
    const fileName = typeof req.query.fileName === "string" ? req.query.fileName : "";
    if (!fileName || fileName.length > 255) return bad(res, "Choose a valid signed proof file.");
    const file = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const proof = inspectDeliveryProof(file, fileName);
    if ("error" in proof) return bad(res, proof.error ?? "Invalid proof file.");
    const [delivery] = await db.select({
      id: salesDeliveries.id, deliveryNumber: salesDeliveries.deliveryNumber,
    }).from(salesDeliveries).where(eq(salesDeliveries.id, deliveryId)).limit(1);
    if (!delivery) return res.status(404).json({ error: "Delivery note not found." });
    const [receipt] = await db.select({ id: salesDeliveryReceipts.id })
      .from(salesDeliveryReceipts).where(eq(salesDeliveryReceipts.deliveryId, deliveryId)).limit(1);
    if (!receipt) return res.status(409).json({ error: "Save the delivery recipient and receipt time before adding signed proof." });

    const outcome = await db.transaction(async (tx) => {
      const [created] = await tx.insert(salesDeliveryReceiptProofs).values({
        deliveryId, fileName: proof.fileName, mimeType: proof.mimeType, data: file, idempotencyKey,
      }).onConflictDoNothing({
        target: [salesDeliveryReceiptProofs.deliveryId, salesDeliveryReceiptProofs.idempotencyKey],
      }).returning();
      if (!created) {
        const [existing] = await tx.select({
          id: salesDeliveryReceiptProofs.id,
          fileName: salesDeliveryReceiptProofs.fileName,
          mimeType: salesDeliveryReceiptProofs.mimeType,
          data: salesDeliveryReceiptProofs.data,
        }).from(salesDeliveryReceiptProofs).where(and(
          eq(salesDeliveryReceiptProofs.deliveryId, deliveryId),
          eq(salesDeliveryReceiptProofs.idempotencyKey, idempotencyKey),
        )).limit(1);
        if (!existing) return { conflict: true as const };
        const isSameUpload = existing.fileName === proof.fileName
          && existing.mimeType === proof.mimeType
          && Buffer.from(existing.data).equals(file);
        return isSameUpload
          ? { proof: existing, replay: true as const, conflict: false as const }
          : { conflict: true as const };
      }
      await recordBusinessAudit(tx, {
        entityType: "sales_delivery_receipt", entityId: receipt.id,
        recordLabel: `${delivery.deliveryNumber} · ${proof.fileName}`,
        actor: res.locals.actor, action: "updated", changedFields: ["proof"],
      });
      return { proof: created, replay: false as const, conflict: false as const };
    });
    if (outcome.conflict) return res.status(409).json({ error: "This upload request key was already used for a different proof file." });
    res.status(outcome.replay ? 200 : 201).json({
      proof: { id: outcome.proof.id, fileName: outcome.proof.fileName, mimeType: outcome.proof.mimeType },
    });
  });
  app.get("/api/sales-deliveries/:id/receipt-proofs/:proofId", owner, async (req, res) => {
    const deliveryId = idOf(req.params.id);
    const proofId = idOf(req.params.proofId);
    if (!deliveryId || !proofId) return bad(res, "Invalid delivery proof.");
    const [proof] = await db.select({
      fileName: salesDeliveryReceiptProofs.fileName,
      mimeType: salesDeliveryReceiptProofs.mimeType,
      data: salesDeliveryReceiptProofs.data,
    }).from(salesDeliveryReceiptProofs).where(and(
      eq(salesDeliveryReceiptProofs.id, proofId),
      eq(salesDeliveryReceiptProofs.deliveryId, deliveryId),
    )).limit(1);
    if (!proof) return res.status(404).json({ error: "Signed proof not found for this delivery note." });
    const downloadName = proof.fileName.replace(/[\u0000-\u001f\u007f"\\]/g, "_");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", proof.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
    res.send(proof.data);
  });
  app.get("/api/sales-deliveries/:id/receipt-proof", owner, async (req, res) => {
    const deliveryId = idOf(req.params.id);
    if (!deliveryId) return bad(res, "Invalid delivery note.");
    const [receipt] = await db.select({
      proofFileName: salesDeliveryReceipts.proofFileName,
      proofMimeType: salesDeliveryReceipts.proofMimeType,
      proofData: salesDeliveryReceipts.proofData,
    }).from(salesDeliveryReceipts).where(eq(salesDeliveryReceipts.deliveryId, deliveryId)).limit(1);
    if (!receipt?.proofData || !receipt.proofFileName || !receipt.proofMimeType) {
      return res.status(404).json({ error: "No signed proof is saved for this delivery note." });
    }
    const downloadName = receipt.proofFileName.replace(/[\u0000-\u001f\u007f"\\]/g, "_");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", receipt.proofMimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
    res.send(receipt.proofData);
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
      return recordDelivery(tx, id, {
        idempotencyKey: randomUUID(),
        deliveryDate: new Date().toISOString().slice(0, 10),
        lines: remainingLines,
      }, res.locals.actor);
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
      const releasedReservations = await tx.update(inventoryReservations).set({ status: "released", updatedAt: new Date() })
        .where(and(eq(inventoryReservations.salesOrderId, id), eq(inventoryReservations.status, "active"))).returning();
      for (const reservation of releasedReservations) await recordBusinessAudit(tx, {
        entityType: "inventory_reservation", entityId: reservation.id,
        recordLabel: `Reservation #${reservation.id} · product #${reservation.productId}`,
        actor: res.locals.actor, action: "updated", changedFields: ["status"],
      });
      const [saved] = await tx.update(salesOrders).set({ status: "cancelled", updatedAt: new Date() }).where(eq(salesOrders.id, id)).returning();
      await recordBusinessAudit(tx, {
        entityType: "sales_order", entityId: saved.id, recordLabel: saved.orderNumber,
        actor: res.locals.actor, action: "updated", changedFields: ["status"],
      });
      return { order: saved };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.json({ order: result.order });
  });
}
