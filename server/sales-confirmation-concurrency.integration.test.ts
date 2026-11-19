import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test from "node:test";
import { and, eq, inArray, sum } from "drizzle-orm";
import {
  businessAuditLogs, customers, inventoryLocations, inventoryMovements, inventoryReservations,
  products, salesOrderLines, salesOrders,
} from "../shared/schema";

test("concurrent sales confirmations cannot reserve the same location stock twice", {
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
  const actorEmail = `sales-confirmation-concurrency-${suffix}@example.test`;
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

  let customerId: number | undefined;
  let productId: number | undefined;
  let locationId: number | undefined;
  const orderIds: number[] = [];
  const request = async (path: string, body: unknown, expectedStatus: number) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as any;
    assert.equal(response.status, expectedStatus, JSON.stringify(payload));
    return payload;
  };

  try {
    const [customer] = await db.insert(customers).values({
      name: `Concurrent confirmation customer ${suffix}`,
      status: "active",
    }).returning();
    customerId = customer.id;
    const [product] = await db.insert(products).values({
      sku: `SCON-${suffix}`,
      name: `Concurrent confirmation product ${suffix}`,
      status: "active",
    }).returning();
    productId = product.id;
    const [location] = await db.insert(inventoryLocations).values({
      name: `Concurrent confirmation location ${suffix}`,
    }).returning();
    locationId = location.id;
    await db.insert(inventoryMovements).values({
      productId,
      locationId,
      kind: "opening_stock",
      quantityDelta: 5,
      reason: `Concurrent sales confirmation test ${suffix}`,
      sourceKey: `sales-confirmation-concurrency-${suffix}`,
    });

    for (let index = 0; index < 2; index += 1) {
      const { order } = await request("/api/sales-orders", {
        customerId,
        deliveryAddress: null,
        notes: null,
        lines: [{ productId, quantity: 4, unitPriceZmw: "10.00" }],
      }, 201);
      orderIds.push(order.id);
    }

    const confirmations = await Promise.all(orderIds.map(async (orderId) => {
      const response = await fetch(`${baseUrl}/api/sales-orders/${orderId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locations: [{ productId, locationId }] }),
      });
      return { status: response.status, payload: await response.json() as any };
    }));
    assert.deepEqual(confirmations.map(({ status }) => status).sort(), [200, 409]);
    const losingConfirmation = confirmations.find(({ status }) => status === 409);
    assert.ok(losingConfirmation);
    assert.match(losingConfirmation.payload.error, /1 units available .*; 4 requested/i);

    const reservations = await db.select().from(inventoryReservations)
      .where(and(
        inArray(inventoryReservations.salesOrderId, orderIds),
        eq(inventoryReservations.status, "active"),
      ));
    assert.equal(reservations.length, 1, "only the winning order should have an active reservation");
    assert.equal(reservations[0]!.productId, productId);
    assert.equal(reservations[0]!.locationId, locationId);
    assert.equal(reservations[0]!.quantity, 4);

    const orderRows = await db.select({
      id: salesOrders.id,
      status: salesOrders.status,
    }).from(salesOrders).where(inArray(salesOrders.id, orderIds));
    assert.equal(orderRows.filter((order) => order.status === "confirmed").length, 1);
    assert.equal(orderRows.filter((order) => order.status === "draft").length, 1);

    const [onHand] = await db.select({
      quantity: sum(inventoryMovements.quantityDelta),
    }).from(inventoryMovements).where(and(
      eq(inventoryMovements.productId, productId),
      eq(inventoryMovements.locationId, locationId),
    ));
    const [reserved] = await db.select({
      quantity: sum(inventoryReservations.quantity),
    }).from(inventoryReservations).where(and(
      eq(inventoryReservations.productId, productId),
      eq(inventoryReservations.locationId, locationId),
      eq(inventoryReservations.status, "active"),
    ));
    assert.equal(Number(onHand.quantity), 5, "confirming an order must not change on-hand stock");
    assert.equal(Number(reserved.quantity), 4, "the location balance must reflect only the successful reservation");
    assert.equal(Number(onHand.quantity) - Number(reserved.quantity), 1, "one unit should remain available");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      if (orderIds.length) {
        await client.query("DELETE FROM inventory_reservations WHERE sales_order_id = ANY($1::int[])", [orderIds]);
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = ANY($1::int[])", [orderIds]);
        await client.query("DELETE FROM sales_orders WHERE id = ANY($1::int[])", [orderIds]);
      }
      if (productId) {
        await client.query("DELETE FROM inventory_movements WHERE product_id = $1", [productId]);
        await client.query("DELETE FROM products WHERE id = $1", [productId]);
      }
      if (customerId) await client.query("DELETE FROM customers WHERE id = $1", [customerId]);
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
