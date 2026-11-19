import { and, asc, desc, eq, gt, inArray, sum } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Express, RequestHandler } from "express";
import { allocateLandedCosts } from "../shared/landed-cost";
import { importExpensesForPurchaseOrder } from "./import-expense-allocation";
import {
  inventoryAdjustmentInputSchema, inventoryReservationInputSchema, openingStockCorrectionInputSchema, openingStockInputSchema,
} from "./product-validation";
import {
  inventoryLocations, inventoryMovementEvidence, inventoryMovements, inventoryReservations, journalLines, products, purchaseOrderLines, purchaseOrders,
  shipmentLines, shipments, suppliers,
} from "../shared/schema";
import { db } from "./db";
import { recordBusinessAudit } from "./audit";
import {
  inspectOpeningStockEvidence, MAX_OPENING_STOCK_EVIDENCE_FILES, parseOpeningStockEvidenceMultipart,
  safeOpeningStockEvidenceFilename,
} from "./opening-stock-evidence";
import {
  accountBalance, allocateInventoryValueByLocationCents, buildOpeningStockLines, calculatePurchaseReceiptPosting, cents, ensureAccountingAccounts, formatCents,
  journalLinesAreBalanced, postJournal, reverseJournalEntry, weightedAverageUnitCostCents,
} from "./accounting-posting";

const bad = (res: import("express").Response, message: string) => res.status(400).json({ error: message });
async function mainLocationId(tx: any): Promise<number> {
  const [existing] = await tx.select({ id: inventoryLocations.id }).from(inventoryLocations).where(eq(inventoryLocations.name, "Main")).limit(1);
  if (existing) return existing.id;
  const [created] = await tx.insert(inventoryLocations).values({ name: "Main" }).onConflictDoNothing().returning({ id: inventoryLocations.id });
  if (created) return created.id;
  const [raced] = await tx.select({ id: inventoryLocations.id }).from(inventoryLocations).where(eq(inventoryLocations.name, "Main")).limit(1);
  if (!raced) throw new Error("The main stock location could not be created.");
  return raced.id;
}
async function balance(tx: any, productId: number, locationId?: number) {
  const movementWhere = locationId
    ? and(eq(inventoryMovements.productId, productId), eq(inventoryMovements.locationId, locationId))
    : eq(inventoryMovements.productId, productId);
  const reservationWhere = locationId
    ? and(eq(inventoryReservations.productId, productId), eq(inventoryReservations.status, "active"), eq(inventoryReservations.locationId, locationId))
    : and(eq(inventoryReservations.productId, productId), eq(inventoryReservations.status, "active"));
  const [movement] = await tx.select({ quantity: sum(inventoryMovements.quantityDelta) }).from(inventoryMovements).where(movementWhere);
  const [reserved] = await tx.select({ quantity: sum(inventoryReservations.quantity) }).from(inventoryReservations)
    .where(reservationWhere);
  return { onHand: Number(movement?.quantity ?? 0), reserved: Number(reserved?.quantity ?? 0) };
}
function getId(value: unknown) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function registerInventoryRoutes(app: Express, owner: RequestHandler) {
  app.get("/api/inventory", owner, async (_req, res) => {
    const accounts = await ensureAccountingAccounts(db);
    const inventoryAccount = accounts.get("inventory");
    if (!inventoryAccount) throw new Error("The inventory account is unavailable.");
    const [items, movements, locations, reservations, inventoryLines] = await Promise.all([
      db.select({ id: products.id, name: products.name, sku: products.sku, unit: products.unit, status: products.status }).from(products).orderBy(asc(products.name)),
      db.select({ productId: inventoryMovements.productId, locationId: inventoryMovements.locationId, delta: inventoryMovements.quantityDelta }).from(inventoryMovements),
       db.select().from(inventoryLocations),
      db.select({ productId: inventoryReservations.productId, locationId: inventoryReservations.locationId, quantity: inventoryReservations.quantity }).from(inventoryReservations).where(eq(inventoryReservations.status, "active")),
      db.select({
        productId: journalLines.productId, debitZmw: journalLines.debitZmw, creditZmw: journalLines.creditZmw,
      }).from(journalLines).where(eq(journalLines.accountId, inventoryAccount.id)),
    ]);
    const onHand = new Map<number, number>(), reserved = new Map<number, number>();
    const byLocation = new Map<string, number>();
    const reservedByLocation = new Map<string, number>();
    const stockValue = new Map<number, bigint>();
    movements.forEach((row) => {
      onHand.set(row.productId, (onHand.get(row.productId) ?? 0) + row.delta);
      const key = `${row.productId}:${row.locationId}`;
      byLocation.set(key, (byLocation.get(key) ?? 0) + row.delta);
    });
    reservations.forEach((row) => {
      reserved.set(row.productId, (reserved.get(row.productId) ?? 0) + row.quantity);
      const key = `${row.productId}:${row.locationId}`;
      reservedByLocation.set(key, (reservedByLocation.get(key) ?? 0) + row.quantity);
    });
    inventoryLines.forEach((row) => {
      if (row.productId === null) return;
      stockValue.set(row.productId,
        (stockValue.get(row.productId) ?? 0n) + cents(row.debitZmw) - cents(row.creditZmw));
    });
    const locationValueTotals = new Map<number | null, bigint>(locations.map((location) => [location.id, 0n]));
    const inventory = items.map((item) => {
      const stock = onHand.get(item.id) ?? 0, held = reserved.get(item.id) ?? 0;
      const value = stockValue.get(item.id) ?? 0n;
      const unassignedOnHand = byLocation.get(`${item.id}:null`) ?? 0;
      const locationQuantities = [
        ...locations.map((location) => ({
          locationId: location.id,
          onHand: byLocation.get(`${item.id}:${location.id}`) ?? 0,
        })),
        ...(unassignedOnHand !== 0 ? [{ locationId: null, onHand: unassignedOnHand }] : []),
      ];
      const valueByLocation = allocateInventoryValueByLocationCents(value, locationQuantities);
      const locationValues: {
        id: number | null; name: string; onHand: number; reserved: number; available: number; stockValueZmw: string;
      }[] = locations.map((location) => ({
        id: location.id, name: location.name,
        onHand: byLocation.get(`${item.id}:${location.id}`) ?? 0,
        reserved: reservedByLocation.get(`${item.id}:${location.id}`) ?? 0,
        available: (byLocation.get(`${item.id}:${location.id}`) ?? 0) - (reservedByLocation.get(`${item.id}:${location.id}`) ?? 0),
        stockValueZmw: formatCents(valueByLocation.get(location.id) ?? 0n),
      }));
      if (unassignedOnHand !== 0 || (valueByLocation.has(null) && (valueByLocation.get(null) ?? 0n) !== 0n)) {
        locationValues.push({
          id: null, name: "Unassigned",
          onHand: unassignedOnHand,
          reserved: reservedByLocation.get(`${item.id}:null`) ?? 0,
          available: unassignedOnHand - (reservedByLocation.get(`${item.id}:null`) ?? 0),
          stockValueZmw: formatCents(valueByLocation.get(null) ?? 0n),
        });
      }
      for (const location of locationValues) {
        locationValueTotals.set(location.id, (locationValueTotals.get(location.id) ?? 0n) + cents(location.stockValueZmw));
      }
      return {
        ...item, onHand: stock, reserved: held, available: stock - held,
        stockValueZmw: formatCents(value),
        averageUnitCostZmw: formatCents(weightedAverageUnitCostCents(value, stock)),
        locations: locationValues,
      };
    });
    const locationTotals = [...locationValueTotals.entries()]
      .map(([id, value]) => ({
        id,
        name: id === null ? "Unassigned" : locations.find((location) => location.id === id)?.name ?? "Unknown",
        stockValueZmw: formatCents(value),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ inventory, locationTotals });
  });

  app.get("/api/inventory/movements", owner, async (_req, res) => {
    const rows = await db.select({
      id: inventoryMovements.id, productId: inventoryMovements.productId, locationId: inventoryMovements.locationId,
      correctionOfMovementId: inventoryMovements.correctionOfMovementId,
      kind: inventoryMovements.kind, quantityDelta: inventoryMovements.quantityDelta, reason: inventoryMovements.reason,
      reference: inventoryMovements.reference, sourceKey: inventoryMovements.sourceKey, reservationId: inventoryMovements.reservationId,
      salesDeliveryLineId: inventoryMovements.salesDeliveryLineId,
      createdAt: inventoryMovements.createdAt, evidenceFileName: inventoryMovements.evidenceFileName,
      evidenceMimeType: inventoryMovements.evidenceMimeType,
      productName: products.name, sku: products.sku, locationName: inventoryLocations.name,
    })
      .from(inventoryMovements).innerJoin(products, eq(inventoryMovements.productId, products.id))
      .leftJoin(inventoryLocations, eq(inventoryMovements.locationId, inventoryLocations.id))
      .orderBy(desc(inventoryMovements.createdAt)).limit(200);
    const evidenceRows = rows.length
      ? await db.select({
        id: inventoryMovementEvidence.id, movementId: inventoryMovementEvidence.movementId,
        fileName: inventoryMovementEvidence.fileName, mimeType: inventoryMovementEvidence.mimeType,
      }).from(inventoryMovementEvidence)
        .where(inArray(inventoryMovementEvidence.movementId, rows.map((row) => row.id)))
        .orderBy(asc(inventoryMovementEvidence.id))
      : [];
    const evidenceByMovement = new Map<number, typeof evidenceRows>();
    evidenceRows.forEach((evidence) => evidenceByMovement.set(
      evidence.movementId,
      [...(evidenceByMovement.get(evidence.movementId) ?? []), evidence],
    ));
    res.json({ movements: rows.map(({ evidenceFileName, evidenceMimeType, ...movement }) => ({
      ...movement,
      evidenceFiles: [
        ...(evidenceByMovement.get(movement.id) ?? []).map(({ id, fileName, mimeType }) => ({ id, fileName, mimeType })),
        ...(evidenceFileName && evidenceMimeType
          ? [{ id: null, fileName: evidenceFileName, mimeType: evidenceMimeType }]
          : []),
      ],
    })) });
  });

  app.get("/api/inventory/movements/:id/opening-evidence", owner, async (req, res) => {
    const id = getId(req.params.id);
    if (!id) return bad(res, "Invalid stock movement.");
    const [movement] = await db.select({
      kind: inventoryMovements.kind, evidenceFileName: inventoryMovements.evidenceFileName,
      evidenceMimeType: inventoryMovements.evidenceMimeType, evidenceData: inventoryMovements.evidenceData,
    }).from(inventoryMovements).where(eq(inventoryMovements.id, id)).limit(1);
    if (movement?.kind !== "opening_stock") {
      return res.status(404).json({ error: "No count evidence is saved for this opening-stock entry." });
    }
    const [firstEvidence] = movement.evidenceData ? [] : await db.select({
      fileName: inventoryMovementEvidence.fileName,
      mimeType: inventoryMovementEvidence.mimeType,
      data: inventoryMovementEvidence.data,
    }).from(inventoryMovementEvidence).where(eq(inventoryMovementEvidence.movementId, id))
      .orderBy(asc(inventoryMovementEvidence.id)).limit(1);
    const fileName = movement.evidenceFileName ?? firstEvidence?.fileName;
    const mimeType = movement.evidenceMimeType ?? firstEvidence?.mimeType;
    const data = movement.evidenceData ?? firstEvidence?.data;
    if (!fileName || !mimeType || !data) {
      return res.status(404).json({ error: "No count evidence is saved for this opening-stock entry." });
    }
    const downloadName = safeOpeningStockEvidenceFilename(fileName);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.query.download === "1") res.attachment(downloadName);
    else res.setHeader("Content-Disposition", "inline");
    res.setHeader("Content-Type", mimeType);
    return res.send(data);
  });

  app.get("/api/inventory/movements/:id/opening-evidence/:evidenceId", owner, async (req, res) => {
    const movementId = getId(req.params.id);
    const evidenceId = getId(req.params.evidenceId);
    if (!movementId || !evidenceId) return bad(res, "Invalid opening-stock evidence.");
    const [evidence] = await db.select({
      fileName: inventoryMovementEvidence.fileName,
      mimeType: inventoryMovementEvidence.mimeType,
      data: inventoryMovementEvidence.data,
    }).from(inventoryMovementEvidence)
      .innerJoin(inventoryMovements, eq(inventoryMovementEvidence.movementId, inventoryMovements.id))
      .where(and(
        eq(inventoryMovementEvidence.id, evidenceId),
        eq(inventoryMovementEvidence.movementId, movementId),
        eq(inventoryMovements.kind, "opening_stock"),
      )).limit(1);
    if (!evidence) return res.status(404).json({ error: "Count evidence was not found for this opening-stock entry." });
    const downloadName = safeOpeningStockEvidenceFilename(evidence.fileName);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.query.download === "1") res.attachment(downloadName);
    else res.setHeader("Content-Disposition", "inline");
    res.setHeader("Content-Type", evidence.mimeType);
    return res.send(evidence.data);
  });

  app.get("/api/inventory/locations", owner, async (_req, res) => {
    res.json({ locations: await db.select().from(inventoryLocations).orderBy(asc(inventoryLocations.name)) });
  });
  app.post("/api/inventory/locations", owner, async (req, res) => {
    const parsed = z.object({ name: z.string().trim().min(2).max(120) }).strict().safeParse(req.body);
    if (!parsed.success) return bad(res, "Enter a location name between 2 and 120 characters.");
    try {
      const [location] = await db.transaction(async (tx) => {
        const [created] = await tx.insert(inventoryLocations).values({ name: parsed.data.name }).returning();
        await recordBusinessAudit(tx, {
          entityType: "inventory_location", entityId: created.id, recordLabel: created.name,
          actor: res.locals.actor, action: "created", changedFields: ["name"],
        });
        return [created];
      });
      return res.status(201).json({ location });
    } catch {
      return res.status(409).json({ error: "A stock location with that name already exists." });
    }
  });

  app.get("/api/inventory/receipts", owner, async (_req, res) => {
    const rows = await db.select({
      shipmentLine: shipmentLines, shipment: shipments, order: purchaseOrders, supplierName: suppliers.name,
      productName: products.name, sku: products.sku,
    }).from(shipmentLines)
      .innerJoin(shipments, eq(shipmentLines.shipmentId, shipments.id))
      .innerJoin(purchaseOrderLines, eq(shipmentLines.purchaseOrderLineId, purchaseOrderLines.id))
      .innerJoin(purchaseOrders, eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id))
      .innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
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
    const body = z.object({ locationId: z.coerce.number().int().positive().optional() }).strict().safeParse(req.body ?? {});
    if (!body.success) return bad(res, "Choose a valid receiving location.");
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
      const [order] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, orderLine?.purchaseOrderId ?? 0)).limit(1);
      if (!orderLine || !order) return { error: "Purchase order cost details could not be found.", status: 409 };
      const locationId = body.data.locationId ?? await mainLocationId(tx);
      const [location] = await tx.select({ id: inventoryLocations.id }).from(inventoryLocations)
        .where(and(eq(inventoryLocations.id, locationId), eq(inventoryLocations.active, true))).limit(1);
      if (!location) return { error: "Choose an active receiving location.", status: 400 };
      const orderLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, order.id));
      const expenses = await importExpensesForPurchaseOrder(tx, order.id);
      const allocated = allocateLandedCosts(
        orderLines.map((row) => ({ lineId: row.id, quantityOrdered: row.quantityOrdered, unitPrice: row.unitPrice })),
        expenses.map((row) => ({
          expenseId: row.id, amount: row.amount, exchangeRateToZmw: row.exchangeRateToZmw,
          basis: row.basis, lineAllocations: row.lineAllocations,
        })),
        order.exchangeRateToZmw,
      );
      const [stockedBefore] = await tx.select({ quantity: sum(shipmentLines.quantityStocked) })
        .from(shipmentLines).where(eq(shipmentLines.purchaseOrderLineId, orderLine.id));
      const priorQty = Number(stockedBefore?.quantity ?? 0);
      const allocatedLine = allocated.lines.find((row) => row.lineId === orderLine.id);
      const receiptPosting = calculatePurchaseReceiptPosting({
        productId: productLine.productId,
        quantity,
        unitPrice: orderLine.unitPrice,
        exchangeRateToZmw: order.exchangeRateToZmw,
        quantityOrdered: orderLine.quantityOrdered,
        quantityPreviouslyStocked: priorQty,
        allocatedExpensesZmw: allocatedLine?.allocatedExpensesZmw ?? "0.00",
      });
      const [movement] = await tx.insert(inventoryMovements).values({
        productId: productLine.productId, locationId, kind: "stock_receipt", quantityDelta: quantity,
        reason: `Received shipment ${shipment.shipmentReference || `#${shipment.id}`}`,
        reference: shipment.trackingNumber, sourceKey: `shipment-line-${line.id}-to-${line.quantityReceived}`,
      }).returning();
      if (receiptPosting.inventoryCost > 0n) {
        await postJournal(tx, {
          sourceKey: `inventory-movement-${movement.id}`, sourceType: "stock_receipt", sourceId: movement.id,
          shipmentLineId: line.id,
          memo: `Stock receipt for ${order.orderNumber}`, entryDate: shipment.receivedAt ?? undefined,
          lines: receiptPosting.lines,
        });
      }
      await tx.update(shipmentLines).set({ quantityStocked: line.quantityReceived }).where(eq(shipmentLines.id, line.id));
      await recordBusinessAudit(tx, {
        entityType: "inventory_movement", entityId: movement.id,
        recordLabel: `${quantity} units received for product #${productLine.productId}`,
        actor: res.locals.actor, action: "created", changedFields: ["productId", "locationId", "kind", "quantityDelta", "reason", "reference"],
      });
      return { movement };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.status(201).json({ movement: result.movement });
  });

  app.get("/api/inventory/reservations", owner, async (_req, res) => {
    const rows = await db.select({ reservation: inventoryReservations, productName: products.name, sku: products.sku, locationName: inventoryLocations.name })
      .from(inventoryReservations).innerJoin(products, eq(inventoryReservations.productId, products.id))
      .leftJoin(inventoryLocations, eq(inventoryReservations.locationId, inventoryLocations.id))
      .orderBy(desc(inventoryReservations.createdAt));
    res.json({ reservations: rows.map((row) => ({ ...row.reservation, productName: row.productName, sku: row.sku, locationName: row.locationName })) });
  });

  app.post("/api/inventory/reservations", owner, async (req, res) => {
    const parsed = inventoryReservationInputSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the reservation.");
    const result = await db.transaction(async (tx) => {
      const [product] = await tx.select({ id: products.id }).from(products).where(eq(products.id, parsed.data.productId)).for("update").limit(1);
      if (!product) return { error: "Product not found.", status: 404 };
      const locationId = parsed.data.locationId ?? await mainLocationId(tx);
      const [location] = await tx.select({ id: inventoryLocations.id }).from(inventoryLocations)
        .where(and(eq(inventoryLocations.id, locationId), eq(inventoryLocations.active, true))).limit(1);
      if (!location) return { error: "Choose an active stock location.", status: 400 };
      const current = await balance(tx, product.id, locationId), available = current.onHand - current.reserved;
      if (parsed.data.quantity > available) return { error: `Only ${available} units are available to reserve.`, status: 409 };
      const [reservation] = await tx.insert(inventoryReservations).values({ ...parsed.data, locationId }).returning();
      await recordBusinessAudit(tx, {
        entityType: "inventory_reservation", entityId: reservation.id,
        recordLabel: `Reservation #${reservation.id} · product #${reservation.productId}`,
        actor: res.locals.actor, action: "created", changedFields: Object.keys(parsed.data),
      });
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
      await recordBusinessAudit(tx, {
        entityType: "inventory_reservation", entityId: saved.id,
        recordLabel: `Reservation #${saved.id} · product #${saved.productId}`,
        actor: res.locals.actor, action: "updated", changedFields: ["status"],
      });
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
      const current = await balance(tx, reservation.productId, reservation.locationId ?? undefined);
      if (current.onHand < reservation.quantity) return { error: "Insufficient on-hand stock to fulfill this reservation.", status: 409 };
      const productTotal = await balance(tx, reservation.productId);
      const inventoryValue = await accountBalance(tx, "inventory", reservation.productId);
      const cost = productTotal.onHand > 0 ? (inventoryValue * BigInt(reservation.quantity) + BigInt(productTotal.onHand / 2)) / BigInt(productTotal.onHand) : 0n;
      const [movement] = await tx.insert(inventoryMovements).values({
        productId: reservation.productId, locationId: reservation.locationId, kind: "reservation_fulfillment", quantityDelta: -reservation.quantity,
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
      await recordBusinessAudit(tx, {
        entityType: "inventory_reservation", entityId: reservation.id,
        recordLabel: `Reservation #${reservation.id} · product #${reservation.productId}`,
        actor: res.locals.actor, action: "updated", changedFields: ["status"],
      });
      await recordBusinessAudit(tx, {
        entityType: "inventory_movement", entityId: movement.id,
        recordLabel: `Fulfilled reservation #${reservation.id}`,
        actor: res.locals.actor, action: "created", changedFields: ["productId", "locationId", "kind", "quantityDelta", "reason"],
      });
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
      const locationId = parsed.data.locationId ?? await mainLocationId(tx);
      const [location] = await tx.select({ id: inventoryLocations.id }).from(inventoryLocations)
        .where(and(eq(inventoryLocations.id, locationId), eq(inventoryLocations.active, true))).limit(1);
      if (!location) return { error: "Choose an active stock location.", status: 400 };
      const current = await balance(tx, product.id, locationId), next = current.onHand + parsed.data.quantityDelta;
      if (next < current.reserved) return { error: `Adjustment would leave fewer than ${current.reserved} reserved units on hand.`, status: 409 };
      const productTotal = await balance(tx, product.id);
      const [movement] = await tx.insert(inventoryMovements).values({
        ...parsed.data, locationId, kind: "adjustment",
      }).returning();
      await recordBusinessAudit(tx, {
        entityType: "inventory_movement", entityId: movement.id,
        recordLabel: `Stock adjustment · product #${product.id}`,
        actor: res.locals.actor, action: "created", changedFields: ["productId", "locationId", "kind", "quantityDelta", "reason", "reference"],
      });
      const inventoryValue = await accountBalance(tx, "inventory", product.id);
      if (productTotal.onHand > 0 && inventoryValue > 0n) {
        const value = (inventoryValue * BigInt(Math.abs(parsed.data.quantityDelta)) + BigInt(productTotal.onHand / 2)) / BigInt(productTotal.onHand);
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

  app.post("/api/inventory/transfers", owner, async (req, res) => {
    const parsed = z.object({
      productId: z.number().int().positive(), fromLocationId: z.number().int().positive(),
      toLocationId: z.number().int().positive(), quantity: z.number().int().positive().max(1_000_000),
      reason: z.string().trim().min(3).max(500), reference: z.string().trim().max(120).nullable(),
    }).strict().safeParse(req.body);
    if (!parsed.success) return bad(res, "Check the product, locations, quantity, and reason.");
    if (parsed.data.fromLocationId === parsed.data.toLocationId) return bad(res, "Choose two different locations.");
    const result = await db.transaction(async (tx) => {
      const [product] = await tx.select({ id: products.id }).from(products).where(eq(products.id, parsed.data.productId)).for("update").limit(1);
      if (!product) return { error: "Product not found.", status: 404 };
      const locations = await tx.select({ id: inventoryLocations.id }).from(inventoryLocations)
        .where(inArray(inventoryLocations.id, [parsed.data.fromLocationId, parsed.data.toLocationId]));
      if (locations.length !== 2) return { error: "Choose two active stock locations.", status: 400 };
      const source = await balance(tx, product.id, parsed.data.fromLocationId);
      if (source.onHand - source.reserved < parsed.data.quantity) return { error: "That location does not have enough unreserved stock to transfer.", status: 409 };
      const transferKey = `transfer-${randomUUID()}`;
      const movements = await tx.insert(inventoryMovements).values([
        { productId: product.id, locationId: parsed.data.fromLocationId, kind: "stock_transfer_out", quantityDelta: -parsed.data.quantity, reason: parsed.data.reason, reference: parsed.data.reference, sourceKey: `${transferKey}-out` },
        { productId: product.id, locationId: parsed.data.toLocationId, kind: "stock_transfer_in", quantityDelta: parsed.data.quantity, reason: parsed.data.reason, reference: parsed.data.reference, sourceKey: `${transferKey}-in` },
      ]).returning();
      for (const movement of movements) await recordBusinessAudit(tx, {
        entityType: "inventory_movement", entityId: movement.id,
        recordLabel: `Stock transfer · product #${product.id}`,
        actor: res.locals.actor, action: "created", changedFields: ["productId", "locationId", "kind", "quantityDelta", "reason", "reference"],
      });
      return { movements };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.status(201).json(result);
  });

  app.post("/api/inventory/events", owner, async (req, res) => {
    const parsed = z.object({
      kind: z.enum(["stock_return", "stock_damage"]), productId: z.number().int().positive(),
      locationId: z.number().int().positive(), quantity: z.number().int().positive().max(1_000_000),
      reason: z.string().trim().min(3).max(500), reference: z.string().trim().max(120).nullable(),
    }).strict().safeParse(req.body);
    if (!parsed.success) return bad(res, "Check the event type, product, location, quantity, and reason.");
    const result = await db.transaction(async (tx) => {
      const [product] = await tx.select({ id: products.id }).from(products).where(eq(products.id, parsed.data.productId)).for("update").limit(1);
      if (!product) return { error: "Product not found.", status: 404 };
      const [location] = await tx.select({ id: inventoryLocations.id }).from(inventoryLocations)
        .where(eq(inventoryLocations.id, parsed.data.locationId)).limit(1);
      if (!location) return { error: "Stock location not found.", status: 404 };
      const [locBalance] = await tx.select({ quantity: sum(inventoryMovements.quantityDelta) }).from(inventoryMovements)
        .where(and(eq(inventoryMovements.productId, product.id), eq(inventoryMovements.locationId, location.id)));
      const locOnHand = Number(locBalance?.quantity ?? 0);
      const locationBalance = await balance(tx, product.id, location.id);
      const productTotal = await balance(tx, product.id);
      const delta = parsed.data.kind === "stock_return" ? parsed.data.quantity : -parsed.data.quantity;
      if (delta < 0 && locOnHand + delta < locationBalance.reserved) return { error: "This write-off would reduce stock below reserved quantities.", status: 409 };
      const [movement] = await tx.insert(inventoryMovements).values({
        productId: product.id, locationId: location.id, kind: parsed.data.kind, quantityDelta: delta,
        reason: parsed.data.reason, reference: parsed.data.reference, sourceKey: `${parsed.data.kind}:${randomUUID()}`,
      }).returning();
      await recordBusinessAudit(tx, {
        entityType: "inventory_movement", entityId: movement.id,
        recordLabel: `${parsed.data.kind.replaceAll("_", " ")} · product #${product.id}`,
        actor: res.locals.actor, action: "created", changedFields: ["productId", "locationId", "kind", "quantityDelta", "reason", "reference"],
      });
      const inventoryValue = await accountBalance(tx, "inventory", product.id);
      const cost = productTotal.onHand > 0 ? (inventoryValue * BigInt(parsed.data.quantity) + BigInt(productTotal.onHand / 2)) / BigInt(productTotal.onHand) : 0n;
      if (cost > 0n) await postJournal(tx, {
        sourceKey: `inventory-movement-${movement.id}`, sourceType: parsed.data.kind, sourceId: movement.id,
        memo: parsed.data.reason,
        lines: parsed.data.kind === "stock_return"
          ? [
              { accountKey: "inventory", productId: product.id, debitZmw: formatCents(cost), description: "Returned stock" },
              { accountKey: "inventory_adjustments", creditZmw: formatCents(cost), description: "Stock return value" },
            ]
          : [
              { accountKey: "inventory_adjustments", debitZmw: formatCents(cost), description: "Damaged stock write-off" },
              { accountKey: "inventory", productId: product.id, creditZmw: formatCents(cost), description: "Damaged inventory" },
            ],
      });
      return { movement };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.status(201).json(result);
  });

  app.post("/api/inventory/opening-stock", owner, async (req, res) => {
    const rawEvidence = Buffer.isBuffer(req.body) && req.is("application/octet-stream");
    const multipartEvidence = Buffer.isBuffer(req.body) && req.is("multipart/form-data");
    let openingStockBody = req.body;
    let uploadedFiles: { fileName: string; data: Buffer }[] = [];
    if (multipartEvidence) {
      const parsedMultipart = parseOpeningStockEvidenceMultipart(req.body as Buffer, req.get("content-type") ?? "");
      if ("error" in parsedMultipart) return bad(res, parsedMultipart.error ?? "The count evidence upload is invalid.");
      openingStockBody = parsedMultipart.fields;
      uploadedFiles = parsedMultipart.files;
    } else if (rawEvidence) {
      openingStockBody = Object.fromEntries(Object.entries(req.query).filter(([key]) => key !== "fileName"));
      uploadedFiles = [{
        fileName: typeof req.query.fileName === "string" ? req.query.fileName : "",
        data: req.body as Buffer,
      }];
    }
    const parsed = openingStockInputSchema.safeParse(openingStockBody);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the opening stock details.");
    if (uploadedFiles.length > MAX_OPENING_STOCK_EVIDENCE_FILES) {
      return bad(res, `Attach no more than ${MAX_OPENING_STOCK_EVIDENCE_FILES} count files.`);
    }
    const checkedEvidence = uploadedFiles.map((file) => ({
      data: file.data,
      result: inspectOpeningStockEvidence(file.data, file.fileName),
    }));
    const invalidEvidence = checkedEvidence.find((item) => "error" in item.result);
    if (invalidEvidence && "error" in invalidEvidence.result) return bad(res, invalidEvidence.result.error ?? "Invalid count evidence.");
    const result = await db.transaction(async (tx) => {
      const [product] = await tx.select({ id: products.id, name: products.name })
        .from(products).where(eq(products.id, parsed.data.productId)).for("update").limit(1);
      if (!product) return { error: "Product not found.", status: 404 };
      const locationId = parsed.data.locationId ?? await mainLocationId(tx);
      const [location] = await tx.select({ id: inventoryLocations.id }).from(inventoryLocations)
        .where(and(eq(inventoryLocations.id, locationId), eq(inventoryLocations.active, true))).limit(1);
      if (!location) return { error: "Choose an active stock location.", status: 400 };
      const [existing] = await tx.select({ id: inventoryMovements.id }).from(inventoryMovements)
        .where(and(eq(inventoryMovements.productId, product.id), eq(inventoryMovements.locationId, locationId), eq(inventoryMovements.kind, "opening_stock"))).limit(1);
      if (existing) return { error: "Opening stock was already recorded for this product at this location. Use a stock adjustment for later changes.", status: 409 };
      const totalValue = cents(parsed.data.unitCostZmw) * BigInt(parsed.data.quantity);
      const lines = buildOpeningStockLines(product.id, formatCents(totalValue));
      if (!journalLinesAreBalanced(lines)) throw new Error("Opening stock journal is not balanced.");
      const effectiveAt = parsed.data.effectiveAt || new Date().toISOString().slice(0, 10);
      const memo = parsed.data.memo || `Opening stock for ${product.name}`;
      const sourceKey = `opening-stock:${product.id}:location:${locationId}`;
      const movement = (await tx.insert(inventoryMovements).values({
        productId: product.id, locationId, kind: "opening_stock", quantityDelta: parsed.data.quantity,
        reason: memo, reference: parsed.data.reference, sourceKey,
      }).returning({ id: inventoryMovements.id }))[0]!;
      if (checkedEvidence.length) {
        await tx.insert(inventoryMovementEvidence).values(checkedEvidence.map(({ data, result: evidence }) => {
          if ("error" in evidence) throw new Error(evidence.error);
          return {
            movementId: movement.id,
            fileName: evidence.fileName,
            mimeType: evidence.mimeType,
            data,
          };
        }));
      }
      await recordBusinessAudit(tx, {
        entityType: "inventory_movement", entityId: movement.id, recordLabel: `Opening stock · ${product.name}`,
        actor: res.locals.actor, action: "created",
        changedFields: ["productId", "locationId", "kind", "quantityDelta", "reason", "reference", ...(checkedEvidence.length ? ["evidence"] : [])],
      });
      await postJournal(tx, {
        sourceKey, sourceType: "opening_stock", sourceId: movement.id,
        memo, entryDate: effectiveAt, lines,
      });
      return { movement };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    res.status(201).json({ movement: result.movement });
  });

  app.post("/api/inventory/opening-stock/:id/correct", owner, async (req, res) => {
    const id = getId(req.params.id);
    if (!id) return bad(res, "Invalid opening-stock entry.");
    const parsed = openingStockCorrectionInputSchema.safeParse(req.body);
    if (!parsed.success) return bad(res, parsed.error.issues[0]?.message ?? "Check the corrected count details.");

    const result = await db.transaction(async (tx) => {
      const [original] = await tx.select({
        id: inventoryMovements.id,
        productId: inventoryMovements.productId,
        locationId: inventoryMovements.locationId,
        quantityDelta: inventoryMovements.quantityDelta,
        reason: inventoryMovements.reason,
        reference: inventoryMovements.reference,
        sourceKey: inventoryMovements.sourceKey,
        kind: inventoryMovements.kind,
      }).from(inventoryMovements).where(eq(inventoryMovements.id, id)).for("update").limit(1);
      if (!original || original.kind !== "opening_stock" || original.quantityDelta <= 0 || !original.sourceKey) {
        return { error: "This is not a correctable opening-stock entry.", status: 404 };
      }
      const [existingCorrection] = await tx.select({ id: inventoryMovements.id })
        .from(inventoryMovements).where(eq(inventoryMovements.correctionOfMovementId, original.id)).limit(1);
      if (existingCorrection) {
        return { error: "This opening-stock entry has already been corrected. Correct its latest replacement instead.", status: 409 };
      }

      const [product] = await tx.select({ id: products.id, name: products.name })
        .from(products).where(eq(products.id, original.productId)).for("update").limit(1);
      if (!product) return { error: "Product not found.", status: 404 };
      const current = await balance(tx, original.productId, original.locationId ?? undefined);
      const correctedOnHand = current.onHand - original.quantityDelta + parsed.data.quantity;
      if (correctedOnHand < current.reserved) {
        return { error: "The corrected count would put stock below quantities already reserved.", status: 409 };
      }

      const effectiveAt = parsed.data.effectiveAt ?? new Date().toISOString().slice(0, 10);
      const memo = `Opening stock correction for movement #${original.id}: ${parsed.data.reason}`.slice(0, 500);
      const reversal = (await tx.insert(inventoryMovements).values({
        productId: original.productId,
        locationId: original.locationId,
        correctionOfMovementId: original.id,
        kind: "opening_stock_reversal",
        quantityDelta: -original.quantityDelta,
        reason: parsed.data.reason,
        reference: parsed.data.reference ?? original.reference,
        sourceKey: `opening-stock-reversal:${original.id}`,
      }).returning({ id: inventoryMovements.id }))[0]!;
      await recordBusinessAudit(tx, {
        entityType: "inventory_movement", entityId: reversal.id,
        recordLabel: `Opening stock reversal · ${product.name}`,
        actor: res.locals.actor, action: "created",
        changedFields: ["productId", "locationId", "kind", "quantityDelta", "reason", "reference", "correctionOfMovementId"],
      });
      await reverseJournalEntry(tx, {
        originalSourceKey: original.sourceKey,
        sourceKey: `inventory-movement-${reversal.id}`,
        sourceType: "opening_stock_reversal",
        sourceId: reversal.id,
        memo,
        entryDate: effectiveAt,
      });

      const replacement = (await tx.insert(inventoryMovements).values({
        productId: original.productId,
        locationId: original.locationId,
        correctionOfMovementId: reversal.id,
        kind: "opening_stock",
        quantityDelta: parsed.data.quantity,
        reason: `Corrected opening count: ${parsed.data.reason}`.slice(0, 500),
        reference: parsed.data.reference,
        sourceKey: `opening-stock-correction:${reversal.id}`,
      }).returning({ id: inventoryMovements.id }))[0]!;
      await recordBusinessAudit(tx, {
        entityType: "inventory_movement", entityId: replacement.id,
        recordLabel: `Corrected opening stock · ${product.name}`,
        actor: res.locals.actor, action: "created",
        changedFields: ["productId", "locationId", "kind", "quantityDelta", "reason", "reference", "correctionOfMovementId"],
      });
      const totalValue = cents(parsed.data.unitCostZmw) * BigInt(parsed.data.quantity);
      const lines = buildOpeningStockLines(original.productId, formatCents(totalValue));
      if (!journalLinesAreBalanced(lines)) throw new Error("Corrected opening stock journal is not balanced.");
      await postJournal(tx, {
        sourceKey: `opening-stock-correction:${reversal.id}`,
        sourceType: "opening_stock", sourceId: replacement.id, memo, entryDate: effectiveAt, lines,
      });
      return { movement: replacement, reversal };
    });
    if ("error" in result) return res.status(result.status ?? 400).json({ error: result.error });
    return res.status(201).json(result);
  });
}
