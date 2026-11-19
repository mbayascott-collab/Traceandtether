import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test from "node:test";
import { eq } from "drizzle-orm";
import { customers, customerQuoteLines, customerQuotes, products, salesOrders } from "../shared/schema";

test("customer quote conversion requires explicit confirmation only after expiry", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerSalesRoutes }] = await Promise.all([
    import("./db"),
    import("./sales-routes"),
  ]);
  const auditTable = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.business_audit_logs') IS NOT NULL AS exists",
  );
  if (!auditTable.rows[0]?.exists) {
    await pool.end();
    t.skip("requires the business audit migration used by sales routes");
    return;
  }
  const suffix = randomUUID();
  const actorEmail = `customer-quote-expiry-${suffix}@example.test`;
  const app = express();
  app.use(express.json());
  const owner: RequestHandler = (_req, res, next) => {
    res.locals.actor = { clerkUserId: `test-${suffix}`, email: actorEmail, role: "owner" };
    next();
  };
  registerSalesRoutes(app, owner);
  app.use(((error: unknown, _req, res, _next) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Request failed." });
  }) as express.ErrorRequestHandler);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const quoteIds: number[] = [];
  const orderIds: number[] = [];
  let customerId: number | undefined;
  let productId: number | undefined;

  const convert = async (quoteId: number, body: Record<string, unknown>) => {
    const response = await fetch(`${baseUrl}/api/customer-quotes/${quoteId}/convert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() as Record<string, any> };
  };

  try {
    const [customer] = await db.insert(customers).values({
      name: `Quote expiry customer ${suffix}`,
      status: "active",
    }).returning();
    customerId = customer.id;
    const [product] = await db.insert(products).values({
      sku: `CQE-${suffix}`,
      name: `Quote expiry product ${suffix}`,
      status: "active",
    }).returning();
    productId = product.id;

    const [expiredQuote] = await db.insert(customerQuotes).values({
      quoteNumber: `CQ-${suffix.slice(0, 30)}-E`,
      customerId,
      status: "accepted",
      validUntil: "2000-01-01",
    }).returning();
    quoteIds.push(expiredQuote.id);
    await db.insert(customerQuoteLines).values({
      customerQuoteId: expiredQuote.id,
      productId,
      quantity: 2,
      unitPriceZmw: "25.00",
    });

    const [currentQuote] = await db.insert(customerQuotes).values({
      quoteNumber: `CQ-${suffix.slice(0, 30)}-C`,
      customerId,
      status: "accepted",
      validUntil: "2999-12-31",
    }).returning();
    quoteIds.push(currentQuote.id);
    await db.insert(customerQuoteLines).values({
      customerQuoteId: currentQuote.id,
      productId,
      quantity: 1,
      unitPriceZmw: "30.00",
    });

    for (const body of [{}, { confirmExpired: false }]) {
      const rejected = await convert(expiredQuote.id, body);
      assert.equal(rejected.status, 409, JSON.stringify(rejected.payload));
      assert.match(rejected.payload.error, /expired .*confirm before converting/i);

      const [savedQuote] = await db.select().from(customerQuotes)
        .where(eq(customerQuotes.id, expiredQuote.id));
      assert.equal(savedQuote?.status, "accepted");
      assert.equal(savedQuote?.salesOrderId, null);
      const draftOrders = await db.select().from(salesOrders)
        .where(eq(salesOrders.customerId, customerId));
      assert.equal(draftOrders.length, 0, "a rejected conversion must not create a draft order");
    }

    const confirmed = await convert(expiredQuote.id, { confirmExpired: true });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.payload));
    assert.equal(confirmed.payload.quote.status, "converted");
    assert.equal(confirmed.payload.order.status, "draft");
    orderIds.push(confirmed.payload.order.id);

    const current = await convert(currentQuote.id, {});
    assert.equal(current.status, 200, JSON.stringify(current.payload));
    assert.equal(current.payload.quote.status, "converted");
    assert.equal(current.payload.order.status, "draft");
    orderIds.push(current.payload.order.id);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      const linkedOrders = quoteIds.length
        ? await client.query<{ sales_order_id: number | null }>(
          "SELECT sales_order_id FROM customer_quotes WHERE id = ANY($1::int[])",
          [quoteIds],
        )
        : { rows: [] };
      const cleanupOrderIds = [...new Set([
        ...orderIds,
        ...linkedOrders.rows.flatMap(({ sales_order_id }) => sales_order_id === null ? [] : [sales_order_id]),
      ])];
      if (quoteIds.length) {
        await client.query(
          "UPDATE customer_quotes SET status = 'accepted', sales_order_id = NULL WHERE id = ANY($1::int[])",
          [quoteIds],
        );
        await client.query("DELETE FROM customer_quote_lines WHERE customer_quote_id = ANY($1::int[])", [quoteIds]);
      }
      if (cleanupOrderIds.length) {
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = ANY($1::int[])", [cleanupOrderIds]);
      }
      if (quoteIds.length) {
        await client.query("DELETE FROM customer_quotes WHERE id = ANY($1::int[])", [quoteIds]);
      }
      if (cleanupOrderIds.length) {
        await client.query("DELETE FROM sales_orders WHERE id = ANY($1::int[])", [cleanupOrderIds]);
      }
      if (productId) await client.query("DELETE FROM products WHERE id = $1", [productId]);
      if (customerId) await client.query("DELETE FROM customers WHERE id = $1", [customerId]);
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
