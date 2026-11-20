import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test, { after } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  accountingAccounts, inventoryLocations, inventoryMovements, journalEntries, journalLines,
  products, purchaseOrderLines, purchaseOrders, shipmentLines, shipments, suppliers,
} from "../shared/schema";
import { cents, journalLinesAreBalanced } from "./accounting-posting";

let closeIntegrationPool: (() => Promise<void>) | undefined;
after(async () => closeIntegrationPool?.());

test("partial multi-product receipt rounding preserves every cent in landed-cost adjustments", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerProcurementRoutes }, { registerInventoryRoutes }] = await Promise.all([
    import("./db"),
    import("./procurement-routes"),
    import("./inventory-routes"),
  ]);
  closeIntegrationPool = () => pool.end();
  const auditTable = await pool.query(
    "SELECT to_regclass('public.business_audit_logs') IS NOT NULL AS exists",
  );
  if (!auditTable.rows[0]?.exists) {
    t.skip("requires the business audit database migration");
    return;
  }

  const suffix = randomUUID();
  const actorEmail = `accounting-rounding-${suffix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerProcurementRoutes(app, owner);
  registerInventoryRoutes(app, owner);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let supplierId: number | undefined;
  let purchaseOrderId: number | undefined;
  let shipmentId: number | undefined;
  let locationId: number | undefined;
  const productIds: number[] = [];
  const request = async (path: string, body: unknown, expectedStatus: number) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json() as any;
    assert.equal(response.status, expectedStatus, JSON.stringify(payload));
    return payload;
  };
  const patch = async (path: string, body: unknown, expectedStatus: number) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as any;
    assert.equal(response.status, expectedStatus, JSON.stringify(payload));
    return payload;
  };

  try {
    const [supplier] = await db.insert(suppliers).values({
      name: `Rounding supplier ${suffix}`,
    }).returning();
    supplierId = supplier.id;
    const productsCreated = await db.insert(products).values([
      { sku: `ROUND-A-${suffix}`, name: `Rounding product A ${suffix}`, status: "active", purchaseCurrency: "ZMW" },
      { sku: `ROUND-B-${suffix}`, name: `Rounding product B ${suffix}`, status: "active", purchaseCurrency: "ZMW" },
    ]).returning();
    productIds.push(...productsCreated.map((product) => product.id));
    const [location] = await db.insert(inventoryLocations).values({
      name: `Rounding location ${suffix}`,
    }).returning();
    locationId = location.id;

    const { order } = await request("/api/purchase-orders", {
      supplierId,
      currency: "ZMW",
      exchangeRateToZmw: "1",
      expectedAt: null,
      notes: null,
      lines: [
        { productId: productIds[0], quantityOrdered: 3, unitPrice: "1.00" },
        { productId: productIds[1], quantityOrdered: 3, unitPrice: "2.00" },
      ],
    }, 201);
    purchaseOrderId = order.id;
    const orderLines = await db.select().from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId!))
      .orderBy(purchaseOrderLines.id);
    const { shipment } = await request("/api/shipments", {
      purchaseOrderIds: [purchaseOrderId],
      shipmentReference: `ROUND-SHIP-${suffix}`,
      carrier: null,
      trackingNumber: null,
      shippedAt: null,
      expectedAt: null,
      notes: null,
      lines: orderLines.map((line) => ({ purchaseOrderLineId: line.id, quantityShipped: 3 })),
    }, 201);
    shipmentId = shipment.id;
    const shipmentReceiptLines = await db.select().from(shipmentLines)
      .where(eq(shipmentLines.shipmentId, shipmentId!))
      .orderBy(shipmentLines.id);

    await request("/api/import-expenses", {
      purchaseOrderId,
      shipmentId: null,
      category: "Freight",
      description: `Initial rounding freight ${suffix}`,
      amount: "0.05",
      currency: "ZMW",
      exchangeRateToZmw: "1",
      basis: "value",
      incurredAt: "2026-11-18",
      reference: null,
      notes: null,
    }, 201);
    await patch(`/api/shipments/${shipmentId}/receive`, {
      lines: shipmentReceiptLines.map((line) => ({ shipmentLineId: line.id, quantityReceived: 1 })),
    }, 200);
    for (const line of shipmentReceiptLines) {
      await request(`/api/inventory/receipts/${line.id}/post`, { locationId }, 201);
    }

    const receiptPreview = await request(`/api/landed-costs?purchaseOrderId=${purchaseOrderId}`, undefined, 200);
    const initialPreview = receiptPreview.orders[0].adjustmentPreview;
    assert.equal(initialPreview.allocatedExpensesZmw, "0.05");
    assert.deepEqual(initialPreview.receipts.map((receipt: any) => receipt.clearedAmountZmw), ["0.01", "0.01"]);
    assert.equal(initialPreview.receiptClearedTotalZmw, "0.02");

    await request("/api/import-expenses", {
      purchaseOrderId,
      shipmentId: null,
      category: "Freight",
      description: `Late rounding freight ${suffix}`,
      amount: "0.05",
      currency: "ZMW",
      exchangeRateToZmw: "1",
      basis: "value",
      incurredAt: "2026-11-19",
      reference: null,
      notes: null,
    }, 201);
    const { orders: [readyOrder] } = await request(`/api/landed-costs?purchaseOrderId=${purchaseOrderId}`, undefined, 200);
    const preview = readyOrder.adjustmentPreview;
    assert.equal(preview.allocatedExpensesZmw, "0.10");
    assert.equal(preview.receiptClearedTotalZmw, "0.02");
    assert.equal(preview.clearingBalanceZmw, "0.08");
    assert.equal(preview.adjustmentAvailableZmw, "0.01");

    const { journalEntry } = await request(`/api/landed-costs/${purchaseOrderId}/adjust`, {
      reviewedAmountZmw: preview.adjustmentAvailableZmw,
      reviewedLines: preview.lines.map((line: any) => ({
        lineId: line.lineId,
        adjustmentZmw: line.adjustmentZmw,
        inventoryZmw: line.inventoryZmw,
        cogsZmw: line.cogsZmw,
      })),
      note: "Verify rounded partial-receipt adjustment",
    }, 201);
    const postedLines = await db.select({
      accountKey: accountingAccounts.systemKey,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalLines)
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(eq(journalLines.journalEntryId, journalEntry.id));
    assert.equal(postedLines.reduce((sum, line) => sum + cents(line.debitZmw), 0n), 1n);
    assert.equal(postedLines.reduce((sum, line) => sum + cents(line.creditZmw), 0n), 1n);
    assert.equal(journalLinesAreBalanced(postedLines.map((line) => ({
      accountKey: line.accountKey ?? "",
      debitZmw: line.debitZmw,
      creditZmw: line.creditZmw,
    }))), true);

    const afterAdjustment = await request(`/api/landed-costs?purchaseOrderId=${purchaseOrderId}`, undefined, 200);
    assert.equal(afterAdjustment.orders[0].adjustmentPreview.priorAdjustmentsClearedZmw, "0.01");
    assert.equal(afterAdjustment.orders[0].adjustmentPreview.receiptClearedTotalZmw, "0.02");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      if (purchaseOrderId) {
        await client.query(`
          DELETE FROM journal_lines WHERE journal_entry_id IN (
            SELECT id FROM journal_entries
            WHERE (source_type = 'import_expense' AND source_id IN (
              SELECT id FROM import_expenses WHERE purchase_order_id = $1
            ))
            OR (source_type = 'stock_receipt' AND source_id IN (
              SELECT id FROM inventory_movements WHERE product_id = ANY($2::int[])
            ))
            OR (source_type = 'landed_cost_adjustment' AND source_id = $1)
          )
        `, [purchaseOrderId, productIds]);
        await client.query(`
          DELETE FROM journal_entries
          WHERE (source_type = 'import_expense' AND source_id IN (
            SELECT id FROM import_expenses WHERE purchase_order_id = $1
          ))
          OR (source_type = 'stock_receipt' AND source_id IN (
            SELECT id FROM inventory_movements WHERE product_id = ANY($2::int[])
          ))
          OR (source_type = 'landed_cost_adjustment' AND source_id = $1)
        `, [purchaseOrderId, productIds]);
        await client.query("DELETE FROM inventory_movements WHERE product_id = ANY($1::int[])", [productIds]);
        await client.query("DELETE FROM import_expenses WHERE purchase_order_id = $1", [purchaseOrderId]);
      }
      if (shipmentId) {
        await client.query("DELETE FROM shipment_lines WHERE shipment_id = $1", [shipmentId]);
        await client.query("DELETE FROM shipment_purchase_orders WHERE shipment_id = $1", [shipmentId]);
        await client.query("DELETE FROM shipments WHERE id = $1", [shipmentId]);
      }
      if (purchaseOrderId) {
        await client.query("DELETE FROM purchase_order_lines WHERE purchase_order_id = $1", [purchaseOrderId]);
        await client.query("DELETE FROM purchase_orders WHERE id = $1", [purchaseOrderId]);
      }
      if (productIds.length) await client.query("DELETE FROM products WHERE id = ANY($1::int[])", [productIds]);
      if (supplierId) await client.query("DELETE FROM suppliers WHERE id = $1", [supplierId]);
      if (locationId) await client.query("DELETE FROM inventory_locations WHERE id = $1", [locationId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});
