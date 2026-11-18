import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  accountingAccounts, customers, importExpenses, inventoryLocations, inventoryMovements,
  journalEntries, journalLines, products, purchaseOrderLines, shipmentLines,
  salesDeliveryLines, salesOrderLines, suppliers,
} from "../shared/schema";
import { journalLinesAreBalanced } from "./accounting-posting";

test("database flow adjusts late import costs across partial receipts and sales", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const [
    { db, pool },
    { registerProcurementRoutes },
    { registerInventoryRoutes },
    { registerSalesRoutes },
  ] = await Promise.all([
    import("./db"),
    import("./procurement-routes"),
    import("./inventory-routes"),
    import("./sales-routes"),
  ]);

  const suffix = randomUUID();
  const testEmail = `accounting-posting-${suffix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: testEmail, role: "owner" };
    next();
  };
  registerProcurementRoutes(app, owner);
  registerInventoryRoutes(app, owner);
  registerSalesRoutes(app, owner);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let productId: number | undefined;
  let supplierId: number | undefined;
  let customerId: number | undefined;
  let locationId: number | undefined;
  let purchaseOrderId: number | undefined;
  let shipmentId: number | undefined;
  let shipmentLineId: number | undefined;
  let salesOrderId: number | undefined;
  let deliveryId: number | undefined;
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
      name: `Accounting flow supplier ${suffix}`,
    }).returning();
    supplierId = supplier.id;
    const [product] = await db.insert(products).values({
      sku: `ACC-${suffix}`,
      name: `Accounting flow product ${suffix}`,
      status: "active",
      purchaseCurrency: "CNY",
    }).returning();
    productId = product.id;
    const [customer] = await db.insert(customers).values({
      name: `Accounting flow customer ${suffix}`,
    }).returning();
    customerId = customer.id;
    const [location] = await db.insert(inventoryLocations).values({
      name: `Accounting flow location ${suffix}`,
    }).returning();
    locationId = location.id;

    const { order } = await request("/api/purchase-orders", {
      supplierId,
      currency: "CNY",
      exchangeRateToZmw: "2",
      expectedAt: null,
      notes: null,
      lines: [{ productId, quantityOrdered: 10, unitPrice: "100.00" }],
    }, 201);
    purchaseOrderId = order.id;
    const [orderLine] = await db.select().from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId!));
    const { shipment } = await request("/api/shipments", {
      purchaseOrderIds: [purchaseOrderId],
      shipmentReference: `ACC-SHIP-${suffix}`,
      carrier: null,
      trackingNumber: null,
      shippedAt: null,
      expectedAt: null,
      notes: null,
      lines: [{ purchaseOrderLineId: orderLine.id, quantityShipped: 10 }],
    }, 201);
    shipmentId = shipment.id;
    const [shipmentLine] = await db.select().from(shipmentLines)
      .where(eq(shipmentLines.shipmentId, shipmentId!));
    shipmentLineId = shipmentLine.id;

    const { expense: earlyExpense } = await request("/api/import-expenses", {
      purchaseOrderId,
      shipmentId: null,
      category: "Freight",
      description: `Pre-receipt freight ${suffix}`,
      amount: "100.00",
      currency: "USD",
      exchangeRateToZmw: "10",
      basis: "value",
      incurredAt: "2026-10-01",
      reference: null,
      notes: null,
    }, 201);

    await patch(`/api/shipments/${shipmentId}/receive`, {
      lines: [{ shipmentLineId, quantityReceived: 4 }],
    }, 200);
    await request(`/api/inventory/receipts/${shipmentLineId}/post`, { locationId }, 201);
    const [earlyReceiptMovement] = await db.select().from(inventoryMovements)
      .where(eq(inventoryMovements.sourceKey, `shipment-line-${shipmentLineId}-to-4`));
    const [earlyReceiptEntry] = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "stock_receipt"),
      eq(journalEntries.sourceId, earlyReceiptMovement.id),
    ));
    assert.equal(earlyReceiptEntry.shipmentLineId, shipmentLineId);
    // Simulate a pre-migration journal that relies on its old movement key.
    await db.update(journalEntries).set({ shipmentLineId: null })
      .where(eq(journalEntries.id, earlyReceiptEntry.id));
    const { orders: [afterEarlyExpense] } = await request(
      `/api/landed-costs?purchaseOrderId=${purchaseOrderId}`, undefined, 200,
    );
    assert.equal(afterEarlyExpense.adjustmentPreview.adjustmentAvailableZmw, "0.00");
    assert.equal(afterEarlyExpense.adjustmentPreview.canPost, false);
    assert.equal(afterEarlyExpense.adjustmentPreview.unpostedClearingZmw, "600.00");

    const { order: salesOrder } = await request("/api/sales-orders", {
      customerId,
      deliveryAddress: null,
      notes: null,
      lines: [{ productId, quantity: 2, unitPriceZmw: "500.00" }],
    }, 201);
    salesOrderId = salesOrder.id;
    await request(`/api/sales-orders/${salesOrderId}/confirm`, {}, 200);
    const [salesLine] = await db.select().from(salesOrderLines)
      .where(eq(salesOrderLines.salesOrderId, salesOrderId!));
    const { delivery } = await request(`/api/sales-orders/${salesOrderId}/deliveries`, {
      idempotencyKey: randomUUID(),
      deliveryDate: "2026-11-18",
      lines: [{ salesOrderLineId: salesLine.id, quantity: 2 }],
    }, 201);
    deliveryId = delivery.id;

    const { expense: lateExpense } = await request("/api/import-expenses", {
      purchaseOrderId,
      shipmentId: null,
      category: "Freight",
      description: `Late freight ${suffix}`,
      amount: "50.00",
      currency: "USD",
      exchangeRateToZmw: "10",
      basis: "value",
      incurredAt: "2026-11-18",
      reference: null,
      notes: null,
    }, 201);

    const { orders: [beforeAdjustment] } = await request(
      `/api/landed-costs?purchaseOrderId=${purchaseOrderId}`, undefined, 200,
    );
    const preview = beforeAdjustment.adjustmentPreview;
    assert.equal(preview.clearingBalanceZmw, "1100.00");
    assert.equal(preview.adjustmentAvailableZmw, "200.00");
    assert.equal(preview.unpostedClearingZmw, "900.00");
    assert.equal(preview.canPost, true);
    assert.deepEqual(preview.lines.map((line: any) => [
      line.stockedQuantity, line.onHand, line.adjustmentZmw, line.inventoryZmw, line.cogsZmw,
    ]), [[4, 2, "200.00", "100.00", "100.00"]]);

    const adjustmentRequest = {
      reviewedAmountZmw: preview.adjustmentAvailableZmw,
      reviewedLines: preview.lines.map((line: any) => ({
        lineId: line.lineId,
        adjustmentZmw: line.adjustmentZmw,
        inventoryZmw: line.inventoryZmw,
        cogsZmw: line.cogsZmw,
      })),
      note: "Reviewed after partial receipts and sale",
    };
    const concurrentAdjustments = await Promise.all([
      fetch(`${baseUrl}/api/landed-costs/${purchaseOrderId}/adjust`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(adjustmentRequest),
      }),
      fetch(`${baseUrl}/api/landed-costs/${purchaseOrderId}/adjust`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(adjustmentRequest),
      }),
    ]);
    const concurrentPayloads = await Promise.all(concurrentAdjustments.map((response) => response.json() as Promise<any>));
    assert.deepEqual(concurrentAdjustments.map((response) => response.status).sort(), [201, 409]);
    const postedAdjustment = concurrentPayloads.find((payload) => payload.journalEntry)?.journalEntry;
    assert.ok(postedAdjustment, JSON.stringify(concurrentPayloads));

    await request(`/api/landed-costs/${purchaseOrderId}/adjust`, adjustmentRequest, 409);
    const [adjustmentEntry] = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "landed_cost_adjustment"),
      eq(journalEntries.sourceId, purchaseOrderId!),
    ));
    assert.ok(adjustmentEntry);
    assert.equal(adjustmentEntry.id, postedAdjustment.id);

    const adjustmentLines = await db.select({
      systemKey: accountingAccounts.systemKey,
      productId: journalLines.productId,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalLines)
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(eq(journalLines.journalEntryId, adjustmentEntry.id));
    assert.deepEqual(adjustmentLines.map((line) => [
      line.systemKey, line.debitZmw, line.creditZmw,
    ]), [
      ["inventory", "100.00", "0.00"],
      ["cost_of_goods_sold", "100.00", "0.00"],
      ["landed_cost_clearing", "0.00", "200.00"],
    ]);
    assert.equal(adjustmentEntry.sourceId, purchaseOrderId);

    await patch(`/api/shipments/${shipmentId}/receive`, {
      lines: [{ shipmentLineId, quantityReceived: 10 }],
    }, 200);
    await request(`/api/inventory/receipts/${shipmentLineId}/post`, { locationId }, 201);
    const [secondReceiptMovement] = await db.select().from(inventoryMovements)
      .where(eq(inventoryMovements.sourceKey, `shipment-line-${shipmentLineId}-to-10`));
    await db.update(inventoryMovements).set({ sourceKey: `receipt-key-reformatted-${suffix}` })
      .where(eq(inventoryMovements.id, secondReceiptMovement.id));
    const { orders: [afterSecondReceipt] } = await request(
      `/api/landed-costs?purchaseOrderId=${purchaseOrderId}`, undefined, 200,
    );
    assert.equal(afterSecondReceipt.adjustmentPreview.clearingBalanceZmw, "0.00");
    assert.equal(afterSecondReceipt.adjustmentPreview.adjustmentAvailableZmw, "0.00");
    assert.equal(afterSecondReceipt.adjustmentPreview.unpostedClearingZmw, "0.00");

    const [expenseEntries, receiptMovements, adjustmentEntries, deliveryEntries] = await Promise.all([
      db.select().from(journalEntries).where(and(
        eq(journalEntries.sourceType, "import_expense"),
        inArray(journalEntries.sourceId, [earlyExpense.id, lateExpense.id]),
      )),
      db.select().from(inventoryMovements).where(and(
        eq(inventoryMovements.productId, productId!),
        eq(inventoryMovements.kind, "stock_receipt"),
      )),
      db.select().from(journalEntries).where(and(
        eq(journalEntries.sourceType, "landed_cost_adjustment"),
        eq(journalEntries.sourceId, purchaseOrderId!),
      )),
      db.select().from(journalEntries).where(and(
        inArray(journalEntries.sourceType, ["sales_delivery", "sales_delivery_cogs"]),
        eq(journalEntries.sourceId, deliveryId!),
      )),
    ]);
    assert.equal(expenseEntries.length, 2);
    assert.equal(receiptMovements.length, 2);
    assert.equal(adjustmentEntries.length, 1);
    assert.equal(deliveryEntries.length, 2);

    const [salesCogsEntry] = deliveryEntries.filter((entry) => entry.sourceType === "sales_delivery_cogs");
    assert.ok(salesCogsEntry);
    const salesCogsLines = await db.select({
      systemKey: accountingAccounts.systemKey,
      debitZmw: journalLines.debitZmw,
      creditZmw: journalLines.creditZmw,
    }).from(journalLines)
      .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
      .where(eq(journalLines.journalEntryId, salesCogsEntry.id));
    assert.deepEqual(salesCogsLines.map((line) => [
      line.systemKey, line.debitZmw, line.creditZmw,
    ]), [
      ["cost_of_goods_sold", "600.00", "0.00"],
      ["inventory", "0.00", "600.00"],
    ]);

    const receiptEntries = await db.select().from(journalEntries).where(and(
      eq(journalEntries.sourceType, "stock_receipt"),
      inArray(journalEntries.sourceId, receiptMovements.map((movement) => movement.id)),
    ));
    const allTestEntries = [...expenseEntries, ...receiptEntries, ...adjustmentEntries, ...deliveryEntries];
    assert.equal(receiptEntries.length, 2);
    for (const entry of allTestEntries) {
      const lines = await db.select({
        accountKey: accountingAccounts.systemKey,
        debitZmw: journalLines.debitZmw,
        creditZmw: journalLines.creditZmw,
      }).from(journalLines)
        .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
        .where(eq(journalLines.journalEntryId, entry.id));
      assert.equal(journalLinesAreBalanced(lines.map((line) => ({
        accountKey: line.accountKey ?? "",
        debitZmw: line.debitZmw,
        creditZmw: line.creditZmw,
      }))), true, `Journal ${entry.id} is unbalanced`);
    }

    const [linkedExpenses, linkedReceiptLines] = await Promise.all([
      db.select().from(importExpenses).where(eq(importExpenses.purchaseOrderId, purchaseOrderId!)),
      db.select({ id: shipmentLines.id, orderId: purchaseOrderLines.purchaseOrderId })
        .from(shipmentLines)
        .innerJoin(purchaseOrderLines, eq(shipmentLines.purchaseOrderLineId, purchaseOrderLines.id))
        .where(eq(shipmentLines.shipmentId, shipmentId!)),
    ]);
    assert.equal(linkedExpenses.length, 2);
    assert.deepEqual(linkedExpenses.map((expense) => expense.id).sort(), [earlyExpense.id, lateExpense.id].sort());
    assert.equal(linkedReceiptLines.length, 1);
    assert.deepEqual(receiptMovements.map((movement) => movement.quantityDelta).sort(), [4, 6]);
    assert.ok(linkedReceiptLines.every((line) => line.orderId === purchaseOrderId));
    assert.ok(receiptEntries.every((entry) => receiptMovements.some((movement) => movement.id === entry.sourceId)));
    assert.deepEqual(receiptEntries.map((entry) => entry.shipmentLineId).sort(), [null, shipmentLineId].sort());
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const auditTable = await client.query(
        "SELECT to_regclass('public.business_audit_logs') IS NOT NULL AS exists",
      );
      if (auditTable.rows[0]?.exists) {
        await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [testEmail]);
      }
      if (productId) {
        await client.query(`
          DELETE FROM journal_lines
          WHERE journal_entry_id IN (
            SELECT id FROM journal_entries
            WHERE (source_type = 'import_expense' AND source_id IN (
              SELECT id FROM import_expenses WHERE purchase_order_id = $1
            ))
            OR (source_type = 'stock_receipt' AND source_id IN (
              SELECT id FROM inventory_movements WHERE product_id = $2
            ))
            OR (source_type = 'landed_cost_adjustment' AND source_id = $1)
            OR (source_type IN ('sales_delivery', 'sales_delivery_cogs') AND source_id IN (
              SELECT id FROM sales_deliveries WHERE sales_order_id = $3
            ))
          )
        `, [purchaseOrderId ?? 0, productId, salesOrderId ?? 0]);
        await client.query(`
          DELETE FROM journal_entries
          WHERE (source_type = 'import_expense' AND source_id IN (
            SELECT id FROM import_expenses WHERE purchase_order_id = $1
          ))
          OR (source_type = 'stock_receipt' AND source_id IN (
            SELECT id FROM inventory_movements WHERE product_id = $2
          ))
          OR (source_type = 'landed_cost_adjustment' AND source_id = $1)
          OR (source_type IN ('sales_delivery', 'sales_delivery_cogs') AND source_id IN (
            SELECT id FROM sales_deliveries WHERE sales_order_id = $3
          ))
        `, [purchaseOrderId ?? 0, productId, salesOrderId ?? 0]);
        await client.query("DELETE FROM inventory_movements WHERE product_id = $1", [productId]);
      }
      if (deliveryId) await client.query(
        "DELETE FROM sales_delivery_lines WHERE delivery_id = $1", [deliveryId],
      );
      if (deliveryId) await client.query("DELETE FROM sales_deliveries WHERE id = $1", [deliveryId]);
      if (salesOrderId) {
        await client.query("DELETE FROM inventory_reservations WHERE sales_order_id = $1", [salesOrderId]);
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = $1", [salesOrderId]);
        await client.query("DELETE FROM sales_orders WHERE id = $1", [salesOrderId]);
      }
      if (customerId) await client.query("DELETE FROM customers WHERE id = $1", [customerId]);
      if (purchaseOrderId) {
        await client.query("DELETE FROM import_expenses WHERE purchase_order_id = $1", [purchaseOrderId]);
        if (shipmentId) {
          await client.query("DELETE FROM shipment_lines WHERE shipment_id = $1", [shipmentId]);
          await client.query("DELETE FROM shipment_purchase_orders WHERE shipment_id = $1", [shipmentId]);
          await client.query("DELETE FROM shipments WHERE id = $1", [shipmentId]);
        }
        await client.query("DELETE FROM purchase_order_lines WHERE purchase_order_id = $1", [purchaseOrderId]);
        await client.query("DELETE FROM purchase_orders WHERE id = $1", [purchaseOrderId]);
      }
      if (productId) await client.query("DELETE FROM products WHERE id = $1", [productId]);
      if (supplierId) await client.query("DELETE FROM suppliers WHERE id = $1", [supplierId]);
      if (locationId) await client.query("DELETE FROM inventory_locations WHERE id = $1", [locationId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  }
});
