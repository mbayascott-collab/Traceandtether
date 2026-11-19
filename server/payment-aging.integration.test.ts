import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import {
  customers, products, purchaseOrders, salesDeliveries, salesDeliveryLines, salesOrderLines, salesOrders, suppliers,
} from "../shared/schema";

let closeIntegrationPool: (() => Promise<void>) | undefined;
after(async () => closeIntegrationPool?.());

test("payment overview derives term dates from deliveries and purchase orders and preserves saved dates", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerPaymentRoutes }, { postJournal }] = await Promise.all([
    import("./db"),
    import("./payment-routes"),
    import("./accounting-posting"),
  ]);
  closeIntegrationPool = () => pool.end();

  const requiredTables = await pool.query<{ name: string; exists: boolean }>(`
    SELECT name, to_regclass('public.' || name) IS NOT NULL AS exists
    FROM unnest(ARRAY['business_audit_logs', 'payment_reminders']) AS name
  `);
  if (requiredTables.rows.some((row) => !row.exists)) {
    t.skip("requires the business audit and payment reminder migrations");
    return;
  }

  const suffix = randomUUID();
  const actorEmail = `payment-aging-${suffix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerPaymentRoutes(app, owner);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Request failed." });
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let customerId: number | undefined;
  let supplierId: number | undefined;
  let productId: number | undefined;
  let salesOrderId: number | undefined;
  let purchaseOrderId: number | undefined;
  const payableSourceKey = `payment-aging-${suffix}`;

  const getOverview = async () => {
    const response = await fetch(`${baseUrl}/api/payments`);
    const payload = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload;
  };

  const saveDueDate = async (direction: "customer_receipt" | "supplier_payment", orderId: number, dueDate: string) => {
    const response = await fetch(`${baseUrl}/api/payments/due-date`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction, orderId, dueDate }),
    });
    const payload = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.dueDate, dueDate);
  };

  try {
    const [customer] = await db.insert(customers).values({
      name: `Payment aging customer ${suffix}`,
      paymentTermDays: 30,
    }).returning();
    customerId = customer.id;
    const [supplier] = await db.insert(suppliers).values({
      name: `Payment aging supplier ${suffix}`,
      paymentTermDays: 45,
    }).returning();
    supplierId = supplier.id;
    const [product] = await db.insert(products).values({
      sku: `AGE-${suffix}`,
      name: `Payment aging product ${suffix}`,
      status: "active",
    }).returning();
    productId = product.id;

    const [salesOrder] = await db.insert(salesOrders).values({
      orderNumber: `AGE-C-${suffix.slice(0, 12)}`,
      customerId,
      status: "fulfilled",
      orderDate: "2026-01-01",
    }).returning();
    salesOrderId = salesOrder.id;
    const [salesLine] = await db.insert(salesOrderLines).values({
      salesOrderId,
      productId,
      quantity: 2,
      unitPriceZmw: "100.00",
    }).returning();

    const [earlierDelivery] = await db.insert(salesDeliveries).values({
      deliveryNumber: `AGE-D1-${suffix.slice(0, 10)}`,
      idempotencyKey: `age-d1-${suffix}`,
      salesOrderId,
      deliveryDate: "2026-10-04",
    }).returning();
    const [latestDelivery] = await db.insert(salesDeliveries).values({
      deliveryNumber: `AGE-D2-${suffix.slice(0, 10)}`,
      idempotencyKey: `age-d2-${suffix}`,
      salesOrderId,
      deliveryDate: "2026-10-21",
    }).returning();
    await db.insert(salesDeliveryLines).values([
      { deliveryId: earlierDelivery.id, salesOrderLineId: salesLine.id, quantity: 1 },
      { deliveryId: latestDelivery.id, salesOrderLineId: salesLine.id, quantity: 1 },
    ]);

    const [purchaseOrder] = await db.insert(purchaseOrders).values({
      orderNumber: `AGE-S-${suffix.slice(0, 12)}`,
      supplierId,
      currency: "ZMW",
      exchangeRateToZmw: "1",
      orderedAt: "2026-10-01",
    }).returning();
    purchaseOrderId = purchaseOrder.id;
    await db.transaction((tx) => postJournal(tx, {
      sourceKey: payableSourceKey,
      sourceType: "stock_receipt",
      sourceId: purchaseOrder.id,
      memo: `Stock receipt for ${purchaseOrder.orderNumber}`,
      entryDate: "2026-10-01",
      lines: [
        { accountKey: "inventory", creditZmw: "0.00", debitZmw: "200.00" },
        { accountKey: "accounts_payable", creditZmw: "200.00" },
      ],
    }));

    let overview = await getOverview();
    const invoice = overview.invoices.find((item: any) => item.orderId === salesOrderId);
    const bill = overview.bills.find((item: any) => item.orderId === purchaseOrderId);
    assert.ok(invoice, "customer balance appears in the payment overview");
    assert.ok(bill, "supplier balance appears in the payment overview");
    assert.equal(invoice.dueDate, "2026-11-20", "customer terms start from the latest delivery date");
    assert.equal(bill.dueDate, "2026-11-15", "supplier terms start from the purchase-order date");

    await saveDueDate("customer_receipt", salesOrderId, "2027-01-15");
    await saveDueDate("supplier_payment", purchaseOrderId, "2027-02-20");
    await db.update(customers).set({ paymentTermDays: 90 }).where(eq(customers.id, customerId));
    await db.update(suppliers).set({ paymentTermDays: 120 }).where(eq(suppliers.id, supplierId));

    overview = await getOverview();
    assert.equal(
      overview.invoices.find((item: any) => item.orderId === salesOrderId)?.dueDate,
      "2027-01-15",
      "a manually saved customer due date takes precedence over changed terms",
    );
    assert.equal(
      overview.bills.find((item: any) => item.orderId === purchaseOrderId)?.dueDate,
      "2027-02-20",
      "a manually saved supplier due date takes precedence over changed terms",
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM journal_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE source_key = $1)",
        [payableSourceKey],
      );
      await client.query("DELETE FROM journal_entries WHERE source_key = $1", [payableSourceKey]);
      if (salesOrderId) {
        await client.query(
          "DELETE FROM sales_delivery_lines WHERE delivery_id IN (SELECT id FROM sales_deliveries WHERE sales_order_id = $1)",
          [salesOrderId],
        );
        await client.query("DELETE FROM sales_deliveries WHERE sales_order_id = $1", [salesOrderId]);
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = $1", [salesOrderId]);
        await client.query("DELETE FROM sales_orders WHERE id = $1", [salesOrderId]);
      }
      if (purchaseOrderId) await client.query("DELETE FROM purchase_orders WHERE id = $1", [purchaseOrderId]);
      if (customerId) await client.query("DELETE FROM customers WHERE id = $1", [customerId]);
      if (supplierId) await client.query("DELETE FROM suppliers WHERE id = $1", [supplierId]);
      if (productId) await client.query("DELETE FROM products WHERE id = $1", [productId]);
      await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});
