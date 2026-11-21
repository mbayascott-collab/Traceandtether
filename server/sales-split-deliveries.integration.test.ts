import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import test from "node:test";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  businessAuditLogs, customers, inventoryLocations, inventoryMovements, inventoryReservations,
  products, salesDeliveryLines, salesOrderLines,
} from "../shared/schema";

test("split sales deliveries keep each location linked and release undelivered reservations", {
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
  const actorEmail = `sales-split-delivery-${suffix}@example.test`;
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
  let orderId: number | undefined;
  const locationIds: number[] = [];
  const request = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() as any };
  };
  const post = async (path: string, body: unknown, status: number) => {
    const result = await request("POST", path, body);
    assert.equal(result.status, status, JSON.stringify(result.payload));
    return result.payload;
  };

  try {
    const [customer] = await db.insert(customers).values({
      name: `Split delivery customer ${suffix}`,
      status: "active",
    }).returning();
    customerId = customer.id;
    const [product] = await db.insert(products).values({
      sku: `SPLIT-${suffix}`,
      name: `Split delivery product ${suffix}`,
      status: "active",
    }).returning();
    productId = product.id;
    const locations = await db.insert(inventoryLocations).values([
      { name: `A split delivery ${suffix}` },
      { name: `B split delivery ${suffix}` },
      { name: `C split delivery ${suffix}` },
    ]).returning();
    locationIds.push(...locations.map((location) => location.id));

    await db.insert(inventoryMovements).values(locations.map((location, index) => ({
      productId: product.id,
      locationId: location.id,
      kind: "opening_stock" as const,
      quantityDelta: [2, 4, 4][index]!,
      reason: `Split sales delivery integration test ${suffix}`,
      sourceKey: `sales-split-delivery-${suffix}-${index}`,
    })));

    const { payload: created, status: createStatus } = await request("POST", "/api/sales-orders", {
      customerId: customer.id,
      deliveryAddress: null,
      notes: null,
      lines: [{ productId: product.id, quantity: 10, unitPriceZmw: "10.00" }],
    });
    assert.equal(createStatus, 201, JSON.stringify(created));
    const salesOrderId = created.order.id as number;
    orderId = salesOrderId;

    await post(`/api/sales-orders/${salesOrderId}/confirm`, {}, 200);
    const [line] = await db.select().from(salesOrderLines)
      .where(eq(salesOrderLines.salesOrderId, salesOrderId));
    assert.ok(line);

    const reservationsAfterConfirmation = await db.select().from(inventoryReservations)
      .where(and(
        eq(inventoryReservations.salesOrderId, salesOrderId),
        eq(inventoryReservations.productId, product.id),
        eq(inventoryReservations.status, "active"),
      ));
    assert.deepEqual(
      reservationsAfterConfirmation
        .sort((left, right) => left.locationId! - right.locationId!)
        .map((reservation) => [reservation.locationId, reservation.quantity]),
      locations
        .map((location, index) => [location.id, [2, 4, 4][index]])
        .sort((left, right) => Number(left[0]) - Number(right[0])),
      "confirmation must save a distinct active reservation for each supplying location",
    );

    const reservationsBeforeRejectedDelivery = await db.select().from(inventoryReservations)
      .where(eq(inventoryReservations.salesOrderId, salesOrderId))
      .orderBy(asc(inventoryReservations.id));
    const rejectedDelivery = await request("POST", `/api/sales-orders/${salesOrderId}/deliveries`, {
      idempotencyKey: randomUUID(),
      deliveryDate: "2026-11-16",
      lines: [{
        salesOrderLineId: line.id,
        quantity: 3,
        locationAllocations: [{ locationId: locations[0]!.id, quantity: 3 }],
      }],
    });
    assert.equal(rejectedDelivery.status, 409, JSON.stringify(rejectedDelivery.payload));
    const reservationsAfterRejectedDelivery = await db.select().from(inventoryReservations)
      .where(eq(inventoryReservations.salesOrderId, salesOrderId))
      .orderBy(asc(inventoryReservations.id));
    assert.deepEqual(reservationsAfterRejectedDelivery, reservationsBeforeRejectedDelivery,
      "a rejected split delivery must leave all location reservations unchanged");
    assert.equal((await db.select().from(salesDeliveryLines).where(eq(salesDeliveryLines.salesOrderLineId, line.id))).length, 0,
      "a rejected split delivery must not create delivery lines");
    assert.equal((await db.select().from(inventoryMovements).where(and(
      eq(inventoryMovements.productId, product.id),
      eq(inventoryMovements.kind, "reservation_fulfillment"),
    ))).length, 0, "a rejected split delivery must not consume stock");

    const firstDelivery = await post(`/api/sales-orders/${salesOrderId}/deliveries`, {
      idempotencyKey: randomUUID(),
      deliveryDate: "2026-11-17",
      lines: [{
        salesOrderLineId: line.id, quantity: 1,
        locationAllocations: [{ locationId: locations[2]!.id, quantity: 1 }],
      }],
    }, 201);
    await post(`/api/sales-orders/${salesOrderId}/deliveries`, {
      idempotencyKey: randomUUID(),
      deliveryDate: "2026-11-18",
      lines: [{
        salesOrderLineId: line.id, quantity: 4,
        locationAllocations: [{ locationId: locations[2]!.id, quantity: 4 }],
      }],
    }, 409);
    const secondDeliveryRequest = {
      idempotencyKey: randomUUID(),
      deliveryDate: "2026-11-19",
      lines: [{ salesOrderLineId: line.id, quantity: 3 }],
    };
    const secondDelivery = await post(`/api/sales-orders/${salesOrderId}/deliveries`, secondDeliveryRequest, 201);
    const reservationSnapshot = async () => (await db.select().from(inventoryReservations)
      .where(eq(inventoryReservations.salesOrderId, salesOrderId))
      .orderBy(asc(inventoryReservations.id)))
      .map(({ id, locationId, quantity, status }) => ({ id, locationId, quantity, status }));
    const fulfillmentSnapshot = async () => (await db.select({
      id: inventoryMovements.id,
      locationId: inventoryMovements.locationId,
      quantityDelta: inventoryMovements.quantityDelta,
      reservationId: inventoryMovements.reservationId,
      salesDeliveryLineId: inventoryMovements.salesDeliveryLineId,
    }).from(inventoryMovements).where(and(
      eq(inventoryMovements.productId, product.id),
      eq(inventoryMovements.kind, "reservation_fulfillment"),
    )).orderBy(asc(inventoryMovements.id)));
    const beforeRetryReservations = await reservationSnapshot();
    const beforeRetryFulfillments = await fulfillmentSnapshot();
    const retry = await post(`/api/sales-orders/${salesOrderId}/deliveries`, secondDeliveryRequest, 201);
    assert.equal(retry.delivery.id, secondDelivery.delivery.id, "a retry must return the saved split delivery");
    assert.deepEqual(await reservationSnapshot(), beforeRetryReservations, "a retry must not consume reservations again");
    assert.deepEqual(await fulfillmentSnapshot(), beforeRetryFulfillments, "a retry must not create additional fulfillment movements");
    const mismatchedRetry = await post(`/api/sales-orders/${salesOrderId}/deliveries`, {
      ...secondDeliveryRequest,
      lines: [{ salesOrderLineId: line.id, quantity: 2 }],
    }, 409);
    assert.match(mismatchedRetry.error, /already used for different details/i);
    assert.deepEqual(await reservationSnapshot(), beforeRetryReservations, "a rejected key reuse must leave reservations unchanged");
    assert.deepEqual(await fulfillmentSnapshot(), beforeRetryFulfillments, "a rejected key reuse must leave fulfillment movements unchanged");

    const deliveryLines = await db.select().from(salesDeliveryLines)
      .where(inArray(salesDeliveryLines.deliveryId, [firstDelivery.delivery.id, secondDelivery.delivery.id]))
      .orderBy(asc(salesDeliveryLines.id));
    assert.equal(deliveryLines.length, 2);
    const deliveryLineIds = deliveryLines.map((deliveryLine) => deliveryLine.id);
    const linkedMovements = await db.select({
      movement: inventoryMovements,
      reservation: inventoryReservations,
    }).from(inventoryMovements)
      .innerJoin(inventoryReservations, eq(inventoryReservations.id, inventoryMovements.reservationId))
      .where(inArray(inventoryMovements.salesDeliveryLineId, deliveryLineIds));
    assert.deepEqual(
      linkedMovements.map(({ movement, reservation }) => [
        movement.salesDeliveryLineId,
        movement.locationId,
        -movement.quantityDelta,
        movement.reservationId,
        reservation.locationId,
      ]).sort((left, right) => Number(left[0]) - Number(right[0]) || Number(left[1]) - Number(right[1])),
      [
        [deliveryLineIds[0], locations[2]!.id, 1, reservationsAfterConfirmation.find((item) => item.locationId === locations[2]!.id)!.id, locations[2]!.id],
        [deliveryLineIds[1], locations[0]!.id, 2, reservationsAfterConfirmation.find((item) => item.locationId === locations[0]!.id)!.id, locations[0]!.id],
        [deliveryLineIds[1], locations[1]!.id, 1, reservationsAfterConfirmation.find((item) => item.locationId === locations[1]!.id)!.id, locations[1]!.id],
      ].sort((left, right) => Number(left[0]) - Number(right[0]) || Number(left[1]) - Number(right[1])),
      "fulfillment movements must retain both their saved reservation and delivery-line links",
    );

    const { payload: history, status: historyStatus } = await request("GET", "/api/sales-orders");
    assert.equal(historyStatus, 200, JSON.stringify(history));
    const savedOrder = history.orders.find((order: any) => order.id === salesOrderId);
    assert.ok(savedOrder);
    assert.deepEqual(
      savedOrder.deliveries.map((delivery: any) => ({
        id: delivery.id,
        quantity: delivery.lines[0].quantity,
        stockLocations: delivery.lines[0].stockLocations
          .map((stock: any) => [stock.locationId, stock.locationName, stock.quantity])
          .sort((left: any[], right: any[]) => left[0] - right[0]),
      })).sort((left: any, right: any) => left.id - right.id),
      [
        {
          id: firstDelivery.delivery.id,
          quantity: 1,
          stockLocations: [[locations[2]!.id, locations[2]!.name, 1]],
        },
        {
          id: secondDelivery.delivery.id,
          quantity: 3,
          stockLocations: [
            [locations[0]!.id, locations[0]!.name, 2],
            [locations[1]!.id, locations[1]!.name, 1],
          ],
        },
      ].sort((left, right) => left.id - right.id),
      "sales history must report each partial delivery's quantity from its actual locations",
    );

    const cancelled = await post(`/api/sales-orders/${salesOrderId}/cancel`, {}, 200);
    assert.equal(cancelled.order.status, "cancelled");
    const finalReservations = await db.select().from(inventoryReservations)
      .where(eq(inventoryReservations.salesOrderId, salesOrderId));
    assert.deepEqual(
      finalReservations
        .sort((left, right) => left.locationId! - right.locationId!)
        .map((reservation) => [reservation.locationId, reservation.quantity, reservation.status]),
      [
        [locations[0]!.id, 2, "fulfilled"],
        [locations[1]!.id, 3, "released"],
        [locations[2]!.id, 3, "released"],
      ].sort((left, right) => Number(left[0]) - Number(right[0])),
      "cancellation must release every still-active reservation while preserving fulfilled holds",
    );
    const activeReservations = await db.select().from(inventoryReservations)
      .where(and(
        eq(inventoryReservations.salesOrderId, salesOrderId),
        eq(inventoryReservations.status, "active"),
      ));
    assert.deepEqual(activeReservations, []);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      if (orderId) {
        await client.query(`
          DELETE FROM journal_lines
          WHERE journal_entry_id IN (
            SELECT id FROM journal_entries
            WHERE source_type IN ('sales_delivery', 'sales_delivery_cogs')
              AND source_id IN (SELECT id FROM sales_deliveries WHERE sales_order_id = $1)
          )
        `, [orderId]);
        await client.query(`
          DELETE FROM journal_entries
          WHERE source_type IN ('sales_delivery', 'sales_delivery_cogs')
            AND source_id IN (SELECT id FROM sales_deliveries WHERE sales_order_id = $1)
        `, [orderId]);
      }
      if (productId) {
        await client.query("DELETE FROM inventory_movements WHERE product_id = $1", [productId]);
      }
      if (orderId) {
        await client.query(`
          DELETE FROM sales_delivery_lines
          WHERE delivery_id IN (SELECT id FROM sales_deliveries WHERE sales_order_id = $1)
        `, [orderId]);
        await client.query("DELETE FROM sales_deliveries WHERE sales_order_id = $1", [orderId]);
        await client.query("DELETE FROM inventory_reservations WHERE sales_order_id = $1", [orderId]);
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = $1", [orderId]);
        await client.query("DELETE FROM sales_orders WHERE id = $1", [orderId]);
      }
      if (productId) await client.query("DELETE FROM products WHERE id = $1", [productId]);
      if (customerId) await client.query("DELETE FROM customers WHERE id = $1", [customerId]);
      if (locationIds.length) await client.query(
        "DELETE FROM inventory_locations WHERE id = ANY($1::int[])", [locationIds],
      );
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
