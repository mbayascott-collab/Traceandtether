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
  let siblingSalesOrderId: number | undefined;
  let purchaseOrderId: number | undefined;
  let siblingPurchaseOrderId: number | undefined;
  let siblingDeliveryId: number | undefined;
  const payableSourceKey = `payment-aging-${suffix}`;
  const siblingPayableSourceKey = `payment-aging-sibling-${suffix}`;

  const getOverview = async () => {
    const response = await fetch(`${baseUrl}/api/payments`);
    const payload = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload;
  };

  const requestDueDate = async (direction: "customer_receipt" | "supplier_payment", orderId: number, dueDate: string) => {
    const response = await fetch(`${baseUrl}/api/payments/due-date`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction, orderId, dueDate }),
    });
    return { response, payload: await response.json() as any };
  };

  const saveDueDate = async (direction: "customer_receipt" | "supplier_payment", orderId: number, dueDate: string) => {
    const { response, payload } = await requestDueDate(direction, orderId, dueDate);
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
    assert.equal(invoice.dueDateSource, "calculated", "customer due date is identified as calculated");
    assert.equal(bill.dueDate, "2026-11-15", "supplier terms start from the purchase-order date");
    assert.equal(bill.dueDateSource, "calculated", "supplier due date is identified as calculated");

    await saveDueDate("customer_receipt", salesOrderId, "2027-01-15");
    await saveDueDate("supplier_payment", purchaseOrderId, "2027-02-20");
    await db.update(customers).set({ paymentTermDays: 90 }).where(eq(customers.id, customerId));
    await db.update(suppliers).set({ paymentTermDays: 120 }).where(eq(suppliers.id, supplierId));

    for (const [direction, orderId, savedDate] of [
      ["customer_receipt", salesOrderId, "2027-01-15"],
      ["supplier_payment", purchaseOrderId, "2027-02-20"],
    ] as const) {
      const rejected = await requestDueDate(direction, orderId, "2026-02-30");
      assert.equal(rejected.response.status, 400, JSON.stringify(rejected.payload));
      assert.match(rejected.payload.error, /date/i);
    }

    const [siblingSalesOrder] = await db.insert(salesOrders).values({
      orderNumber: `AGE-C-SIB-${suffix.slice(0, 10)}`,
      customerId,
      status: "partially_fulfilled",
      orderDate: "2026-10-01",
    }).returning();
    siblingSalesOrderId = siblingSalesOrder.id;
    const [siblingSalesLine] = await db.insert(salesOrderLines).values({
      salesOrderId: siblingSalesOrderId,
      productId,
      quantity: 2,
      unitPriceZmw: "100.00",
    }).returning();
    const [siblingDelivery] = await db.insert(salesDeliveries).values({
      deliveryNumber: `AGE-D-SIB-${suffix.slice(0, 10)}`,
      idempotencyKey: `age-d-sib-${suffix}`,
      salesOrderId: siblingSalesOrderId,
      deliveryDate: "2026-10-20",
    }).returning();
    siblingDeliveryId = siblingDelivery.id;
    await db.insert(salesDeliveryLines).values({
      deliveryId: siblingDeliveryId,
      salesOrderLineId: siblingSalesLine.id,
      quantity: 1,
    });

    const [siblingPurchaseOrder] = await db.insert(purchaseOrders).values({
      orderNumber: `AGE-S-SIB-${suffix.slice(0, 10)}`,
      supplierId,
      currency: "ZMW",
      exchangeRateToZmw: "1",
      orderedAt: "2026-10-15",
    }).returning();
    siblingPurchaseOrderId = siblingPurchaseOrder.id;
    await db.transaction((tx) => postJournal(tx, {
      sourceKey: siblingPayableSourceKey,
      sourceType: "stock_receipt",
      sourceId: siblingPurchaseOrder.id,
      memo: `Stock receipt for ${siblingPurchaseOrder.orderNumber}`,
      entryDate: "2026-10-15",
      lines: [
        { accountKey: "inventory", debitZmw: "100.00" },
        { accountKey: "accounts_payable", creditZmw: "100.00" },
      ],
    }));

    overview = await getOverview();
    assert.equal(
      overview.invoices.find((item: any) => item.orderId === salesOrderId)?.dueDate,
      "2027-01-15",
      "a manually saved customer due date takes precedence over changed terms",
    );
    assert.equal(
      overview.invoices.find((item: any) => item.orderId === salesOrderId)?.dueDateSource,
      "saved",
      "customer due date is identified as manually saved",
    );
    assert.equal(
      overview.bills.find((item: any) => item.orderId === purchaseOrderId)?.dueDate,
      "2027-02-20",
      "a manually saved supplier due date takes precedence over changed terms",
    );
    assert.equal(
      overview.bills.find((item: any) => item.orderId === purchaseOrderId)?.dueDateSource,
      "saved",
      "supplier due date is identified as manually saved",
    );
    assert.equal(
      overview.invoices.find((item: any) => item.orderId === salesOrderId)?.dueDate,
      "2027-01-15",
      "an invalid date must not replace the saved customer deadline",
    );
    assert.equal(
      overview.bills.find((item: any) => item.orderId === purchaseOrderId)?.dueDate,
      "2027-02-20",
      "an invalid date must not replace the saved supplier deadline",
    );
    assert.equal(
      overview.invoices.find((item: any) => item.orderId === siblingSalesOrderId)?.dueDate,
      "2027-01-18",
      "saving one customer deadline must leave its sibling based on customer terms",
    );
    assert.equal(
      overview.bills.find((item: any) => item.orderId === siblingPurchaseOrderId)?.dueDate,
      "2027-02-12",
      "saving one supplier deadline must leave its sibling based on supplier terms",
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM journal_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE source_key = $1)",
        [siblingPayableSourceKey],
      );
      await client.query("DELETE FROM journal_entries WHERE source_key = $1", [siblingPayableSourceKey]);
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
      if (siblingSalesOrderId) {
        await client.query("DELETE FROM sales_delivery_lines WHERE delivery_id = ANY($1::int[])", [[siblingDeliveryId]]);
        await client.query("DELETE FROM sales_deliveries WHERE sales_order_id = $1", [siblingSalesOrderId]);
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = $1", [siblingSalesOrderId]);
        await client.query("DELETE FROM sales_orders WHERE id = $1", [siblingSalesOrderId]);
      }
      if (purchaseOrderId) await client.query("DELETE FROM purchase_orders WHERE id = $1", [purchaseOrderId]);
      if (siblingPurchaseOrderId) await client.query("DELETE FROM purchase_orders WHERE id = $1", [siblingPurchaseOrderId]);
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
