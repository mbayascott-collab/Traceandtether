import { and, asc, desc, eq, gt, inArray, sum } from "drizzle-orm";
import type { Express, RequestHandler } from "express";
import { allocateLandedCosts } from "../shared/landed-cost";
import {
  inventoryAdjustmentInputSchema, inventoryReservationInputSchema,
} from "./product-validation";
import {
  importExpenses, inventoryMovements, inventoryReservations, products, purchaseOrderLines, purchaseOrders,
  shipmentLines, shipments, suppliers,
} from "../shared/schema";
import { db } from "./db";
import { accountBalance, cents, formatCents, postJournal } from "./accounting-posting";

const bad = (res: import("express").Response, message: string) => res.status(400).json({ error: message });
async function balance(tx: any, productId: number) {
  const [movement] = await tx.select({ quantity: sum(inventoryMovements.quantityDelta) }).from(inventoryMovements).where(eq(inventoryMovements.productId, productId));
  const [reserved] = await tx.select({ quantity: sum(inventoryReservations.quantity) }).from(inventoryReservations)
    .where(and(eq(inventoryReservations.productId, productId), eq(inventoryReservations.status, "active")));
  return { onHand: Number(movement?.quantity ?? 0), reserved: Number(reserved?.quantity ?? 0) };
}
function getId(value: unknown) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function registerInventoryRoutes(app: Express, owner: RequestHandler) {
  app.get("/api/inventory", owner, async (_req, res) => {
    const [items, movements, reservations] = await Promise.all([
      db.select({ id: products.id, name: products.name, sku: products.sku, unit: products.unit, status: products.status }).from(products).orderBy(asc(products.name)),
      db.select({ productId: inventoryMovements.productId, delta: inventoryMovements.quantityDelta }).from(inventoryMovements),
      db.select({ productId: inventoryReservations.productId, quantity: inventoryReservations.quantity }).from(inventoryReservations).where(eq(inventoryReservations.status, "active")),
    ]);
    const onHand = new Map<number, number>(), reserved = new Map<number, number>();
    movements.forEach((row) => onHand.set(row.productId, (onHand.get(row.productId) ?? 0) + row.delta));
    reservations.forEach((row) => reserved.set(row.productId, (reserved.get(row.productId) ?? 0) + row.quantity));
    res.json({ inventory: items.map((item) => {
      const stock = onHand.get(item.id) ?? 0, held = reserved.get(item.id) ?? 0;
      return { ...item, onHand: stock, reserved: held, available: stock - held };
    }) });
  });

  app.get("/api/inventory/movements", owner, async (_req, res) => {
    const rows = await db.select({ movement: inventoryMovements, productName: products.name, sku: products.sku })
      .from(inventoryMovements).innerJoin(products, eq(inventoryMovements.productId, products.id))
      .orderBy(desc(inventoryMovements.createdAt)).limit(200);
    res.json({ movements: rows.map((row) => ({ ...row.movement, productName: row.productName, sku: row.sku })) });
  });

  app.get("/api/inventory/receipts", owner, async (_req, res) => {
    const rows = await db.select({
      shipmentLine: shipmentLines, shipment: shipments, order: purchaseOrders, supplierName: suppliers.name,
      productName: products.name, sku: products.sku,
    }).from(shipmentLines)
      .innerJoin(shipments, eq(shipmentLines.shipmentId, shipments.id))
      .innerJoin(purchaseOrders, eq(shipments.purchaseOrderId, purchaseOrders.id))
      .innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
      .innerJoin(purchaseOrderLines, eq(shipmentLines.purchaseOrderLineId, purchaseOrderLines.id))
      .innerJoin(products, eq(purchaseOrderLines.productId, products.id))
      .where(and(gt(shipmentLines.quantityReceived, shipmentLines.quantityStocked), inArray(shipments.status, ["received", "partially_received"])))
      .orderBy(asc(shipments.receivedAt));
    res.json({ receipts: rows.map(({ shipmentLine, shipment, order, supplierName, productName, sku }) => ({
      ...shipmentLine, shipmentReference: shipment.shipmentReference, orderNumber: order.orderNumber,
      supplierName, productName, sku, quantityToPost: shipmentLine.quantityReceived - shipmentLine.quantityStocked,
    })) });
  });

  app.post("/api/inventory/receipts/:shipmentLineId/post", owner, async (req, res) => {
    const id = getId(req.params.shipmentLineId);
    if (!id) return bad(res, "Invalid shipment line.");
    const result = await db.transaction(async (tx) => {
      const [line] = await tx.select().from(shipmentLines).where(eq(shipmentLines.id, id)).for("update").limit(1);
      if (!line) return { error: "Shipment line not found.", status: 404 };
      const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, line.shipmentId)).limit(1);
      if (!shipment || !["received", "partially_received"].includes(shipment.status)) return { error: "Only received shipments can be posted to stock.", status: 409 };
      const quantity = line.quantityReceived - line.quantityStocked;
      if (quantity <= 0) return { error: "This received quantity has already been posted.", status: 409 };
      const [productLine] = await tx.select({ productId: purchaseOrderLines.productId }).from(purchaseOrderLines).where(eq(purchaseOrderLines.id, line.purchaseOrderLineId)).limit(1);
      if (!productLine) return { error: "Order product not found.", status: 404 };
      await tx.select({ id: products.id }).from(products).where(eq(products.id, productLine.productId)).for("update");
      const [orderLine] = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, line.purchaseOrderLineId)).limit(1);
      const [order] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, shipment.purchaseOrderId)).limit(1);
      if (!orderLine || !order) return { error: "Purchase order cost details could not be found.", status: 409 };
      const orderLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, order.id));
      const expenses = await tx.select().from(importExpenses).where(eq(importExpenses.purchaseOrderId, order.id));
      const allocated = allocateLandedCosts(
        orderLines.map((row) => ({ lineId: row.id, quantityOrdered: row.quantityOrdered, unitPrice: row.unitPrice })),
        expenses.map((row) => ({ expenseId: row.id, amount: row.amount, exchangeRateToZmw: row.exchangeRateToZmw, basis: row.basis })),
        order.exchangeRateToZmw,
      );
      const [stockedBefore] = await tx.select({ quantity: sum(shipmentLines.quantityStocked) })
        .from(shipmentLines).where(eq(shipmentLines.purchaseOrderLineId, orderLine.id));
      const priorQty = Number(stockedBefore?.quantity ?? 0);
      const allocatedLine = allocated.lines.find((row) => row.lineId === orderLine.id);
      const allocatedExpenseCents = cents(allocatedLine?.allocatedExpensesZmw ?? "0.00");
      const roundDiv = (numerator: bigint, denominator: bigint) => (numerator + denominator / 2n) / denominator;
      const allocatedThrough = (stockedQty: number) => roundDiv(allocatedExpenseCents * BigInt(stockedQty), BigInt(orderLine.quantityOrdered));
      const landedIncrement = allocatedThrough(priorQty + quantity) - allocatedThrough(priorQty);
      const [fxWhole, fxFraction = ""] = order.exchangeRateToZmw.split(".");
      const fxRate = BigInt(fxWhole) * 100_000_000n + BigInt(fxFraction.padEnd(8, "0").slice(0, 8));
      const purchaseUnitCents = roundDiv(cents(orderLine.unitPrice) * fxRate, 100_000_000n);
      const goodsCost = purchaseUnitCents * BigInt(quantity);
      const inventoryCost = goodsCost + landedIncrement;
      const [movement] = await tx.insert(inventoryMovements).values({
        productId: productLine.productId, kind: "stock_receipt", quantityDelta: quantity,
        reason: `Received shipment ${shipment.shipmentReference || `#${shipment.id}`}`,
        reference: shipment.trackingNumber, sourceKey: `shipment-line-${line.id}-to-${line.quantityReceived}`,
      }).returning();
      if (inventoryCost > 0n) {
        await postJournal(tx, {
          sourceKey: `inventory-movement-${movement.id}`, sourceType: "stock_receipt", sourceId: movement.id,
          memo: `Stock receipt for ${order.orderNumber}`, entryDate: shipment.receivedAt ?? undefined,
          lines: [
            { accountKey: "inventory", productId: productLine.productId, debitZmw: formatCents(inventoryCost), description: "Received inventory" },
            ...(goodsCost > 0n ? [{ accountKey: "accounts_payable", creditZmw: formatCents(goodsCost), description: "Supplier goods cost" }] : []),
            ...(landedIncrement > 0n ? [{ accountKey: "landed_cost_clearing", creditZmw: formatCents(landedIncrement), description: "Allocated import costs" }] : []),
          ],
        });
      }
      await tx.update(shipmentLines).set({ quantityStocked: line.quantityReceived }).where(eq(shipmentLines.id, line.id));
      return { movement };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.status(201).json({ movement: result.movement });
  });

  app.get("/api/inventory/reservations", owner, async (_req, res) => {
    const rows = await db.select({ reservation: inventoryReservations, productName: products.name, sku: products.sku })
      .from(inventoryReservations).innerJoin(products, eq(inventoryReservations.productId, products.id))
      .orderBy(desc(inventoryReservations.createdAt));
    res.json({ reservations: rows.map((row) => ({ ...row.reservation, productName: row.productName, sku: row.sku })) });
  });

  app.post("/api/inventory/reservations", owner, async (req, res) => {
    const parsed = inventoryReservationInputSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the reservation.");
    const result = await db.transaction(async (tx) => {
      const [product] = await tx.select({ id: products.id }).from(products).where(eq(products.id, parsed.data.productId)).for("update").limit(1);
      if (!product) return { error: "Product not found.", status: 404 };
      const current = await balance(tx, product.id), available = current.onHand - current.reserved;
      if (parsed.data.quantity > available) return { error: `Only ${available} units are available to reserve.`, status: 409 };
      const [reservation] = await tx.insert(inventoryReservations).values(parsed.data).returning();
      return { reservation };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.status(201).json({ reservation: result.reservation });
  });

  app.post("/api/inventory/reservations/:id/release", owner, async (req, res) => {
    const id = getId(req.params.id);
    if (!id) return bad(res, "Invalid reservation.");
    const result = await db.transaction(async (tx) => {
      const [reservation] = await tx.select().from(inventoryReservations).where(eq(inventoryReservations.id, id)).for("update").limit(1);
      if (!reservation) return { error: "Reservation not found.", status: 404 };
      if (reservation.salesOrderId) return { error: "Manage this reservation through its sales order.", status: 409 };
      if (reservation.status !== "active") return { error: "Only active reservations can be released.", status: 409 };
      const [saved] = await tx.update(inventoryReservations).set({ status: "released", updatedAt: new Date() }).where(eq(inventoryReservations.id, id)).returning();
      return { reservation: saved };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.json({ reservation: result.reservation });
  });

  app.post("/api/inventory/reservations/:id/fulfill", owner, async (req, res) => {
    const id = getId(req.params.id);
    if (!id) return bad(res, "Invalid reservation.");
    const result = await db.transaction(async (tx) => {
      const [reservation] = await tx.select().from(inventoryReservations).where(eq(inventoryReservations.id, id)).for("update").limit(1);
      if (!reservation) return { error: "Reservation not found.", status: 404 };
      if (reservation.salesOrderId) return { error: "Manage this reservation through its sales order.", status: 409 };
      if (reservation.status !== "active") return { error: "Only active reservations can be fulfilled.", status: 409 };
      await tx.select({ id: products.id }).from(products).where(eq(products.id, reservation.productId)).for("update");
      const current = await balance(tx, reservation.productId);
      if (current.onHand < reservation.quantity) return { error: "Insufficient on-hand stock to fulfill this reservation.", status: 409 };
      const inventoryValue = await accountBalance(tx, "inventory", reservation.productId);
      const cost = current.onHand > 0 ? (inventoryValue * BigInt(reservation.quantity) + BigInt(current.onHand / 2)) / BigInt(current.onHand) : 0n;
      const [movement] = await tx.insert(inventoryMovements).values({
        productId: reservation.productId, kind: "reservation_fulfillment", quantityDelta: -reservation.quantity,
        reason: `Fulfilled reservation #${reservation.id}: ${reservation.reason}`,
        reference: reservation.reference, sourceKey: `reservation-${reservation.id}-fulfilled`, reservationId: reservation.id,
      }).returning();
      if (cost > 0n) {
        await postJournal(tx, {
          sourceKey: `inventory-movement-${movement.id}`, sourceType: "reservation_fulfillment", sourceId: movement.id,
          memo: `Fulfilled inventory reservation #${reservation.id}`,
          lines: [
            { accountKey: "inventory_adjustments", productId: reservation.productId, debitZmw: formatCents(cost), description: "Inventory issued outside a sales order" },
            { accountKey: "inventory", productId: reservation.productId, creditZmw: formatCents(cost), description: "Inventory issued" },
          ],
        });
      }
      await tx.update(inventoryReservations).set({ status: "fulfilled", updatedAt: new Date() }).where(eq(inventoryReservations.id, id));
      return { movement };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.json({ movement: result.movement });
  });

  app.post("/api/inventory/adjustments", owner, async (req, res) => {
    const parsed = inventoryAdjustmentInputSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the adjustment.");
    const result = await db.transaction(async (tx) => {
      const [product] = await tx.select({ id: products.id }).from(products).where(eq(products.id, parsed.data.productId)).for("update").limit(1);
      if (!product) return { error: "Product not found.", status: 404 };
      const current = await balance(tx, product.id), next = current.onHand + parsed.data.quantityDelta;
      if (next < current.reserved) return { error: `Adjustment would leave fewer than ${current.reserved} reserved units on hand.`, status: 409 };
      const [movement] = await tx.insert(inventoryMovements).values({
        ...parsed.data, kind: "adjustment",
      }).returning();
      const inventoryValue = await accountBalance(tx, "inventory", product.id);
      if (current.onHand > 0 && inventoryValue > 0n) {
        const value = (inventoryValue * BigInt(Math.abs(parsed.data.quantityDelta)) + BigInt(current.onHand / 2)) / BigInt(current.onHand);
        if (value > 0n) {
          await postJournal(tx, {
            sourceKey: `inventory-movement-${movement.id}`, sourceType: "inventory_adjustment", sourceId: movement.id,
            memo: parsed.data.reason,
            lines: parsed.data.quantityDelta > 0
              ? [
                  { accountKey: "inventory", productId: product.id, debitZmw: formatCents(value), description: "Stock adjustment" },
                  { accountKey: "inventory_adjustments", creditZmw: formatCents(value), description: "Adjustment gain" },
                ]
              : [
                  { accountKey: "inventory_adjustments", productId: product.id, debitZmw: formatCents(value), description: "Stock adjustment loss" },
                  { accountKey: "inventory", productId: product.id, creditZmw: formatCents(value), description: "Inventory reduction" },
                ],
          });
        }
      }
      return { movement };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.status(201).json({ movement: result.movement });
  });
}
