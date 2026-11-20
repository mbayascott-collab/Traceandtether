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

test("concurrent stock reservations cannot overbook the same location", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const [{ db, pool }, { registerSalesRoutes }, { registerInventoryRoutes }] = await Promise.all([
    import("./db"),
    import("./sales-routes"),
    import("./inventory-routes"),
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
  registerInventoryRoutes(app, owner);
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
  let manualRaceProductId: number | undefined;
  let transferRaceProductId: number | undefined;
  let writeOffRaceProductId: number | undefined;
  let locationId: number | undefined;
  let transferDestinationLocationId: number | undefined;
  const orderIds: number[] = [];
  const manualRaceOrderIds: number[] = [];
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
    const [manualRaceProduct] = await db.insert(products).values({
      sku: `SMAN-${suffix}`,
      name: `Manual reservation race product ${suffix}`,
      status: "active",
    }).returning();
    manualRaceProductId = manualRaceProduct.id;
    const [location] = await db.insert(inventoryLocations).values({
      name: `Concurrent confirmation location ${suffix}`,
    }).returning();
    locationId = location.id;
    const [transferDestinationLocation] = await db.insert(inventoryLocations).values({
      name: `Concurrent transfer destination ${suffix}`,
    }).returning();
    transferDestinationLocationId = transferDestinationLocation.id;
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

    await db.insert(inventoryMovements).values({
      productId: manualRaceProductId,
      locationId,
      kind: "opening_stock",
      quantityDelta: 5,
      reason: `Manual reservation race test ${suffix}`,
      sourceKey: `manual-reservation-race-${suffix}`,
    });
    const { order: manualRaceOrder } = await request("/api/sales-orders", {
      customerId,
      deliveryAddress: null,
      notes: null,
      lines: [{ productId: manualRaceProductId, quantity: 4, unitPriceZmw: "10.00" }],
    }, 201);
    manualRaceOrderIds.push(manualRaceOrder.id);

    const [manualReservation, orderConfirmation] = await Promise.all([
      fetch(`${baseUrl}/api/inventory/reservations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productId: manualRaceProductId,
          locationId,
          quantity: 4,
          reference: `manual-race-${suffix}`,
          reason: `Concurrent manual reservation test ${suffix}`,
        }),
      }),
      fetch(`${baseUrl}/api/sales-orders/${manualRaceOrder.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locations: [{ productId: manualRaceProductId, locationId }] }),
      }),
    ]);
    const [manualReservationResult, orderConfirmationResult] = await Promise.all([
      manualReservation.json() as Promise<any>,
      orderConfirmation.json() as Promise<any>,
    ]);
    const raceResults = [
      { status: manualReservation.status, payload: manualReservationResult },
      { status: orderConfirmation.status, payload: orderConfirmationResult },
    ];
    const raceStatuses = raceResults.map(({ status }) => status).sort();
    assert.ok(
      JSON.stringify(raceStatuses) === JSON.stringify([200, 409])
        || JSON.stringify(raceStatuses) === JSON.stringify([201, 409]),
      `expected exactly one successful reservation request and one conflict, received ${raceStatuses.join(", ")}`,
    );
    const losingRequest = raceResults.find(({ status }) => status === 409);
    assert.ok(losingRequest);
    assert.match(losingRequest.payload.error, /available to reserve|units available .*; 4 requested/i);

    const manualRaceReservations = await db.select().from(inventoryReservations).where(and(
      eq(inventoryReservations.productId, manualRaceProductId),
      eq(inventoryReservations.locationId, locationId),
      eq(inventoryReservations.status, "active"),
    ));
    const [manualRaceOnHand] = await db.select({
      quantity: sum(inventoryMovements.quantityDelta),
    }).from(inventoryMovements).where(and(
      eq(inventoryMovements.productId, manualRaceProductId),
      eq(inventoryMovements.locationId, locationId),
    ));
    const totalActiveReserved = manualRaceReservations.reduce((total, reservation) => total + reservation.quantity, 0);
    assert.equal(manualRaceReservations.length, 1, "only the winning request should create an active reservation");
    assert.equal(totalActiveReserved, 4);
    assert.ok(totalActiveReserved <= Number(manualRaceOnHand.quantity), "active reservations must not exceed on-hand stock");

    const [transferRaceProduct] = await db.insert(products).values({
      sku: `STRANS-${suffix}`,
      name: `Concurrent transfer race product ${suffix}`,
      status: "active",
    }).returning();
    transferRaceProductId = transferRaceProduct.id;
    await db.insert(inventoryMovements).values({
      productId: transferRaceProductId,
      locationId,
      kind: "opening_stock",
      quantityDelta: 5,
      reason: `Concurrent transfer race test ${suffix}`,
      sourceKey: `stock-transfer-confirmation-race-${suffix}`,
    });
    const { order: transferRaceOrder } = await request("/api/sales-orders", {
      customerId,
      deliveryAddress: null,
      notes: null,
      lines: [{ productId: transferRaceProductId, quantity: 4, unitPriceZmw: "10.00" }],
    }, 201);
    orderIds.push(transferRaceOrder.id);

    const [transferResponse, transferConfirmationResponse] = await Promise.all([
      fetch(`${baseUrl}/api/inventory/transfers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productId: transferRaceProductId,
          fromLocationId: locationId,
          toLocationId: transferDestinationLocationId,
          quantity: 3,
          reason: `Concurrent transfer race test ${suffix}`,
          reference: null,
        }),
      }),
      fetch(`${baseUrl}/api/sales-orders/${transferRaceOrder.id}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locations: [{ productId: transferRaceProductId, locationId }] }),
      }),
    ]);
    const [transferResult, transferConfirmationResult] = await Promise.all([
      transferResponse.json() as Promise<any>,
      transferConfirmationResponse.json() as Promise<any>,
    ]);
    assert.ok(
      (transferResponse.status === 201 && transferConfirmationResponse.status === 409)
        || (transferResponse.status === 409 && transferConfirmationResponse.status === 200),
      `expected transfer and confirmation to serialize, received ${transferResponse.status} and ${transferConfirmationResponse.status}`,
    );
    if (transferResponse.status === 409) {
      assert.match(transferResult.error, /not have enough unreserved stock/i);
    }
    if (transferConfirmationResponse.status === 409) {
      assert.match(transferConfirmationResult.error, /units available .*; 4 requested/i);
    }

    const balanceAt = async (balanceLocationId: number) => {
      const [onHand] = await db.select({
        quantity: sum(inventoryMovements.quantityDelta),
      }).from(inventoryMovements).where(and(
        eq(inventoryMovements.productId, transferRaceProductId!),
        eq(inventoryMovements.locationId, balanceLocationId),
      ));
      const [reserved] = await db.select({
        quantity: sum(inventoryReservations.quantity),
      }).from(inventoryReservations).where(and(
        eq(inventoryReservations.productId, transferRaceProductId!),
        eq(inventoryReservations.locationId, balanceLocationId),
        eq(inventoryReservations.status, "active"),
      ));
      return {
        onHand: Number(onHand.quantity ?? 0),
        reserved: Number(reserved.quantity ?? 0),
      };
    };
    const [sourceBalance, destinationBalance] = await Promise.all([
      balanceAt(locationId),
      balanceAt(transferDestinationLocationId),
    ]);
    assert.ok(sourceBalance.reserved <= sourceBalance.onHand, "source reservations must not exceed source stock");
    assert.ok(destinationBalance.reserved <= destinationBalance.onHand, "destination reservations must not exceed destination stock");

    if (transferResponse.status === 201) {
      assert.deepEqual(sourceBalance, { onHand: 2, reserved: 0 }, "a completed transfer leaves two unreserved units at the source");
      assert.deepEqual(destinationBalance, { onHand: 3, reserved: 0 }, "a completed transfer adds three units at the destination");
    } else {
      assert.deepEqual(sourceBalance, { onHand: 5, reserved: 4 }, "a completed confirmation keeps all five units at the source and reserves four");
      assert.deepEqual(destinationBalance, { onHand: 0, reserved: 0 }, "a blocked transfer leaves the destination unchanged");
    }

    const [writeOffRaceProduct] = await db.insert(products).values({
      sku: `SWOFF-${suffix}`,
      name: `Concurrent write-off race product ${suffix}`,
      status: "active",
    }).returning();
    writeOffRaceProductId = writeOffRaceProduct.id;
    await db.insert(inventoryMovements).values({
      productId: writeOffRaceProductId,
      locationId,
      kind: "opening_stock",
      quantityDelta: 5,
      reason: `Write-off and reservation race test ${suffix}`,
      sourceKey: `writeoff-reservation-race-${suffix}`,
    });
    const [reservationResponse, writeOffResponse] = await Promise.all([
      fetch(`${baseUrl}/api/inventory/reservations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productId: writeOffRaceProductId,
          locationId,
          quantity: 4,
          reference: `writeoff-race-${suffix}`,
          reason: `Concurrent write-off reservation test ${suffix}`,
        }),
      }),
      fetch(`${baseUrl}/api/inventory/adjustments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productId: writeOffRaceProductId,
          locationId,
          quantityDelta: -3,
          reference: `writeoff-race-${suffix}`,
          reason: `Concurrent stock write-off test ${suffix}`,
        }),
      }),
    ]);
    const [reservationRaceResult, writeOffRaceResult] = await Promise.all([
      reservationResponse.json() as Promise<any>,
      writeOffResponse.json() as Promise<any>,
    ]);
    const writeOffRaceStatuses = [reservationResponse.status, writeOffResponse.status].sort();
    assert.deepEqual(writeOffRaceStatuses, [201, 409], "only the reservation or write-off may win the race");
    const losingRaceResult = reservationResponse.status === 409 ? reservationRaceResult : writeOffRaceResult;
    assert.match(losingRaceResult.error, /available to reserve|reserved units on hand/i, "the losing request must explain the stock conflict");
    const [writeOffRaceOnHand] = await db.select({
      quantity: sum(inventoryMovements.quantityDelta),
    }).from(inventoryMovements).where(and(
      eq(inventoryMovements.productId, writeOffRaceProductId),
      eq(inventoryMovements.locationId, locationId),
    ));
    const [writeOffRaceReserved] = await db.select({
      quantity: sum(inventoryReservations.quantity),
    }).from(inventoryReservations).where(and(
      eq(inventoryReservations.productId, writeOffRaceProductId),
      eq(inventoryReservations.locationId, locationId),
      eq(inventoryReservations.status, "active"),
    ));
    const writeOffRaceBalance = {
      onHand: Number(writeOffRaceOnHand.quantity ?? 0),
      reserved: Number(writeOffRaceReserved.quantity ?? 0),
    };
    assert.ok(writeOffRaceBalance.reserved <= writeOffRaceBalance.onHand, "active reservations must never exceed on-hand stock after a write-off race");
    if (reservationResponse.status === 201) {
      assert.deepEqual(writeOffRaceBalance, { onHand: 5, reserved: 4 });
    } else {
      assert.deepEqual(writeOffRaceBalance, { onHand: 2, reserved: 0 });
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM business_audit_logs WHERE actor_email = $1", [actorEmail]);
      const allOrderIds = [...orderIds, ...manualRaceOrderIds];
      if (allOrderIds.length) {
        await client.query("DELETE FROM inventory_reservations WHERE sales_order_id = ANY($1::int[])", [allOrderIds]);
        await client.query("DELETE FROM sales_order_lines WHERE sales_order_id = ANY($1::int[])", [allOrderIds]);
        await client.query("DELETE FROM sales_orders WHERE id = ANY($1::int[])", [allOrderIds]);
      }
      const allProductIds = [productId, manualRaceProductId, transferRaceProductId, writeOffRaceProductId].filter((id): id is number => id !== undefined);
      if (allProductIds.length) {
        await client.query("DELETE FROM inventory_reservations WHERE product_id = ANY($1::int[])", [allProductIds]);
        await client.query("DELETE FROM inventory_movements WHERE product_id = ANY($1::int[])", [allProductIds]);
        await client.query("DELETE FROM products WHERE id = ANY($1::int[])", [allProductIds]);
      }
      if (customerId) await client.query("DELETE FROM customers WHERE id = $1", [customerId]);
      if (transferDestinationLocationId) await client.query("DELETE FROM inventory_locations WHERE id = $1", [transferDestinationLocationId]);
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
